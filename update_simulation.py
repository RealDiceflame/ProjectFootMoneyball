import argparse
from pathlib import Path
from app.simulation_inputs import refresh_simulation_inputs

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--cache-dir', required=True)
    parser.add_argument('--use-cache', action='store_true')
    options = parser.parse_args()
    result = refresh_simulation_inputs(Path(__file__).resolve().parent, options.cache_dir, use_cache=options.use_cache)
    print(result['coverage'])
