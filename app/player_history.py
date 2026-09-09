"""Publish season histories for the draft board and recent historical players."""

from __future__ import annotations

from datetime import datetime, timezone
from io import BytesIO
import json
from pathlib import Path
from typing import Callable, Iterable

import pandas as pd
import requests

from app.player_intel import DEFAULT_BOARD, load_ranked_players
from app.player_news import normalize_name


STATS_URL = (
    "https://github.com/nflverse/nflverse-data/releases/download/"
    "stats_player/stats_player_reg_{season}.csv"
)
DEFAULT_HISTORY_SEASONS = 10
DEFAULT_HISTORICAL_LOOKBACK = 5
PLAYERS_URL = "https://github.com/nflverse/nflverse-data/releases/download/players/players.csv"
FANTASY_POSITIONS = {"QB", "RB", "WR", "TE"}
STAT_COLUMNS = (
    "games",
    "completions",
    "attempts",
    "passing_yards",
    "passing_tds",
    "passing_interceptions",
    "carries",
    "rushing_yards",
    "rushing_tds",
    "targets",
    "receptions",
    "receiving_yards",
    "receiving_tds",
    "fumbles_total",
)
HISTORY_COLUMNS = ("season", "team", *STAT_COLUMNS, "pos")
SOURCE_COLUMNS = (
    "player_id",
    "player_display_name",
    "position",
    "season",
    "season_type",
    "recent_team",
    *STAT_COLUMNS,
)


def _text(value) -> str:
    if value is None or pd.isna(value):
        return ""
    text = str(value).strip()
    return "" if text.casefold() in {"-", "nan", "none"} else text


def _position(value) -> str:
    position = _text(value).upper()
    return "RB" if position in {"HB", "FB"} else position


def history_key(player: dict) -> str:
    """Return the same stable history identifier used by the browser."""
    player_id = _text(player.get("player_id"))
    if player_id:
        return f"id:{player_id}"
    return f"name:{normalize_name(player.get('player', ''))}|{_position(player.get('pos'))}"


def _number(value):
    if value is None or pd.isna(value):
        return 0
    number = float(value)
    return int(number) if number.is_integer() else round(number, 2)


def _team(value) -> str:
    if value is None or pd.isna(value):
        return "-"
    team = str(value).strip().upper()
    return team if team and team not in {"NAN", "NONE"} else "-"


def _season_rows(frame: pd.DataFrame, player: dict) -> pd.DataFrame:
    """Use exact IDs; name fallback must not cross conflicting known IDs."""
    if frame.empty:
        return frame.copy()
    regular = frame
    if "season_type" in regular.columns:
        regular = regular[regular["season_type"].eq("REG")]
    player_id = _text(player.get("player_id"))
    ids = regular["player_id"].map(_text)
    if player_id:
        matches = regular[ids.eq(player_id)]
        if not matches.empty:
            return matches.copy()
        regular = regular[ids.eq("")]
    names = regular["player_display_name"].fillna("").map(normalize_name)
    positions = regular["position"].map(_position)
    matches = regular[(names == normalize_name(player.get("player", ""))) & positions.eq(_position(player.get("pos")))].copy()
    if matches["player_id"].map(_text).replace("", pd.NA).dropna().nunique() > 1:
        return matches.iloc[:0]
    return matches


def _birth_dates(player_frame: pd.DataFrame | None) -> dict[str, str]:
    """Join archived and active identities without relying on current rosters."""
    if player_frame is None or player_frame.empty:
        return {}
    result = {}
    for player_id, group in player_frame.groupby("gsis_id"):
        dates = pd.to_datetime(group["birth_date"], errors="coerce").dropna().dt.strftime("%Y-%m-%d").unique()
        if _text(player_id) and len(dates) == 1:
            result[_text(player_id)] = dates[0]
    return result


def _history_record(player: dict, matched: pd.DataFrame, births: dict, *, ranked: bool) -> dict:
    rows = []
    ordered = matched.sort_values("season", ascending=False).drop_duplicates("season")
    for values in ordered.to_dict("records"):
        rows.append([
            int(values["season"]),
            _team(values.get("recent_team")),
            *[_number(values.get(column)) for column in STAT_COLUMNS],
            _position(values.get("position")),
        ])
    matched_ids = matched["player_id"].map(_text).replace("", pd.NA).dropna().unique()
    player_id = _text(player.get("player_id")) or (matched_ids[0] if len(matched_ids) == 1 else "")
    return {
        "player": player["player"],
        "player_id": player_id or None,
        "pos": _position(player["pos"]),
        "birth_date": births.get(player_id),
        "is_ranked": ranked,
        "last_recorded_season": rows[0][0],
        "seasons": rows,
    }


def build_player_history(
    rankings_path: str | Path,
    destination: str | Path,
    *,
    season_frames: Iterable[pd.DataFrame],
    player_frame: pd.DataFrame | None = None,
    historical_lookback: int = DEFAULT_HISTORICAL_LOOKBACK,
    now: datetime | None = None,
) -> Path:
    """Keep ranked players plus anyone with stats inside the recent exit window.

    A last season is an observed fact, not a confirmed retirement date. For an
    archive ending in 2025, including last seasons from 2020 covers departures
    starting in 2021. Every selected player's available ten-year history is kept.
    """
    if historical_lookback < 0:
        raise ValueError("historical_lookback must be non-negative")
    now = now or datetime.now(timezone.utc)
    frames = list(season_frames)
    combined = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame(columns=SOURCE_COLUMNS)
    if "season_type" in combined.columns:
        combined = combined[combined["season_type"].eq("REG")].copy()
    combined["season"] = pd.to_numeric(combined["season"], errors="coerce")
    combined = combined.dropna(subset=["season"])
    combined["position"] = combined["position"].map(_position)
    combined = combined[combined["position"].isin(FANTASY_POSITIONS)].copy()
    combined["player_id"] = combined["player_id"].map(_text)
    ranked_players = load_ranked_players(rankings_path, DEFAULT_BOARD)
    players = {}
    seasons = sorted(int(season) for season in combined["season"].unique())
    births = _birth_dates(player_frame)
    represented = set()
    historical_since = seasons[-1] - historical_lookback if seasons else None

    for player in ranked_players:
        matched = _season_rows(combined, player)
        if matched.empty:
            continue
        record = _history_record(player, matched, births, ranked=True)
        players[history_key(player)] = record
        represented.add(history_key(record))

    # Stable IDs also keep same-name players and position changes together.
    combined["history_key"] = combined.apply(lambda row: history_key({
        "player": row["player_display_name"], "player_id": row["player_id"], "pos": row["position"],
    }), axis=1)
    for key, matched in combined.groupby("history_key", sort=True):
        if key in represented or matched["season"].max() < historical_since:
            continue
        latest = matched.sort_values("season", ascending=False).iloc[0]
        player = {"player": _text(latest["player_display_name"]), "player_id": latest["player_id"], "pos": latest["position"]}
        if not player["player"]:
            continue
        players[key] = _history_record(player, matched, births, ranked=False)

    ordered_seasons = seasons
    payload = {
        "generated_at": now.isoformat(),
        "seasons": ordered_seasons,
        "start_season": ordered_seasons[0] if ordered_seasons else None,
        "end_season": ordered_seasons[-1] if ordered_seasons else None,
        "season_count": len(ordered_seasons),
        "player_count": len(players),
        "ranked_player_count": sum(player["is_ranked"] for player in players.values()),
        "historical_player_count": sum(not player["is_ranked"] for player in players.values()),
        "historical_since_season": historical_since,
        "historical_lookback": historical_lookback,
        "historical_scope": "Players outside the current board with regular-season stats since the cutoff; last recorded season does not confirm retirement.",
        "player_season_count": sum(len(player["seasons"]) for player in players.values()),
        "source": "nflverse player stats and player identities",
        "attribution_url": "https://github.com/nflverse/nflverse-data",
        "columns": list(HISTORY_COLUMNS),
        "players": players,
    }
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    temporary.replace(destination)
    return destination


def _download_season(season: int, *, get: Callable = requests.get) -> pd.DataFrame:
    response = get(
        STATS_URL.format(season=season),
        headers={"User-Agent": "ProjectFootMoneyball/1.0"},
        timeout=180,
    )
    response.raise_for_status()
    return pd.read_csv(BytesIO(response.content), usecols=list(SOURCE_COLUMNS))


def _download_players(*, get: Callable = requests.get) -> pd.DataFrame:
    response = get(PLAYERS_URL, headers={"User-Agent": "OutlierBaseline/1.0"}, timeout=180)
    response.raise_for_status()
    return pd.read_csv(BytesIO(response.content), usecols=["gsis_id", "birth_date"])


def refresh_player_history(
    rankings_path: str | Path,
    destination: str | Path,
    *,
    start_season: int,
    end_season: int,
    historical_lookback: int = DEFAULT_HISTORICAL_LOOKBACK,
    status: Callable[[str], None] = print,
) -> Path:
    """Download a bounded season range and publish the browser history bundle."""
    if start_season > end_season:
        raise ValueError("start_season must be before or equal to end_season")
    if historical_lookback < 0:
        raise ValueError("historical_lookback must be non-negative")
    frames = []
    for season in range(start_season, end_season + 1):
        status(f"Loading {season} regular-season player stats...")
        frames.append(_download_season(season))
    status("Loading birth dates for current and historical NFL players...")
    player_frame = _download_players()
    result = build_player_history(
        rankings_path,
        destination,
        season_frames=frames,
        player_frame=player_frame,
        historical_lookback=historical_lookback,
    )
    status(f"[OK] Player history ready: {result}")
    return result
