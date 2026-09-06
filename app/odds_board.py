"""Build the public weekly NFL odds board from documented data sources."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from io import StringIO
import json
import os
from pathlib import Path
import re
from typing import Callable
from zoneinfo import ZoneInfo

import pandas as pd
import requests


SCHEDULE_URL = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv"
NFLVERSE_SOURCE_URL = "https://github.com/nflverse/nfldata/blob/master/data/games.csv"
KALSHI_API = "https://external-api.kalshi.com/trade-api/v2"
KALSHI_SOURCE_URL = "https://kalshi.com/markets"
ODDS_API_URL = "https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds"
ODDS_API_SOURCE_URL = "https://the-odds-api.com/sports/nfl-odds.html"
SPORTSGAMEODDS_API = "https://api.sportsgameodds.com/v2/events/"
SPORTSGAMEODDS_SOURCE_URL = "https://sportsgameodds.com/docs/endpoints/getEvents"
POLYMARKET_EVENTS_API = "https://gamma-api.polymarket.com/events"
POLYMARKET_SOURCE_URL = "https://polymarket.com/sports/nfl"
NWS_API = "https://api.weather.gov"
NWS_SOURCE_URL = "https://www.weather.gov/documentation/services-web-api"

STADIUM_COORDINATES = {
    "ATL97": (33.7554, -84.4008), "BAL00": (39.2780, -76.6238),
    "BOS00": (42.0913, -71.2645), "BUF00": (42.7737, -78.7869),
    "CAR00": (35.2257, -80.8537), "CHI98": (41.8625, -87.6167),
    "CIN00": (39.0955, -84.5160), "CLE00": (41.5061, -81.6997),
    "DAL00": (32.7479, -97.0928), "DEN00": (39.7440, -105.0192),
    "DET00": (42.3400, -83.0456), "GNB00": (44.5010, -88.0610),
    "HOU00": (29.6849, -95.4108), "IND00": (39.7601, -86.1637),
    "JAX00": (30.3240, -81.6373), "KAN00": (39.0489, -94.4850),
    "LAX01": (33.9535, -118.3388), "MIA00": (25.9579, -80.2388),
    "MIN01": (44.9750, -93.2599), "NAS00": (36.1665, -86.7713),
    "NOR00": (29.9510, -90.0823), "NYC01": (40.8135, -74.0734),
    "PHI00": (39.9009, -75.1675), "PHO00": (33.5277, -112.2626),
    "PIT00": (40.4467, -80.0158), "SEA00": (47.5953, -122.3316),
    "SFO01": (37.4030, -121.9697), "TAM00": (27.9760, -82.5042),
    "VEG00": (36.0908, -115.1825), "WAS00": (38.9077, -76.8633),
}

# International schedule rows can retain the home club's usual roof/surface values.
# These overrides describe the actual host venue so the public game card stays honest.
VENUE_OVERRIDES = {
    "MEL00": {"roof": "outdoors", "surface": "grass"},
    "RIO00": {"roof": "outdoors", "surface": "grass"},
    "LON02": {"roof": "outdoors", "surface": "artificial"},
    "LON00": {"roof": "outdoors", "surface": "grass"},
    "PAR00": {"roof": "outdoors", "surface": "grass"},
    "MAD01": {"roof": "retractable", "surface": "grass"},
    "MUN01": {"roof": "outdoors", "surface": "grass"},
    "MEX00": {"roof": "outdoors", "surface": "grass"},
}

TEAM_NAMES = {
    "ARI": "Arizona Cardinals", "ATL": "Atlanta Falcons", "BAL": "Baltimore Ravens",
    "BUF": "Buffalo Bills", "CAR": "Carolina Panthers", "CHI": "Chicago Bears",
    "CIN": "Cincinnati Bengals", "CLE": "Cleveland Browns", "DAL": "Dallas Cowboys",
    "DEN": "Denver Broncos", "DET": "Detroit Lions", "GB": "Green Bay Packers",
    "HOU": "Houston Texans", "IND": "Indianapolis Colts", "JAX": "Jacksonville Jaguars",
    "KC": "Kansas City Chiefs", "LA": "Los Angeles Rams", "LAC": "Los Angeles Chargers",
    "LV": "Las Vegas Raiders", "MIA": "Miami Dolphins", "MIN": "Minnesota Vikings",
    "NE": "New England Patriots", "NO": "New Orleans Saints", "NYG": "New York Giants",
    "NYJ": "New York Jets", "PHI": "Philadelphia Eagles", "PIT": "Pittsburgh Steelers",
    "SEA": "Seattle Seahawks", "SF": "San Francisco 49ers", "TB": "Tampa Bay Buccaneers",
    "TEN": "Tennessee Titans", "WAS": "Washington Commanders",
}
TEAM_LOGO_KEYS = {
    **{code: code.casefold() for code in TEAM_NAMES},
    "LA": "lar",
    "WAS": "wsh",
}
TEAM_ALIASES = {
    **{name.casefold(): code for code, name in TEAM_NAMES.items()},
    **{name.rsplit(" ", 1)[0].casefold(): code for code, name in TEAM_NAMES.items()},
    **{name.rsplit(" ", 1)[-1].casefold(): code for code, name in TEAM_NAMES.items()},
    "arizona": "ARI", "atlanta": "ATL", "baltimore": "BAL", "buffalo": "BUF",
    "carolina": "CAR", "chicago": "CHI", "cincinnati": "CIN", "cleveland": "CLE",
    "dallas": "DAL", "denver": "DEN", "detroit": "DET", "green bay": "GB",
    "houston": "HOU", "indianapolis": "IND", "jacksonville": "JAX",
    "kansas city": "KC", "los angeles rams": "LA", "la rams": "LA",
    "los angeles chargers": "LAC", "la chargers": "LAC", "las vegas": "LV",
    "miami": "MIA", "minnesota": "MIN", "new england": "NE", "new orleans": "NO",
    "new york giants": "NYG", "ny giants": "NYG", "new york jets": "NYJ",
    "ny jets": "NYJ", "philadelphia": "PHI", "pittsburgh": "PIT", "seattle": "SEA",
    "san francisco": "SF", "tampa bay": "TB", "tennessee": "TEN",
    "washington": "WAS",
}

BOOK_URLS = {
    "draftkings": "https://sportsbook.draftkings.com/",
    "fanduel": "https://sportsbook.fanduel.com/",
    "betmgm": "https://sports.betmgm.com/en/sports",
    "williamhill_us": "https://sportsbook.caesars.com/",
    "betrivers": "https://www.betrivers.com/",
    "betonlineag": "https://www.betonline.ag/sportsbook",
    "bovada": "https://www.bovada.lv/sports",
}
BOOK_NAMES = {
    "draftkings": "DraftKings", "fanduel": "FanDuel", "betmgm": "BetMGM",
    "williamhill_us": "Caesars", "caesars": "Caesars", "betrivers": "BetRivers",
    "betonlineag": "BetOnline", "bovada": "Bovada", "fanatics": "Fanatics",
    "espnbet": "ESPN BET", "bet365": "bet365",
}


def _number(value) -> float | None:
    if value is None or pd.isna(value) or str(value).strip() == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _american(value) -> int | None:
    number = _number(value)
    return int(round(number)) if number is not None else None


def _team_logo_url(team: str) -> str:
    key = TEAM_LOGO_KEYS.get(team, team.casefold())
    return f"https://a.espncdn.com/i/teamlogos/nfl/500/{key}.png"


def probability_to_american(probability) -> int | None:
    """Convert a $0-$1 contract ask into comparable implied American odds."""
    value = _number(probability)
    if value is None or value <= 0 or value >= 1:
        return None
    if value < 0.5:
        return int(round(100 * (1 - value) / value))
    return int(round(-100 * value / (1 - value)))


def _team_code(value: str | None) -> str | None:
    if not value:
        return None
    clean = " ".join(str(value).replace("Pro Football game", "").split()).strip(" :?")
    upper = clean.upper()
    if upper in TEAM_NAMES:
        return upper
    return TEAM_ALIASES.get(clean.casefold())


def _kickoff(row: pd.Series) -> str:
    raw_time = row.get("gametime")
    game_time = "00:00" if raw_time is None or pd.isna(raw_time) else str(raw_time).strip()
    local = datetime.fromisoformat(f"{row['gameday']}T{game_time or '00:00'}")
    return local.replace(tzinfo=ZoneInfo("America/New_York")).astimezone(timezone.utc).isoformat()


def _text(value) -> str | None:
    if value is None or pd.isna(value):
        return None
    clean = str(value).strip()
    return None if not clean or clean.casefold() in {"nan", "none"} else clean


def _weather_status(row: pd.Series, kickoff: str, now: datetime) -> dict:
    roof = (_text(row.get("roof")) or "unknown").casefold()
    if roof in {"dome", "closed"}:
        return {
            "status": "indoor",
            "summary": "Indoor venue — weather impact limited",
            "temperature": None,
            "wind_speed": None,
            "wind_direction": None,
            "source_url": None,
        }
    scheduled_temp = _number(row.get("temp"))
    scheduled_wind = _number(row.get("wind"))
    if scheduled_temp is not None or scheduled_wind is not None:
        return {
            "status": "schedule",
            "summary": "Schedule weather snapshot",
            "temperature": int(round(scheduled_temp)) if scheduled_temp is not None else None,
            "wind_speed": f"{int(round(scheduled_wind))} mph" if scheduled_wind is not None else None,
            "wind_direction": None,
            "source_url": NFLVERSE_SOURCE_URL,
        }
    kickoff_dt = datetime.fromisoformat(kickoff)
    if kickoff_dt > now.astimezone(timezone.utc) + timedelta(days=7):
        status, summary = "pending", "Forecast available within seven days of kickoff"
    elif _text(row.get("stadium_id")) not in STADIUM_COORDINATES:
        status, summary = "unavailable", "Forecast not available for this venue"
    else:
        status, summary = "pending", "Forecast is being updated"
    return {
        "status": status,
        "summary": summary,
        "temperature": None,
        "wind_speed": None,
        "wind_direction": None,
        "source_url": NWS_SOURCE_URL,
    }


def _row(
    *,
    provider: str,
    provider_key: str,
    provider_kind: str,
    provider_url: str,
    market: str,
    selection: str,
    price: int | None,
    line: float | None = None,
    contract_price: int | None = None,
    updated_at: str | None = None,
) -> dict:
    return {
        "provider": provider,
        "provider_key": provider_key,
        "provider_kind": provider_kind,
        "provider_url": provider_url,
        "market": market,
        "selection": selection,
        "line": line,
        "price": price,
        "contract_price": contract_price,
        "updated_at": updated_at,
        "is_best": False,
    }


def _reference_rows(row: pd.Series, generated_at: str) -> list[dict]:
    rows = []
    common = {
        "provider": "Market consensus",
        "provider_key": "nflverse",
        "provider_kind": "reference",
        "provider_url": NFLVERSE_SOURCE_URL,
        "updated_at": generated_at,
    }
    away, home = str(row["away_team"]), str(row["home_team"])
    for team, price in ((away, _american(row.get("away_moneyline"))), (home, _american(row.get("home_moneyline")))):
        if price is not None:
            rows.append(_row(**common, market="Moneyline", selection=team, price=price))

    spread = _number(row.get("spread_line"))
    away_spread = _american(row.get("away_spread_odds"))
    home_spread = _american(row.get("home_spread_odds"))
    if spread is not None and away_spread is not None:
        rows.append(_row(**common, market="Spread", selection=away, line=spread, price=away_spread))
    if spread is not None and home_spread is not None:
        rows.append(_row(**common, market="Spread", selection=home, line=-spread, price=home_spread))

    total = _number(row.get("total_line"))
    over = _american(row.get("over_odds"))
    under = _american(row.get("under_odds"))
    if total is not None and over is not None:
        rows.append(_row(**common, market="Total", selection="Over", line=total, price=over))
    if total is not None and under is not None:
        rows.append(_row(**common, market="Total", selection="Under", line=total, price=under))
    return rows


def _schedule_games(schedule: pd.DataFrame, *, season: int, now: datetime) -> list[dict]:
    rows = schedule[
        (schedule["season"].astype(int) == season)
        & (schedule["game_type"].astype(str) == "REG")
    ].copy()
    games = []
    for _, row in rows.iterrows():
        kickoff = _kickoff(row)
        if datetime.fromisoformat(kickoff) < now.astimezone(timezone.utc):
            continue
        away, home = str(row["away_team"]), str(row["home_team"])
        stadium_id = _text(row.get("stadium_id"))
        venue = row.copy()
        for key, value in VENUE_OVERRIDES.get(stadium_id, {}).items():
            venue[key] = value
        games.append({
            "game_id": str(row["game_id"]),
            "week": int(row["week"]),
            "kickoff": kickoff,
            "away": away,
            "home": home,
            "away_name": TEAM_NAMES.get(away, away),
            "home_name": TEAM_NAMES.get(home, home),
            "away_logo_url": _team_logo_url(away),
            "home_logo_url": _team_logo_url(home),
            "stadium_id": stadium_id,
            "stadium": _text(row.get("stadium")) or "Venue to be announced",
            "roof": _text(venue.get("roof")) or "unknown",
            "surface": _text(venue.get("surface")),
            "weather": _weather_status(venue, kickoff, now),
            "rows": [],
        })
    return games


def _game_index(games: list[dict]) -> dict[tuple[str, str], dict]:
    return {(game["away"], game["home"]): game for game in games}


def _kalshi_teams(event: dict) -> tuple[str | None, str | None]:
    title = str(event.get("title") or "")
    if " vs " not in title:
        return None, None
    away_name, home_name = title.split(" vs ", 1)
    return _team_code(away_name), _team_code(home_name)


def add_kalshi_markets(games: list[dict], events: list[dict], generated_at: str) -> None:
    """Add documented public Kalshi game-winner contracts to matching NFL games."""
    index = _game_index(games)
    for event in events:
        away, home = _kalshi_teams(event)
        game = index.get((away, home))
        if game is None:
            continue
        for market in event.get("markets") or []:
            selection = _team_code(market.get("subtitle") or market.get("yes_sub_title"))
            ask = _number(market.get("yes_ask_dollars"))
            if selection not in {away, home} or ask is None:
                continue
            game["rows"].append(_row(
                provider="Kalshi",
                provider_key="kalshi",
                provider_kind="exchange",
                provider_url=KALSHI_SOURCE_URL,
                market="Moneyline",
                selection=selection,
                price=probability_to_american(ask),
                contract_price=int(ask * 100 + 0.5),
                updated_at=str(market.get("last_price_ts") or generated_at),
            ))


def add_sportsbook_markets(games: list[dict], events: list[dict]) -> None:
    """Normalize licensed The Odds API bookmaker data into board rows."""
    index = _game_index(games)
    market_names = {"h2h": "Moneyline", "spreads": "Spread", "totals": "Total"}
    for event in events:
        away = _team_code(event.get("away_team"))
        home = _team_code(event.get("home_team"))
        game = index.get((away, home))
        if game is None:
            continue
        for book in event.get("bookmakers") or []:
            provider_key = str(book.get("key") or "").strip()
            provider = str(book.get("title") or provider_key or "Sportsbook")
            provider_url = BOOK_URLS.get(provider_key, ODDS_API_SOURCE_URL)
            updated = book.get("last_update")
            for market in book.get("markets") or []:
                market_name = market_names.get(market.get("key"))
                if not market_name:
                    continue
                for outcome in market.get("outcomes") or []:
                    raw_selection = outcome.get("name")
                    selection = (
                        str(raw_selection).title()
                        if market_name == "Total"
                        else _team_code(raw_selection)
                    )
                    if not selection:
                        continue
                    price = _american(outcome.get("price"))
                    if price is None:
                        continue
                    game["rows"].append(_row(
                        provider=provider,
                        provider_key=provider_key,
                        provider_kind="sportsbook",
                        provider_url=provider_url,
                        market=market_name,
                        selection=selection,
                        line=_number(outcome.get("point")),
                        price=price,
                        updated_at=str(updated or ""),
                    ))


def _sports_game_odds_teams(event: dict) -> tuple[str | None, str | None]:
    teams = event.get("teams") or {}

    def code(side: str) -> str | None:
        team = teams.get(side) or {}
        names = team.get("names") or {}
        for field in ("long", "medium", "short"):
            matched = _team_code(names.get(field))
            if matched:
                return matched
        return _team_code(team.get("teamID"))

    return code("away"), code("home")


def _book_link(value) -> str | None:
    if isinstance(value, str) and value.startswith(("https://", "http://")):
        return value
    if isinstance(value, dict):
        for key in ("url", "link", "web"):
            url = value.get(key)
            if isinstance(url, str) and url.startswith(("https://", "http://")):
                return url
    return None


def add_sportsgameodds_markets(games: list[dict], events: list[dict]) -> None:
    """Normalize SportsGameOdds data when the primary sportsbook feed is unavailable."""
    index = _game_index(games)
    market_names = {"ml": "Moneyline", "sp": "Spread", "ou": "Total"}
    for event in events:
        away, home = _sports_game_odds_teams(event)
        game = index.get((away, home))
        if game is None:
            continue
        links = (event.get("links") or {}).get("bookmakers") or {}
        seen: set[tuple[str, str, str, float | None, int]] = set()
        for odd in (event.get("odds") or {}).values():
            market_name = market_names.get(str(odd.get("betTypeID") or "").casefold())
            side = str(odd.get("sideID") or "").casefold()
            if market_name in {"Moneyline", "Spread"}:
                selection = home if side == "home" else away if side == "away" else None
            elif market_name == "Total":
                selection = side.title() if side in {"over", "under"} else None
            else:
                selection = None
            if not selection:
                continue
            for provider_key, book in (odd.get("byBookmaker") or {}).items():
                if not isinstance(book, dict) or book.get("available") is False:
                    continue
                price = _american(book.get("odds"))
                if price is None:
                    continue
                provider_key = str(provider_key).strip()
                if market_name == "Spread":
                    line = _number(book.get("spread") if book.get("spread") is not None else book.get("bookSpread"))
                    if line is None:
                        line = _number(odd.get("bookSpread") if odd.get("bookSpread") is not None else odd.get("spread"))
                elif market_name == "Total":
                    line = _number(book.get("overUnder") if book.get("overUnder") is not None else book.get("bookOverUnder"))
                    if line is None:
                        line = _number(odd.get("bookOverUnder") if odd.get("bookOverUnder") is not None else odd.get("overUnder"))
                else:
                    line = None
                identity = (provider_key, market_name, selection, line, price)
                if identity in seen:
                    continue
                seen.add(identity)
                provider = BOOK_NAMES.get(provider_key.casefold()) or provider_key.replace("_", " ").title()
                provider_url = (
                    _book_link(links.get(provider_key))
                    or BOOK_URLS.get(provider_key.casefold())
                    or SPORTSGAMEODDS_SOURCE_URL
                )
                game["rows"].append(_row(
                    provider=provider,
                    provider_key=provider_key,
                    provider_kind="sportsbook",
                    provider_url=provider_url,
                    market=market_name,
                    selection=selection,
                    line=line,
                    price=price,
                    updated_at=str(book.get("lastUpdatedAt") or odd.get("lastUpdatedAt") or event.get("updatedAt") or ""),
                ))


def _json_values(value) -> list:
    if isinstance(value, list):
        return value
    if not isinstance(value, str):
        return []
    try:
        decoded = json.loads(value)
    except (json.JSONDecodeError, TypeError):
        return []
    return decoded if isinstance(decoded, list) else []


def build_polymarket_markets(events: list[dict], *, limit: int = 12) -> list[dict]:
    """Create compact, source-linked NFL prediction cards from public Gamma events."""
    normalized = []
    for event in events:
        if event.get("closed") is True or event.get("active") is False:
            continue
        if re.fullmatch(r"nfl-[a-z]+-[a-z]+-\d{4}-\d{2}-\d{2}", str(event.get("slug") or "")):
            continue
        markets = [
            market for market in (event.get("markets") or [])
            if market.get("closed") is not True and market.get("active") is not False
        ]
        contracts = []
        multiple = len(markets) > 1
        for market in markets:
            outcomes = _json_values(market.get("outcomes"))
            prices = _json_values(market.get("outcomePrices"))
            pairs = []
            for outcome, price in zip(outcomes, prices):
                probability = _number(price)
                if probability is not None and 0 <= probability <= 1:
                    pairs.append((str(outcome), probability))
            if not pairs:
                continue
            if multiple and {name.casefold() for name, _ in pairs} == {"yes", "no"}:
                yes = next((price for name, price in pairs if name.casefold() == "yes"), None)
                if yes is not None:
                    contracts.append({
                        "label": _text(market.get("groupItemTitle")) or _text(market.get("question")) or "Yes",
                        "probability": round(yes, 4),
                    })
            else:
                contracts.extend({"label": name, "probability": round(price, 4)} for name, price in pairs)
        if not contracts:
            continue
        contracts.sort(key=lambda item: item["probability"], reverse=True)
        slug = _text(event.get("slug"))
        normalized.append({
            "id": str(event.get("id") or slug or len(normalized)),
            "title": _text(event.get("title")) or _text(event.get("question")) or "NFL market",
            "url": f"https://polymarket.com/event/{slug}" if slug else POLYMARKET_SOURCE_URL,
            "closes_at": _text(event.get("endDate")),
            "volume": _number(event.get("volume")) or 0,
            "liquidity": _number(event.get("liquidity")) or 0,
            "contracts": contracts[:6],
        })
    normalized.sort(key=lambda item: (item["volume"], item["liquidity"]), reverse=True)
    return normalized[:limit]


def _polymarket_game_teams(event: dict) -> tuple[str | None, str | None]:
    slug = str(event.get("slug") or "")
    match = re.fullmatch(r"nfl-([a-z]+)-([a-z]+)-\d{4}-\d{2}-\d{2}", slug)
    if match:
        return _team_code(match.group(1)), _team_code(match.group(2))
    title = str(event.get("title") or "").replace(" vs. ", " vs ")
    if " vs " not in title:
        return None, None
    away, home = title.split(" vs ", 1)
    return _team_code(away), _team_code(home)


def _polymarket_main_market(markets: list[dict], market_type: str) -> dict | None:
    candidates = [market for market in markets if market.get("sportsMarketType") == market_type]
    if not candidates:
        return None

    def distance(market: dict) -> float:
        probabilities = [_number(value) for value in _json_values(market.get("outcomePrices"))]
        probabilities = [value for value in probabilities if value is not None]
        return min((abs(value - 0.5) for value in probabilities), default=1)

    return min(candidates, key=lambda market: (distance(market), -(_number(market.get("volume")) or 0)))


def add_polymarket_game_markets(games: list[dict], events: list[dict], generated_at: str) -> None:
    """Add each upcoming Polymarket game's main moneyline, spread, and total."""
    index = _game_index(games)
    for event in events:
        away, home = _polymarket_game_teams(event)
        game = index.get((away, home))
        if game is None:
            continue
        markets = [
            market for market in (event.get("markets") or [])
            if market.get("closed") is not True and market.get("active") is not False
        ]
        provider_url = (
            f"https://polymarket.com/sports/nfl/{event['slug']}"
            if event.get("slug") else POLYMARKET_SOURCE_URL
        )
        for market_type, market_name in (("moneyline", "Moneyline"), ("spreads", "Spread"), ("totals", "Total")):
            market = _polymarket_main_market(markets, market_type)
            if market is None:
                continue
            outcomes = _json_values(market.get("outcomes"))
            probabilities = _json_values(market.get("outcomePrices"))
            base_line = _number(market.get("line"))
            for outcome, raw_probability in zip(outcomes, probabilities):
                probability = _number(raw_probability)
                if probability is None or probability <= 0 or probability >= 1:
                    continue
                if market_name == "Total":
                    selection = str(outcome).title()
                    if selection not in {"Over", "Under"}:
                        continue
                    line = base_line
                else:
                    selection = _team_code(str(outcome))
                    if selection not in {away, home}:
                        continue
                    line = None if market_name == "Moneyline" else (
                        base_line if selection == home else -base_line if base_line is not None else None
                    )
                game["rows"].append(_row(
                    provider="Polymarket",
                    provider_key="polymarket",
                    provider_kind="exchange",
                    provider_url=provider_url,
                    market=market_name,
                    selection=selection,
                    line=line,
                    price=probability_to_american(probability),
                    contract_price=int(probability * 100 + 0.5),
                    updated_at=str(market.get("updatedAt") or event.get("updatedAt") or generated_at),
                ))


def mark_best_sportsbook_rows(games: list[dict]) -> None:
    """Mark the most favorable sportsbook line, then the best price at that line."""
    for game in games:
        sportsbook = [row for row in game["rows"] if row["provider_kind"] == "sportsbook"]
        groups: dict[tuple[str, str], list[dict]] = {}
        for row in sportsbook:
            groups.setdefault((row["market"], row["selection"]), []).append(row)
        for (market, selection), rows in groups.items():
            candidates = rows
            if market == "Spread":
                available_lines = [row["line"] for row in rows if row["line"] is not None]
                if not available_lines:
                    continue
                best_line = max(available_lines)
                candidates = [row for row in rows if row["line"] == best_line]
            elif market == "Total" and selection == "Over":
                available_lines = [row["line"] for row in rows if row["line"] is not None]
                if not available_lines:
                    continue
                best_line = min(available_lines)
                candidates = [row for row in rows if row["line"] == best_line]
            elif market == "Total" and selection == "Under":
                available_lines = [row["line"] for row in rows if row["line"] is not None]
                if not available_lines:
                    continue
                best_line = max(available_lines)
                candidates = [row for row in rows if row["line"] == best_line]
            available_prices = [row["price"] for row in candidates if row["price"] is not None]
            if not available_prices:
                continue
            best_price = max(available_prices)
            for row in candidates:
                row["is_best"] = row["price"] == best_price


def _nws_forecast(game: dict, *, get: Callable = requests.get) -> dict | None:
    coordinates = STADIUM_COORDINATES.get(game.get("stadium_id"))
    if not coordinates:
        return None
    headers = {
        "User-Agent": "OutlierBaseline.com (https://outlierbaseline.com)",
        "Accept": "application/geo+json",
    }
    latitude, longitude = coordinates
    point = get(
        f"{NWS_API}/points/{latitude:.4f},{longitude:.4f}",
        headers=headers,
        timeout=60,
    )
    point.raise_for_status()
    forecast_url = point.json().get("properties", {}).get("forecastHourly")
    if not forecast_url:
        return None
    forecast = get(forecast_url, headers=headers, timeout=60)
    forecast.raise_for_status()
    periods = forecast.json().get("properties", {}).get("periods", [])
    kickoff = datetime.fromisoformat(game["kickoff"])
    eligible = []
    for period in periods:
        try:
            start = datetime.fromisoformat(str(period.get("startTime")))
        except (TypeError, ValueError):
            continue
        eligible.append((abs((start.astimezone(timezone.utc) - kickoff).total_seconds()), period))
    if not eligible:
        return None
    distance, period = min(eligible, key=lambda item: item[0])
    if distance > 2 * 60 * 60:
        return None
    temperature = _number(period.get("temperature"))
    return {
        "status": "forecast",
        "summary": _text(period.get("shortForecast")) or "Forecast available",
        "temperature": int(round(temperature)) if temperature is not None else None,
        "wind_speed": _text(period.get("windSpeed")),
        "wind_direction": _text(period.get("windDirection")),
        "source_url": NWS_SOURCE_URL,
    }


def add_nws_weather(
    games: list[dict],
    *,
    now: datetime | None = None,
    get: Callable = requests.get,
) -> int:
    """Attach kickoff-hour NWS forecasts to outdoor US games inside its seven-day window."""
    now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    updated = 0
    cache: dict[tuple[str, str], dict | None] = {}
    for game in games:
        if game.get("weather", {}).get("status") != "pending":
            continue
        kickoff = datetime.fromisoformat(game["kickoff"])
        if kickoff > now + timedelta(days=7) or game.get("stadium_id") not in STADIUM_COORDINATES:
            continue
        cache_key = (str(game.get("stadium_id")), game["kickoff"][:13])
        if cache_key not in cache:
            try:
                cache[cache_key] = _nws_forecast(game, get=get)
            except (requests.RequestException, ValueError, TypeError):
                cache[cache_key] = None
        if cache[cache_key]:
            game["weather"] = cache[cache_key]
            updated += 1
        else:
            game["weather"]["status"] = "unavailable"
            game["weather"]["summary"] = "Forecast temporarily unavailable"
    return updated


def build_odds_board(
    schedule: pd.DataFrame,
    *,
    season: int,
    kalshi_events: list[dict] | None = None,
    sportsbook_events: list[dict] | None = None,
    sportsgameodds_events: list[dict] | None = None,
    polymarket_events: list[dict] | None = None,
    now: datetime | None = None,
) -> dict:
    now = now or datetime.now(timezone.utc)
    generated_at = now.astimezone(timezone.utc).isoformat()
    games = _schedule_games(schedule, season=season, now=now)
    schedule_rows = schedule.set_index("game_id")
    for game in games:
        game["rows"].extend(_reference_rows(schedule_rows.loc[game["game_id"]], generated_at))
    add_kalshi_markets(games, kalshi_events or [], generated_at)
    add_sportsbook_markets(games, sportsbook_events or [])
    add_sportsgameodds_markets(games, sportsgameodds_events or [])
    add_polymarket_game_markets(games, polymarket_events or [], generated_at)
    mark_best_sportsbook_rows(games)
    weeks = sorted({game["week"] for game in games})
    sportsbook_source = (
        {"name": "The Odds API", "url": ODDS_API_SOURCE_URL}
        if sportsbook_events
        else {"name": "SportsGameOdds", "url": SPORTSGAMEODDS_SOURCE_URL}
        if sportsgameodds_events
        else {"name": "Licensed sportsbook feed pending", "url": ODDS_API_SOURCE_URL}
    )
    return {
        "season": season,
        "generated_at": generated_at,
        "weeks": weeks,
        "has_sportsbooks": any(
            row["provider_kind"] == "sportsbook" for game in games for row in game["rows"]
        ),
        "sources": {
            "schedule": {"name": "nflverse", "url": NFLVERSE_SOURCE_URL},
            "exchange": {"name": "Kalshi public market API", "url": KALSHI_SOURCE_URL},
            "sportsbooks": sportsbook_source,
            "sportsbook_backup": {"name": "SportsGameOdds", "url": SPORTSGAMEODDS_SOURCE_URL},
            "prediction_markets": {"name": "Polymarket Gamma API", "url": POLYMARKET_SOURCE_URL},
            "weather": {"name": "National Weather Service", "url": NWS_SOURCE_URL},
        },
        "prediction_markets": build_polymarket_markets(polymarket_events or []),
        "games": games,
    }


def _get_json(url: str, *, params: dict | None = None, get: Callable = requests.get):
    response = get(url, params=params, headers={"User-Agent": "OutlierBaseline/0.2"}, timeout=120)
    response.raise_for_status()
    return response.json()


def refresh_odds_board(
    destination: str | Path,
    *,
    season: int,
    odds_api_key: str | None = None,
    sportsgameodds_api_key: str | None = None,
    status: Callable[[str], None] = print,
    get: Callable = requests.get,
) -> Path:
    """Download current documented sources and atomically refresh the public board."""
    now = datetime.now(timezone.utc)
    status(f"[1/6] Loading the {season} NFL schedule and market consensus...")
    response = get(SCHEDULE_URL, headers={"User-Agent": "OutlierBaseline/0.2"}, timeout=180)
    response.raise_for_status()
    schedule = pd.read_csv(StringIO(response.text), low_memory=False)

    status("[2/6] Loading public Kalshi NFL winner markets...")
    try:
        kalshi = _get_json(
            f"{KALSHI_API}/events",
            params={
                "series_ticker": "KXNFLGAME",
                "status": "open",
                "with_nested_markets": "true",
                "limit": 200,
            },
            get=get,
        ).get("events", [])
    except (requests.RequestException, ValueError) as error:
        status(f"[WARN] Kalshi markets are temporarily unavailable: {error}")
        kalshi = []

    key = odds_api_key or os.getenv("ODDS_API_KEY")
    sportsbooks = []
    if key:
        status("[3/6] Loading The Odds API sportsbook comparisons...")
        try:
            sportsbooks = _get_json(
                ODDS_API_URL,
                params={
                    "apiKey": key,
                    "regions": "us",
                    "markets": "h2h,spreads,totals",
                    "oddsFormat": "american",
                    "dateFormat": "iso",
                },
                get=get,
            )
        except (requests.RequestException, ValueError) as error:
            status(f"[WARN] Sportsbook comparisons are temporarily unavailable: {error}")
    else:
        status("[3/6] ODDS_API_KEY is not set; checking the backup sportsbook feed.")

    backup_key = sportsgameodds_api_key or os.getenv("SPORTSGAMEODDS_API_KEY")
    sports_game_odds = []
    if not sportsbooks and backup_key:
        status("[4/6] Loading SportsGameOdds as the backup sportsbook feed...")

        def sports_game_odds_get(url, **kwargs):
            headers = {**kwargs.pop("headers", {}), "X-Api-Key": backup_key}
            return get(url, headers=headers, **kwargs)

        try:
            response = _get_json(
                SPORTSGAMEODDS_API,
                params={
                    "leagueID": "NFL",
                    "oddsAvailable": "true",
                    "started": "false",
                    "includeAltLines": "false",
                    "limit": 100,
                },
                get=sports_game_odds_get,
            )
            sports_game_odds = response.get("data", []) if isinstance(response, dict) else []
        except (requests.RequestException, ValueError) as error:
            status(f"[WARN] Backup sportsbook comparisons are temporarily unavailable: {error}")
    elif sportsbooks:
        status("[4/6] The Odds API returned data; the SportsGameOdds backup was not needed.")
    else:
        status("[4/6] SPORTSGAMEODDS_API_KEY is not set; no licensed sportsbook fallback is available.")

    status("[5/6] Loading public Polymarket NFL prediction markets...")
    try:
        polymarket = _get_json(
            POLYMARKET_EVENTS_API,
            params={
                "active": "true",
                "closed": "false",
                "limit": 100,
                "tag_slug": "nfl",
                "order": "endDate",
                "ascending": "true",
                "end_date_min": now.isoformat(),
                "end_date_max": (now + timedelta(days=15)).isoformat(),
            },
            get=get,
        )
        if not isinstance(polymarket, list):
            polymarket = []
    except (requests.RequestException, ValueError) as error:
        status(f"[WARN] Polymarket NFL markets are temporarily unavailable: {error}")
        polymarket = []

    payload = build_odds_board(
        schedule,
        season=season,
        kalshi_events=kalshi,
        sportsbook_events=sportsbooks,
        sportsgameodds_events=sports_game_odds,
        polymarket_events=polymarket,
        now=now,
    )
    status("[6/6] Loading kickoff weather for upcoming outdoor games...")
    weather_count = add_nws_weather(payload["games"], get=get)
    status(f"[OK] Added {weather_count} National Weather Service forecasts.")
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    temporary.replace(destination)
    status(f"[OK] Weekly odds board ready: {destination}")
    return destination
