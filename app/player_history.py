"""Publish compact year-by-year nflverse stats for ranked players."""

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
HISTORY_COLUMNS = (
    "season",
    "team",
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
SOURCE_COLUMNS = (
    "player_id",
    "player_display_name",
    "position",
    "season",
    "season_type",
    "recent_team",
    *HISTORY_COLUMNS[2:],
)


def history_key(player: dict) -> str:
    """Return the same stable history identifier used by the browser."""
    player_id = str(player.get("player_id") or "").strip()
    if player_id and player_id.casefold() not in {"-", "nan", "none"}:
        return f"id:{player_id}"
    return f"name:{normalize_name(player.get('player', ''))}|{str(player.get('pos') or '').upper()}"


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
    """Match one ranked player by NFL ID, with name plus position as fallback."""
    if frame.empty:
        return frame.copy()
    regular = frame
    if "season_type" in regular.columns:
        regular = regular[regular["season_type"].eq("REG")]
    player_id = str(player.get("player_id") or "").strip()
    if player_id and player_id.casefold() not in {"-", "nan", "none"}:
        matches = regular[regular["player_id"].fillna("").astype(str).eq(player_id)]
        if not matches.empty:
            return matches.copy()
    names = regular["player_display_name"].fillna("").map(normalize_name)
    positions = regular["position"].fillna("").astype(str).str.upper()
    accepted = {"RB", "HB", "FB"} if str(player.get("pos") or "").upper() == "RB" else {
        str(player.get("pos") or "").upper()
    }
    return regular[(names == normalize_name(player.get("player", ""))) & positions.isin(accepted)].copy()


def build_player_history(
    rankings_path: str | Path,
    destination: str | Path,
    *,
    season_frames: Iterable[pd.DataFrame],
    now: datetime | None = None,
) -> Path:
    """Write compact regular-season history for every player on the draft board."""
    now = now or datetime.now(timezone.utc)
    frames = [frame.copy() for frame in season_frames]
    ranked_players = load_ranked_players(rankings_path, DEFAULT_BOARD)
    players = {}
    seasons = set()

    for player in ranked_players:
        matched = pd.concat(
            [_season_rows(frame, player) for frame in frames],
            ignore_index=True,
        ) if frames else pd.DataFrame()
        if matched.empty:
            continue
        matched["season"] = pd.to_numeric(matched["season"], errors="coerce")
        matched = matched.dropna(subset=["season"]).sort_values("season", ascending=False)
        rows = []
        for row in matched.drop_duplicates(subset=["season"], keep="last").itertuples(index=False):
            values = row._asdict()
            season = int(values["season"])
            seasons.add(season)
            rows.append([
                season,
                _team(values.get("recent_team")),
                *[_number(values.get(column)) for column in HISTORY_COLUMNS[2:]],
            ])
        players[history_key(player)] = {
            "player": player["player"],
            "player_id": player.get("player_id") or None,
            "pos": player["pos"],
            "seasons": rows,
        }

    payload = {
        "generated_at": now.isoformat(),
        "seasons": sorted(seasons),
        "player_count": len(players),
        "source": "nflverse player stats",
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


def refresh_player_history(
    rankings_path: str | Path,
    destination: str | Path,
    *,
    start_season: int,
    end_season: int,
    status: Callable[[str], None] = print,
) -> Path:
    """Download a bounded season range and publish the browser history bundle."""
    if start_season > end_season:
        raise ValueError("start_season must be before or equal to end_season")
    frames = []
    for season in range(start_season, end_season + 1):
        status(f"Loading {season} regular-season player stats...")
        frames.append(_download_season(season))
    result = build_player_history(
        rankings_path,
        destination,
        season_frames=frames,
    )
    status(f"[OK] Player history ready: {result}")
    return result
