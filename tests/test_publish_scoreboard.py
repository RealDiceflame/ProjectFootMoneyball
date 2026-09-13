"""Publication retries are independent of score-source refreshes."""
import base64
import json
from pathlib import Path

import pytest
import requests

from scripts.publish_scoreboard import publish_scoreboard

OLD, CURRENT, OTHER = "a" * 40, "b" * 40, "c" * 40
SNAPSHOT = {"season": 2026, "checked_at": "2026-09-13T21:00:00Z", "games": []}


class Response:
    def __init__(self, value, status=200):
        self.value, self.status_code = value, status

    def json(self):
        return self.value

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"HTTP {self.status_code}")


class Pages:
    def __init__(self, histories, snapshots, *, status=200):
        self.histories, self.snapshots, self.status = list(histories), snapshots, status
        self.posts, self.reads, self.time = 0, [], 0

    def get(self, url, **kwargs):
        self.reads.append((url, kwargs))
        if url.endswith("/pages/builds"):
            history = self.histories.pop(0) if len(self.histories) > 1 else self.histories[0]
            return Response(history, self.status)
        snapshot = self.snapshots.get(kwargs["params"]["ref"])
        if snapshot is None:
            return Response({}, 404)
        content = base64.b64encode(json.dumps(snapshot).encode()).decode()
        return Response({"type": "file", "encoding": "base64", "content": content})

    def post(self, url, **kwargs):
        assert url.endswith("/pages/builds")
        self.posts += 1
        return Response({}, 201)

    def sleep(self, duration):
        self.time += duration

    def run(self, **kwargs):
        return publish_scoreboard("owner/repo", "test-token", SNAPSHOT, client=self,
                                  clock=lambda: self.time, sleep=self.sleep, wait_seconds=15, **kwargs)


def build(commit, status="built"):
    return {"commit": commit, "status": status}


def test_matching_scores_skip_build_even_at_a_different_commit():
    pages = Pages([[build(OTHER)]], {OTHER: SNAPSHOT})
    assert pages.run() is False
    assert pages.posts == 0


def test_retry_unpublished_committed_scores_after_a_failed_build():
    pages = Pages([[build(CURRENT, "errored"), build(OLD)], [build(CURRENT)]],
                  {OLD: {**SNAPSHOT, "checked_at": "older"}, CURRENT: SNAPSHOT})
    assert pages.run() is True
    assert pages.posts == 1


def test_failed_unrelated_build_does_not_rebuild_already_published_scores():
    pages = Pages([[build(CURRENT, "errored"), build(OLD)]], {OLD: SNAPSHOT})
    assert pages.run() is False
    assert pages.posts == 0


def test_wait_for_equivalent_pending_build_without_duplicate_request():
    pages = Pages([[build(CURRENT, "building"), build(OLD)], [build(CURRENT)]],
                  {OLD: {}, CURRENT: SNAPSHOT})
    assert pages.run() is False
    assert pages.posts == 0


def test_newer_different_deployment_is_not_masked_by_old_matching_build():
    pages = Pages([[build(OTHER), build(OLD)], [build(CURRENT)]],
                  {OTHER: {}, OLD: SNAPSHOT, CURRENT: SNAPSHOT})
    assert pages.run() is True
    assert pages.posts == 1


def test_initial_publication_when_prior_build_had_no_scoreboard():
    pages = Pages([[build(OLD)], [build(CURRENT)]], {CURRENT: SNAPSHOT})
    assert pages.run() is True
    assert pages.posts == 1


def test_publication_timeout_is_bounded_and_requests_only_one_build():
    pages = Pages([[build(OLD)]], {OLD: {}})
    with pytest.raises(RuntimeError, match="not confirmed"):
        pages.run()
    assert pages.time == 15
    assert pages.posts == 1
    assert all(0 < kwargs["timeout"] <= 10 for _, kwargs in pages.reads)


def test_api_errors_do_not_cause_unverified_build_requests():
    pages = Pages([[]], {}, status=403)
    with pytest.raises(requests.HTTPError):
        pages.run()
    assert pages.posts == 0


def test_workflow_checks_publication_after_skipped_or_failed_source_refresh():
    workflow = (Path(__file__).resolve().parents[1] / ".github/workflows/update-scores.yml").read_text()
    refresh = workflow.split("- name: Refresh reported scores", 1)[1].split("- name: Save scoreboard", 1)[0]
    publish = workflow.split("- name: Publish any unpublished scoreboard", 1)[1].split("- name: Report", 1)[0]
    assert "continue-on-error: true" in refresh
    assert "if:" not in publish
    assert "python scripts/publish_scoreboard.py" in publish
    assert "if: always() && steps.refresh.outcome == 'failure'" in workflow
