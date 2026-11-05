# Statistical pipeline diagnostics

`stat_utils.pandas_helpers` and `stat_utils.project_dataframe_utils` use standard
Python module loggers. They do not install handlers or change the application's
root logging configuration. Default Python logging shows warnings and errors;
INFO enables concise progress messages; DEBUG adds transformation details.

For a local pipeline run with diagnostics:

```python
import logging
from pipeline.runner import run_pipeline

logging.basicConfig(level=logging.WARNING)
logging.getLogger('stat_utils').setLevel(logging.DEBUG)
run_pipeline()
```

Normal text handlers display the message. Structured fields live on each
`LogRecord` in `extra`, so a JSON formatter or a custom handler can retain them.
For example, a handler can inspect `record.__dict__`, or a dedicated column-event
formatter can use `%(stage)s %(columns_before)s -> %(columns_after)s` (only on a
handler filtered to `event == 'column_changes'`). Do not apply that formatter
to all records: other event types do not have those fields.

| Event | Fields | Purpose |
| --- | --- | --- |
| `column_changes` | `stage`, `columns_before`, `columns_after` | Ordered schemas, including duplicate labels, at normalization, consolidation, removal and cleanup stages |
| `alias_consolidation` | `target`, `aliases` (or merge `targets`) | Source alias selection; precedence remains source column order |
| `columns_dropped` | `source_path`, `dropped_columns` | Configured removal rules and their effects |
| `missing_required_fields` | `stage`, `missing_fields` | Missing structural fields without inventing values |
| `missing_source_file` | `source_path` | Missing optional column-removal configuration |
| `unresolved_player_identities` | `frame_number`, `unresolved_count` | Unresolved rows remain separate rather than being joined speculatively |
| `stats_fetched`, `stats_saved`, `stats_merged` | `rows`, `column_count` | Size summaries without row previews |

Unlike `print()`, logging supports severity filtering, application-selected
handlers, timestamps and machine-readable context. Complete schemas are DEBUG
only. DataFrame row previews are never logged. Missing source/cache files,
unnamed source aggregates and fetch failures retain visible warnings/errors.
Required fields are stage-specific: player/position/games for final cleanup,
player for name normalization, and the actual directly indexed provider fields
for nflverse loading. Optional scoring adjustments are not required fields.
Warnings do not introduce new rejection or filling policies.

## Integrity and validation

The numerical operations and removal rules are unchanged. Direct helper tests
pin mixed-case/trimmed source labels, source-order alias precedence, missing
values versus measured zeroes, duplicate labels, no-match behavior, in-place
versus returned-frame behavior, and configured removal exceptions. In particular,
duplicate canonical alias labels retain the helper's existing broadcast behavior;
changing that schema policy would need a separate migration. Pipeline tests
assert DEBUG and quiet runs return identical frames, saving retains the CSV
missing-value marker, and fetching logs shape without player-row dumps.

Before editing, a saved-source rebuild from base commit
`1d0ef96dd265f7ce27c22f84e7e1b26dc45045c4` was captured. The same rebuild after
editing, at WARNING and DEBUG, matched exactly: **2,019 rows × 27 columns**,
including values, dtypes, index, column order and CSV serialization with `na_rep='-'`.
This comparison used `_load_stats(_pipeline_paths())` with the rookie-betting-line
path set to a nonexistent path to avoid regenerating input files. The optional
rookie prediction CSV was absent in this checkout, so this comparison covers
historical saved-source cleaning; existing rookie integrity/scoring tests cover
projection behavior. No live fetching or production output replacement was needed.

The website reliability workflow runs both direct diagnostic/helper test files
alongside its existing Python checks. Install `requirements.txt` first; it includes
the `schedule` dependency imported by the shared `DataFetcher` module.

Run focused regressions with:

```sh
python -m pytest -q tests/test_pandas_helpers.py tests/test_pipeline_diagnostics.py \
  tests/test_dataframe_integrity.py tests/test_pipeline_cleaning.py \
  tests/test_scoring_pipeline_audit.py tests/test_final_stat_builder.py
```
