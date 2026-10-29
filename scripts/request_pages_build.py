"""Explicitly publish a Pages build after an automated data commit.

GitHub's automatic token pushes do not themselves trigger a Pages build.
"""
import os
import re
import subprocess
import time

import requests


def publish_commit(repository, token, commit, *, client=requests, clock=time.monotonic,
                   sleep=time.sleep, wait_seconds=300):
    """Confirm a successful deployment containing commit; request at most one build.

    Independent updaters can replace a Pages build with one for a newer commit.
    An errored/cancelled attempt is therefore not a final publication result.
    A descendant proves that the requested commit was included, not that later
    updates left every snapshot byte unchanged.
    """
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise ValueError("Invalid repository")
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("Invalid publication commit")
    base = f"https://api.github.com/repos/{repository}"
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"}
    deadline, ancestry, requested = clock() + wait_seconds, {}, False
    last_observation = "No successful deployment containing the requested commit observed."

    def request(method, path, **kwargs):
        remaining = deadline - clock()
        if remaining <= 0:
            raise RuntimeError(f"Pages publication not confirmed within {wait_seconds:g} seconds. "
                               f"{last_observation} Inspect the Pages build log.")
        response = getattr(client, method)(f"{base}{path}", headers=headers,
                                          timeout=min(10, remaining), **kwargs)
        response.raise_for_status()
        return response

    def includes_requested(build):
        published = build.get("commit", "")
        if not isinstance(published, str) or not re.fullmatch(r"[0-9a-f]{40}", published):
            raise ValueError("Pages returned an invalid build commit")
        if published == commit:
            return True
        if published not in ancestry:
            # API comparison also works with shallow checkouts and commits pushed
            # by another updater after this job checked out main.
            comparison = request("get", f"/compare/{commit}...{published}",
                                 params={"per_page": 1}).json()
            if not isinstance(comparison, dict) or comparison.get("status") not in {
                "ahead", "behind", "identical", "diverged"
            }:
                raise ValueError("GitHub returned an invalid commit comparison")
            ancestry[published] = comparison["status"] in {"ahead", "identical"}
        return ancestry[published]

    while clock() < deadline:
        try:
            response = request("get", "/pages/builds", params={"per_page": 100})
            builds = response.json()
            if not isinstance(builds, list) or any(not isinstance(build, dict) for build in builds):
                raise ValueError("Pages returned invalid build history")
            # History is newest first. Never let an older successful deployment
            # hide a newer successful deployment that excludes our commit.
            latest_built = next((build for build in builds if build.get("status") == "built"), None)
            if latest_built and includes_requested(latest_built):
                return latest_built["commit"]
            pending = any(build.get("status") in {"queued", "building"} and includes_requested(build)
                          for build in builds)
            last_observation = "No successful deployment containing the requested commit observed."
            if builds:
                last_observation += f" Latest build status: {builds[0].get('status', 'unknown')}."
        except (requests.Timeout, requests.ConnectionError):
            # GET is safe to retry; do not repeat a POST whose outcome is unknown.
            last_observation = "GitHub could not be reached while checking publication."
        except requests.HTTPError as error:
            if error.response is None or error.response.status_code < 500:
                raise
            last_observation = f"GitHub returned HTTP {error.response.status_code} while checking publication."
        else:
            if not requested and not pending:
                response = request("post", "/pages/builds", json={})
                if response.status_code != 201:
                    raise RuntimeError(f"Pages build request failed (HTTP {response.status_code}); "
                                       "snapshots committed, publication not confirmed.")
                requested = True
        remaining = deadline - clock()
        if remaining > 0:
            sleep(min(5, remaining))
    raise RuntimeError(f"Pages publication not confirmed within {wait_seconds:g} seconds. "
                       f"{last_observation} Inspect the Pages build log.")


def main():
    # push_snapshot.py may have rebased the data commit; use the resulting HEAD.
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    try:
        published = publish_commit(os.environ["GITHUB_REPOSITORY"], os.environ["GH_TOKEN"], commit)
    except (requests.RequestException, ValueError, RuntimeError) as error:
        raise SystemExit(f"Pages publication not confirmed: {error}") from None
    print(f"Pages publication confirmed: requested commit {commit} is included in deployment {published}.")


if __name__ == "__main__":
    main()
