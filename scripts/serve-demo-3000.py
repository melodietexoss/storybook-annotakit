#!/usr/bin/env python3
"""Detached launcher for the annotakit demo Storybook (container-safe).

WHY THIS EXISTS: in ephemeral agent/CI containers every bash invocation often
spawns a fresh shell whose wrapper kills the whole descendant tree when the
call ends — `bun run storybook &` (or nohup/setsid/disown) dies within
seconds. A double-forked process reparents to PID 1 (or tini) and escapes
the kill.

Output goes to sb-<port>.log in the demo dir (NOT /dev/null) so failures stay
diagnosable. `--ci` keeps Storybook non-interactive (no TTY, no prompts, no
browser-open). Storybook AUTO-INCREMENTS the port if busy — always verify the
actual listener (ss + /annotakit/api/health), never trust the exit code.

Usage: python3 scripts/serve-demo-3000.py [port]   (default 3000)
Kill:  kill <pid>  then AWAIT exit (SIGTERM triggers the annotakit async
       shutdown flush: fetch→merge→push of the store, can take ~15s).
"""
import os
import sys

PORT = sys.argv[1] if len(sys.argv) > 1 else '3000'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # kit repo root
DEMO = os.path.join(ROOT, 'examples', 'nimbus')
LOG = os.path.join(DEMO, f'sb-{PORT}.log')


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
    os.dup2(devnull, 0)    # stdin: /dev/null (detached, no TTY)
    os.dup2(logfd, 1)      # stdout + stderr → log file
    os.dup2(logfd, 2)


daemonize()
os.chdir(DEMO)
env = dict(os.environ)
env['BROWSER'] = 'none'   # headless environment — never open a browser
os.execvp('node', ['node', os.path.join(DEMO, 'node_modules', '.bin', 'storybook'),
                   'dev', '-p', PORT, '--ci'])
