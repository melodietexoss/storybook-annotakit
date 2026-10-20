#!/usr/bin/env python3
"""Detached static file server (container-safe double-fork, serve-demo twin).

Serves a `storybook build` output directory on a port — commonly :3000 when
a reverse proxy / preview gateway forwards the public URL there. Static
files carry no Host validation, so the 403 "Invalid host" allowlist dance
from dev mode does NOT apply — any HTTP file server works.

v0.6.13 (s9 DD / 33-g P2-3 + P3-2): bind failures are LOUD and FATAL in the
PARENT. The port-in-use / bad-port / no-permission cases used to exit 0 with
the error buried in the daemon log, while a PRE-EXISTING listener kept
serving — the operator tested the STALE build believing it was fresh. The
socket is now bound BEFORE the double-fork, so the fd survives into the
grandchild and any bind error reaches the caller's stderr with exit 1.

Usage: python3 scripts/serve-static.py <dir> [port]   (port default 3000)
Kill:  kill <pid> (no async flush to await — plain http.server, exits fast).
"""

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # kit repo root
# v0.6.7 (cold-install audit): --help/-h must not be treated as a dirname —
# the daemonized grandchild used to exit 0 silently (bind error hidden in
# the side log) leaving the user with nothing.
if any(a in ('--help', '-h') for a in sys.argv[1:]):
    print(__doc__)
    raise SystemExit(0)
SERVE_DIR = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'examples', 'nimbus', 'dist-storybook')
PORT = sys.argv[2] if len(sys.argv) > 2 else '3000'
# v0.6.7 (audit P1): the log used to point unconditionally at
# <pkg>/examples/nimbus/ — a directory that does NOT exist in an npm
# install (examples/ is not in the files whitelist), so the daemonized
# grandchild died on os.open(LOG, O_CREAT) with FileNotFoundError, the
# parent had already exited 0, and no server ever listened. Write the log
# next to the SERVED directory (any dir the user can read, they can write
# next to — and when they can't, /tmp is the fallback).
LOG_CANDIDATES = [
    os.path.join(os.path.dirname(os.path.abspath(SERVE_DIR)) or '.', f'annotakit-static-{PORT}.log'),
    os.path.join(os.path.expanduser('~'), f'.annotakit-static-{PORT}.log'),
    os.path.join('/tmp', f'annotakit-static-{PORT}.log'),
]

# v0.6.13 (s9 / 33-g P2-3 + P3-2): validate the port BEFORE daemonize — a
# non-numeric port used to kill the grandchild on int(PORT) with the parent
# already gone (silent exit-0 death class).
try:
    PORT_N = int(PORT)
except ValueError:
    print(f'serve-static: FATAL: port {PORT!r} is not an integer', file=sys.stderr)
    raise SystemExit(1)

# v0.6.13 (s9 / 33-g P2-3): import + BIND in the PARENT, BEFORE any fork.
# A bind failure here (port already in use / privileged port / out of range)
# reaches the caller's stderr and exits 1 — instead of exit 0 while the
# grandchild dies in the side log and a pre-existing listener keeps serving
# STALE content. The bound+listening fd survives the double-fork, so the
# grandchild serves the FRESH build or nothing at all.
import http.server  # noqa: E402  (pre-daemonize BY DESIGN: bind errors must reach the caller, not the log)

try:
    srv = http.server.ThreadingHTTPServer(
        ('', PORT_N),
        lambda *a, **kw: http.server.SimpleHTTPRequestHandler(*a, directory=os.path.abspath(SERVE_DIR), **kw),
    )
except (OSError, OverflowError) as e:
    print(f'serve-static: FATAL: cannot bind port {PORT_N}: {e}\n'
          f'  (port already in use? `ss -ltnp | grep :{PORT_N}` — refusing to exit 0 while another listener serves STALE content)',
          file=sys.stderr)
    raise SystemExit(1)


def daemonize():
    if os.fork():
        os._exit(0)        # parent exits → shell toolcall returns immediately
    os.setsid()            # new session, no controlling TTY
    if os.fork():
        os._exit(0)        # first child exits → grandchild reparents to PID 1
    sys.stdout.flush()
    sys.stderr.flush()
    logfd = None
    for cand in LOG_CANDIDATES:
        try:
            logfd = os.open(cand, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
            break
        except OSError:
            continue
    if logfd is None:
        os._exit(3)        # nowhere to log — die loudly (parent already exited 0, so ALSO print below pre-fork)
    devnull = os.open('/dev/null', os.O_RDONLY)
    os.dup2(devnull, 0)
    os.dup2(logfd, 1)
    os.dup2(logfd, 2)


daemonize()
# Serve by PATH, never by chdir: a rebuild that wipes+recreates the output
# dir deletes the process cwd (os.getcwd() then raises FileNotFoundError and
# every request handler dies — observed live in v0.5.3 E2E). Passing
# `directory=` keeps the server alive across rebuilds.
srv.serve_forever()
