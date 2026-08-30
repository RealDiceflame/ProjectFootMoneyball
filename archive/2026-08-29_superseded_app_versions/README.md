# Superseded app versions

Archived during the clean-pipeline release on 2026-08-29.

## `generated_builds/`

- Previous PyInstaller build caches and expanded distributions
- Previous release ZIPs
- The broken legacy `.venv`
- Generated `.spec` and run-output files

These files are not used by the current application. They are retained only
for recovery and historical comparison.

## `legacy_source/`

- One-off maintenance scripts from `tools/`
- The Selenium-based 4for4 downloader replaced by `adp_importer.py`
- The custom pytest runner replaced by `pytest.ini`
- The obsolete cleanup checklist

The current application source remains in the project root, `data_fetcher/`,
`stat_utils/`, and `tests/`.
