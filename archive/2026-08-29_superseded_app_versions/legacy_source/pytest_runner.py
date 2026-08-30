"""
pytest_runner.py – Simple entry point to run all tests using pytest
"""


import os
import sys
import pytest

def main():
    # Make sure we're running from the project root, not from inside tests/
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    os.chdir(root)

    # Run all tests in the tests/ folder
    exit_code = pytest.main(["tests", "-v"])
    sys.exit(exit_code)

if __name__ == "__main__":
    main()