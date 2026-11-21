from pathlib import Path
from app.coaching import refresh_coaching

if __name__ == '__main__':
    result = refresh_coaching(Path(__file__).resolve().parent)
    print({status: sum(row['refresh_status'] == status for row in result['teams'].values()) for status in ('ok', 'retained', 'unavailable')})
