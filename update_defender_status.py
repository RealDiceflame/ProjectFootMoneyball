from datetime import datetime, timezone
from pathlib import Path
from app.defender_inputs import refresh_defender_status

if __name__ == '__main__':
    now = datetime.now(timezone.utc)
    result = refresh_defender_status(Path(__file__).resolve().parent, now.year - (now.month < 3), now=now)
    print(f"Validated defender roster: {len(result['reports'])} players; injury context {result['injury_context']['status']}")
