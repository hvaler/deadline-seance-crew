"""Starts a Node script of this app from the app's own folder.

Why: Crew anchors a relative `.py` launcher in mcpServers to the installed app
folder, but leaves a relative `node <file>.mjs` as written, and kiro-cli starts
the server in the session's folder, where that file does not exist. This
launcher knows its own location, so the relative script path always resolves.

Usage (from app.json): "command": "python", "args": ["bin/node-launch.py", "<script relative to the app root>"]
Writes nothing to stdout itself: stdout is the MCP channel.
"""

import os
import shutil
import subprocess
import sys


def main() -> int:
    root = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
    if len(sys.argv) < 2:
        print("node-launch: name a script", file=sys.stderr)
        return 2
    script = os.path.realpath(os.path.join(root, sys.argv[1]))
    if os.path.commonpath([root, script]) != root or not os.path.isfile(script):
        print("node-launch: the script is not a file inside the app", file=sys.stderr)
        return 2
    node = shutil.which("node")
    if node is None:
        print("node-launch: node is not on PATH", file=sys.stderr)
        return 127
    # No cwd change: a running process whose cwd is the app folder keeps Windows from replacing that folder on update.
    return subprocess.call([node, script, *sys.argv[2:]])


if __name__ == "__main__":
    sys.exit(main())
