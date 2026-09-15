"""Retry unpublished score snapshots without rebuilding an unchanged scoreboard."""
import base64
import argparse
import json
import os
import re
import subprocess
import time

import requests

SCORE_PATH = "docs/data/scores.json"


def publish_scoreboard(repository, token, snapshot, *, client=requests, clock=time.monotonic,
                       sleep=time.sleep, wait_seconds=180, snapshot_path=SCORE_PATH):
    """Compare committed scores with successful builds; request at most one build."""
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise ValueError("Invalid repository")
    if snapshot_path not in {SCORE_PATH, "docs/data/game_stats/index.json"}:
        raise ValueError("Unsupported public snapshot")
    base = f"https://api.github.com/repos/{repository}"
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"}
    deadline, snapshots, requested = clock() + wait_seconds, {}, False

    def request(method, url, **kwargs):
        remaining = deadline - clock()
        if remaining <= 0:
            raise RuntimeError("Scoreboard publication was not confirmed within three minutes")
        return getattr(client, method)(url, headers=headers, timeout=min(10, remaining), **kwargs)

    def matches(build):
        commit = build.get("commit", "")
        if not re.fullmatch(r"[0-9a-f]{40}", commit):
            raise ValueError("Pages returned an invalid build commit")
        if commit not in snapshots:
            response = request("get", f"{base}/contents/{snapshot_path}", params={"ref": commit})
            if response.status_code == 404:
                snapshots[commit] = None  # A build from before the scoreboard was added.
            else:
                response.raise_for_status()
                item = response.json()
                if item.get("encoding") != "base64" or item.get("type") != "file":
                    raise ValueError("Could not read the published score snapshot")
                content = base64.b64decode("".join(item["content"].split()), validate=True)
                snapshots[commit] = json.loads(content)
        return snapshots[commit] == snapshot

    while True:
        response = request("get", f"{base}/pages/builds", params={"per_page": 10})
        response.raise_for_status()
        builds = response.json()
        if not isinstance(builds, list) or any(not isinstance(build, dict) for build in builds):
            raise ValueError("Pages returned invalid build history")
        # Newest first: an older matching build cannot override a newer deployed snapshot.
        latest_built = next((build for build in builds if build.get("status") == "built"), None)
        if latest_built and matches(latest_built):
            return requested
        pending = any(build.get("status") in {"queued", "building"} and matches(build)
                      for build in builds)
        if not requested and not pending:
            response = request("post", f"{base}/pages/builds", json={})
            if response.status_code != 201:
                raise RuntimeError(f"Pages build request failed (HTTP {response.status_code})")
            requested = True
        remaining = deadline - clock()
        if remaining <= 0:
            raise RuntimeError("Scoreboard publication was not confirmed within three minutes")
        sleep(min(5, remaining))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stats", action="store_true", help="Verify publication of the game-stats archive")
    args = parser.parse_args()
    path = "docs/data/game_stats/index.json" if args.stats else SCORE_PATH
    # Read the committed artifact, never an uncommitted result of a failed save.
    content = subprocess.check_output(["git", "show", f"HEAD:{path}"])
    requested = publish_scoreboard(os.environ["GITHUB_REPOSITORY"], os.environ["GH_TOKEN"],
                                  json.loads(content), snapshot_path=path)
    print("Snapshot published successfully." if requested else "Snapshot publication is current.")


if __name__ == "__main__":
    main()
