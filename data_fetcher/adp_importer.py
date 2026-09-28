"""Build normalized ADP data from live platform feeds or a saved comparison table."""

from __future__ import annotations

from datetime import datetime, timezone
from functools import reduce
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
MFL_EXPORT_URL = "https://api.myfantasyleague.com/{season}/export"
MFL_SOURCE_LABELS = {
    "RECENT": "MyFantasyLeague recent PPR, 12-team redraft",
    "ALL": "MyFantasyLeague season aggregate PPR, 12-team redraft",
    "UNKNOWN": "MyFantasyLeague PPR, 12-team redraft (sampling window unknown)",
}
ADP_PROVIDERS = ("Yahoo", "Sleeper", "MFL")


class ProviderDataUnavailable(ValueError):
    """An explained empty provider response, safe to expose without request details."""

    def __init__(self, reason_code, message):
        super().__init__(message)
        self.reason_code = reason_code


def _failure_health(error, cached, cached_date, attempted_at):
    empty_recent = isinstance(error, ProviderDataUnavailable) and error.reason_code == "no_recent_drafts"
    reason = "MFL reports no recent qualifying drafts." if empty_recent else "Provider unavailable or invalid."
    return {
        "status": "cached" if cached is not None else "failed",
        "freshness": "stale" if cached is not None else "unavailable",
        "attempted_at": attempted_at, "last_success": cached_date, "data_updated_at": cached_date,
        "timestamp_kind": "snapshot", "row_count": len(cached) if cached is not None else 0,
        "reason_code": "no_recent_drafts" if empty_recent else "provider_unavailable",
        "note": reason + (" Saved snapshot retained with its original capture date." if cached is not None else " No saved snapshot is available."),
    }


def _mfl_provenance(frame):
    """Recover the sampled window independently of when the CSV was captured."""
    if frame is None:
        return {}
    metadata = frame.attrs.get("mfl_provenance", {})
    period = metadata.get("actual_period")
    if period not in MFL_SOURCE_LABELS:
        values = frame.get("MFL_Period", pd.Series(dtype=str)).dropna().astype(str).unique()
        period = values[0] if len(values) == 1 and values[0] in MFL_SOURCE_LABELS else "UNKNOWN"
        if "MFL_Period" not in frame.columns:
            labels = frame.get("MFL_Source", pd.Series(dtype=str)).dropna().astype(str).unique()
            if len(labels) == 1:
                period = next((key for key, label in MFL_SOURCE_LABELS.items() if label == labels[0]), "UNKNOWN")
    return {"actual_period": period, "sample_basis": {
        "RECENT": "recent_drafts", "ALL": "season_aggregate", "UNKNOWN": "unknown",
    }[period]}


def saved_mfl_provenance(path):
    """Return non-secret CSV provenance for manual/skip-refresh exports."""
    frame, _ = _cached_provider(Path(path), "MFL")
    return _mfl_provenance(frame)


def _describe_mfl_health(health, frame, *, fetched=False):
    health.update(_mfl_provenance(frame))
    period = health.get("actual_period")
    if fetched:
        health["requested_period"] = "RECENT"
    if period == "ALL":
        if fetched:
            health.update(status="fallback", freshness="season_aggregate", reason_code="no_recent_drafts")
            health["note"] = "No recent qualifying MFL drafts; downloaded and validated the broader season aggregate. "
        else:
            health["note"] += " Saved MFL values use the broader season aggregate. "
        health["note"] += "This is not recent-draft ADP; the date is its capture, not provider publication."
    elif period == "UNKNOWN":
        health["note"] += " The saved MFL sampling window is unknown."


def _write_mfl_provenance(output, health):
    period = health.get("actual_period", "UNKNOWN")
    output["MFL_Period"] = period
    output["MFL_Source"] = MFL_SOURCE_LABELS.get(period, MFL_SOURCE_LABELS["UNKNOWN"])


TEAM_CODES = {
    "ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE",
    "DAL", "DEN", "DET", "GB", "HOU", "IND", "JAX", "KC",
    "LAC", "LAR", "LV", "MIA", "MIN", "NE", "NO", "NYG",
    "NYJ", "PHI", "PIT", "SEA", "SF", "TB", "TEN", "WAS",
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
    required = {"Player", "Team", "Position"}
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
    output = output.drop(columns=["NFL", "NFL_Source", "NFL_Updated"], errors="ignore")
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


def _mfl_display_name(value) -> str:
    name = str(value or "").strip()
    if "," not in name:
        return name
    last, first = (part.strip() for part in name.split(",", 1))
    return " ".join(part for part in (first, last) if part)


def parse_mfl_adp(adp_payload, players_payload, *, positions=SKILL_POSITIONS) -> pd.DataFrame:
    """Normalize 12-team PPR redraft ADP; the fetcher records its sample window."""
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


def fetch_mfl_adp(
    season: int, *, http_get=requests.get, positions=SKILL_POSITIONS
) -> pd.DataFrame:
    common = {"JSON": 1}

    def fetch_window(period):
        response = http_get(
            MFL_EXPORT_URL.format(season=season),
            params={
                **common,
                "TYPE": "adp",
                "PERIOD": period,
                "FCOUNT": 12,
                "IS_PPR": 1,
                "IS_KEEPER": "N",
                "IS_MOCK": -1,
                "CUTOFF": 5,
            },
            timeout=60,
        )
        response.raise_for_status()
        payload = response.json()
        adp = payload.get("adp") if isinstance(payload, dict) else None
        if not isinstance(adp, dict):
            raise ValueError("MFL ADP response is invalid.")
        records = adp.get("player", [])
        if not isinstance(records, list) or any(not isinstance(record, dict) for record in records):
            raise ValueError("MFL ADP player records are invalid.")
        return payload, adp

    period = "RECENT"
    adp_payload, adp = fetch_window(period)
    # A genuine empty recent window may use a clearly labeled broader sample.
    # Transport errors, invalid payloads, and thin samples never trigger this.
    if not adp.get("player") and str(adp.get("totalDrafts")) == "0":
        period = "ALL"
        adp_payload, adp = fetch_window(period)
        if not adp.get("player") and str(adp.get("totalDrafts")) == "0":
            raise ProviderDataUnavailable("no_recent_drafts", "MFL reports no qualifying drafts in either window.")
    players_response = http_get(
        MFL_EXPORT_URL.format(season=season),
        params={**common, "TYPE": "players"},
        timeout=60,
    )
    players_response.raise_for_status()
    frame = parse_mfl_adp(
        adp_payload, players_response.json(), positions=positions
    )
    frame.attrs["mfl_provenance"] = {"actual_period": period}
    return frame


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
    if cached.empty:
        return None, None
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
    attempted_at = datetime.now(timezone.utc).isoformat()
    health = {}

    yahoo, yahoo_date = _cached_provider(output_path, "Yahoo")
    if yahoo is not None:
        providers["Yahoo"] = yahoo
        source_dates["Yahoo"] = yahoo_date
    health["Yahoo"] = {
        "status": "manual", "freshness": "manual", "attempted_at": None,
        "last_success": yahoo_date, "data_updated_at": yahoo_date,
        "timestamp_kind": "snapshot",
        "note": "User-supplied Yahoo snapshot; date records its import, not provider publication. No scheduled provider fetch.",
        "row_count": len(yahoo) if yahoo is not None else 0,
    }

    source_specs = (
        ("Sleeper", fetch_sleeper_adp, True),
        ("MFL", fetch_mfl_adp, False),
    )
    for column, fetcher, required in source_specs:
        try:
            providers[column] = _validate_provider(fetcher(season, http_get=http_get), column)
            source_dates[column] = update_date
            health[column] = {
                "status": "success", "freshness": "current", "attempted_at": attempted_at,
                "last_success": attempted_at, "data_updated_at": update_date,
                "timestamp_kind": "snapshot",
                "row_count": len(providers[column]), "note": "Downloaded and validated on the snapshot date; provider publication time is not supplied.",
            }
            if column == "MFL":
                _describe_mfl_health(health[column], providers[column], fetched=True)
        except (requests.RequestException, ValueError, TypeError, KeyError) as exc:
            cached, cached_date = _cached_provider(output_path, column)
            health[column] = _failure_health(exc, cached, cached_date, attempted_at)
            if column == "MFL":
                _describe_mfl_health(health[column], cached)
            if cached is None:
                if required:
                    raise RuntimeError(
                        f"{column} ADP failed and no saved snapshot exists."
                    ) from None
                errors.append(f"{column} unavailable; no saved data")
                continue
            providers[column] = cached
            source_dates[column] = cached_date
            errors.append(f"{column} unavailable; using saved data")

    if not providers:
        raise FileNotFoundError("No direct or saved ADP source is available.")

    merged_frames = [_provider_for_merge(frame, column) for column, frame in providers.items()]
    merged = reduce(lambda left, right: left.merge(right, on="_key", how="outer"), merged_frames)
    output = pd.DataFrame(
        {
            "Player": _coalesce(merged, "Player", ("Sleeper", "MFL", "Yahoo")),
            "Team": _coalesce(merged, "Team", ("Sleeper", "MFL", "Yahoo")),
            "Position": _coalesce(merged, "Position", ("Sleeper", "MFL", "Yahoo")),
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
    _write_mfl_provenance(output, health.get("MFL", {}))
    output["Source_Updated"] = max((value for value in source_dates.values() if value), default=None)
    for column in ADP_PROVIDERS:
        output[f"{column}_Updated"] = source_dates.get(column)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = output_path.with_suffix(output_path.suffix + ".tmp")
    output.to_csv(temporary, index=False)
    temporary.replace(output_path)
    output.attrs["source_health"] = health
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
    """Refresh each K/DST provider independently, preserving its last-good values."""
    output_path = Path(output_path)
    update_date = update_date or _today()
    frames = []
    errors = []
    source_dates = {}
    health = {}
    attempted_at = datetime.now(timezone.utc).isoformat()
    for column, fetcher in (
        ("Sleeper", fetch_sleeper_adp),
        ("MFL", fetch_mfl_adp),
    ):
        try:
            provider = fetcher(
                season,
                http_get=http_get,
                positions=SPECIAL_TEAM_POSITIONS,
            )
            frames.append(_special_provider_for_merge(provider, column))
            source_dates[column] = update_date
            health[column] = {
                "status": "success", "freshness": "current", "attempted_at": attempted_at,
                "last_success": attempted_at, "data_updated_at": update_date,
                "timestamp_kind": "snapshot", "row_count": len(frames[-1]),
                "note": "Downloaded and validated on the snapshot date; provider publication time is not supplied.",
            }
            if column == "MFL":
                _describe_mfl_health(health[column], provider, fetched=True)
        except (requests.RequestException, ValueError, TypeError, KeyError) as exc:
            cached, cached_date = _cached_provider(output_path, column)
            try:
                saved_frame = _special_provider_for_merge(cached, column) if cached is not None else None
            except (ValueError, TypeError, KeyError):
                cached, saved_frame, cached_date = None, None, None
            if saved_frame is not None:
                frames.append(saved_frame)
                source_dates[column] = cached_date
            health[column] = _failure_health(exc, cached, cached_date, attempted_at)
            if column == "MFL":
                _describe_mfl_health(health[column], cached)
            errors.append(f"{column}: {health[column]['note']}")

    if len(frames) < 2:
        detail = "; ".join(errors) or "fewer than two sources returned data"
        raise RuntimeError(f"K/DST market refresh needs two usable sources: {detail}")

    merged = reduce(lambda left, right: left.merge(right, on="_key", how="outer"), frames)
    provider_order = ("Sleeper", "MFL")
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
    _write_mfl_provenance(output, health.get("MFL", {}))
    output["Source_Updated"] = max((date for date in source_dates.values() if date), default=None)
    for column in provider_order:
        output[f"{column}_Updated"] = source_dates.get(column)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = output_path.with_suffix(output_path.suffix + ".tmp")
    output.to_csv(temporary, index=False)
    temporary.replace(output_path)
    output.attrs["source_health"] = health
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
        if column not in frame or not pd.to_numeric(frame[column], errors="coerce").notna().any():
            continue
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
        }
    )
    output = _adp_metrics(output)
    output["Source_Updated"] = update_date
    for column in ("Yahoo", "Sleeper"):
        output[f"{column}_Updated"] = update_date

    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output.to_csv(output_path, index=False)
    print(f"[OK] Saved {len(output)} combined ADP rows to {output_path}")
    return output


if __name__ == "__main__":
    from config import ADP_DIR, ADP_FILENAME, PROJECTION_SEASON

    build_direct_adp(ADP_DIR / ADP_FILENAME, season=PROJECTION_SEASON)
