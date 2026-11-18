"""Behavioral monitoring checks; no database or GitHub credentials needed."""
from contextlib import nullcontext
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import importlib.util
import io
import json
from pathlib import Path
from urllib.error import HTTPError
import zipfile

import pytest

from app.stats_monitor import DEFAULTS, evaluate_health, monitor_config, validate_health, write_health_report

NOW = datetime(2026,11,19,12,tzinfo=timezone.utc)
REPO = "RealDiceflame/ProjectFootMoneyball"
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("stats_monitor_script", ROOT / "scripts/monitor_stats_database.py")
script = importlib.util.module_from_spec(spec)
spec.loader.exec_module(script)


def run(identity=1, hours=1, conclusion="success", event="workflow_dispatch", name=None):
    return {"id":identity,"run_attempt":1,"created_at":(NOW-timedelta(hours=hours,minutes=30)).isoformat(),
            "updated_at":(NOW-timedelta(hours=hours)).isoformat(),"head_branch":"main",
            "status":"completed","conclusion":conclusion,"event":event,"name":name,
            "head_repository":{"full_name":REPO},"path":".github/workflows/sync-stats-database.yml"}


def report(identity=1, hours=1, size=400*1024**2, event="workflow_dispatch", upstream=None):
    return {"schema_version":1,"verified":True,"completed_at":(NOW-timedelta(hours=hours)).isoformat(),
            "repository":REPO,"run_id":identity,"run_attempt":1,"event":event,"upstream_run_id":upstream,
            "counts":{"snapshots":2790,"players":5777,"games":2789,"player_game_rows":184822,
                      "team_game_rows":5578,"player_season_rows":5056},
            "storage":{"database_bytes":size,"application_relations_bytes":size//2},"website_changed":False}


def collectors(hours=2):
    return {"Update site data":[run(101,hours,event="schedule")],"Update game stats":[run(102,hours,event="schedule")]}


def assess(runs=None,reports=None,sources=None):
    return evaluate_health(runs or [run()], [] if reports is None else reports,
                           collectors() if sources is None else sources,now=NOW)


def test_success_is_quiet_and_preinstrumentation_does_not_invent_metrics():
    assert assess() == {}
    assert assess(reports=[report()]) == {}


def test_failure_and_post_sync_failure_are_distinguished_and_recover():
    assert assess([run(conclusion="failure")])["sync"]["code"] == "sync_failed"
    assert assess([run(conclusion="failure")],[report()])["shadow"]["code"] == "post_sync_check_failed"
    assert assess([run(),run(2,2,"failure")],[report()]) == {}


def test_successful_retry_uses_attempt_start_not_original_creation_time():
    retry=run(1,0.5)
    retry.update(created_at=(NOW-timedelta(hours=5)).isoformat(),
                 run_started_at=(NOW-timedelta(hours=0.75)).isoformat(),run_attempt=2)
    healthy=report(1,0.5)
    healthy["run_attempt"]=2
    assert assess([run(2,2,"failure"),retry],[healthy]) == {}


def test_skipped_and_fork_runs_cannot_be_healthy_heartbeats():
    old = run(2,11)
    assert assess([run(conclusion="skipped"),old])["sync"]["code"] == "sync_overdue"
    fork = run()
    fork["head_branch"] = "feature"
    assert assess([fork,old])["sync"]["code"] == "sync_overdue"


def test_queued_sync_does_not_hide_stalled_work():
    queued = run(2,4)
    queued.update(status="queued",conclusion=None)
    assert assess([queued,run()])["sync"]["code"] == "sync_stalled"


def test_new_attempt_of_old_run_is_not_immediately_stalled():
    active=run(2,5)
    active.update(status="in_progress",conclusion=None,run_attempt=2,
                  run_started_at=(NOW-timedelta(minutes=10)).isoformat())
    assert assess([active,run()]) == {}


def replacement(identity=2,hours=0.5):
    value=run(identity,hours)
    value.update(status="pending",conclusion=None)
    return value


def test_new_trusted_attempt_can_recover_pending_cancellation_quietly():
    assert assess([replacement(),run(1,1,"cancelled"),run(3,2)]) == {}
    alerts=assess([replacement(),run(1,1,"cancelled"),run(3,2,"failure")])
    assert alerts["sync"]=={"code":"sync_failed","run_id":3}


@pytest.mark.parametrize("conclusion", ["failure","timed_out"])
def test_replacement_does_not_suppress_real_failure(conclusion):
    alerts=assess([replacement(),run(1,1,conclusion),run(3,2)])
    assert alerts["sync"]=={"code":"sync_failed","run_id":1}


def test_replacement_does_not_suppress_post_sync_cancellation():
    alerts=assess([replacement(),run(1,1,"cancelled"),run(3,2)],[report()])
    assert alerts["shadow"]=={"code":"post_sync_check_failed","run_id":1}


@pytest.mark.parametrize("change", [
    {"head_branch":"feature"}, {"head_repository":{"full_name":"someone/else"}},
    {"path":".github/workflows/unrelated.yml"},
    {"run_started_at":(NOW-timedelta(hours=3)).isoformat()},
    {"run_started_at":(NOW+timedelta(minutes=1)).isoformat()},
])
def test_cancellation_recovery_requires_newer_trusted_nonfuture_attempt(change):
    active=replacement()
    active.update(change)
    alerts=assess([active,run(1,1,"cancelled"),run(3,2)])
    assert alerts["sync"]["code"]=="sync_failed"


def test_cancellation_recovery_keeps_stall_and_freshness_limits():
    assert assess([replacement(2,4),run(1,5,"cancelled"),run(3,6)])["sync"]["code"]=="sync_stalled"
    assert assess([replacement(),run(1,1,"cancelled"),run(3,11)])["sync"]["code"]=="sync_overdue"


def test_collector_failures_and_overdue_schedules_are_visible():
    failed = collectors()
    failed["Update site data"][0]["conclusion"] = "failure"
    assert assess(sources=failed)["collectors"]["code"] == "collector_failed"
    assert assess(sources=collectors(11))["collectors"]["code"] == "collector_schedule_overdue"


def test_completed_collector_needs_automatic_sync_not_manual_activity():
    runs = [run(1,1),run(2,8)]
    reports = [report(1,1),report(2,8)]
    assert assess(runs,reports,collectors(5))["sync"]["code"] == "collector_not_followed_by_sync"
    runs[0]["event"] = reports[0]["event"] = "workflow_run"
    reports[0]["upstream_run_id"] = 102
    # Later automatic current-main sync covers coalesced earlier collector events.
    assert assess(runs,reports,collectors(5)) == {}


def test_chain_grace_period_avoids_false_alarm_during_normal_sync():
    assert assess([run(),run(2,8)],[report(),report(2,8)],collectors(2)) == {}


@pytest.mark.parametrize("started_hours,missing", [(5.4,True),(4.9,False)])
def test_coalescing_requires_sync_to_start_after_collector_finished(started_hours,missing):
    automatic=run(1,4.5,event="workflow_run")
    automatic["run_started_at"]=(NOW-timedelta(hours=started_hours)).isoformat()
    # This automatic receipt came from another collector. Its completion time
    # alone does not prove it checked out the target collector's new commit.
    alerts=assess([automatic,run(2,8)],
                  [report(1,4.5,event="workflow_run",upstream=999),report(2,8)],collectors(5))
    assert (alerts.get("sync",{}).get("code")=="collector_not_followed_by_sync") is missing


def test_first_receipt_cannot_skip_an_overlapping_post_activation_collector():
    automatic=run(1,4.5,event="workflow_run")
    automatic["run_started_at"]=(NOW-timedelta(hours=5.4)).isoformat()
    alerts=evaluate_health([automatic],[report(1,4.5,event="workflow_run",upstream=999)],
                           collectors(5),now=NOW,config={**DEFAULTS,"active_since":NOW-timedelta(hours=6)})
    assert alerts["sync"]["code"]=="collector_not_followed_by_sync"


def test_post_activation_collector_does_not_wait_for_first_receipt():
    alerts=evaluate_health([run()],[],collectors(5),now=NOW,
                           config={**DEFAULTS,"active_since":NOW-timedelta(hours=6)})
    assert alerts["sync"]["code"]=="collector_not_followed_by_sync"
    assert evaluate_health([run()],[],collectors(2),now=NOW,
                           config={**DEFAULTS,"active_since":NOW-timedelta(hours=6)}) == {}


def test_chain_check_ignores_collectors_older_than_evidence_window_after_recovery():
    sources=collectors(2)
    sources["Update game stats"].append(run(999,49,event="schedule"))
    assert evaluate_health([run()],[report()],sources,now=NOW,
                           config={**DEFAULTS,"active_since":NOW-timedelta(days=20)}) == {}


def test_storage_requires_both_absolute_and_relative_growth():
    mib = 1024**2
    runs = [run(),run(2,8)]
    assert "storage" not in assess(runs,[report(size=600*mib),report(2,8,size=400*mib)])
    alert = assess(runs,[report(size=700*mib),report(2,8,size=400*mib)])["storage"]
    assert alert["code"] == "unusual_database_growth" and alert["growth_bytes"] == 300*mib
    assert "storage" not in assess([run(),run(2,26)],[report(size=700*mib),report(2,26,size=400*mib)])


def test_absolute_storage_warning_does_not_claim_disk_or_cost():
    alert = assess(reports=[report(size=DEFAULTS["warn_bytes"])])["storage"]
    body = script.incident_body("storage",alert)
    assert "not total provisioned disk, WAL, or a billing threshold" in body


@pytest.mark.parametrize("change", [
    {"verified":False}, {"website_changed":True}, {"run_id":False},
    {"event":"push"}, {"event":"workflow_run"}, {"upstream_run_id":123},
    {"password":"synthetic-secret"}, {"counts":{}}, {"storage":{"database_bytes":1}},
    {"schema_version":True},
])
def test_report_schema_rejects_unverified_or_private_fields(change):
    value = report()
    value.update(change)
    with pytest.raises(ValueError):
        validate_health(value,REPO,1)


def test_attempt_and_future_reports_cannot_silently_hide_failure():
    value = report()
    value["run_attempt"] = 2
    with pytest.raises(ValueError): assess(reports=[value])


def test_report_binds_to_run_window_repo_and_workflow():
    with pytest.raises(ValueError): assess(reports=[report(hours=2)])
    with pytest.raises(ValueError): assess(reports=[report(hours=0.5)])
    wrong=run()
    wrong["path"]=".github/workflows/unrelated.yml"
    with pytest.raises(ValueError): assess([wrong],[report()])
    wrong=report()
    wrong["repository"]="someone/else"
    with pytest.raises(ValueError): assess(reports=[wrong])


def test_late_old_report_from_active_rerun_cannot_supply_health():
    active=run()
    active.update(status="in_progress",conclusion=None,run_attempt=2)
    assert assess([active,run(2,11)],[report()])["sync"]["code"]=="sync_overdue"


def test_artifact_missing_after_activation_fails_before_legacy_fallback():
    client=script.GitHub("synthetic-not-a-real-token")
    calls=[]
    client.request=lambda path: calls.append(path) or {"artifacts":[]}
    with pytest.raises(ValueError,match="post-activation"):
        client.health(run(),NOW-timedelta(hours=3))
    assert len(calls)==1


def test_legacy_success_bootstrap_requires_absence_of_instrumented_step():
    client=script.GitHub("synthetic-not-a-real-token")
    client.request=lambda path: {"artifacts":[]} if path.endswith("artifacts?per_page=100") else {"jobs":[{"steps":[]}]}
    assert client.health(run(),NOW) is None
    client.request=lambda path: {"artifacts":[]} if path.endswith("artifacts?per_page=100") else {"jobs":[{"steps":[{"name":"Save aggregate sync health"}]}]}
    with pytest.raises(ValueError,match="instrumented"):
        client.health(run(),NOW)
    value = report(hours=-1)
    with pytest.raises(ValueError): assess(reports=[value])


def test_legacy_queued_run_starting_after_activation_uses_original_workflow():
    client=script.GitHub("synthetic-not-a-real-token")
    client.request=lambda path: {"artifacts":[]} if path.endswith("artifacts?per_page=100") else {"jobs":[{"steps":[]}]}
    legacy=run()
    legacy["run_started_at"]=(NOW-timedelta(minutes=10)).isoformat()
    assert client.health(legacy,NOW-timedelta(minutes=30)) is None
    # Reruns still cannot hide missing instrumentation behind old creation time.
    legacy["run_attempt"]=2
    client.request=lambda path: {"artifacts":[]} if path.endswith("artifacts?per_page=100") else {"jobs":[{"steps":[{"name":"Save aggregate sync health"}]}]}
    with pytest.raises(ValueError,match="instrumented"):
        client.health(legacy,NOW-timedelta(minutes=30))


def test_future_activation_cannot_disable_missing_evidence_alerts():
    with pytest.raises(ValueError,match="future"):
        monitor_config({"STATS_MONITOR_ACTIVE_SINCE":(NOW+timedelta(seconds=1)).isoformat()},now=NOW)
    assert monitor_config({"STATS_MONITOR_ACTIVE_SINCE":NOW.isoformat()},now=NOW)["active_since"]==NOW


def test_fresh_recovery_ignores_expired_receipts_but_requires_new_receipt():
    fresh=run()
    old=run(2,15*24)
    candidates=script.health_candidates([old,fresh],NOW)
    assert candidates==[fresh]
    client=script.GitHub("synthetic-not-a-real-token")
    client.request=lambda path: {"artifacts":[]}
    # Expired old artifacts are never requested; the fresh instrumented run
    # still fails closed until its own current receipt is available.
    with pytest.raises(ValueError,match="post-activation"):
        client.health(candidates[0],NOW-timedelta(days=20))
    assert assess([fresh,old],[report()]) == {}
    assert assess([old])["sync"]["code"]=="sync_overdue"


def test_recent_attempts_are_selected_even_when_created_before_evidence_window():
    fresh=run()
    fresh["created_at"]=(NOW-timedelta(days=15)).isoformat()
    assert script.health_candidates([fresh],NOW)==[fresh]
    assert script.health_candidates([run(2,49)],NOW)==[]


@pytest.mark.parametrize("value",["0","-1","nan","inf","wrong"])
def test_invalid_thresholds_fail_closed(value):
    with pytest.raises(ValueError): monitor_config({"STATS_MONITOR_STALE_HOURS":value})


class Connection:
    def __init__(self): self.queries=[]
    def transaction(self,**options):
        assert options == {"force_rollback":True}
        return nullcontext()
    def execute(self,query): self.queries.append(query); return self
    def fetchone(self): return 400*1024**2,300*1024**2


def test_reporting_reads_only_aggregates_and_never_serializes_credentials(tmp_path,monkeypatch):
    for key,value in {"GITHUB_REPOSITORY":REPO,"GITHUB_RUN_ID":"1","GITHUB_RUN_ATTEMPT":"1",
                      "GITHUB_EVENT_NAME":"workflow_run","STATS_SYNC_UPSTREAM_RUN_ID":"101",
                      "OUTLIER_DATABASE_PASSWORD":"synthetic-private-password"}.items():
        monkeypatch.setenv(key,value)
    destination = tmp_path/"stats-sync-health.json"
    conn = Connection()
    result = write_health_report(conn,{"verification":{"verified":True,**report()["counts"]}},destination)
    assert validate_health(result,REPO,1) == result
    assert result["upstream_run_id"] == 101
    assert "synthetic-private-password" not in destination.read_text()
    assert conn.queries[0] == "SET TRANSACTION READ ONLY"
    assert all("source_snapshots" not in query and "payload" not in query for query in conn.queries)
    assert "pg_database_size" in conn.queries[-1]


def test_report_never_written_before_full_verification(tmp_path):
    destination=tmp_path/"health.json"
    with pytest.raises(ValueError): write_health_report(Connection(),{"verification":{"verified":False}},destination)
    assert not destination.exists()


class FakeGitHub:
    def __init__(self,issues=()): self.issues=list(issues); self.calls=[]
    def monitor_issues(self): return self.issues
    def request(self,*args): self.calls.append(args)


def test_incident_dedup_update_close_and_reopen_without_comments():
    alert={"sync":{"code":"sync_failed","run_id":1}}
    client=FakeGitHub()
    assert script.reconcile(client,alert)==[{"category":"sync","action":"open"}]
    assert client.calls[0][2]["assignees"] == ["RealDiceflame"]
    issue={**client.calls[0][2],"number":10,"user":{"login":"github-actions[bot]"}}
    client=FakeGitHub([issue])
    assert script.reconcile(client,alert)==[] and client.calls==[]
    assert script.reconcile(client,{})==[{"category":"sync","action":"close"}]
    assert client.calls[0][0]=="/issues/10" and client.calls[0][2]["state"]=="closed"
    issue["state"]="closed"
    client=FakeGitHub([issue])
    assert script.reconcile(client,alert)==[{"category":"sync","action":"update"}]
    assert all("comments" not in call[0] for call in client.calls)


def test_unknown_health_never_closes_existing_incidents():
    issue={"number":10,"body":script.marker("sync"),"state":"open","user":{"login":"github-actions[bot]"}}
    client=FakeGitHub([issue])
    script.reconcile(client,{"monitor":{"code":"monitoring_evidence_unavailable"}},preserve_unmentioned=True)
    assert all(call[0]!="/issues/10" for call in client.calls)


def test_existing_incident_restores_owner_assignment_without_adding_other_contacts():
    alert={"code":"sync_failed","run_id":1}
    issue={"number":10,"body":script.incident_body("sync",alert),"state":"open",
           "title":"[Database monitor] Sync needs attention","user":{"login":"github-actions[bot]"},"assignees":[]}
    client=FakeGitHub([issue])
    script.reconcile(client,{"sync":alert})
    assert client.calls[0][2]["assignees"] == ["RealDiceflame"]


def test_artifact_redirect_never_forwards_token_and_only_reads_exact_health_file():
    stream=io.BytesIO()
    with zipfile.ZipFile(stream,"w") as archive:
        archive.writestr("stats-sync-health.json",json.dumps(report()))
    archive_bytes=stream.getvalue()
    requests=[]
    class Opener:
        def open(self,request,timeout):
            requests.append(request)
            if len(requests)==1:
                raise HTTPError(request.full_url,302,"redirect",{"Location":"https://objects.example/aggregate.zip?signature=synthetic"},None)
            return io.BytesIO(archive_bytes)
    client=script.GitHub("synthetic-github-token")
    client.opener=Opener()
    client.request=lambda path:{"artifacts":[{"id":99,"name":script.HEALTH_ARTIFACT,"expired":False,"size_in_bytes":len(archive_bytes)}]}
    assert client.health(run(),NOW-timedelta(hours=3))==report()
    assert requests[0].get_header("Authorization")=="Bearer synthetic-github-token"
    assert requests[1].get_header("Authorization") is None


def test_unexpected_artifact_files_are_not_extracted_or_inspected():
    stream=io.BytesIO()
    with zipfile.ZipFile(stream,"w") as archive:
        archive.writestr("private-data.json","synthetic-private-value")
    class Opener:
        def open(self,*args,**kwargs): return io.BytesIO(stream.getvalue())
    client=script.GitHub("synthetic-github-token")
    client.opener=Opener()
    client.request=lambda path:{"artifacts":[{"id":99,"name":script.HEALTH_ARTIFACT,"expired":False,"size_in_bytes":100}]}
    with pytest.raises(ValueError,match="unexpected files"):
        client.health(run(),NOW-timedelta(hours=3))


def test_monitor_workflow_has_no_database_credentials_and_no_sync_timer():
    text=(ROOT/".github/workflows/monitor-stats-database.yml").read_text(encoding="utf-8")
    assert "issues: write" in text and "actions: read" in text
    assert "github.ref == 'refs/heads/main'" in text
    assert "STATS_MONITOR_ACTIVE_SINCE" in text
    assert "OUTLIER_DATABASE_PASSWORD" not in text and "database_stats.py sync" not in text
    sync=(ROOT/".github/workflows/sync-stats-database.yml").read_text(encoding="utf-8")
    assert "schedule:" not in sync
