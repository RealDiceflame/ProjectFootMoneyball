"""Publish a snapshot commit despite another independent updater racing the push."""
import subprocess
import time


def push_snapshot(*, run=subprocess.run, sleep=time.sleep, attempts=3):
    for attempt in range(attempts):
        # Rebase only; never force-push or resolve overlapping edits automatically.
        if run(["git", "pull", "--rebase", "origin", "main"], check=False).returncode:
            raise RuntimeError("Could not reconcile the snapshot with main; inspect the update log")
        if run(["git", "push"], check=False).returncode == 0:
            return
        if attempt + 1 < attempts:
            print("Another update may have published first; retrying against current main.", flush=True)
            sleep(2)
    raise RuntimeError("Snapshot push failed after bounded retries; no forced update attempted")


if __name__ == "__main__":
    push_snapshot()
