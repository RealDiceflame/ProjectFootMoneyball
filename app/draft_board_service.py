"""Application-facing helpers for selecting and displaying draft rankings."""

from dataclasses import dataclass
import json
from pathlib import Path
import re
import pandas as pd

NUMERIC_COLUMNS = {
    "overall_rank", "position_rank", "projected_points", "replacement_points",
    "vorp", "market_expected_points", "market_value", "adp", "value_vs_adp",
    "Yahoo", "Sleeper", "NFL",
}


@dataclass(frozen=True)
class LeagueSettings:
    teams: int = 12
    quarterbacks: str = "2QB"
    ppr: str = "Half PPR"
    te_premium: str = "+0.5"

    def ranking_slug(self):
        qb = "2qb" if self.quarterbacks == "2QB" else "1qb"
        ppr = {"Standard": "standard", "Half PPR": "half_ppr", "Full PPR": "full_ppr"}[self.ppr]
        if self.te_premium == "+0.5":
            if ppr == "half_ppr" and qb == "1qb":
                format_slug = "te_premium_half_ppr"
            elif ppr == "half_ppr" and qb == "2qb":
                format_slug = "2qb_te_premium_half_ppr"
            else:
                format_slug = f"{qb}_te_premium_{ppr}"
        else:
            format_slug = f"{qb}_{ppr}"
        return f"{self.teams}team_{format_slug}"

    def ranking_path(self, output_dir):
        return Path(output_dir) / f"draft_rankings_{self.ranking_slug()}.csv"


def load_rankings(output_dir, settings):
    path = settings.ranking_path(output_dir)
    if not path.exists():
        raise FileNotFoundError("Rankings have not been generated yet. Click Update Data first.")
    rankings = pd.read_csv(path)
    value = pd.to_numeric(rankings["market_value"], errors="coerce")
    rankings["draft_tag"] = "FAIR"
    rankings.loc[value >= 10, "draft_tag"] = "VALUE"
    rankings.loc[value >= 25, "draft_tag"] = "TARGET"
    rankings.loc[value <= -10, "draft_tag"] = "REACH"
    return rankings


def player_key(player, team=""):
    """Return a stable key that survives ranking and scoring-format changes."""
    return f"{str(player).strip().casefold()}|{str(team).strip().upper()}"


class DraftedPlayerStore:
    """Persist drafted players separately from regenerated ranking files."""

    def __init__(self, path):
        self.path = Path(path)
        self._keys = self._load()

    def _load(self):
        if not self.path.exists():
            return set()
        try:
            values = json.loads(self.path.read_text(encoding="utf-8"))
            return {str(value) for value in values}
        except (OSError, ValueError, TypeError):
            return set()

    def contains(self, player, team=""):
        return player_key(player, team) in self._keys

    def toggle(self, player, team=""):
        key = player_key(player, team)
        if key in self._keys:
            self._keys.remove(key)
            drafted = False
        else:
            self._keys.add(key)
            drafted = True
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(".tmp")
        temporary.write_text(json.dumps(sorted(self._keys), indent=2), encoding="utf-8")
        temporary.replace(self.path)
        return drafted

    def clear(self):
        self._keys.clear()
        if self.path.exists():
            self.path.unlink()


def filter_rankings(rankings, column, query):
    """Return a filtered copy without ever changing the loaded ranking data."""
    query = str(query).strip()
    if not query or column not in rankings.columns:
        return rankings.copy()

    values = rankings[column]
    if column == "drafted":
        choices = {
            "yes": True, "y": True, "true": True, "1": True,
            "drafted": True, "✓": True,
            "no": False, "n": False, "false": False, "0": False,
            "available": False, "undrafted": False,
        }
        wanted = choices.get(query.casefold())
        if wanted is None:
            return rankings.copy()
        return rankings[values.astype(bool) == wanted].copy()

    normalized_query = query.casefold()
    blank = values.isna() | values.astype(str).str.strip().eq("")
    if normalized_query in {"blank", "empty"}:
        return rankings[blank].copy()
    if normalized_query in {"not blank", "not empty"}:
        return rankings[~blank].copy()

    numeric = pd.to_numeric(values, errors="coerce")
    range_match = re.fullmatch(r"\s*(-?\d+(?:\.\d+)?)\s*\.\.\s*(-?\d+(?:\.\d+)?)\s*", query)
    comparison = re.fullmatch(r"\s*(<=|>=|<|>|=)\s*(-?\d+(?:\.\d+)?)\s*", query)
    if range_match and numeric.notna().any():
        low, high = sorted(map(float, range_match.groups()))
        return rankings[numeric.between(low, high)].copy()
    if comparison and numeric.notna().any():
        operator, raw_number = comparison.groups()
        number = float(raw_number)
        masks = {
            ">": numeric > number, ">=": numeric >= number,
            "<": numeric < number, "<=": numeric <= number,
            "=": numeric == number,
        }
        return rankings[masks[operator]].copy()
    if re.fullmatch(r"-?\d+(?:\.\d+)?", query) and numeric.notna().any():
        return rankings[numeric == float(query)].copy()

    terms = [term.strip() for term in query.split(",") if term.strip()]
    if not terms:
        return rankings.copy()
    text = values.astype("string")
    if column in {"team", "pos", "draft_tag"}:
        wanted = {term.casefold() for term in terms}
        mask = text.str.strip().str.casefold().isin(wanted)
    else:
        mask = pd.Series(False, index=rankings.index)
        for term in terms:
            mask |= text.str.contains(term, case=False, na=False, regex=False)
    return rankings[mask.fillna(False)].copy()


def prepare_rankings(rankings, drafted_store, *, filter_column, query, sort_column, ascending):
    """Create the final table view without mixing data operations into the UI."""
    view = rankings.copy()
    view["drafted"] = [
        drafted_store.contains(player, team)
        for player, team in zip(view.get("player", ""), view.get("team", ""))
    ]
    view = filter_rankings(view, filter_column, query)
    if sort_column == "drafted":
        view = view.sort_values(["drafted", "overall_rank"], ascending=[ascending, True])
    elif sort_column in NUMERIC_COLUMNS and sort_column in view.columns:
        numeric_sort = pd.to_numeric(view[sort_column], errors="coerce")
        view = view.assign(_numeric_sort=numeric_sort).sort_values(
            "_numeric_sort", ascending=ascending, na_position="last"
        ).drop(columns="_numeric_sort")
    elif sort_column in view.columns:
        view = view.sort_values(sort_column, ascending=ascending, na_position="last")
    return view
