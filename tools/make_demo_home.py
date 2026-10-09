#!/usr/bin/env python3
"""Generate a fake ``~/.hermes`` tree with sample data for local preview/tests.

    python3 tools/make_demo_home.py /tmp/demo-hermes
    HERMES_HOME=/tmp/demo-hermes python3 server.py --port 8090

Only ever writes into the directory given on the command line.
"""

import json
import math
import os
import sqlite3
import sys
import time
from datetime import datetime, timezone

PROFILES = ("default", "editor", "obchodnik", "programovani", "skola", "tegistic")


def iso(ts):
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def profile_home(root, p):
    return root if p == "default" else os.path.join(root, "profiles", p)


def build(root, now=None, broken=True, pid=None):
    now = now or time.time()
    pid = pid or os.getpid()
    os.makedirs(os.path.join(root, "scripts"), exist_ok=True)

    # 1. usage history: every 10 minutes for 9 days
    with open(os.path.join(root, "scripts", "claude_usage_history.jsonl"), "w") as fh:
        t = now - 9 * 86400
        while t <= now:
            phase = (t % (5 * 3600)) / (5 * 3600)
            session = min(100, 95 * phase * (0.6 + 0.4 * math.sin(t / 7000.0) ** 2))
            week = ((t - (now - 9 * 86400)) % (7 * 86400)) / (7 * 86400) * 88
            fh.write(json.dumps({"ts": iso(t), "session_pct": round(session), "session_reset": "in 2h",
                                 "week_pct": round(week), "week_reset": "Mon 09:00"}) + "\n")
            t += 600
        fh.write("this line is broken\n")

    # 2. gateway state
    platforms = {}
    for p in PROFILES:
        platforms[p] = {"telegram": {"state": "connected"}}
        if p in ("default", "programovani"):
            platforms[p]["discord"] = {"state": "connected"}
    if broken:
        platforms["obchodnik"]["telegram"] = {"state": "error", "error": "401 Unauthorized"}
    with open(os.path.join(root, "gateway_state.json"), "w") as fh:
        json.dump({
            "pid": pid, "gateway_state": "running", "active_agents": 2,
            "served_profiles": list(PROFILES), "platforms": platforms,
            "active_work": {"programovani": {"summary": "review PR #12", "platform": "telegram"}},
            "code_version": "1.4.2", "code_sha": "a1b2c3d4e5f6", "start_time": 12345,
            "updated_at": iso(now - 20),
        }, fh, indent=2)

    for i, p in enumerate(PROFILES):
        home = profile_home(root, p)
        os.makedirs(os.path.join(home, "cron"), exist_ok=True)
        os.makedirs(os.path.join(home, "logs"), exist_ok=True)
        jobs = [
            {"id": "%s-daily" % p, "name": "daily-report", "schedule_display": "0 7 * * *",
             "next_run_at": iso(now + 3600 * (i + 1)), "last_run_at": iso(now - 3600 * (i + 2)),
             "last_status": "ok", "failure_streak": 0, "enabled": True},
            {"id": "%s-sync" % p, "name": "inbox-sync", "schedule_display": "every 30m",
             "next_run_at": iso(now + 600), "last_run_at": iso(now - 1200),
             "last_status": "ok", "failure_streak": 0, "enabled": True},
            {"id": "%s-old" % p, "name": "legacy-cleanup", "schedule_display": "weekly",
             "next_run_at": None, "last_run_at": iso(now - 8 * 86400),
             "last_status": "ok", "failure_streak": 0, "enabled": False},
        ]
        if broken and p in ("editor", "skola"):
            jobs[1].update(last_status="error", failure_streak=3 if p == "skola" else 1,
                           last_error="TimeoutError: upstream did not respond")
        with open(os.path.join(home, "cron", "jobs.json"), "w") as fh:
            json.dump(jobs, fh, indent=2)
        with open(os.path.join(home, "agent.log"), "w") as fh:
            for k in range(120):
                level = "WARNING" if k % 17 == 5 else ("ERROR" if k % 41 == 7 else "INFO")
                fh.write("%s %s agent: handled message %d\n" % (iso(now - 300 * (120 - k)), level, k))
        # cron run history: <home>/cron/output/<job_id>/<YYYY-mm-dd_HH-MM-SS>.md
        for job, step, count in ((jobs[0], 86400, 10), (jobs[1], 1800, 30)):
            out_dir = os.path.join(home, "cron", "output", job["id"])
            os.makedirs(out_dir, exist_ok=True)
            last = datetime.fromisoformat(job["last_run_at"].replace("Z", "+00:00")).timestamp()
            streak = job["failure_streak"]
            for r in range(count):
                t = last - r * step
                failed = r < streak or (r % 11 == 4)
                name = datetime.fromtimestamp(t).strftime("%Y-%m-%d_%H-%M-%S") + ".md"
                with open(os.path.join(out_dir, name), "w") as fh:
                    fh.write("# Cron Job: %s%s\n\n**Job ID:** %s\n**Schedule:** %s\n\n## Prompt\n\nDo the %s thing.\n\n"
                             % (job["name"], " (FAILED)" if failed else "", job["id"], job["schedule_display"], job["name"]))
                    if failed:
                        fh.write("## Error\n\nTimeoutError: upstream did not respond\n")
                    else:
                        fh.write("## Response\n\nDone. Processed %d items for %s.\n" % (r * 3 + 1, p))
                # mtime = end of the run -> dashboard estimates run duration
                end = t + 20 + (i * 37 + r * 13) % (240 if step > 3600 else 90)
                os.utime(os.path.join(out_dir, name), (end, end))
        if broken and p in ("default", "obchodnik"):
            with open(os.path.join(home, "logs", "errors.log"), "w") as fh:
                fh.write("%s ERROR gateway: telegram poll failed\nTraceback (most recent call last):\n"
                         "  File \"x.py\", line 1\nValueError: boom\n" % iso(now - 1800))
                fh.write("%s WARNING cron: job took 95s\n" % iso(now - 7200))
                fh.write("%s ERROR old error outside 24h\n" % iso(now - 3 * 86400))
        db = os.path.join(home, "state.db")
        if os.path.exists(db):
            os.remove(db)
        conn = sqlite3.connect(db)
        conn.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY, started_at TEXT)")
        conn.execute("CREATE TABLE session_model_usage (session_id TEXT, model TEXT, input_tokens INTEGER,"
                     " output_tokens INTEGER, cache_read_tokens INTEGER, estimated_cost_usd REAL,"
                     " actual_cost_usd REAL)")
        for d in range(14):
            for s in range(1 + (d + i) % 4):
                sid = "%s-%d-%d" % (p, d, s)
                conn.execute("INSERT INTO sessions VALUES (?, ?)", (sid, iso(now - d * 86400 - s * 1000)))
                conn.execute("INSERT INTO session_model_usage VALUES (?,?,?,?,?,?,?)",
                             (sid, "claude", 20000 + 5000 * i, 3000 + 700 * s, 50000, 0.12 + 0.03 * i, None))
        conn.commit()
        conn.close()
    return root


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: make_demo_home.py <target-dir>")
    # this script exits right away, so point the fake gateway PID at the
    # parent shell (normally still alive while the demo server runs)
    print(build(os.path.abspath(sys.argv[1]), pid=os.getppid()))
