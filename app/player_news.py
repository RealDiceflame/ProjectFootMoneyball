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
ESPN_INJURIES_URL = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries"
ESPN_NEWS_SOURCE = "https://www.espn.com/nfl/"
ESPN_TEAM_CODES = {"LA": "lar", "WAS": "wsh"}
ESPN_TEAM_ALIASES = {"LAR": "LA", "WSH": "WAS"}
NFL_HEADSHOT_TRANSFORM = "/image/upload/f_auto,q_auto/"
NFL_HEADSHOT_COMPACT = "/image/upload/f_auto,q_auto,w_160,c_fill,g_face/"

CURRENT_STATUSES = {"ACT", "RES", "DEV", "EXE"}
STATUS_DETAILS = {
    "RES": ("Reserve-list status", "risk"),
    "DEV": ("Practice-squad/developmental status", "risk"),
    "CUT": ("Released or waived", "risk"),
    "RET": ("Retired status", "risk"),
    "EXE": ("Roster exemption", "risk"),
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


def _clean_player_id(value) -> str:
    if value is None or pd.isna(value):
        return ""
    player_id = str(value).strip()
    return "" if player_id.casefold() in {"", "-", "nan", "none"} else player_id


def _matching_roster_rows(roster: pd.DataFrame, player: dict) -> pd.DataFrame:
    """Match a roster identity by stable ID, falling back to name plus position."""
    if roster.empty:
        return roster.copy()
    player_id = _clean_player_id(player.get("player_id"))
    if player_id and "gsis_id" in roster.columns:
        ids = roster["gsis_id"].map(_clean_player_id)
        id_matches = roster[ids == player_id].copy()
        if not id_matches.empty:
            return id_matches
    matches = _matching_rows(roster, "full_name", player["player"])
    if matches.empty or "position" not in matches.columns:
        return matches
    position = str(player.get("pos") or "").upper()
    accepted = {"RB", "HB", "FB"} if position == "RB" else {position}
    return matches[matches["position"].fillna("").astype(str).str.upper().isin(accepted)].copy()


def _ambiguous_roster_names(roster: pd.DataFrame) -> set[str]:
    """Identify names belonging to multiple roster identities so headlines are not guessed."""
    if roster.empty or "full_name" not in roster.columns:
        return set()
    identities = roster.copy()
    identities["_name"] = identities["full_name"].map(normalize_name)
    if "gsis_id" in identities.columns:
        identities["_identity"] = identities["gsis_id"].map(_clean_player_id)
    else:
        position = identities.get("position", pd.Series("", index=identities.index)).fillna("").astype(str)
        team = identities.get("team", pd.Series("", index=identities.index)).fillna("").astype(str)
        identities["_identity"] = position + "|" + team
    counts = identities[identities["_identity"] != ""].groupby("_name")["_identity"].nunique()
    return set(counts[counts > 1].index)


def _headshot_url(player: dict, roster: pd.DataFrame, current_team: str | None) -> str | None:
    """Prefer the headshot attached to the player's current roster entry."""
    matches = _matching_roster_rows(roster, player)
    if matches.empty or "headshot_url" not in matches.columns:
        return None
    if current_team:
        current = matches[matches["team"] == current_team]
        matches = pd.concat([current, matches.drop(index=current.index)])
    for value in matches["headshot_url"].dropna():
        url = str(value).strip()
        if url.startswith(("https://", "http://")):
            return url.replace(NFL_HEADSHOT_TRANSFORM, NFL_HEADSHOT_COMPACT, 1)
    return None


def _roster_event(
    player: dict,
    roster: pd.DataFrame,
    generated_date: str,
) -> tuple[dict | None, str, str | None]:
    matches = _matching_roster_rows(roster, player)
    same_team = matches[matches["team"] == player["team"]]
    active_elsewhere = matches[
        (matches["team"] != player["team"]) & matches["status"].isin(CURRENT_STATUSES)
    ]

    if not active_elsewhere.empty:
        new_team = str(active_elsewhere.iloc[0]["team"])
        return _event(
            "Roster",
            "watch",
            generated_date,
            f"Current roster data lists {player['player']} with {new_team}",
            f"The draft board still lists {player['team']}. Verify the team and role before drafting.",
            _source(f"View {new_team} roster at ESPN", espn_team_url("roster", new_team)),
        ), "watch", new_team

    if same_team.empty:
        return _event(
            "Roster",
            "watch",
            generated_date,
            "Not matched on the current roster",
            "The player could not be matched to the current team roster. This may be a naming or roster-timing issue.",
            _source(f"View {player['team']} roster at ESPN", espn_team_url("roster", player["team"])),
        ), "watch", None

    row = same_team.sort_values(
        "status", key=lambda values: values.map({"ACT": 0, "RES": 1, "DEV": 2, "EXE": 3}).fillna(9)
    ).iloc[0]
    status = str(row.get("status") or "").upper()
    if status == "ACT":
        return None, "stable", player["team"]
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
    ), severity, player["team"]


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


def _injury_event(player: dict, injuries: pd.DataFrame) -> tuple[dict | None, dict | None]:
    if injuries.empty:
        return None, None
    matches = _matching_roster_rows(injuries, player)
    matches = matches[matches["team"] == player["team"]]
    if matches.empty:
        return None, None
    row = matches.sort_values("week").iloc[-1]
    injury_names = []
    seen_injuries = set()
    for column in (
        "report_primary_injury",
        "report_secondary_injury",
        "practice_primary_injury",
        "practice_secondary_injury",
    ):
        value = row.get(column)
        if pd.isna(value) or not str(value).strip():
            continue
        clean_value = str(value).strip()
        normalized_value = clean_value.casefold()
        if normalized_value not in seen_injuries:
            injury_names.append(clean_value)
            seen_injuries.add(normalized_value)
    report = row.get("report_status")
    practice = row.get("practice_status")
    values = [*injury_names, *[
        value for value in (report, practice) if pd.notna(value) and str(value).strip()
    ]]
    if not values:
        return None, None
    severity = "risk" if str(report).casefold() in {"out", "doubtful"} else "watch"
    clean_injury = ", ".join(injury_names) if injury_names else "Availability"
    clean_report = str(report).strip() if pd.notna(report) and str(report).strip() else None
    clean_practice = str(practice).strip() if pd.notna(practice) and str(practice).strip() else None
    snapshot = {
        "name": clean_injury,
        "injuries": injury_names,
        "status": clean_report or clean_practice,
        "report_status": clean_report,
        "practice_status": clean_practice,
        "week": int(row["week"]),
        "severity": severity,
    }
    return _event(
        "Injury",
        severity,
        f"Week {int(row['week'])}",
        f"Injury report: {clean_injury}",
        "; ".join(str(value) for value in values),
        _source(f"View {player['team']} injuries at ESPN", espn_team_url("injuries", player["team"])),
    ), snapshot


def _espn_injury_event(player: dict, injuries: list[dict]) -> tuple[dict | None, dict | None]:
    """Return ESPN's current injury or availability designation for one player."""
    accepted_positions = {"RB", "HB", "FB"} if player["pos"] == "RB" else {player["pos"]}
    matches = [
        report for report in injuries
        if normalize_name(report.get("full_name", "")) == normalize_name(player["player"])
        and report.get("team") == player["team"]
        and str(report.get("position") or "").upper() in accepted_positions
    ]
    if not matches:
        return None, None

    report = max(matches, key=lambda item: str(item.get("date") or ""))
    injury_names = list(dict.fromkeys(report.get("injuries") or []))
    status = str(report.get("status") or "").strip()
    severity = "risk" if status.casefold() in {
        "out", "doubtful", "injured reserve", "suspension",
    } else "watch"
    non_injury_reasons = {"personal", "suspension"}
    label = "STATUS" if injury_names and {
        name.casefold() for name in injury_names
    } <= non_injury_reasons else "INJ"
    injury_name = ", ".join(injury_names) if injury_names else "Availability"
    date_label = str(report.get("date") or "Recent").split("T", 1)[0]
    return_date = report.get("return_date")
    detail_parts = [f"ESPN lists the current status as {status or 'an availability update' }."]
    if injury_names:
        detail_parts.append(f"Reported issue: {injury_name}.")
    if return_date:
        detail_parts.append(f"Listed return date: {return_date}.")
    source_url = report.get("source_url") or espn_team_url("injuries", player["team"])
    snapshot = {
        "name": injury_name,
        "injuries": injury_names,
        "status": status or None,
        "report_status": status or None,
        "practice_status": None,
        "week": None,
        "severity": severity,
        "label": label,
        "date": date_label,
        "return_date": return_date,
    }
    return _event(
        "Injury" if label == "INJ" else "Availability",
        severity,
        date_label,
        f"{status or 'Availability'}: {injury_name}",
        " ".join(detail_parts),
        _source("View the ESPN player update", source_url),
    ), snapshot


def _headline_severity(headline: str) -> str:
    text = headline.casefold()
    risk_terms = (
        "out for season", "season-ending", "torn ", "suspended", "released", "waived", "retires",
        "commissioner's exempt", "commissioner exempt", "exempt list",
    )
    watch_terms = ("injury", "injured", "surgery", "misses", "miss ", "limited", "questionable", "holdout", "competition")
    if any(term in text for term in risk_terms):
        return "risk"
    if any(term in text for term in watch_terms):
        return "watch"
    return "info"


def match_headlines(
    players: list[dict],
    headlines: list[dict],
    *,
    ambiguous_names: set[str] | None = None,
) -> dict[str, list[dict]]:
    """Match RSS headlines conservatively when the full name appears in title or URL."""
    matched: dict[str, list[dict]] = {}
    ambiguous_names = ambiguous_names or set()
    for player in players:
        key = player_key(player["player"], player["team"])
        full_name = normalize_name(player["player"])
        if full_name in ambiguous_names:
            continue
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
    espn_injuries: list[dict] | None = None,
    headlines: list[dict] | None = None,
    now: datetime | None = None,
) -> Path:
    """Create a compact factual timeline for every ranked player."""
    now = now or datetime.now(timezone.utc)
    generated_date = now.date().isoformat()
    current_depth = _latest_by_team(current_depth)
    previous_depth = _latest_by_team(previous_depth)
    injuries = injuries if injuries is not None else pd.DataFrame()
    espn_injuries = espn_injuries or []
    players = {}

    ranked_players = load_ranked_players(rankings_path, DEFAULT_BOARD)
    ranked_names = {normalize_name(player["player"]) for player in ranked_players}
    headline_events = match_headlines(
        ranked_players,
        headlines or [],
        ambiguous_names=_ambiguous_roster_names(current_roster),
    )
    for player in ranked_players:
        key = player_key(player["player"], player["team"])
        events = list(headline_events.get(key, []))
        severities = [event["severity"] for event in events]
        roster_event, roster_signal, current_team = _roster_event(player, current_roster, generated_date)
        if roster_event:
            events.append(roster_event)
        severities.append(roster_signal)
        current_player = {**player, "team": current_team or player["team"]}
        depth_event, depth_signal = _depth_event(current_player, current_depth, generated_date)
        events.append(depth_event)
        severities.append(depth_signal)
        position_events = _position_changes(current_player, current_depth, previous_depth, ranked_names)
        events.extend(position_events)
        severities.extend(event["severity"] for event in position_events)
        injury_event, injury = _espn_injury_event(current_player, espn_injuries)
        if not injury_event:
            injury_event, injury = _injury_event(current_player, injuries)
        if injury_event:
            events.insert(0, injury_event)
            severities.append(injury_event["severity"])
        signal = "risk" if "risk" in severities else "watch" if "watch" in severities else "stable"
        team_changed = bool(current_team and current_team != player["team"])
        only_team_change = team_changed and not any(
            event["category"] not in {"Roster", "Depth chart"} for event in events
        )
        players[key] = {
            "player": player["player"],
            "player_id": _clean_player_id(player.get("player_id")) or None,
            "team": player["team"],
            "listed_team": player["team"],
            "current_team": current_team,
            "headshot_url": _headshot_url(player, current_roster, current_team),
            "pos": player["pos"],
            "signal": signal,
            "injury": injury,
            "team_changed": team_changed,
            "only_team_change": only_team_change,
            "events": events,
        }

    payload = {
        "season": season,
        "generated_at": now.isoformat(),
        "player_count": len(players),
        "source": "nflverse roster, depth-chart, and injury data plus ESPN injuries and NFL headlines",
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


def _download_espn_injuries(*, get: Callable = requests.get) -> list[dict]:
    """Load ESPN designations used before official weekly reports are published."""
    response = get(
        ESPN_INJURIES_URL,
        headers={"User-Agent": "curl/8.10.1", "Accept": "application/json"},
        timeout=60,
    )
    response.raise_for_status()
    reports = []
    for team in response.json().get("injuries", []):
        for item in team.get("injuries", []):
            athlete = item.get("athlete") or {}
            details = item.get("details") or {}
            status = str(item.get("status") or "").strip()
            injury_type = str(details.get("type") or "").strip()
            if status.casefold() == "active" and not injury_type:
                continue
            links = athlete.get("links") or []
            source_url = next((
                link.get("href") for link in links
                if "news" in (link.get("rel") or [])
                and str(link.get("href") or "").startswith(("https://", "http://"))
            ), None)
            team_code = str((athlete.get("team") or {}).get("abbreviation") or "").upper()
            reports.append({
                "full_name": athlete.get("displayName"),
                "team": ESPN_TEAM_ALIASES.get(team_code, team_code),
                "position": (athlete.get("position") or {}).get("abbreviation"),
                "injuries": [injury_type] if injury_type else [],
                "status": status,
                "date": item.get("date"),
                "return_date": details.get("returnDate"),
                "source_url": source_url,
            })
    return reports


def refresh_player_news(
    rankings_path: str | Path,
    destination: str | Path,
    *,
    season: int,
    status: Callable[[str], None] = print,
) -> Path:
    """Download the public source data and refresh the website timeline."""
    status(f"[1/6] Loading {season} rosters...")
    roster = _download_csv(
        ROSTER_URL.format(season=season),
        [
            "team", "status", "full_name", "position", "gsis_id",
            "status_description_abbr", "headshot_url",
        ],
    )
    status(f"[2/6] Loading {season} depth charts...")
    current_depth = _download_csv(
        DEPTH_URL.format(season=season),
        ["dt", "team", "player_name", "pos_abb", "pos_rank"],
    )
    status(f"[3/6] Comparing {season - 1} depth charts...")
    previous_depth = _download_csv(
        DEPTH_URL.format(season=season - 1),
        ["dt", "team", "player_name", "pos_abb", "pos_rank"],
    )
    status(f"[4/6] Checking {season} injury reports...")
    injuries = _download_csv(
        INJURY_URL.format(season=season),
        [
            "team", "week", "gsis_id", "position", "full_name",
            "report_primary_injury", "report_secondary_injury", "report_status",
            "practice_primary_injury", "practice_secondary_injury", "practice_status",
        ],
        optional=True,
    )
    status("[5/6] Loading current ESPN injuries...")
    try:
        espn_injuries = _download_espn_injuries()
    except (requests.RequestException, ValueError) as error:
        status(f"[WARN] Current ESPN injuries are temporarily unavailable: {error}")
        espn_injuries = []
    status("[6/6] Loading recent ESPN NFL headlines...")
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
        espn_injuries=espn_injuries,
        headlines=headlines,
    )
    status(f"[OK] Player news ready: {result}")
    return result
