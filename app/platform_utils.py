"""Small operating-system helpers used by the desktop application."""

import os
from pathlib import Path
import subprocess
import sys


def open_file(path):
    """Open a file in its default application on Windows, macOS, or Linux."""
    path = str(Path(path).resolve())
    if sys.platform == "win32":
        os.startfile(path)
    elif sys.platform == "darwin":
        subprocess.Popen(["open", path])
    else:
        subprocess.Popen(["xdg-open", path])
