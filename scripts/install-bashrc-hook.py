#!/usr/bin/env python3
"""Idempotently insert or replace the agent-board-boot block in a shell rc file."""
import pathlib
import sys

BEGIN = "# >>> agent-board-boot >>>"
END = "# <<< agent-board-boot <<<"
BLOCK = f"""{BEGIN}
# Idempotent: starts Tailscale and the board if they are not already running.
if [ -x /workspace/agent-board-ops/start.sh ]; then
  /workspace/agent-board-ops/start.sh >/dev/null 2>&1 &
fi
{END}
"""

path = pathlib.Path(sys.argv[1])
text = path.read_text() if path.exists() else ""
start = text.find(BEGIN)
stop = text.find(END)
if start != -1 and stop != -1 and stop > start:
    stop += len(END)
    if stop < len(text) and text[stop] == "\n":
        stop += 1
    prefix = text[:start]
    if prefix and not prefix.endswith("\n"):
        prefix += "\n"
    new = prefix + BLOCK + text[stop:]
else:
    prefix = text
    if prefix and not prefix.endswith("\n"):
        prefix += "\n"
    if prefix:
        prefix += "\n"
    new = prefix + BLOCK

if not new.endswith("\n"):
    new += "\n"
if new != text:
    path.write_text(new)
