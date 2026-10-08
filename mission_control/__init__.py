"""Hermes Mission Control — read-only, zero-LLM-token monitoring dashboard.

The package never calls any LLM API. It only reads local files, SQLite
databases and the output of the ``hermes`` / ``gh`` CLIs. The single
side-effecting action is ``hermes gateway restart`` triggered explicitly
from the UI.
"""

__version__ = "0.1.0"

PROFILES = ("default", "editor", "obchodnik", "programovani", "skola", "tegistic")
