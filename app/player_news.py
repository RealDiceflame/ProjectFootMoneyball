"""Build a no-key, source-linked player news timeline from nflverse data."""

from __future__ import annotations

from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from io import BytesIO
import json
from pathlib import Path
import re
from typing import Callable
from xml.etree import ElementTree

import pandas as pd
import requests

from app.player_intel import DEFAULT_BOARD, load_ranked_players, player_key


ROSTER_URL = "https://github.com/nflverse/nflverse-data/releases/download/rosters/roster_{season}.csv.gz"
DEPTH_URL = "https://github.com/nflverse/nflverse-data/releases/download/depth_charts/depth_charts_{season}.csv.gz"
INJURY_URL = "https://github.com/nflverse/nflverse-data/releases/download/injuries/injuries_{season}.csv.gz"
ESPN_NEWS_URL = "https://www.espn.com/espn/rss/nfl/news"
ESPN_NEWS_SOURCE = "https://www.espn.com/nfl/"
ESPN_TEAM_CODES = {"LA": "lar", "WAS": "wsh"}

CURRENT_STATUSES = {"ACT", "RES", "DEV", "EXE"}
STATUS_DETAILS = {
    "RES": ("Reserve-list status", "risk"),
    "DEV": ("Practice-squad/developmental status", "risk"),
    "CUT": ("Released or waived", "risk"),
    "RET": ("Retired status", "risk"),
    "EXE": ("Roster exemption", "watch"),
    "INA": ("Inactive status", "watch"),
    "TRD": ("Trade status", "watch"),
    "TRC": ("Contract terminated", "risk"),
}
NAME_SUFFIXES = {"jr", "sr", "ii", "iii", "iv", "v"}
NON_FOOTBALL_HEADLINE_TERMS = {
    "dating", "engagement", "engaged", "girlfriend", "home purchase", "marriage",
    "purchased", "real estate", "relationship", "wedding", "wife",
}


def normalize_name(value: str) -> str:
    """Match common ranking names with roster names that include suffixes."""
    parts = re.findall(r"[a-z0-9]+", str(value).casefold())
    while parts and parts[-1] in NAME_SUFFIXES:
        parts.pop()
    return "".join(parts)


def espn_team_url(page: str, team: str) -> str:
    """Return the exact ESPN team page that lets a reader verify an update."""
    team_code = ESPN_TEAM_CODES.get(str(team).upper(), str(team).lower())
    return f"https://www.espn.com/nfl/team/{page}/_/name/{team_code}"


def _latest_by_team(depth: pd.DataFrame) -> pd.DataFrame:
    if depth.empty:
        return depth.copy()
    result = depth.copy()
    result["dt"] = pd.to_datetime(result["dt"], utc=True, errors="coerce")
    latest = result.groupby("team")["dt"].transform("max")
    return result[result["dt"] == latest].copy()


def _source(title: str, url: str) -> dict:
    return {"title": title, "url": url}


def _event(category: str, severity: str, date_label: str, title: str, detail: str, source: dict) -> dict:
    return {
        "category": category,
        "severity": severity,
        "date": date_label,
        "title": title,
        "detail": detail,
        "source": source,
    }


def _matching_rows(frame: pd.DataFrame, column: str, name: str) -> pd.DataFrame:
    if frame.empty:
        return frame.copy()
    normalized = frame[column].fillna("").map(normalize_name)
    return frame[normalized == normalize_name(name)].copy()


def _roster_event(player: dict, roster: pd.DataFrame, generated_date: str) -> tuple[dict | None, str]:
    matches = _matching_rows(roster, "full_name", player["player"])
    same_team = matches[matches["team"] == player["team"]]
    active_elsewhere = matches[
        (matches["team"] != player["team"]) & matches["status"].isin(CURRENT_STATUSES)
    ]

    if not active_elsewhere.empty:
        new_team = active_elsewhere.iloc[0]["team"]
        return _event(
            "Roster",
            "risk",
            generated_date,
            f"Current roster data lists {player['player']} with {new_team}",
            f"The draft board still lists {player['team']}. Verify the team and role before drafting.",
            _source(f"View {new_team} roster at ESPN", espn_team_url("roster", new_team)),
        ), "risk"

    if same_team.empty:
        return _event(
            "Roster",
            "watch",
            generated_date,
            "Not matched on the current roster",
            "The player could not be matched to the current team roster. This may be a naming or roster-timing issue.",
            _source(f"View {player['team']} roster at ESPN", espn_team_url("roster", player["team"])),
        ), "watch"

    row = same_team.sort_values(
        "status", key=lambda values: values.map({"ACT": 0, "RES": 1, "DEV": 2, "EXE": 3}).fillna(9)
    ).iloc[0]
    status = str(row.get("status") or "").upper()
    if status == "ACT":
        return None, "stable"
    title, severity = STATUS_DETAILS.get(status, (f"Roster status: {status or 'unknown'}", "watch"))
    description = str(row.get("status_description_abbr") or "").strip()
    detail = f"Current roster status is {status}."
    if description and description.lower() != "nan":
        detail += f" The roster designation is {description}."
    return _event(
        "Availability",
        severity,
        generated_date,
        title,
        detail,
        _source(f"View {player['team']} roster at ESPN", espn_team_url("roster", player["team"])),
    ), severity


def _depth_event(player: dict, depth: pd.DataFrame, generated_date: str) -> tuple[dict, str]:
    matches = _matching_rows(depth, "player_name", player["player"])
    matches = matches[(matches["team"] == player["team"]) & (matches["pos_abb"] == player["pos"])]
    if matches.empty:
        return _event(
            "Depth chart",
            "risk",
            generated_date,
            "Not listed on the latest depth chart",
            "The newest depth-chart snapshot does not list this player at the board's team and position.",
            _source(f"View {player['team']} depth chart at ESPN", espn_team_url("depth", player["team"])),
        ), "risk"

    row = matches.sort_values("pos_rank").iloc[0]
    rank = int(row["pos_rank"])
    snapshot = pd.Timestamp(row["dt"]).date().isoformat()
    starter_cutoff = 3 if player["pos"] == "WR" else 1
    severity = "stable" if rank <= starter_cutoff else "watch"
    if player["pos"] == "WR" and rank <= 3:
        detail = f"The latest {player['team']} depth chart places {player['player']} among its top three wide receivers."
    elif rank == 1:
        detail = f"The latest {player['team']} depth chart lists {player['player']} first at {player['pos']}."
    else:
        detail = f"The latest {player['team']} depth chart lists {player['player']} at {player['pos']}{rank}."
    detail += " A depth-chart listing does not guarantee playing time or touches."
    return _event(
        "Depth chart",
        severity,
        snapshot,
        f"Listed as {player['pos']}{rank}",
        detail,
        _source(f"View {player['team']} depth chart at ESPN", espn_team_url("depth", player["team"])),
    ), severity


def _position_changes(
    player: dict,
    current: pd.DataFrame,
    previous: pd.DataFrame,
    ranked_names: set[str],
) -> list[dict]:
    current_group = current[
        (current["team"] == player["team"]) & (current["pos_abb"] == player["pos"])
    ].sort_values("pos_rank")
    previous_group = previous[
        (previous["team"] == player["team"]) & (previous["pos_abb"] == player["pos"])
    ].sort_values("pos_rank")
    cutoff = 6 if player["pos"] == "WR" else 4
    current_group = current_group[current_group["pos_rank"] <= cutoff]
    previous_group = previous_group[previous_group["pos_rank"] <= cutoff]
    current_names = {normalize_name(name): name for name in current_group["player_name"].dropna()}
    previous_names = {normalize_name(name): name for name in previous_group["player_name"].dropna()}
    current_ranks = {
        normalize_name(row.player_name): int(row.pos_rank)
        for row in current_group.itertuples()
    }
    previous_ranks = {
        normalize_name(row.player_name): int(row.pos_rank)
        for row in previous_group.itertuples()
    }
    own_name = normalize_name(player["player"])
    own_current_rank = current_ranks.get(own_name)
    own_previous_rank = previous_ranks.get(own_name)
    arrivals = [
        current_names[key]
        for key in current_names
        if key not in previous_names
        and key != own_name
        and (key in ranked_names or (own_current_rank is not None and current_ranks[key] < own_current_rank))
    ]
    departures = [
        previous_names[key]
        for key in previous_names
        if key not in current_names
        and key != own_name
        and (key in ranked_names or (own_previous_rank is not None and previous_ranks[key] < own_previous_rank))
    ]
    events = []
    if arrivals:
        events.append(_event(
            "Arrival",
            "watch",
            f"{current_group['dt'].max().year} offseason" if not current_group.empty else "Current offseason",
            f"New {player['pos']} competition",
            f"New names in the top of the {player['team']} position group: {', '.join(arrivals[:5])}.",
            _source(f"View {player['team']} depth chart at ESPN", espn_team_url("depth", player["team"])),
        ))
    if departures:
        events.append(_event(
            "Departure",
            "info",
            f"{current_group['dt'].max().year} offseason" if not current_group.empty else "Current offseason",
            f"Departures from the {player['pos']} room",
            f"Names no longer in the top of the {player['team']} position group: {', '.join(departures[:5])}.",
            _source(f"View {player['team']} depth chart at ESPN", espn_team_url("depth", player["team"])),
        ))
    return events


def _injury_event(player: dict, injuries: pd.DataFrame) -> dict | None:
    if injuries.empty:
        return None
    matches = _matching_rows(injuries, "full_name", player["player"])
    matches = matches[matches["team"] == player["team"]]
    if matches.empty:
        return None
    row = matches.sort_values("week").iloc[-1]
    report_injury = row.get("report_primary_injury")
    practice_injury = row.get("practice_primary_injury")
    injury = report_injury if pd.notna(report_injury) and str(report_injury).strip() else practice_injury
    report = row.get("report_status")
    practice = row.get("practice_status")
    values = [value for value in (injury, report, practice) if pd.notna(value) and str(value).strip()]
    if not values:
        return None
    severity = "risk" if str(report).casefold() in {"out", "doubtful"} else "watch"
    return _event(
        "Injury",
        severity,
        f"Week {int(row['week'])}",
        f"Injury report: {injury or 'availability update'}",
        "; ".join(str(value) for value in values),
        _source(f"View {player['team']} injuries at ESPN", espn_team_url("injuries", player["team"])),
    )


def _headline_severity(headline: str) -> str:
    text = headline.casefold()
    risk_terms = ("out for season", "season-ending", "torn ", "suspended", "released", "waived", "retires")
    watch_terms = ("injury", "injured", "surgery", "misses", "miss ", "limited", "questionable", "holdout", "competition")
    if any(term in text for term in risk_terms):
        return "risk"
    if any(term in text for term in watch_terms):
        return "watch"
    return "info"


def match_headlines(players: list[dict], headlines: list[dict]) -> dict[str, list[dict]]:
    """Match RSS headlines conservatively when the full name appears in title or URL."""
    matched: dict[str, list[dict]] = {}
    for player in players:
        key = player_key(player["player"], player["team"])
        full_name = normalize_name(player["player"])
        for article in headlines:
            headline = str(article.get("title") or "").strip()
            if any(term in headline.casefold() for term in NON_FOOTBALL_HEADLINE_TERMS):
                continue
            searchable = normalize_name(f"{headline} {article.get('url') or ''}")
            if not full_name or full_name not in searchable:
                continue
            matched.setdefault(key, []).append(_event(
                "Recent news",
                _headline_severity(headline),
                article.get("date") or "Recent",
                headline,
                "Open the linked ESPN report for the full context.",
                _source("ESPN NFL News", article.get("url") or ESPN_NEWS_SOURCE),
            ))
            if len(matched[key]) >= 3:
                break
    return matched


def build_player_news(
    rankings_path: str | Path,
    destination: str | Path,
    *,
    season: int,
    current_roster: pd.DataFrame,
    current_depth: pd.DataFrame,
    previous_depth: pd.DataFrame,
    injuries: pd.DataFrame | None = None,
    headlines: list[dict] | None = None,
    now: datetime | None = None,
) -> Path:
    """Create a compact factual timeline for every ranked player."""
    now = now or datetime.now(timezone.utc)
    generated_date = now.date().isoformat()
    current_depth = _latest_by_team(current_depth)
    previous_depth = _latest_by_team(previous_depth)
    injuries = injuries if injuries is not None else pd.DataFrame()
    players = {}

    ranked_players = load_ranked_players(rankings_path, DEFAULT_BOARD)
    ranked_names = {normalize_name(player["player"]) for player in ranked_players}
    headline_events = match_headlines(ranked_players, headlines or [])
    for player in ranked_players:
        key = player_key(player["player"], player["team"])
        events = list(headline_events.get(key, []))
        severities = [event["severity"] for event in events]
        roster_event, roster_signal = _roster_event(player, current_roster, generated_date)
        if roster_event:
            events.append(roster_event)
        severities.append(roster_signal)
        depth_event, depth_signal = _depth_event(player, current_depth, generated_date)
        events.append(depth_event)
        severities.append(depth_signal)
        position_events = _position_changes(player, current_depth, previous_depth, ranked_names)
        events.extend(position_events)
        severities.extend(event["severity"] for event in position_events)
        injury_event = _injury_event(player, injuries)
        if injury_event:
            events.insert(0, injury_event)
            severities.append(injury_event["severity"])
        signal = "risk" if "risk" in severities else "watch" if "watch" in severities else "stable"
        players[key] = {
            "player": player["player"],
            "team": player["team"],
            "pos": player["pos"],
            "signal": signal,
            "events": events,
        }

    payload = {
        "season": season,
        "generated_at": now.isoformat(),
        "player_count": len(players),
        "source": "nflverse roster, depth-chart, and injury data plus ESPN NFL headlines",
        "attribution_url": "https://github.com/nflverse/nflverse-data",
        "reports": players,
    }
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    temporary.replace(destination)
    return destination


def _download_csv(url: str, columns: list[str], *, get: Callable = requests.get, optional: bool = False) -> pd.DataFrame:
    response = get(url, headers={"User-Agent": "ProjectFootMoneyball/1.0"}, timeout=180)
    if optional and response.status_code == 404:
        return pd.DataFrame(columns=columns)
    response.raise_for_status()
    return pd.read_csv(BytesIO(response.content), compression="gzip", usecols=columns)


def _download_headlines(*, get: Callable = requests.get) -> list[dict]:
    response = get(ESPN_NEWS_URL, headers={"User-Agent": "Mozilla/5.0 ProjectFootMoneyball/1.0"}, timeout=60)
    response.raise_for_status()
    root = ElementTree.fromstring(response.content)
    headlines = []
    for item in root.findall("./channel/item"):
        title = (item.findtext("title") or "").strip()
        url = (item.findtext("link") or "").strip()
        published = (item.findtext("pubDate") or "").strip()
        try:
            date_label = parsedate_to_datetime(published).date().isoformat()
        except (TypeError, ValueError, OverflowError):
            date_label = "Recent"
        if title and url.startswith(("https://", "http://")):
            headlines.append({"title": title, "url": url, "date": date_label})
    return headlines


def refresh_player_news(
    rankings_path: str | Path,
    destination: str | Path,
    *,
    season: int,
    status: Callable[[str], None] = print,
) -> Path:
    """Download the public source data and refresh the website timeline."""
    status(f"[1/5] Loading {season} rosters...")
    roster = _download_csv(
        ROSTER_URL.format(season=season),
        ["team", "status", "full_name", "status_description_abbr"],
    )
    status(f"[2/5] Loading {season} depth charts...")
    current_depth = _download_csv(
        DEPTH_URL.format(season=season),
        ["dt", "team", "player_name", "pos_abb", "pos_rank"],
    )
    status(f"[3/5] Comparing {season - 1} depth charts...")
    previous_depth = _download_csv(
        DEPTH_URL.format(season=season - 1),
        ["dt", "team", "player_name", "pos_abb", "pos_rank"],
    )
    status(f"[4/5] Checking {season} injury reports...")
    injuries = _download_csv(
        INJURY_URL.format(season=season),
        [
            "team", "week", "full_name", "report_primary_injury", "report_status",
            "practice_primary_injury", "practice_status",
        ],
        optional=True,
    )
    status("[5/5] Loading recent ESPN NFL headlines...")
    try:
        headlines = _download_headlines()
    except (requests.RequestException, ElementTree.ParseError) as error:
        status(f"[WARN] Recent headlines are temporarily unavailable: {error}")
        headlines = []
    result = build_player_news(
        rankings_path,
        destination,
        season=season,
        current_roster=roster,
        current_depth=current_depth,
        previous_depth=previous_depth,
        injuries=injuries,
        headlines=headlines,
    )
    status(f"[OK] Player news ready: {result}")
    return result
