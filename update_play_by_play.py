"""Import and validate the complete 2025 regular-season play-by-play archive."""
from pathlib import Path
from app.play_by_play import refresh_play_by_play

if __name__ == "__main__":
    print(refresh_play_by_play(Path(__file__).resolve().parent))
