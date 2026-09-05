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
SPECIAL_TEAM_POSITIONS = {"K", "DST"}
MIN_PROVIDER_ROWS = 100
MAX_PUBLISHED_PLAYERS = 350
SLEEPER_PROJECTIONS_URL = "https://api.sleeper.com/projections/nfl/{season}"
ESPN_PLAYERS_URL = (
    "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/"
    "{season}/segments/0/leaguedefaults/1?view=kona_player_info"
)
MFL_EXPORT_URL = "https://api.myfantasyleague.com/{season}/export"
ADP_PROVIDERS = ("Yahoo", "Sleeper", "NFL", "MFL")

TEAM_CODES = {
    "ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE",
    "DAL", "DEN", "DET", "GB", "HOU", "IND", "JAX", "KC",
    "LAC", "LAR", "LV", "MIA", "MIN", "NE", "NO", "NYG",
    "NYJ", "PHI", "PIT", "SEA", "SF", "TB", "TEN", "WAS",
}
ESPN_POSITIONS = {1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "DST"}
ESPN_TEAMS = {
    1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL",
    7: "DEN", 8: "DET", 9: "GB", 10: "TEN", 11: "IND", 12: "KC",
    13: "LV", 14: "LAR", 15: "MIA", 16: "MIN", 17: "NE", 18: "NO",
    19: "NYG", 20: "NYJ", 21: "PHI", 22: "ARI", 23: "PIT",
    24: "LAC", 25: "SF", 26: "SEA", 27: "TB", 28: "WAS",
    29: "CAR", 30: "JAX", 33: "BAL", 34: "HOU",
}
NAME_SUFFIXES = {"jr", "sr", "ii", "iii", "iv", "v"}
TEAM_ALIASES = {
    "JAC": "JAX", "GBP": "GB", "KCC": "KC", "NEP": "NE",
    "NOS": "NO", "SFO": "SF", "TBB": "TB", "LVR": "LV",
}


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


def _normalized_team(value):
    if value is None or pd.isna(value):
        return pd.NA
    team = str(value).strip().upper()
    return TEAM_ALIASES.get(team, team) or pd.NA


def _canonical_position(value) -> str:
    position = str(value or "").strip().upper()
    return {"DEF": "DST", "D/ST": "DST", "PK": "K"}.get(position, position)


def _adp_metrics(frame: pd.DataFrame) -> pd.DataFrame:
    """Recalculate the consensus and expose how much evidence supports it."""
    result = frame.copy()
    available = [column for column in ADP_PROVIDERS if column in result.columns]
    for column in available:
        result[column] = pd.to_numeric(result[column], errors="coerce")
    if not available:
        result["ADP"] = pd.NA
        result["Source_Count"] = 0
        result["ADP_Spread"] = pd.NA
        result["ADP_StdDev"] = pd.NA
        return result
    values = result[available]
    result["ADP"] = values.mean(axis=1)
    result["Source_Count"] = values.notna().sum(axis=1)
    result["ADP_Spread"] = values.max(axis=1) - values.min(axis=1)
    result["ADP_StdDev"] = values.std(axis=1, ddof=1)
    result.loc[result["Source_Count"] < 2, "ADP_Spread"] = pd.NA
    result.loc[result["Source_Count"] < 2, "ADP_StdDev"] = pd.NA
    return result


def _normalized_header(value) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value).strip().casefold())


def _find_snapshot_column(columns, aliases, *, startswith=()):
    normalized = {column: _normalized_header(column) for column in columns}
    for column, key in normalized.items():
        if key in aliases or any(key.startswith(prefix) for prefix in startswith):
            return column
    return None


def update_yahoo_snapshot(
    source,
    output_path,
    *,
    update_date: str | None = None,
    minimum_rows: int = MIN_PROVIDER_ROWS,
) -> pd.DataFrame:
    """Replace Yahoo ADP with a user-supplied CSV snapshot.

    The file must contain Player/Name, Position/Pos, and Yahoo/Y! columns. The
    existing direct-provider values remain intact, and Yahoo-only players are
    appended before the normal top-player cap is applied.
    """
    update_date = update_date or _today()
    snapshot = pd.read_csv(source, sep=None, engine="python", encoding="utf-8-sig")
    player_column = _find_snapshot_column(
        snapshot.columns, {"player", "playername", "name", "fullname"}
    )
    position_column = _find_snapshot_column(snapshot.columns, {"position", "pos"})
    team_column = _find_snapshot_column(snapshot.columns, {"team", "nflteam", "proteam"})
    yahoo_column = _find_snapshot_column(
        snapshot.columns,
        {"y", "yahoo", "yahooadp"},
        startswith=("yahoo",),
    )
    missing = [
        label
        for label, column in (
            ("Player or Name", player_column),
            ("Position or Pos", position_column),
            ("Yahoo or Y!", yahoo_column),
        )
        if column is None
    ]
    if missing:
        raise ValueError("Yahoo snapshot is missing: " + ", ".join(missing))

    provider = pd.DataFrame(
        {
            "Player": snapshot[player_column].astype(str).str.strip(),
            "Team": (
                snapshot[team_column].astype(str).str.strip().str.upper()
                if team_column is not None
                else pd.Series(pd.NA, index=snapshot.index)
            ),
            "Position": (
                snapshot[position_column]
                .astype(str)
                .str.upper()
                .str.extract(r"(?:^|[^A-Z])(QB|RB|WR|TE)(?:[^A-Z]|$)", expand=False)
            ),
            "Yahoo": pd.to_numeric(snapshot[yahoo_column], errors="coerce"),
        }
    )
    provider = provider[
        provider["Player"].ne("")
        & provider["Position"].isin(SKILL_POSITIONS)
        & provider["Yahoo"].between(1, 400, inclusive="both")
    ].copy()
    provider["_key"] = [
        _player_key(name, position)
        for name, position in zip(provider["Player"], provider["Position"])
    ]
    provider = provider.sort_values("Yahoo").drop_duplicates("_key", keep="first")
    if len(provider) < minimum_rows:
        raise ValueError(
            f"Yahoo snapshot contains only {len(provider)} usable players; "
            f"at least {minimum_rows} are required."
        )

    output_path = Path(output_path)
    if not output_path.exists():
        raise FileNotFoundError(f"The combined ADP file does not exist: {output_path}")
    output = pd.read_csv(output_path)
    required = {"Player", "Team", "Position", "Sleeper", "NFL"}
    missing_output = required.difference(output.columns)
    if missing_output:
        raise ValueError(
            "Combined ADP file is missing: " + ", ".join(sorted(missing_output))
        )
    output["_key"] = [
        _player_key(name, position)
        for name, position in zip(output["Player"], output["Position"])
    ]
    yahoo_values = provider.set_index("_key")["Yahoo"]
    output["Yahoo"] = output["_key"].map(yahoo_values)

    new_provider_rows = provider[~provider["_key"].isin(output["_key"])].copy()
    if not new_provider_rows.empty:
        additions = pd.DataFrame(index=new_provider_rows.index, columns=output.columns)
        for column in ("_key", "Player", "Team", "Position", "Yahoo"):
            additions[column] = new_provider_rows[column]
        output = pd.concat([output, additions], ignore_index=True)

    output = _adp_metrics(output)
    output = output.drop(columns=["FFC", "FFC_Source", "FFC_Updated"], errors="ignore")
    output["Yahoo_Updated"] = update_date
    output["Source_Updated"] = update_date
    if "NFL_Source" not in output.columns:
        output["NFL_Source"] = "ESPN fantasy football PPR"
    output = (
        output[
            output["ADP"].notna()
            & output["Position"].astype(str).str.upper().isin(SKILL_POSITIONS)
        ]
        .sort_values(["ADP", "Player"], kind="stable")
        .head(MAX_PUBLISHED_PLAYERS)
        .reset_index(drop=True)
    )
    output = output.drop(columns="_key", errors="ignore")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = output_path.with_suffix(output_path.suffix + ".tmp")
    output.to_csv(temporary, index=False)
    temporary.replace(output_path)
    print(
        f"[OK] Updated Yahoo ADP from {source}: "
        f"{int(output['Yahoo'].notna().sum())} matched players ({update_date})"
    )
    return output


def parse_sleeper_adp(payload, *, positions=SKILL_POSITIONS) -> pd.DataFrame:
    """Normalize Sleeper half-PPR ADP from its season projection response."""
    rows = []
    for record in payload if isinstance(payload, list) else []:
        player = record.get("player") or {}
        stats = record.get("stats") or {}
        position = _canonical_position(player.get("position"))
        adp = _numeric_adp(stats.get("adp_half_ppr"))
        if position not in positions or pd.isna(adp) or adp > 400:
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


def parse_espn_adp(payload, *, positions=SKILL_POSITIONS) -> pd.DataFrame:
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
        if position not in positions or pd.isna(adp):
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


def _mfl_display_name(value) -> str:
    name = str(value or "").strip()
    if "," not in name:
        return name
    last, first = (part.strip() for part in name.split(",", 1))
    return " ".join(part for part in (first, last) if part)


def parse_mfl_adp(adp_payload, players_payload, *, positions=SKILL_POSITIONS) -> pd.DataFrame:
    """Normalize recent 12-team PPR redraft ADP from MyFantasyLeague."""
    player_records = (
        players_payload.get("players", {}).get("player", [])
        if isinstance(players_payload, dict)
        else []
    )
    players = {str(player.get("id") or ""): player for player in player_records}
    adp_records = (
        adp_payload.get("adp", {}).get("player", [])
        if isinstance(adp_payload, dict)
        else []
    )
    rows = []
    for record in adp_records:
        player_id = str(record.get("id") or "")
        player = players.get(player_id, {})
        position = _canonical_position(player.get("position"))
        adp = _numeric_adp(record.get("averagePick"))
        name = _mfl_display_name(player.get("name"))
        if position not in positions or pd.isna(adp) or not name:
            continue
        rows.append(
            {
                "Player": name,
                "Team": _normalized_team(player.get("team")),
                "Position": position,
                "MFL": adp,
                "MFL_ID": player_id,
            }
        )
    return pd.DataFrame(rows)


def fetch_sleeper_adp(
    season: int, *, http_get=requests.get, positions=SKILL_POSITIONS
) -> pd.DataFrame:
    response = http_get(
        SLEEPER_PROJECTIONS_URL.format(season=season),
        params={"season_type": "regular", "order_by": "adp_half_ppr"},
        timeout=60,
    )
    response.raise_for_status()
    return parse_sleeper_adp(response.json(), positions=positions)


def fetch_espn_adp(
    season: int, *, http_get=requests.get, positions=SKILL_POSITIONS
) -> pd.DataFrame:
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
    return parse_espn_adp(response.json(), positions=positions)


def fetch_mfl_adp(
    season: int, *, http_get=requests.get, positions=SKILL_POSITIONS
) -> pd.DataFrame:
    common = {"JSON": 1}
    adp_response = http_get(
        MFL_EXPORT_URL.format(season=season),
        params={
            **common,
            "TYPE": "adp",
            "PERIOD": "RECENT",
            "FCOUNT": 12,
            "IS_PPR": 1,
            "IS_KEEPER": "N",
            "IS_MOCK": -1,
            "CUTOFF": 5,
        },
        timeout=60,
    )
    adp_response.raise_for_status()
    players_response = http_get(
        MFL_EXPORT_URL.format(season=season),
        params={**common, "TYPE": "players"},
        timeout=60,
    )
    players_response.raise_for_status()
    return parse_mfl_adp(
        adp_response.json(), players_response.json(), positions=positions
    )


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
    """Refresh independent ADP feeds and retain the last authorized Yahoo snapshot."""
    output_path = Path(output_path)
    update_date = update_date or _today()
    providers: dict[str, pd.DataFrame] = {}
    source_dates: dict[str, str | None] = {}
    errors: list[str] = []

    yahoo, yahoo_date = _cached_provider(output_path, "Yahoo")
    if yahoo is not None:
        providers["Yahoo"] = yahoo
        source_dates["Yahoo"] = yahoo_date

    source_specs = (
        ("Sleeper", fetch_sleeper_adp, True),
        ("NFL", fetch_espn_adp, True),
        ("MFL", fetch_mfl_adp, False),
    )
    for column, fetcher, required in source_specs:
        try:
            providers[column] = _validate_provider(fetcher(season, http_get=http_get), column)
            source_dates[column] = update_date
        except (requests.RequestException, ValueError, TypeError, KeyError) as exc:
            cached, cached_date = _cached_provider(output_path, column)
            if cached is None:
                if required:
                    raise RuntimeError(
                        f"{column} ADP failed and no saved snapshot exists: {exc}"
                    ) from exc
                errors.append(f"{column} skipped: {exc}")
                continue
            providers[column] = cached
            source_dates[column] = cached_date
            errors.append(f"{column}: {exc}")

    if not providers:
        raise FileNotFoundError("No direct or saved ADP source is available.")

    merged_frames = [_provider_for_merge(frame, column) for column, frame in providers.items()]
    merged = reduce(lambda left, right: left.merge(right, on="_key", how="outer"), merged_frames)
    output = pd.DataFrame(
        {
            "Player": _coalesce(merged, "Player", ("Sleeper", "NFL", "MFL", "Yahoo")),
            "Team": _coalesce(merged, "Team", ("Sleeper", "NFL", "MFL", "Yahoo")),
            "Position": _coalesce(merged, "Position", ("Sleeper", "NFL", "MFL", "Yahoo")),
        }
    )
    for column in ADP_PROVIDERS:
        output[column] = (
            pd.to_numeric(merged[column], errors="coerce")
            if column in merged
            else pd.Series(pd.NA, index=merged.index, dtype="Float64")
        )
    output = _adp_metrics(output)
    output = (
        output[
            output["ADP"].notna()
            & output["Position"].astype(str).str.upper().isin(SKILL_POSITIONS)
        ]
        .sort_values(["ADP", "Player"], kind="stable")
        .head(MAX_PUBLISHED_PLAYERS)
        .reset_index(drop=True)
    )
    output["NFL_Source"] = "ESPN fantasy football PPR"
    output["MFL_Source"] = "MyFantasyLeague recent PPR, 12-team redraft"
    output["Source_Updated"] = update_date
    for column in ADP_PROVIDERS:
        output[f"{column}_Updated"] = source_dates.get(column)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = output_path.with_suffix(output_path.suffix + ".tmp")
    output.to_csv(temporary, index=False)
    temporary.replace(output_path)
    if errors:
        print("[WARN] Used last-good provider data for " + "; ".join(errors))
    counts = ", ".join(
        f"{column} {int(output[column].notna().sum())}" for column in ADP_PROVIDERS
    )
    print(f"[OK] Saved {len(output)} combined ADP rows to {output_path} ({counts})")
    return output


def _special_provider_for_merge(frame: pd.DataFrame, column: str) -> pd.DataFrame:
    result = frame.copy()
    result["Position"] = result["Position"].map(_canonical_position)
    result["Team"] = result["Team"].map(_normalized_team)
    result[column] = pd.to_numeric(result[column], errors="coerce")
    result = result[
        result["Position"].isin(SPECIAL_TEAM_POSITIONS)
        & result[column].between(1, 400, inclusive="both")
    ].copy()
    result["_key"] = [
        f"dst|{team}" if position == "DST" and not pd.isna(team)
        else _player_key(name, position)
        for name, team, position in zip(
            result["Player"], result["Team"], result["Position"]
        )
    ]
    result = result.sort_values(column).drop_duplicates("_key", keep="first")
    if len(result) < 20:
        raise ValueError(
            f"{column} returned only {len(result)} usable kicker/defense rows."
        )
    return _provider_for_merge(result, column)


def build_special_teams_adp(
    output_path,
    *,
    season: int,
    http_get=requests.get,
    update_date: str | None = None,
) -> pd.DataFrame:
    """Build a transparent K/DST market board without inventing projections."""
    output_path = Path(output_path)
    update_date = update_date or _today()
    frames = []
    errors = []
    for column, fetcher in (
        ("Sleeper", fetch_sleeper_adp),
        ("NFL", fetch_espn_adp),
        ("MFL", fetch_mfl_adp),
    ):
        try:
            provider = fetcher(
                season,
                http_get=http_get,
                positions=SPECIAL_TEAM_POSITIONS,
            )
            frames.append(_special_provider_for_merge(provider, column))
        except (requests.RequestException, ValueError, TypeError, KeyError) as exc:
            errors.append(f"{column}: {exc}")

    if len(frames) < 2:
        detail = "; ".join(errors) or "fewer than two sources returned data"
        raise RuntimeError(f"K/DST market refresh needs two usable sources: {detail}")

    merged = reduce(lambda left, right: left.merge(right, on="_key", how="outer"), frames)
    provider_order = ("Sleeper", "NFL", "MFL")
    output = pd.DataFrame(
        {
            "Player": _coalesce(merged, "Player", provider_order),
            "Team": _coalesce(merged, "Team", provider_order),
            "Position": _coalesce(merged, "Position", provider_order),
        }
    )
    for column in provider_order:
        output[column] = (
            pd.to_numeric(merged[column], errors="coerce")
            if column in merged
            else pd.Series(pd.NA, index=merged.index, dtype="Float64")
        )
    output = _adp_metrics(output)
    output = output[output["ADP"].notna()].copy()
    output["Position_Rank"] = (
        output.groupby("Position")["ADP"].rank(method="first").astype(int)
    )
    output["Position_Rank"] = (
        output["Position"] + output["Position_Rank"].astype(str)
    )
    output = output.sort_values(["Position", "ADP", "Player"], kind="stable")
    output["Source_Updated"] = update_date
    for column in provider_order:
        output[f"{column}_Updated"] = update_date if column in merged else pd.NA

    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = output_path.with_suffix(output_path.suffix + ".tmp")
    output.to_csv(temporary, index=False)
    temporary.replace(output_path)
    if errors:
        print("[WARN] K/DST sources skipped: " + "; ".join(errors))
    print(f"[OK] Saved {len(output)} K/DST market rows to {output_path}")
    return output


def adp_source_dates(path) -> dict[str, str]:
    """Read provider freshness dates for website metadata."""
    path = Path(path)
    if not path.exists():
        return {}
    frame = pd.read_csv(path, nrows=MAX_PUBLISHED_PLAYERS)
    result: dict[str, str] = {}
    for column in ADP_PROVIDERS:
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
    output = _adp_metrics(output)
    output["NFL_Source"] = "ESPN fantasy football PPR"
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
