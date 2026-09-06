"""Build the public weekly NFL odds board from documented data sources."""

from __future__ import annotations

from datetime import datetime, timezone
from io import StringIO
import json
import os
from pathlib import Path
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
TEAM_ALIASES = {
    **{name.casefold(): code for code, name in TEAM_NAMES.items()},
    **{name.rsplit(" ", 1)[0].casefold(): code for code, name in TEAM_NAMES.items()},
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
        games.append({
            "game_id": str(row["game_id"]),
            "week": int(row["week"]),
            "kickoff": kickoff,
            "away": away,
            "home": home,
            "away_name": TEAM_NAMES.get(away, away),
            "home_name": TEAM_NAMES.get(home, home),
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
                contract_price=int(round(ask * 100)),
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


def build_odds_board(
    schedule: pd.DataFrame,
    *,
    season: int,
    kalshi_events: list[dict] | None = None,
    sportsbook_events: list[dict] | None = None,
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
    mark_best_sportsbook_rows(games)
    weeks = sorted({game["week"] for game in games})
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
            "sportsbooks": {"name": "The Odds API", "url": ODDS_API_SOURCE_URL},
        },
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
    status: Callable[[str], None] = print,
    get: Callable = requests.get,
) -> Path:
    """Download current documented sources and atomically refresh the public board."""
    status(f"[1/3] Loading the {season} NFL schedule and market consensus...")
    response = get(SCHEDULE_URL, headers={"User-Agent": "OutlierBaseline/0.2"}, timeout=180)
    response.raise_for_status()
    schedule = pd.read_csv(StringIO(response.text), low_memory=False)

    status("[2/3] Loading public Kalshi NFL winner markets...")
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
        status("[3/3] Loading licensed US sportsbook comparisons...")
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
        status("[3/3] ODDS_API_KEY is not set; publishing schedule, consensus, and Kalshi only.")

    payload = build_odds_board(
        schedule,
        season=season,
        kalshi_events=kalshi,
        sportsbook_events=sportsbooks,
    )
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    temporary.replace(destination)
    status(f"[OK] Weekly odds board ready: {destination}")
    return destination
