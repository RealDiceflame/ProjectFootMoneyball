"""Export generated draft rankings for the browser-based draft board."""

from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path

import pandas as pd


TEAM_SIZES = (8, 10, 12, 14, 16)
WEB_COLUMNS = (
    "overall_rank",
    "player",
    "player_id",
    "team",
    "pos",
    "position_rank",
    "projected_points",
    "vorp",
    "market_expected_points",
    "market_value",
    "adp",
    "value_vs_adp",
    "Yahoo",
    "Sleeper",
    "NFL",
    "draft_tag",
)


def _draft_tags(values: pd.Series) -> pd.Series:
    """Classify projected point advantage over the position's ADP market line."""
    numeric = pd.to_numeric(values, errors="coerce")
    tags = pd.Series("FAIR", index=values.index)
    tags.loc[numeric >= 10] = "VALUE"
    tags.loc[numeric >= 25] = "TARGET"
    tags.loc[numeric <= -10] = "REACH"
    return tags


def _ranking_files(rankings_dir: Path) -> list[Path]:
    files: list[Path] = []
    for teams in TEAM_SIZES:
        files.extend(sorted(rankings_dir.glob(f"draft_rankings_{teams}team_*.csv")))
    if len(files) != 60:
        raise FileNotFoundError(
            f"Expected 60 team-size ranking CSVs in {rankings_dir}, found {len(files)}."
        )
    return files


def export_web_rankings(
    rankings_dir: str | Path,
    destination: str | Path,
    *,
    projection_season: int,
    stat_season: int,
    adp_updated: str,
) -> Path:
    """Write an atomic, compact JSON bundle containing every selectable board."""
    rankings_dir = Path(rankings_dir)
    destination = Path(destination)
    files = _ranking_files(rankings_dir)
    boards: dict[str, list[list[object]]] = {}

    for path in files:
        frame = pd.read_csv(path)
        frame["draft_tag"] = _draft_tags(frame["market_value"])
        missing = [column for column in WEB_COLUMNS if column not in frame.columns]
        if missing:
            raise ValueError(f"{path.name} is missing columns: {', '.join(missing)}")
        clean = frame.loc[:, WEB_COLUMNS].astype(object).where(pd.notna(frame.loc[:, WEB_COLUMNS]), None)
        slug = path.stem.removeprefix("draft_rankings_")
        boards[slug] = clean.values.tolist()

    newest_file = max(path.stat().st_mtime for path in files)
    payload = {
        "projection_season": projection_season,
        "stat_season": stat_season,
        "adp_updated": adp_updated,
        "generated_at": datetime.fromtimestamp(newest_file, timezone.utc).isoformat(),
        "columns": list(WEB_COLUMNS),
        "boards": boards,
    }

    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    temporary.replace(destination)
    return destination
