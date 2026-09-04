"""Shared Market +/- thresholds for every draft-board output."""

from __future__ import annotations

import pandas as pd


TARGET_MIN = 50.0
VALUE_MIN = 25.0
REACH_MAX = -20.0


def market_tags(values: pd.Series) -> pd.Series:
    """Classify Market +/- values using the application's shared thresholds."""
    numeric = pd.to_numeric(values, errors="coerce")
    tags = pd.Series("FAIR", index=values.index)
    tags.loc[numeric >= VALUE_MIN] = "VALUE"
    tags.loc[numeric >= TARGET_MIN] = "TARGET"
    tags.loc[numeric <= REACH_MAX] = "REACH"
    return tags
