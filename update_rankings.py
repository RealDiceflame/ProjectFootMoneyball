"""Refresh original ranking evidence using the saved archive, without providers."""
from datetime import datetime, timezone
from pathlib import Path
from app.ranking_inputs import export_ranking_inputs

if __name__ == "__main__":
    now = datetime.now(timezone.utc)
    season = now.year - (now.month < 3)
    result = export_ranking_inputs(Path(__file__).resolve().parent, season, now=now)
    print(f"Ranking inputs: {len(result['rows'])} appearances; {result['defense']['coverage']}")
