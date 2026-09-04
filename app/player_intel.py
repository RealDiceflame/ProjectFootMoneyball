"""Generate source-linked fantasy football player intel for the web draft board."""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
from typing import Callable

import requests


DEFAULT_MODEL = "gpt-5.5"
DEFAULT_BOARD = "12team_2qb_te_premium_half_ppr"
API_URL = "https://api.openai.com/v1/responses"
JOB_STATUSES = {"secure", "competition", "lost", "uncertain"}
RISK_LEVELS = {"low", "medium", "high", "unknown"}
VALUE_DIRECTIONS = {"up", "neutral", "down", "volatile"}
CONFIDENCE_LEVELS = {"low", "medium", "high"}

REPORT_SCHEMA = {
    "type": "object",
    "properties": {
        "headline": {"type": "string"},
        "summary": {"type": "string"},
        "job_status": {"type": "string", "enum": sorted(JOB_STATUSES)},
        "risk_level": {"type": "string", "enum": sorted(RISK_LEVELS)},
        "role_change": {"type": "string"},
        "arrivals": {"type": "array", "items": {"type": "string"}},
        "departures": {"type": "array", "items": {"type": "string"}},
        "injuries": {"type": "array", "items": {"type": "string"}},
        "recent_news": {"type": "array", "items": {"type": "string"}},
        "fantasy_impact": {"type": "string"},
        "value_direction": {"type": "string", "enum": sorted(VALUE_DIRECTIONS)},
        "confidence": {"type": "string", "enum": sorted(CONFIDENCE_LEVELS)},
    },
    "required": [
        "headline",
        "summary",
        "job_status",
        "risk_level",
        "role_change",
        "arrivals",
        "departures",
        "injuries",
        "recent_news",
        "fantasy_impact",
        "value_direction",
        "confidence",
    ],
    "additionalProperties": False,
}


def player_key(player: str, team: str) -> str:
    """Return the shared browser/Python identifier for one player."""
    return f"{player.strip().lower()}|{team.strip().upper()}"


def load_ranked_players(rankings_path: str | Path, board: str = DEFAULT_BOARD) -> list[dict]:
    """Load the unique player pool in rank order from the website data bundle."""
    payload = json.loads(Path(rankings_path).read_text(encoding="utf-8"))
    if board not in payload["boards"]:
        board = next(iter(payload["boards"]))
    columns = payload["columns"]
    indices = {name: columns.index(name) for name in ("player", "team", "pos", "overall_rank")}
    players = []
    seen = set()
    for row in payload["boards"][board]:
        item = {name: row[index] for name, index in indices.items()}
        key = player_key(item["player"], item["team"])
        if key in seen:
            continue
        seen.add(key)
        item["key"] = key
        players.append(item)
    return players


def build_request(player: dict, *, model: str, as_of: str) -> dict:
    """Build a bounded, structured web-research request for one player."""
    prompt = f"""
Research {player['player']} ({player['pos']}, {player['team']}) for a fantasy football draft report as of {as_of}.

Focus only on information that could materially change this player's {as_of[:4]} fantasy value:
- whether the player kept, is competing for, or lost the expected starting role;
- notable players or coaches arriving who change opportunity or role;
- notable teammates leaving who change opportunity or role;
- current or recent injuries, recovery news, suspensions, contract issues, or depth-chart changes;
- recent credible news that raises uncertainty or could lower draft value.

Search the web before answering. Prefer official NFL/team transactions, injury reports, press conferences,
and reputable beat reporting. Use exact dates. Do not treat rumors as facts. When reliable information is not
available, say "No material change found" instead of guessing. Keep each list item short and decision-focused.
""".strip()
    return {
        "model": model,
        "instructions": (
            "You are a careful fantasy football news researcher. Separate confirmed facts from uncertainty. "
            "Never invent injuries, transactions, roles, dates, or sources."
        ),
        "input": prompt,
        "tools": [{"type": "web_search", "search_context_size": "medium"}],
        "tool_choice": {"type": "web_search"},
        "include": ["web_search_call.action.sources"],
        "max_tool_calls": 6,
        "max_output_tokens": 1400,
        "reasoning": {"effort": "low"},
        "text": {
            "format": {
                "type": "json_schema",
                "name": "player_intel_report",
                "strict": True,
                "schema": REPORT_SCHEMA,
            }
        },
        "store": False,
    }


def _output_text(response: dict) -> str:
    if response.get("output_text"):
        return response["output_text"]
    for item in response.get("output", []):
        if item.get("type") != "message":
            continue
        for content in item.get("content", []):
            if content.get("type") == "output_text" and content.get("text"):
                return content["text"]
    raise ValueError("OpenAI returned no report text.")


def _citation(source: dict) -> dict | None:
    nested = source.get("url_citation", source)
    url = nested.get("url")
    if not isinstance(url, str) or not url.startswith(("https://", "http://")):
        return None
    return {"title": nested.get("title") or url, "url": url}


def extract_sources(response: dict) -> list[dict]:
    """Collect unique cited pages from annotations and included web-search sources."""
    found = []
    seen = set()

    def add(source):
        item = _citation(source)
        if not item or item["url"] in seen:
            return
        seen.add(item["url"])
        found.append(item)

    for output in response.get("output", []):
        action = output.get("action") or {}
        for source in action.get("sources", []):
            add(source)
        for content in output.get("content", []):
            for annotation in content.get("annotations", []):
                add(annotation)
    return found


def _clean_text(value) -> str:
    text = str(value or "").strip()
    return re.sub(r"\ue200cite\ue202.*?\ue201", "", text).strip()


def _normalize_report(report: dict, player: dict, sources: list[dict], as_of: str) -> dict:
    lists = ("arrivals", "departures", "injuries", "recent_news")
    for field in lists:
        values = report.get(field, [])
        report[field] = [_clean_text(value) for value in values if _clean_text(value)]
    for field in ("headline", "summary", "role_change", "fantasy_impact"):
        report[field] = _clean_text(report.get(field))
    report["job_status"] = report.get("job_status") if report.get("job_status") in JOB_STATUSES else "uncertain"
    report["risk_level"] = report.get("risk_level") if report.get("risk_level") in RISK_LEVELS else "unknown"
    report["value_direction"] = report.get("value_direction") if report.get("value_direction") in VALUE_DIRECTIONS else "neutral"
    report["confidence"] = report.get("confidence") if report.get("confidence") in CONFIDENCE_LEVELS else "low"
    report.update(
        player=player["player"],
        team=player["team"],
        pos=player["pos"],
        overall_rank=player["overall_rank"],
        updated_at=as_of,
        sources=sources,
    )
    return report


def research_player(
    player: dict,
    *,
    api_key: str,
    model: str = DEFAULT_MODEL,
    as_of: str | None = None,
    post: Callable = requests.post,
) -> dict:
    """Research one player with OpenAI web search and return a normalized report."""
    as_of = as_of or date.today().isoformat()
    response = post(
        API_URL,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json=build_request(player, model=model, as_of=as_of),
        timeout=240,
    )
    response.raise_for_status()
    payload = response.json()
    if payload.get("error"):
        raise RuntimeError(payload["error"].get("message", "OpenAI could not generate the report."))
    report = json.loads(_output_text(payload))
    return _normalize_report(report, player, extract_sources(payload), as_of)


def _load_existing(path: Path) -> dict:
    if not path.exists():
        return {"generated_at": None, "model": None, "reports": {}}
    payload = json.loads(path.read_text(encoding="utf-8"))
    payload.setdefault("reports", {})
    return payload


def _write_payload(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def _is_stale(report: dict | None, as_of: date, stale_days: int) -> bool:
    if not report or not report.get("updated_at"):
        return True
    try:
        updated = date.fromisoformat(report["updated_at"])
    except ValueError:
        return True
    return updated <= as_of - timedelta(days=stale_days)


def update_reports(
    rankings_path: str | Path,
    destination: str | Path,
    *,
    api_key: str,
    model: str = DEFAULT_MODEL,
    limit: int | None = 50,
    names: list[str] | None = None,
    stale_days: int = 7,
    status: Callable[[str], None] = print,
    research: Callable = research_player,
) -> Path:
    """Refresh selected or stale player reports and save progress after each player."""
    destination = Path(destination)
    players = load_ranked_players(rankings_path)
    if names:
        wanted = {name.casefold().strip() for name in names}
        players = [player for player in players if player["player"].casefold() in wanted]
        found = {player["player"].casefold() for player in players}
        missing = sorted(wanted - found)
        if missing:
            raise ValueError(f"Player not found in rankings: {', '.join(missing)}")

    today = date.today()
    payload = _load_existing(destination)
    candidates = [
        player for player in players
        if names or _is_stale(payload["reports"].get(player["key"]), today, stale_days)
    ]
    if limit is not None:
        candidates = candidates[:limit]
    if not candidates:
        status("Player intel is already current.")
        return destination

    failures = []
    for number, player in enumerate(candidates, 1):
        status(f"[{number}/{len(candidates)}] Researching {player['player']}...")
        try:
            report = research(player, api_key=api_key, model=model, as_of=today.isoformat())
        except Exception as error:  # preserve completed reports when one source/API request fails
            failures.append(f"{player['player']}: {error}")
            status(f"[WARN] {failures[-1]}")
            continue
        payload["reports"][player["key"]] = report
        payload.update(
            generated_at=datetime.now(timezone.utc).isoformat(),
            model=model,
            report_count=len(payload["reports"]),
            source="OpenAI Responses API web search",
        )
        _write_payload(destination, payload)

    if failures:
        raise RuntimeError(f"{len(failures)} player report(s) failed; completed reports were saved.")
    return destination


def main() -> Path:
    import argparse

    parser = argparse.ArgumentParser(description="Research and publish fantasy player intel reports.")
    parser.add_argument("--rankings", type=Path, default=Path("docs/data/rankings.json"))
    parser.add_argument("--destination", type=Path, default=Path("docs/data/player_intel.json"))
    parser.add_argument("--model", default=os.getenv("OPENAI_MODEL", DEFAULT_MODEL))
    parser.add_argument("--limit", type=int, default=50, help="Maximum stale players to update.")
    parser.add_argument("--all", action="store_true", help="Update every stale player.")
    parser.add_argument("--player", action="append", help="Update one exact player name; repeat as needed.")
    parser.add_argument("--stale-days", type=int, default=7)
    args = parser.parse_args()
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        parser.error("OPENAI_API_KEY is not set. Keep the key in a GitHub secret or environment variable.")
    return update_reports(
        args.rankings,
        args.destination,
        api_key=api_key,
        model=args.model,
        limit=None if args.all else args.limit,
        names=args.player,
        stale_days=args.stale_days,
    )


if __name__ == "__main__":
    main()
