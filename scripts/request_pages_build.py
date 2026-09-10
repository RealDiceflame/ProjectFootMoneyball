"""Explicitly publish a Pages build after an automated data commit.

GitHub's automatic token pushes do not themselves trigger a Pages build.
"""
import os
import subprocess
import time
import requests


def main():
    repository = os.environ["GITHUB_REPOSITORY"]
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    url = f"https://api.github.com/repos/{repository}/pages/builds"
    headers = {"Authorization": f"Bearer {os.environ['GH_TOKEN']}", "Accept": "application/vnd.github+json"}
    response = requests.post(url, headers=headers, json={}, timeout=30)
    if response.status_code != 201:
        raise SystemExit(f"Pages build request failed (HTTP {response.status_code}); snapshots committed, publication not confirmed.")
    for _ in range(36):
        response = requests.get(f"{url}/latest", headers=headers, timeout=30)
        if response.ok:
            build = response.json()
            if build.get("commit") == commit and build.get("status") == "built":
                print("Refreshed snapshots published successfully.")
                return
            if build.get("commit") == commit and build.get("status") == "errored":
                raise SystemExit("Pages publication failed; inspect the Pages build log.")
        time.sleep(5)
    raise SystemExit("Pages publication was requested but not confirmed within three minutes.")


if __name__ == "__main__":
    main()
