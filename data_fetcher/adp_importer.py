"""Build normalized ADP data from live platform feeds or a saved comparison table."""

from __future__ import annotations

from datetime import datetime
from functools import reduce
import json
from pathlib import Path
import re
import unicodedata
from zoneinfo import ZoneInfo

import pandas as pd
import requests


SKILL_POSITIONS = {"QB", "RB", "WR", "TE"}
MIN_PROVIDER_ROWS = 100
MAX_PUBLISHED_PLAYERS = 350
SLEEPER_PROJECTIONS_URL = "https://api.sleeper.com/projections/nfl/{season}"
ESPN_PLAYERS_URL = (
    "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/"
    "{season}/segments/0/leaguedefaults/1?view=kona_player_info"
)

TEAM_CODES = {
    "ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE",
    "DAL", "DEN", "DET", "GB", "HOU", "IND", "JAX", "KC",
    "LAC", "LAR", "LV", "MIA", "MIN", "NE", "NO", "NYG",
    "NYJ", "PHI", "PIT", "SEA", "SF", "TB", "TEN", "WAS",
}
ESPN_POSITIONS = {1: "QB", 2: "RB", 3: "WR", 4: "TE"}
ESPN_TEAMS = {
    1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL",
    7: "DEN", 8: "DET", 9: "GB", 10: "TEN", 11: "IND", 12: "KC",
    13: "LV", 14: "LAR", 15: "MIA", 16: "MIN", 17: "NE", 18: "NO",
    19: "NYG", 20: "NYJ", 21: "PHI", 22: "ARI", 23: "PIT",
    24: "LAC", 25: "SF", 26: "SEA", 27: "TB", 28: "WAS",
    29: "CAR", 30: "JAX", 33: "BAL", 34: "HOU",
}
NAME_SUFFIXES = {"jr", "sr", "ii", "iii", "iv", "v"}


def _today() -> str:
    return datetime.now(ZoneInfo("America/New_York")).date().isoformat()


def _split_player_and_team(value):
    text = str(value).strip()
    team_pattern = "|".join(sorted(TEAM_CODES, key=len, reverse=True))
    match = re.match(rf"^(.*?)(?:({team_pattern}))$", text)
    if not match:
        return text, pd.NA
    return match.group(1).strip(), match.group(2)


def _player_key(name, position) -> str:
    """Return a provider-neutral identity key without collapsing same-name positions."""
    text = unicodedata.normalize("NFKD", str(name)).encode("ascii", "ignore").decode()
    tokens = re.sub(r"[^a-z0-9]+", " ", text.casefold()).split()
    while tokens and tokens[-1] in NAME_SUFFIXES:
        tokens.pop()
    return f"{' '.join(tokens)}|{str(position).strip().upper()}"


def _numeric_adp(value):
    number = pd.to_numeric(value, errors="coerce")
    if pd.isna(number) or number <= 0 or number >= 999:
        return pd.NA
    return float(number)


def parse_sleeper_adp(payload) -> pd.DataFrame:
    """Normalize Sleeper half-PPR ADP from its season projection response."""
    rows = []
    for record in payload if isinstance(payload, list) else []:
        player = record.get("player") or {}
        stats = record.get("stats") or {}
        position = str(player.get("position") or "").upper()
        adp = _numeric_adp(stats.get("adp_half_ppr"))
        if position not in SKILL_POSITIONS or pd.isna(adp) or adp > 400:
            continue
        name = " ".join(
            part for part in (player.get("first_name"), player.get("last_name")) if part
        ).strip()
        if not name:
            continue
        rows.append(
            {
                "Player": name,
                "Team": record.get("team") or player.get("team"),
                "Position": position,
                "Sleeper": adp,
                "Sleeper_ID": str(record.get("player_id") or ""),
            }
        )
    return pd.DataFrame(rows)


def parse_espn_adp(payload) -> pd.DataFrame:
    """Normalize ESPN PPR average draft position from its fantasy player response."""
    rows = []
    for record in payload.get("players", []) if isinstance(payload, dict) else []:
        player = record.get("player") or {}
        position = ESPN_POSITIONS.get(player.get("defaultPositionId"))
        ownership = player.get("ownership") or {}
        adp = _numeric_adp(ownership.get("averageDraftPosition"))
        ppr_rank = (
            (player.get("draftRanksByRankType") or {}).get("PPR") or {}
        ).get("rank")
        if position not in SKILL_POSITIONS or pd.isna(adp):
            continue
        # ESPN assigns near-end-of-draft ADPs to hundreds of effectively unranked
        # players. Its PPR rank keeps those placeholders out of the usable pool.
        if pd.isna(pd.to_numeric(ppr_rank, errors="coerce")) or float(ppr_rank) > 400:
            continue
        name = str(player.get("fullName") or "").strip()
        if not name:
            continue
        rows.append(
            {
                "Player": name,
                "Team": ESPN_TEAMS.get(player.get("proTeamId"), pd.NA),
                "Position": position,
                "NFL": adp,
                "ESPN_ID": str(player.get("id") or ""),
            }
        )
    return pd.DataFrame(rows)


def fetch_sleeper_adp(season: int, *, http_get=requests.get) -> pd.DataFrame:
    response = http_get(
        SLEEPER_PROJECTIONS_URL.format(season=season),
        params={"season_type": "regular", "order_by": "adp_half_ppr"},
        timeout=60,
    )
    response.raise_for_status()
    return parse_sleeper_adp(response.json())


def fetch_espn_adp(season: int, *, http_get=requests.get) -> pd.DataFrame:
    player_filter = {
        "players": {
            "limit": 2000,
            "sortPercOwned": {"sortPriority": 1, "sortAsc": False},
        }
    }
    response = http_get(
        ESPN_PLAYERS_URL.format(season=season),
        headers={"x-fantasy-filter": json.dumps(player_filter, separators=(",", ":"))},
        timeout=60,
    )
    response.raise_for_status()
    return parse_espn_adp(response.json())


def _validate_provider(frame: pd.DataFrame, column: str) -> pd.DataFrame:
    required = {"Player", "Team", "Position", column}
    missing = required.difference(frame.columns)
    if missing:
        raise ValueError(f"{column} response is missing: {', '.join(sorted(missing))}")
    result = frame.copy()
    result[column] = pd.to_numeric(result[column], errors="coerce")
    result["Position"] = result["Position"].astype(str).str.upper()
    result = result[
        result["Position"].isin(SKILL_POSITIONS)
        & result[column].between(1, 400, inclusive="both")
    ].copy()
    result["_key"] = [
        _player_key(name, position)
        for name, position in zip(result["Player"], result["Position"])
    ]
    result = result.sort_values(column).drop_duplicates("_key", keep="first")
    if len(result) < MIN_PROVIDER_ROWS:
        raise ValueError(
            f"{column} returned only {len(result)} usable players; refusing to replace good data."
        )
    return result


def _cached_provider(path: Path, column: str) -> tuple[pd.DataFrame | None, str | None]:
    if not path.exists():
        return None, None
    cached = pd.read_csv(path)
    if not {"Player", "Position", column}.issubset(cached.columns):
        return None, None
    if "Team" not in cached.columns:
        cached["Team"] = pd.NA
    cached[column] = pd.to_numeric(cached[column], errors="coerce")
    cached = cached[cached[column].notna()].copy()
    cached["_key"] = [
        _player_key(name, position)
        for name, position in zip(cached["Player"], cached["Position"])
    ]
    cached = cached.sort_values(column).drop_duplicates("_key", keep="first")
    date_column = f"{column}_Updated"
    if date_column in cached.columns:
        dates = cached[date_column].dropna().astype(str)
    elif "Source_Updated" in cached.columns:
        dates = cached["Source_Updated"].dropna().astype(str)
    else:
        dates = pd.Series(dtype=str)
    return cached, (dates.max() if not dates.empty else None)


def _provider_for_merge(frame: pd.DataFrame, column: str) -> pd.DataFrame:
    keep = ["_key", "Player", "Team", "Position", column]
    result = frame.loc[:, keep].copy()
    return result.rename(
        columns={
            "Player": f"Player_{column}",
            "Team": f"Team_{column}",
            "Position": f"Position_{column}",
        }
    )


def _coalesce(merged: pd.DataFrame, field: str, providers: tuple[str, ...]) -> pd.Series:
    columns = [f"{field}_{provider}" for provider in providers if f"{field}_{provider}" in merged]
    if not columns:
        return pd.Series(pd.NA, index=merged.index)
    return merged[columns].bfill(axis=1).iloc[:, 0]


def build_direct_adp(
    output_path,
    *,
    season: int,
    http_get=requests.get,
    update_date: str | None = None,
) -> pd.DataFrame:
    """Refresh direct Sleeper/ESPN ADP and retain the last authorized Yahoo snapshot."""
    output_path = Path(output_path)
    update_date = update_date or _today()
    providers: dict[str, pd.DataFrame] = {}
    source_dates: dict[str, str | None] = {}
    errors: list[str] = []

    yahoo, yahoo_date = _cached_provider(output_path, "Yahoo")
    if yahoo is not None:
        providers["Yahoo"] = yahoo
        source_dates["Yahoo"] = yahoo_date

    for column, fetcher in (("Sleeper", fetch_sleeper_adp), ("NFL", fetch_espn_adp)):
        try:
            providers[column] = _validate_provider(fetcher(season, http_get=http_get), column)
            source_dates[column] = update_date
        except (requests.RequestException, ValueError, TypeError, KeyError) as exc:
            cached, cached_date = _cached_provider(output_path, column)
            if cached is None:
                raise RuntimeError(f"{column} ADP failed and no saved snapshot exists: {exc}") from exc
            providers[column] = cached
            source_dates[column] = cached_date
            errors.append(f"{column}: {exc}")

    if not providers:
        raise FileNotFoundError("No direct or saved ADP source is available.")

    merged_frames = [_provider_for_merge(frame, column) for column, frame in providers.items()]
    merged = reduce(lambda left, right: left.merge(right, on="_key", how="outer"), merged_frames)
    output = pd.DataFrame(
        {
            "Player": _coalesce(merged, "Player", ("Sleeper", "NFL", "Yahoo")),
            "Team": _coalesce(merged, "Team", ("Sleeper", "NFL", "Yahoo")),
            "Position": _coalesce(merged, "Position", ("Sleeper", "NFL", "Yahoo")),
        }
    )
    for column in ("Yahoo", "Sleeper", "NFL"):
        output[column] = pd.to_numeric(merged.get(column), errors="coerce")
    output["ADP"] = output[["Yahoo", "Sleeper", "NFL"]].mean(axis=1)
    output = (
        output[
            output["ADP"].notna()
            & output["Position"].astype(str).str.upper().isin(SKILL_POSITIONS)
        ]
        .sort_values(["ADP", "Player"], kind="stable")
        .head(MAX_PUBLISHED_PLAYERS)
        .reset_index(drop=True)
    )
    output["NFL_Source"] = "ESPN (official fantasy game of NFL)"
    output["Source_Updated"] = update_date
    for column in ("Yahoo", "Sleeper", "NFL"):
        output[f"{column}_Updated"] = source_dates.get(column)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = output_path.with_suffix(output_path.suffix + ".tmp")
    output.to_csv(temporary, index=False)
    temporary.replace(output_path)
    if errors:
        print("[WARN] Used last-good provider data for " + "; ".join(errors))
    counts = ", ".join(
        f"{column} {int(output[column].notna().sum())}" for column in ("Yahoo", "Sleeper", "NFL")
    )
    print(f"[OK] Saved {len(output)} combined ADP rows to {output_path} ({counts})")
    return output


def adp_source_dates(path) -> dict[str, str]:
    """Read provider freshness dates for website metadata."""
    path = Path(path)
    if not path.exists():
        return {}
    frame = pd.read_csv(path, nrows=MAX_PUBLISHED_PLAYERS)
    result: dict[str, str] = {}
    for column in ("Yahoo", "Sleeper", "NFL"):
        date_column = f"{column}_Updated"
        if date_column in frame.columns:
            values = frame[date_column].dropna().astype(str)
        elif "Source_Updated" in frame.columns:
            values = frame["Source_Updated"].dropna().astype(str)
        else:
            values = pd.Series(dtype=str)
        if not values.empty:
            result[column] = values.max()
    return result


def latest_adp_date(path, fallback: str | None = None) -> str | None:
    dates = adp_source_dates(path).values()
    return max(dates, default=fallback)


def build_combined_adp(source, output_path, *, update_date: str | None = None):
    """Create a normalized snapshot from the legacy multi-platform HTML table."""
    table = pd.read_html(source)[0]
    player_team = table["Player"].apply(_split_player_and_team)
    update_date = update_date or _today()

    output = pd.DataFrame(
        {
            "Player": player_team.str[0],
            "Team": player_team.str[1],
            "Position": table["Pos"],
            "Yahoo": pd.to_numeric(table["Yahoo 1QB Half-PPRSame market"], errors="coerce"),
            "Sleeper": pd.to_numeric(table["Sleeper Half-PPRPrimary market"], errors="coerce"),
            "NFL": pd.to_numeric(table["ESPN 1QB PPRQueue reference"], errors="coerce"),
        }
    )
    output["ADP"] = output[["Yahoo", "Sleeper", "NFL"]].mean(axis=1)
    output["NFL_Source"] = "ESPN (official fantasy game of NFL)"
    output["Source_Updated"] = update_date
    for column in ("Yahoo", "Sleeper", "NFL"):
        output[f"{column}_Updated"] = update_date

    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output.to_csv(output_path, index=False)
    print(f"[OK] Saved {len(output)} combined ADP rows to {output_path}")
    return output


if __name__ == "__main__":
    from config import ADP_DIR, ADP_FILENAME, PROJECTION_SEASON

    build_direct_adp(ADP_DIR / ADP_FILENAME, season=PROJECTION_SEASON)
