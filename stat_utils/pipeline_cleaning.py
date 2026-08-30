"""Cleaning policy for the final projection and ADP dataset."""

from pathlib import Path
import re

import pandas as pd

from stat_utils.pandas_helpers import drop_columns_from_file
from stat_utils.project_dataframe_utils import ensure_games_column, ensure_pos_column

KEEP_COLUMNS = (
    "passing_att", "passing_cmp", "passing_yds", "passing_td", "passing_int",
    "rushing_att", "rushing_yds", "rushing_td",
    "receiving_tgt", "receiving_rec", "receiving_yds", "receiving_td", "receiving_tds",
    "Yahoo", "Sleeper", "NFL", "ADP", "NFL_Source", "Source_Updated",
)
ALLOWED_PREFIX_COLUMNS = {
    "passing": {"passing_att", "passing_cmp", "passing_yds", "passing_td", "passing_int"},
    "rushing": {"rushing_att", "rushing_yds", "rushing_td"},
    "receiving": {
        "receiving_tgt", "receiving_rec", "receiving_yds", "receiving_td", "receiving_tds",
        "recieving_tgt", "recieving_rec", "recieving_yds", "recieving_td", "recieving_tds",
    },
}


def filter_missing_adp(frame):
    """Keep players with a numeric ADP and normalize it in place."""
    candidates = [column for column in frame.columns if "adp" in str(column).casefold()]
    if not candidates:
        raise ValueError("No ADP column was found in the merged player dataset.")
    column = next((item for item in candidates if str(item).strip().casefold() == "adp"), candidates[0])
    numeric = pd.to_numeric(frame[column], errors="coerce")
    result = frame.loc[numeric.notna()].copy()
    result[column] = numeric.loc[numeric.notna()]
    return result


def keep_supported_stat_columns(frame, columns_file):
    """Apply the configured drop list and retain only supported stat families."""
    result = drop_columns_from_file(frame, filepath=columns_file, keep_patterns=list(KEEP_COLUMNS))
    to_drop = []
    for prefix, allowed in ALLOWED_PREFIX_COLUMNS.items():
        family = [column for column in result.columns if str(column).casefold().startswith(f"{prefix}_")]
        to_drop.extend(column for column in family if str(column).casefold() not in allowed)
    to_drop.extend(column for column in result.columns if str(column).strip().casefold() == "att")
    return result.drop(columns=to_drop, errors="ignore")


def canonical_position(frame):
    """Coalesce position-like columns and return their normalized alpha token."""
    candidates = [
        column for column in frame.columns
        if str(column).strip().casefold() in {"pos", "position"}
        or str(column).strip().casefold().endswith("pos")
    ]
    position = pd.Series(pd.NA, index=frame.index, dtype="object")
    for column in candidates:
        values = frame[column].replace(r"^\s*$", pd.NA, regex=True)
        position = position.fillna(values)
    normalized = position.fillna("").astype(str).str.strip().str.upper()
    return normalized.str.extract(r"^([A-Z]{1,4})", expand=False).fillna("")


def remove_non_skill_positions(frame):
    """Remove kickers and team defenses using position fields only."""
    positions = canonical_position(frame)
    return frame.loc[~positions.isin({"K", "DEF", "DST"})].copy()


def prepare_ranking_input(frame, *, columns_file, audit_path=None):
    """Produce the canonical player dataset consumed by regression and rankings."""
    result = filter_missing_adp(frame)
    result = keep_supported_stat_columns(result, columns_file)
    result = ensure_pos_column(result)
    result = ensure_games_column(result)
    if audit_path:
        audit_path = Path(audit_path)
        audit_path.parent.mkdir(parents=True, exist_ok=True)
        result.to_csv(audit_path, index=False, na_rep="-")
    return remove_non_skill_positions(result)
