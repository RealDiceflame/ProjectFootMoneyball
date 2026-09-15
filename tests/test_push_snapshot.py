from types import SimpleNamespace
import pytest
from scripts.push_snapshot import push_snapshot


def test_push_race_rebases_and_retries_without_force():
    results=iter([0,1,0,0]);calls=[]
    def run(command,**kwargs):
        calls.append(command);return SimpleNamespace(returncode=next(results))
    push_snapshot(run=run,sleep=lambda _:None)
    assert calls==[["git","pull","--rebase","origin","main"],["git","push"]]*2


def test_conflict_stops_without_overwriting_and_push_failures_are_bounded():
    calls=[]
    def conflict(command,**kwargs):
        calls.append(command);return SimpleNamespace(returncode=1)
    with pytest.raises(RuntimeError,match="reconcile"):push_snapshot(run=conflict)
    assert len(calls)==1
    def rejected(command,**kwargs):return SimpleNamespace(returncode=0 if "pull" in command else 1)
    with pytest.raises(RuntimeError,match="bounded"):push_snapshot(run=rejected,sleep=lambda _:None)
