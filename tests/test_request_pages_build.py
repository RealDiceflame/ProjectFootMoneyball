"""Confirm publication even when independent updaters supersede a Pages build."""
from pathlib import Path

import pytest
import requests

from scripts.request_pages_build import publish_commit

OLD, CURRENT, NEXT, UNRELATED = (letter * 40 for letter in "abcd")


class Response:
    def __init__(self, value, status=200):
        self.value, self.status_code = value, status

    def json(self):
        if isinstance(self.value, Exception):
            raise self.value
        return self.value

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"HTTP {self.status_code}", response=self)


class Pages:
    def __init__(self, histories, *, comparisons=None, post_result=None, latency=0):
        self.histories = list(histories)
        self.comparisons = {OLD: "behind", NEXT: "ahead", UNRELATED: "diverged"}
        self.comparisons.update(comparisons or {})
        self.post_result = post_result or Response({}, 201)
        self.posts, self.reads, self.time, self.latency = 0, [], 0, latency

    def get(self, url, **kwargs):
        self.reads.append((url, kwargs))
        self.time += min(self.latency, kwargs["timeout"])
        if url.endswith("/pages/builds"):
            result = self.histories.pop(0) if len(self.histories) > 1 else self.histories[0]
        else:
            assert f"/compare/{CURRENT}..." in url, "Requested commit must be the comparison base"
            result = self.comparisons[url.rsplit("...", 1)[1]]
            if isinstance(result, list):
                result = result.pop(0)
            if isinstance(result, str):
                result = {"status": result}
        if isinstance(result, Exception):
            raise result
        return result if isinstance(result, Response) else Response(result)

    def post(self, url, **kwargs):
        assert url.endswith("/pages/builds")
        self.posts += 1
        if isinstance(self.post_result, Exception):
            raise self.post_result
        return self.post_result

    def sleep(self, duration):
        self.time += duration

    def run(self, **kwargs):
        return publish_commit("owner/repo", "test-token", CURRENT, client=self,
                              clock=lambda: self.time, sleep=self.sleep, wait_seconds=15, **kwargs)


def build(commit=CURRENT, status="built"):
    return {"commit": commit, "status": status}


@pytest.mark.parametrize("commit", [CURRENT, NEXT])
def test_already_published_commit_or_descendant_skips_duplicate_build(commit):
    pages = Pages([[build(commit)]])
    assert pages.run() == commit
    assert pages.posts == 0


@pytest.mark.parametrize("status", ["errored", "cancelled"])
@pytest.mark.parametrize("successor", [CURRENT, NEXT])
def test_requested_build_failure_can_be_replaced_by_success(status, successor):
    pages = Pages([[], [build(CURRENT, status)], [build(successor)]])
    assert pages.run() == successor
    assert pages.posts == 1


def test_failed_newer_attempt_does_not_hide_current_success():
    pages = Pages([[build(NEXT, "errored"), build()]])
    assert pages.run() == CURRENT
    assert pages.posts == 0


@pytest.mark.parametrize("commit,status", [(CURRENT, "queued"), (NEXT, "building")])
def test_covering_pending_build_is_not_duplicated(commit, status):
    pages = Pages([[build(commit, status)], [build(commit)]])
    assert pages.run() == commit
    assert pages.posts == 0


def test_failed_pending_build_allows_one_replacement_request():
    pages = Pages([[build(CURRENT, "queued")], [build(CURRENT, "errored")], [build(NEXT)]])
    assert pages.run() == NEXT
    assert pages.posts == 1


@pytest.mark.parametrize("commit", [OLD, UNRELATED])
def test_newer_incompatible_success_cannot_be_masked_by_older_matching_build(commit):
    pages = Pages([[build(commit), build()]])
    with pytest.raises(RuntimeError, match="not confirmed within 15 seconds"):
        pages.run()
    assert pages.posts == 1
    assert pages.time == 15


def test_pending_unrelated_build_does_not_count_as_covering_request():
    pages = Pages([[build(UNRELATED, "building")], [build()]])
    assert pages.run() == CURRENT
    assert pages.posts == 1


def test_permanent_build_failure_is_reported_after_bounded_wait():
    pages = Pages([[build(CURRENT, "errored")]])
    with pytest.raises(RuntimeError, match="Latest build status: errored"):
        pages.run()
    assert pages.time == 15
    assert pages.posts == 1


@pytest.mark.parametrize("failure", [requests.Timeout(), requests.ConnectionError(), Response({}, 503)])
def test_transient_build_read_failure_retries_without_unverified_post(failure):
    pages = Pages([failure, [build()]])
    assert pages.run() == CURRENT
    assert pages.posts == 0


def test_transient_compare_failure_is_not_cached_as_missing_ancestry():
    pages = Pages([[build(NEXT)]], comparisons={NEXT: [Response({}, 503), "ahead"]})
    assert pages.run() == NEXT
    assert pages.posts == 0


@pytest.mark.parametrize("status", [403, 429])
@pytest.mark.parametrize("endpoint", ["builds", "compare"])
def test_api_denials_are_reported_without_requesting_a_build(status, endpoint):
    pages = Pages([Response({}, status)] if endpoint == "builds" else [[build(NEXT)]],
                  comparisons={NEXT: Response({}, status)})
    with pytest.raises(requests.HTTPError, match=f"HTTP {status}"):
        pages.run()
    assert pages.posts == 0


@pytest.mark.parametrize("result", [Response({}, 403), Response({}, 500), requests.Timeout()])
def test_failed_or_ambiguous_post_is_not_repeated(result):
    pages = Pages([[]], post_result=result)
    with pytest.raises(requests.RequestException):
        pages.run()
    assert pages.posts == 1


def test_unexpected_post_success_status_does_not_claim_publication():
    pages = Pages([[]], post_result=Response({}, 200))
    with pytest.raises(RuntimeError, match="HTTP 200"):
        pages.run()
    assert pages.posts == 1


@pytest.mark.parametrize("history", [{}, [None], [build("../bad")], Response(ValueError("Invalid JSON"))])
def test_malformed_history_cannot_confirm_or_request_a_build(history):
    pages = Pages([history])
    with pytest.raises(ValueError):
        pages.run()
    assert pages.posts == 0


def test_invalid_comparison_cannot_confirm_ancestry():
    pages = Pages([[build(NEXT)]], comparisons={NEXT: {}})
    with pytest.raises(ValueError, match="invalid commit comparison"):
        pages.run()
    assert pages.posts == 0


def test_request_time_is_included_in_deadline():
    pages = Pages([[build(CURRENT, "building")]], latency=10)
    with pytest.raises(RuntimeError, match="not confirmed within 15 seconds"):
        pages.run()
    assert pages.time == 15
    assert pages.posts == 0
    assert all(0 < options["timeout"] <= 10 for _, options in pages.reads)


def test_workflow_runs_publication_regressions_and_exercises_helper_changes():
    root = Path(__file__).resolve().parents[1]
    quality = (root / ".github/workflows/test-website.yml").read_text()
    values = (root / ".github/workflows/update-player-values.yml").read_text()
    assert "tests/test_request_pages_build.py" in quality
    assert quality.count('"scripts/request_pages_build.py"') == 2  # push and pull_request
    assert "'scripts/request_pages_build.py'" in values
