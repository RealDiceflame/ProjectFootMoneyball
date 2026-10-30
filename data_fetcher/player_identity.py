"""Offline NFL identity registry. Provider IDs are namespaced, never name hashes."""
from functools import lru_cache
import re
import unicodedata
import pandas as pd

NAME_SUFFIXES = {"jr", "sr", "ii", "iii", "iv", "v"}
PROVIDER_COLUMNS = {"Sleeper_ID": "sleeper_id", "MFL_ID": "mfl_id", "ESPN_ID": "espn_id", "Yahoo_ID": "yahoo_id", "PFR_ID": "pfr_id"}

def _player_key(name, position) -> str:
    """Return a provider-neutral identity key without collapsing same-name positions."""
    text = unicodedata.normalize("NFKD", str(name)).encode("ascii", "ignore").decode()
    # Existing stat snapshots omit punctuation within name tokens. Keep those
    # identities compatible (Ja'Marr/Jamarr, Smith-Njigba/SmithNjigba).
    text = re.sub(r"[.'\-]", "", text)
    tokens = re.sub(r"[^a-z0-9]+", " ", text.casefold()).split()
    while tokens and tokens[-1] in NAME_SUFFIXES:
        tokens.pop()
    # Providers spell initialisms as DJ, D.J. or D. J. Keep ordinary given
    # names separate; only a leading run of single-letter tokens is joined.
    initials = 0
    while initials < len(tokens) - 1 and len(tokens[initials]) == 1:
        initials += 1
    if initials > 1:
        tokens = ["".join(tokens[:initials]), *tokens[initials:]]
    return f"{' '.join(tokens)}|{str(position).strip().upper()}"


def clean_id(value):
    if pd.isna(value):
        return ""
    text = str(value).strip()
    if text.lower() in {"", "-", "na", "nan", "none", "null", "<na>"}:
        return ""
    # Legacy CSV readers may have inferred a nullable integer ID as float.
    return text[:-2] if re.fullmatch(r"[0-9]+\.0", text) else text


class PlayerRegistry:
    def __init__(self, records):
        self.ids, self.names, self.providers = {}, {}, {}
        for row in records:
            identity = clean_id(row.get("gsis_id"))
            if not identity:
                raise ValueError("Registry row requires a GSIS ID")
            self.ids.setdefault(identity, []).append(row)
            for name in [row.get("name", ""), *str(row.get("aliases", "")).split(";")]:
                if name:
                    self.names.setdefault(_player_key(name, row.get("position", "")), set()).add(identity)
            for column, source in PROVIDER_COLUMNS.items():
                value = clean_id(row.get(source))
                if value:
                    self.providers.setdefault((column, value), set()).add(identity)

    def resolve(self, row):
        canonical = clean_id(row.get("player_id"))
        matches = {canonical} if canonical else set()
        unknown = False
        for column in PROVIDER_COLUMNS:
            value = clean_id(row.get(column))
            if not value:
                continue
            candidates = self.providers.get((column, value), set())
            if len(candidates) > 1:
                raise ValueError(f"Conflicting registry mapping for {column} {value}")
            matches.update(candidates)
            unknown |= not candidates
        if len(matches) > 1:
            raise ValueError(f"Conflicting player identity for {row.get('Player', row.get('player', ''))}")
        if matches:
            return next(iter(matches)), "source_id" if canonical else "provider_id"
        if unknown:
            return "", "unresolved_provider_id"
        key = _player_key(row.get("Player", row.get("player", "")), row.get("Position", row.get("pos", "")))
        candidates = self.names.get(key, set())
        if len(candidates) == 1:
            return next(iter(candidates)), "unique_name_position"
        if len(candidates) > 1:
            # A dated current-team observation can distinguish two historical
            # namesakes. It supports a match, never changes an existing ID.
            team = clean_id(row.get("Team", row.get("team"))).upper()
            season = clean_id(row.get("Source_Updated"))[:4]
            supported = {identity for identity in candidates if any(
                team and season.isdigit() and record.get("latest_team") == team
                and record.get("last_season") == season for record in self.ids[identity])}
            if len(supported) == 1:
                return next(iter(supported)), "name_position_team_season"
        return "", "ambiguous" if candidates else "unmatched"

    def attach(self, frame):
        result = frame.copy()
        resolved = [self.resolve(row) for row in result.to_dict("records")]
        result["player_id"] = [identity or pd.NA for identity, _ in resolved]
        result["identity_status"] = [status for _, status in resolved]
        return result


@lru_cache(maxsize=1)
def default_registry():
    from config import DATA_DIR
    path = DATA_DIR / "identity" / "player_ids.csv"
    rows = pd.read_csv(path, dtype=str, keep_default_na=False).to_dict("records")
    return PlayerRegistry(rows)


def attach_player_ids(frame):
    return default_registry().attach(frame)
