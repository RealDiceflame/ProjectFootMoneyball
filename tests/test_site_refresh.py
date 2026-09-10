import gzip
import json
from types import SimpleNamespace
import pytest
from app.player_news import _download_csv
from scripts.refresh_site import refresh_stage


def response(text):
    return SimpleNamespace(status_code=200, content=gzip.compress(text.encode()), raise_for_status=lambda: None)


def test_optional_injury_columns_are_nullable_not_required():
    frame = _download_csv("https://example.com/data", ["name", "primary", "secondary"],
                          optional_columns=("secondary",), get=lambda *a, **k: response("name,primary\nPlayer,Ankle\n"))
    assert frame.iloc[0]["primary"] == "Ankle"
    assert frame["secondary"].isna().all()
    with pytest.raises(ValueError, match="required"):
        _download_csv("https://example.com/data", ["name", "primary"], get=lambda *a, **k: response("name\nPlayer\n"))


def test_stage_failure_and_invalid_json_preserve_last_good_snapshot(tmp_path):
    saved = tmp_path / "saved.json"; saved.write_text('{"good":true}')
    def failed(*args, **kwargs):
        saved.write_text('{"partial":true}')
        return SimpleNamespace(returncode=1)
    assert not refresh_stage(["example.py"], ["saved.json"], root=tmp_path, run=failed)
    assert json.loads(saved.read_text()) == {"good": True}
    def invalid(*args, **kwargs):
        saved.write_text("invalid")
        return SimpleNamespace(returncode=0)
    assert not refresh_stage(["example.py"], ["saved.json"], root=tmp_path, run=invalid)
    assert json.loads(saved.read_text()) == {"good": True}


def test_successful_retry_and_new_files(tmp_path):
    calls = []
    def retry(*args, **kwargs):
        calls.append(1)
        (tmp_path / "new.json").write_text('{"updated":true}')
        return SimpleNamespace(returncode=0 if len(calls) == 2 else 1)
    assert refresh_stage(["example.py"], ["new.json"], root=tmp_path, run=retry)
    assert len(calls) == 2
