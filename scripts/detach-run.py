#!/usr/bin/env python3
"""storybook-annotakit — detach-run: run a command as a double-forked grandchild
(PID re-parented to 1) so it survives the shell/toolcall that spawned it.

WHY THIS EXISTS: agent sandboxes and shell wrappers reap the whole process
group when a toolcall ends — `cmd &`, `nohup`, `setsid`, `disown` all die with
the session. The ONLY reliable pattern is the double-fork (child decouples
stdio + setsid, forks again, execs; the grandchild is adopted by PID 1). This
is the same 15-line pattern as scripts/serve-static.py / serve-demo-3000.py,
generalized to any command — the one the one-port setup guide
(design/2026-10-09-one-port-nextjs-setup.md, setup B) needs for
`storybook dev -p 6006` behind a Next.js proxy.

Usage:
  python3 scripts/detach-run.py <name> <logfile> <cmd> [args...]

  name     label for logs/pidfile
  logfile  where stdout+stderr of the command go (created; .pid written next
           to it — reuse REFUSES while that pid is alive)
  cmd ...  the command line to run (PATH-resolved)

Examples:
  python3 scripts/detach-run.py sb sb.log bunx storybook dev -p 6006 --ci
  python3 scripts/detach-run.py next next.log bun run dev

Find it later: ss -tlnp (or read <logfile>.pid). Kill: kill <pid>, then WAIT
for the exit (a dying server flushes for ~15s; a zombie holds sqlite/git
children and starves successors).
"""
import os
import sys
import time

if len(sys.argv) < 4:
    print(__doc__)
    sys.exit(2)

name, logfile, cmd = sys.argv[1], sys.argv[2], sys.argv[3:]

pidfile = logfile + ".pid"
if os.path.exists(pidfile):
    try:
        old = int(open(pidfile).read().strip())
        os.kill(old, 0)
        print(f"REFUSE: pid {old} still alive ({name}) — kill it first", file=sys.stderr)
        sys.exit(2)
    except (ProcessLookupError, ValueError):
        pass  # stale pidfile

pid = os.fork()
if pid > 0:
    # parent: wait briefly for the grandchild pidfile, then exit
    for _ in range(50):
        if os.path.exists(pidfile):
            time.sleep(0.2)  # let the grandchild's exec settle a moment
            print(open(pidfile).read().strip())
            sys.exit(0)
        time.sleep(0.1)
    print("WARN: grandchild pidfile never appeared — check the log", file=sys.stderr)
    sys.exit(1)

# child: decouple from the session, redirect stdio, fork again
os.setsid()
log = open(logfile, "ab", buffering=0)
os.dup2(log.fileno(), 1)
os.dup2(log.fileno(), 2)
log.close()
sys.stdin.close()
pid2 = os.fork()
if pid2 > 0:
    with open(pidfile, "w") as pf:
        pf.write(str(pid2))
    os._exit(0)

# grandchild: exec (PATH lookup)
os.execvp(cmd[0], cmd)
