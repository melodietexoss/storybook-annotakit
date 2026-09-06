#!/usr/bin/env python3
"""Detached static file server (container-safe double-fork, serve-demo twin).

Serves a `storybook build` output directory on a port — commonly :3000 when
a reverse proxy / preview gateway forwards the public URL there. Static
files carry no Host validation, so the 403 "Invalid host" allowlist dance
from dev mode does NOT apply — any HTTP file server works.

Usage: python3 scripts/serve-static.py <dir> [port]   (port default 3000)
Kill:  kill <pid> (no async flush to await — plain http.server, exits fast).
"""

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # kit repo root
SERVE_DIR = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'examples', 'nimbus', 'dist-storybook')
PORT = sys.argv[2] if len(sys.argv) > 2 else '3000'
LOG = os.path.join(ROOT, 'examples', 'nimbus', f'static-{PORT}.log')


def daemonize():
    if os.fork():
        os._exit(0)        # parent exits → shell toolcall returns immediately
    os.setsid()            # new session, no controlling TTY
    if os.fork():
        os._exit(0)        # first child exits → grandchild reparents to PID 1
    sys.stdout.flush()
    sys.stderr.flush()
    logfd = os.open(LOG, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
    devnull = os.open('/dev/null', os.O_RDONLY)
    os.dup2(devnull, 0)
    os.dup2(logfd, 1)
    os.dup2(logfd, 2)


daemonize()
# Serve by PATH, never by chdir: a rebuild that wipes+recreates the output
# dir deletes the process cwd (os.getcwd() then raises FileNotFoundError and
# every request handler dies — observed live in v0.5.3 E2E). Passing
# `directory=` keeps the server alive across rebuilds.
import http.server  # noqa: E402  (import AFTER daemonize: stderr → log file)

# SimpleHTTPRequestHandler serves index.html for directory requests.
with http.server.ThreadingHTTPServer(('', int(PORT)), lambda *a, **kw: http.server.SimpleHTTPRequestHandler(*a, directory=os.path.abspath(SERVE_DIR), **kw)) as srv:
    srv.serve_forever()
