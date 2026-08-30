"""Compatibility entry point for the Project Foot Moneyball pipeline."""

from pipeline.runner import run_pipeline


def main():
    """Run the complete stats, ADP, projection, and ranking pipeline."""
    return run_pipeline()


if __name__ == "__main__":
    main()
