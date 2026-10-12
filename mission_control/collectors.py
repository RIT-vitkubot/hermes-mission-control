"""Host data collectors: read-only access to files, SQLite, /proc and CLIs.

Nothing in this module writes to Hermes data and nothing calls an LLM API.
The only side-effecting function is :func:`restart_gateway`.
"""

import os
import shutil
import sqlite3
import subprocess
import threading
import time
from collections import deque
from datetime import datetime, timedelta

try:
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
except ImportError:  # pragma: no cover - Python < 3.9
    ZoneInfo = None
    ZoneInfoNotFoundError = Exception

from . import PROFILES
from . import parsing

DEFAULT_REPOS = (
    "process-supervisor",
    "sysstatus-history",
    "profile-health-check",
    "shared-error-log",
    "auto-pr-review",
    "hermes-mission-control",
)


class Config(object):
    def __init__(self, hermes_home=None, profiles=PROFILES, github_org="RIT-vitkubot",
                 repos=DEFAULT_REPOS, hermes_bin=None, gh_bin=None, use_cli=True):
        self.hermes_home = os.path.expanduser(hermes_home or os.environ.get("HERMES_HOME") or "~/.hermes")
        self.profiles = tuple(profiles)
        self.github_org = github_org
        self.repos = tuple(repos)
        self.hermes_bin = hermes_bin or os.environ.get("MC_HERMES_BIN") or shutil.which("hermes")
        self.gh_bin = gh_bin or os.environ.get("MC_GH_BIN") or shutil.which("gh")
        self.use_cli = use_cli

    def profile_home(self, profile):
        if profile == "default":
            return self.hermes_home
        return os.path.join(self.hermes_home, "profiles", profile)

    def profile_args(self, profile):
        return [] if profile == "default" else ["-p", profile]


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

class TTLCache(object):
    """Tiny thread-safe cache with optional background refresh.

    With ``background=True`` a stale value is returned immediately while a
    refresh runs in a thread; the very first call returns ``default``.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._data = {}  # key -> (expires, value)
        self._running = set()

    def get(self, key, ttl, fn, background=False, default=None):
        now = time.time()
        with self._lock:
            entry = self._data.get(key)
            if entry and entry[0] > now:
                return entry[1]
            if background:
                if key not in self._running:
                    self._running.add(key)
                    threading.Thread(target=self._refresh, args=(key, ttl, fn), daemon=True).start()
                return entry[1] if entry else default
        value = fn()
        with self._lock:
            self._data[key] = (time.time() + ttl, value)
        return value

    def _refresh(self, key, ttl, fn):
        try:
            value = fn()
        except Exception as exc:  # never kill the server because of a collector
            value = {"error": str(exc)}
        with self._lock:
            self._data[key] = (time.time() + ttl, value)
            self._running.discard(key)


def read_text(path, max_bytes=None):
    """Read a text file (optionally only its last ``max_bytes``). None if missing."""
    try:
        with open(path, "rb") as fh:
            if max_bytes:
                fh.seek(0, os.SEEK_END)
                size = fh.tell()
                fh.seek(max(0, size - max_bytes))
                data = fh.read()
                if size > max_bytes:
                    nl = data.find(b"\n")
                    data = data[nl + 1:] if nl >= 0 else data
            else:
                data = fh.read()
    except (IOError, OSError):
        return None
    return data.decode("utf-8", errors="replace")


def read_head(path, max_bytes):
    """First ``max_bytes`` of a text file, or None if missing."""
    try:
        with open(path, "rb") as fh:
            data = fh.read(max_bytes)
    except (IOError, OSError):
        return None
    return data.decode("utf-8", errors="replace")


def tail_lines(path, n=40, max_bytes=256 * 1024):
    text = read_text(path, max_bytes=max_bytes)
    if text is None:
        return None
    return text.splitlines()[-n:]


def run_cmd(args, timeout=20):
    """Run a command, return ``(returncode, stdout, stderr)``; never raises."""
    try:
        proc = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              stdin=subprocess.DEVNULL, timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        return -1, (exc.stdout or b"").decode("utf-8", "replace"), "timeout after %ss" % timeout
    except (OSError, ValueError) as exc:
        return -1, "", str(exc)
    return (proc.returncode, proc.stdout.decode("utf-8", "replace"),
            proc.stderr.decode("utf-8", "replace"))


# The operator lives in Europe/Prague while the production host clock runs on
# Etc/UTC, so display times must not follow the system TZ. Override with
# ``--tz`` or env ``MC_TZ``.
DEFAULT_TZ = "Europe/Prague"
_display_tz_name = os.environ.get("MC_TZ") or DEFAULT_TZ


def set_display_tz(name):
    """Set the IANA zone used for display times and day buckets."""
    global _display_tz_name
    _display_tz_name = name or DEFAULT_TZ


def display_tz():
    """tzinfo for the configured zone (system local only if zoneinfo is unusable)."""
    if ZoneInfo is not None:
        try:
            return ZoneInfo(_display_tz_name)
        except (ZoneInfoNotFoundError, ValueError, OSError):
            pass
    return datetime.now().astimezone().tzinfo


def host_tz(now=None):
    """Name and UTC offset of the display zone at ``now`` (epoch seconds)."""
    dt = datetime.fromtimestamp(time.time() if now is None else now, display_tz())
    off = dt.utcoffset()
    return {"name": dt.tzname(), "zone": _display_tz_name,
            "offset_seconds": int(off.total_seconds()) if off else 0}


# ---------------------------------------------------------------------------
# Collectors
# ---------------------------------------------------------------------------

class Collector(object):
    def __init__(self, config):
        self.cfg = config
        self.cache = TTLCache()
        self._restart_lock = threading.Lock()
        # Restart timeline lives only in memory (lost when the dashboard
        # restarts); nothing is ever written to disk for it.
        self._events_lock = threading.Lock()
        self._restart_events = deque(maxlen=50)
        self._gw_snapshot = None

    # -- 1. usage ---------------------------------------------------------
    def usage_points(self):
        path = os.path.join(self.cfg.hermes_home, "scripts", "claude_usage_history.jsonl")

        def load():
            text = read_text(path)
            return parsing.parse_usage_jsonl(text) if text is not None else None

        return self.cache.get("usage", 10, load)

    def usage(self, window):
        points = self.usage_points()
        if points is None:
            return {"available": False, "window": window, "points": [], "latest": None, "tz": host_tz()}
        now = time.time()
        out = parsing.usage_series(points, window, now)
        out["available"] = True
        out["forecast"] = {
            "session": parsing.quota_eta(points, "session_pct", now, lookback=3 * 3600, period=5 * 3600),
            "week": parsing.quota_eta(points, "week_pct", now, lookback=48 * 3600, min_span=3 * 3600,
                                      period=7 * 86400),
        }
        out["tz"] = host_tz()
        return out

    # -- 2. gateway -------------------------------------------------------
    def gateway_raw(self):
        import json
        text = read_text(os.path.join(self.cfg.hermes_home, "gateway_state.json"))
        if text is None:
            return None
        try:
            data = json.loads(text)
        except ValueError:
            return None
        return data if isinstance(data, dict) else None

    def gateway(self):
        raw = self.gateway_raw()
        pid_alive = uptime = None
        if raw and raw.get("pid"):
            try:
                pid = int(raw["pid"])
            except (TypeError, ValueError):
                pid = None
            if pid:
                pid_alive = os.path.exists("/proc/%d" % pid) if os.path.isdir("/proc") else None
                uptime = self._uptime(pid) if pid_alive else None
        now = time.time()
        summary = parsing.summarize_gateway(raw, self.cfg.profiles, now=now,
                                            pid_alive=pid_alive, uptime=uptime)
        summary["started_at"] = (now - uptime) if uptime is not None else None
        self._observe_gateway(summary, now)
        return summary

    def _observe_gateway(self, gw, now):
        """Record gateway down/up/restart transitions seen while polling."""
        snap = {"pid": gw.get("pid"), "running": bool(gw.get("running")), "started_at": gw.get("started_at")}
        with self._events_lock:
            event = parsing.gateway_transition(self._gw_snapshot, snap)
            self._gw_snapshot = snap
            if event:
                event.update({"ts": now, "source": "observed"})
                self._restart_events.append(event)

    def restart_events(self, limit=20):
        """Newest-first list of restart API calls and observed transitions."""
        with self._events_lock:
            return list(reversed(self._restart_events))[:limit]

    @staticmethod
    def _uptime(pid):
        stat = read_text("/proc/%d/stat" % pid)
        sys_up = read_text("/proc/uptime")
        if not stat or not sys_up:
            return None
        parsed = parsing.parse_proc_stat(stat)
        if not parsed:
            return None
        try:
            hz = os.sysconf("SC_CLK_TCK")
        except (ValueError, OSError, AttributeError):
            hz = 100
        return parsing.proc_uptime_seconds(parsed[3], sys_up.split()[0], hz)

    # -- 3. processes (sub-agent estimate) -------------------------------
    def processes(self, root_pid):
        if not root_pid or not os.path.isdir("/proc"):
            return None
        ppid_map, info = {}, {}
        try:
            names = os.listdir("/proc")
        except OSError:
            return None
        for name in names:
            if not name.isdigit():
                continue
            stat = read_text("/proc/%s/stat" % name)
            parsed = parsing.parse_proc_stat(stat) if stat else None
            if parsed:
                ppid_map[parsed[0]] = parsed[2]
                info[parsed[0]] = parsed
        try:
            root = int(root_pid)
        except (TypeError, ValueError):
            return None
        if root not in ppid_map:
            return None
        sys_up = read_text("/proc/uptime")
        try:
            hz = os.sysconf("SC_CLK_TCK")
        except (ValueError, OSError, AttributeError):
            hz = 100
        out = []
        for pid in parsing.descendants(ppid_map, root):
            raw = read_text("/proc/%d/cmdline" % pid) or ""
            cmd = raw.replace("\x00", " ").strip() or "[%s]" % info[pid][1]
            out.append({
                "pid": pid,
                "ppid": info[pid][2],
                "elapsed": parsing.proc_uptime_seconds(info[pid][3], sys_up.split()[0], hz) if sys_up else None,
                "cmd": cmd[:240],
                "profile": parsing.attribute_process(cmd, self.cfg.profiles),
            })
        return out

    # -- 4. cron -----------------------------------------------------------
    def cron(self, profile):
        def load():
            text = read_text(os.path.join(self.cfg.profile_home(profile), "cron", "jobs.json"))
            jobs = parsing.parse_jobs_json(text) if text is not None else None
            return parsing.summarize_jobs(jobs, profile)

        return self.cache.get("cron:" + profile, 5, load)

    # -- 3b. agent log tail ------------------------------------------------
    def agent_log(self, profile, n=8, max_bytes=256 * 1024):
        home = self.cfg.profile_home(profile)
        for rel in ("agent.log", os.path.join("logs", "agent.log")):
            lines = tail_lines(os.path.join(home, rel), n, max_bytes=max_bytes)
            if lines is not None:
                return lines
        return None

    def agent_log_detail(self, profile, n=300):
        """Longer ``agent.log`` tail for the profile detail view."""
        lines = self.agent_log(profile, n, max_bytes=1024 * 1024)
        return {"profile": profile, "available": lines is not None, "lines": lines or [],
                "requested": n}

    # -- 4b. cron run history ---------------------------------------------
    def _job_run_files(self, profile, job):
        """``(source, [(ts, name, path, mtime)])`` newest first for one job.

        Only files directly inside ``<home>/cron/output/<id or name>/`` are
        listed (job ids from jobs.json are never used as a path otherwise).
        """
        out_root = os.path.join(self.cfg.profile_home(profile), "cron", "output")
        for name in (job.get("id"), job.get("name")):
            name = str(name) if name is not None else ""
            if not name or os.path.basename(name) != name or name in (".", ".."):
                continue
            job_dir = os.path.join(out_root, name)
            try:
                files = os.listdir(job_dir)
            except OSError:
                continue
            # newest first by file name (timestamped), then mtime as tie-breaker
            entries = []
            for f in files:
                path = os.path.join(job_dir, f)
                if not os.path.isfile(path):
                    continue
                try:
                    mtime = os.path.getmtime(path)
                except OSError:
                    continue
                entries.append((parsing.run_ts_from_name(f) or mtime, f, path, mtime))
            entries.sort(reverse=True)
            return "cron/output/%s" % name, entries
        return None, []

    @staticmethod
    def _fallback_run(job):
        return {"file": None, "ts": job["last_run_at"], "size": None, "truncated": False, "duration": None,
                "status": "error" if job["status"] == "error" else "ok",
                "preview": str(job.get("last_error") or job.get("last_status") or "")}

    def cron_runs(self, profile, job_key, limit=50):
        """Run history of one job from ``<home>/cron/output/<job_id>/*.md``.

        Falls back to the single last run recorded in ``jobs.json`` when no
        output directory exists.
        """
        summary = self.cron(profile)
        job = parsing.find_job(summary, job_key)
        if job is None:
            return {"profile": profile, "found": False, "job": None, "runs": [], "count": 0}
        source, entries = self._job_run_files(profile, job)
        runs = [parsing.parse_cron_run(f, read_text(path, max_bytes=64 * 1024), mtime=mtime)
                for _ts, f, path, mtime in entries[:limit]]
        if source is None and job.get("last_run_at"):
            source = "cron/jobs.json"
            runs = [self._fallback_run(job)]
        out = parsing.run_history(runs, limit)
        out.update({"profile": profile, "found": True, "job": job, "source": source})
        return out

    def cron_recent(self, profile, n=12):
        """``{job id or name: [last n runs, oldest first]}`` for sparklines.

        Reads only the first 4 KiB of each output file (enough for the status
        heading) and is cached for a minute.
        """
        def load():
            out = {}
            for job in self.cron(profile).get("jobs", []):
                source, entries = self._job_run_files(profile, job)
                runs = [parsing.parse_cron_run(f, read_head(path, 4096), mtime=mtime)
                        for _ts, f, path, mtime in entries[:n]]
                if source is None and job.get("last_run_at"):
                    runs = [self._fallback_run(job)]
                out[str(job.get("id") or job["name"])] = parsing.job_spark(runs, n)
            return out

        return self.cache.get("cron-recent:%s:%d" % (profile, n), 60, load)

    # -- 5. errors / incidents -------------------------------------------
    def error_log(self, profile, since):
        home = self.cfg.profile_home(profile)
        for rel in (os.path.join("logs", "errors.log"), "errors.log"):
            path = os.path.join(home, rel)
            text = read_text(path, max_bytes=512 * 1024)
            if text is not None:
                return parsing.parse_log_lines(text, profile=profile, source=rel, since=since)
        if not (self.cfg.use_cli and self.cfg.hermes_bin):
            return []

        def load():
            rc, out, _err = run_cmd([self.cfg.hermes_bin] + self.cfg.profile_args(profile) +
                                    ["logs", "errors", "--since", "24h"], timeout=20)
            if rc != 0:
                return []
            return parsing.parse_log_lines(out, profile=profile, source="hermes logs errors")

        entries = self.cache.get("errlog:" + profile, 60, load, background=True, default=[]) or []
        if isinstance(entries, dict):
            return []
        return [e for e in entries if e["ts"] is None or e["ts"] >= since]

    def cron_incidents_cli(self, profile):
        """``hermes cron incidents`` for a profile, or None if unavailable."""
        if not (self.cfg.use_cli and self.cfg.hermes_bin):
            return None

        def load():
            rc, out, _err = run_cmd([self.cfg.hermes_bin] + self.cfg.profile_args(profile) +
                                    ["cron", "incidents"], timeout=20)
            if rc != 0:
                return None
            return parsing.parse_cron_incidents(out, profile)

        result = self.cache.get("incidents:" + profile, 60, load, background=True, default=None)
        return result if isinstance(result, list) else None

    def incidents_detail(self, profile=None, min_level=None, hours=24, limit=1000):
        """Wider incident list for the incident detail view (up to 7 days).

        The CLI fallbacks only ever cover their own window (24 h), log files
        are read up to their last 512 KiB.
        """
        now = time.time()
        since = now - hours * 3600
        profiles = [profile] if profile else list(self.cfg.profiles)
        groups = []
        for p in profiles:
            groups.append(self.error_log(p, since))
            cli = self.cron_incidents_cli(p)
            groups.append(cli if cli is not None else parsing.incidents_from_jobs(self.cron(p)))
        merged = parsing.merge_incidents(*groups, limit=None)
        all_counts = parsing.count_levels(merged)
        items = parsing.filter_incidents(merged, min_level=min_level, since=since, limit=limit)
        return {"now": now, "hours": hours, "profile": profile, "min_level": min_level,
                "counts": all_counts, "total": len(merged), "incidents": items}

    def incidents(self, cron_summaries=None):
        now = time.time()
        since = now - 24 * 3600
        groups = []
        summaries = cron_summaries or [self.cron(p) for p in self.cfg.profiles]
        for summary in summaries:
            p = summary["profile"]
            groups.append(self.error_log(p, since))
            cli = self.cron_incidents_cli(p)
            # Prefer the authoritative CLI; fall back to failures from jobs.json.
            groups.append(cli if cli is not None else parsing.incidents_from_jobs(summary))
        return parsing.merge_incidents(*groups)

    # -- 6. GitHub ---------------------------------------------------------
    def github(self):
        if not self.cfg.gh_bin:
            return {"available": False, "reason": "gh CLI not found", "repos": []}

        def load():
            repos = []
            for name in self.cfg.repos:
                full = "%s/%s" % (self.cfg.github_org, name)
                entry = {"repo": full, "name": name, "url": "https://github.com/" + full}
                rc, out, err = run_cmd([self.cfg.gh_bin, "repo", "view", full, "--json",
                                        "pushedAt,defaultBranchRef,url"], timeout=20)
                view = parsing.parse_repo_view(out) if rc == 0 else None
                if view:
                    entry.update(view)
                    entry["url"] = view.get("url") or entry["url"]
                else:
                    entry["error"] = (err or out).strip()[:200] or "gh repo view failed"
                rc, out, err = run_cmd([self.cfg.gh_bin, "pr", "list", "--repo", full, "--state", "open",
                                        "--json", "number,title,url"], timeout=20)
                prs = parsing.parse_pr_list(out) if rc == 0 else None
                entry["open_prs"] = prs if prs is not None else []
                if prs is None and "error" not in entry:
                    entry["error"] = (err or out).strip()[:200] or "gh pr list failed"
                repos.append(entry)
            return {"available": True, "repos": repos, "fetched_at": time.time()}

        result = self.cache.get("github", 300, load, background=True, default=None)
        if result is None:
            return {"available": True, "loading": True, "repos": []}
        if "error" in result and "repos" not in result:
            return {"available": False, "reason": result["error"], "repos": []}
        return result

    # -- 1b. tokens / cost from state.db ----------------------------------
    def tokens(self, days=14):
        return self.cache.get("tokens:%d" % days, 120, lambda: self._tokens(days))

    def _tokens(self, days):
        since = time.time() - days * 86400
        profiles = []
        for p in self.cfg.profiles:
            path = os.path.join(self.cfg.profile_home(p), "state.db")
            entry = {"profile": p, "available": False, "days": {}, "totals": {}}
            if os.path.exists(path):
                try:
                    entry["days"], entry["totals"] = read_token_usage(path, since)
                    entry["available"] = True
                except sqlite3.Error as exc:
                    entry["error"] = str(exc)
            profiles.append(entry)
        today = datetime.now(display_tz()).date()
        day_keys = [(today - timedelta(days=i)).isoformat() for i in range(days - 1, -1, -1)]
        return {"days": days, "day_keys": day_keys, "profiles": profiles, "tz": host_tz()}

    # -- 1c. monthly forecast --------------------------------------------
    def forecast(self):
        return self.cache.get("forecast", 300, self._forecast)

    def _forecast(self):
        today = datetime.now(display_tz()).date()
        prev_start = (today.replace(day=1) - timedelta(days=1)).replace(day=1)
        since = datetime(prev_start.year, prev_start.month, prev_start.day, tzinfo=display_tz()).timestamp()
        profiles, total_cost, total_tokens = [], {}, {}
        for p in self.cfg.profiles:
            path = os.path.join(self.cfg.profile_home(p), "state.db")
            entry = {"profile": p, "available": False}
            if os.path.exists(path):
                try:
                    days, _ = read_token_usage(path, since)
                except sqlite3.Error as exc:
                    entry["error"] = str(exc)
                else:
                    cost = {d: parsing.day_cost(b) for d, b in days.items()}
                    tokens = {d: parsing.day_tokens(b) for d, b in days.items()}
                    for d in days:
                        total_cost[d] = total_cost.get(d, 0) + cost[d]
                        total_tokens[d] = total_tokens.get(d, 0) + tokens[d]
                    entry.update(available=True, cost=parsing.month_forecast(cost, today),
                                 tokens=parsing.month_forecast(tokens, today))
            profiles.append(entry)
        avail = any(e["available"] for e in profiles)
        return {
            "available": avail,
            "today": today.isoformat(),
            "cost": parsing.month_forecast(total_cost, today) if avail else None,
            "tokens": parsing.month_forecast(total_tokens, today) if avail else None,
            "profiles": profiles,
            "method": "průměr posledních 7 celých dní × zbývající dny v měsíci",
        }

    # -- 7. restart --------------------------------------------------------
    def restart_gateway(self, timeout=120, client=None):
        if not self.cfg.hermes_bin:
            result = {"ok": False, "error": "hermes CLI not found on PATH"}
            self.record_restart_call(time.time(), result, client)
            return result
        if not self._restart_lock.acquire(blocking=False):
            return {"ok": False, "error": "restart already in progress"}
        try:
            started = time.time()
            rc, out, err = run_cmd([self.cfg.hermes_bin, "gateway", "restart"], timeout=timeout)
            result = {"ok": rc == 0, "returncode": rc, "stdout": out[-8000:], "stderr": err[-8000:],
                      "duration": round(time.time() - started, 2)}
            self.record_restart_call(started, result, client)
            return result
        finally:
            self._restart_lock.release()

    def record_restart_call(self, ts, result, client=None):
        tail = (result.get("stderr") or result.get("stdout") or result.get("error") or "").strip()
        with self._events_lock:
            self._restart_events.append({
                "ts": ts, "source": "api", "kind": "api_restart", "ok": bool(result.get("ok")),
                "returncode": result.get("returncode"), "duration": result.get("duration"),
                "client": client, "message": tail.splitlines()[-1][:200] if tail else None,
            })

    # -- aggregate ---------------------------------------------------------
    def cron_with_runs(self, profile):
        """Cron summary copy whose jobs carry ``recent`` (sparkline) runs."""
        summary = self.cron(profile)
        recent = self.cron_recent(profile)
        jobs = [dict(j, recent=recent.get(str(j.get("id") or j["name"]), [])) for j in summary["jobs"]]
        return dict(summary, jobs=jobs)

    def state(self):
        gateway = self.gateway()
        crons = [self.cron_with_runs(p) for p in self.cfg.profiles]
        incidents = self.incidents(crons)
        usage_pts = self.usage_points()
        latest = usage_pts[-1] if usage_pts else None
        now = time.time()
        procs = self.processes(gateway.get("pid")) if gateway.get("pid_alive") else None
        agents = []
        for p, cron in zip(self.cfg.profiles, crons):
            plats = [x for x in gateway.get("platforms", []) if x["profile"] == p]
            if gateway.get("available") and not gateway.get("running"):
                connected = False  # platform states in the file are stale
            elif not plats:
                connected = None
            else:
                connected = all(x["status"] == "ok" for x in plats)
            work = parsing.active_work_for(gateway.get("active_work"), p, self.cfg.profiles)
            agents.append({
                "profile": p,
                "label": "BMO" if p == "default" else p,
                "served": p in gateway.get("served_profiles", []),
                "connected": connected,
                "platforms": plats,
                "activity": parsing.describe_work(work),
                "busy": bool(work),
                "cron": {k: cron[k] for k in ("available", "counts", "last_run_at", "last_job",
                                              "next_run_at", "next_job")},
                "processes": len([x for x in procs if x["profile"] == p]) if procs is not None else None,
                "log_tail": self.agent_log(p),
                "health": parsing.profile_health(connected, cron,
                                                 [i for i in incidents if i.get("profile") == p],
                                                 latest, now=now),
            })
        summary = parsing.overall_status(gateway, crons, incidents, latest, now=now)
        return {
            "now": now,
            "tz": host_tz(),
            "summary": summary,
            "gateway": gateway,
            "agents": agents,
            "processes": {
                "estimate": len(procs) if procs is not None else None,
                "unattributed": len([x for x in procs if not x["profile"]]) if procs is not None else None,
                "list": procs[:50] if procs is not None else [],
                "note": "Odhad podle child procesů gateway PID, ne přesný počet sub-agentů.",
            },
            "cron": crons,
            "incidents": incidents,
            "usage_latest": latest,
            "restarts": self.restart_events(10),
        }


    # -- comparison across profiles ----------------------------------------
    def compare(self, days=14):
        """One row per profile for the side-by-side comparison view."""
        st = self.state()
        tokens = {p["profile"]: p for p in self.tokens(days)["profiles"]}
        crons = {c["profile"]: c for c in st["cron"]}
        rows = []
        for a in st["agents"]:
            p = a["profile"]
            cron = crons.get(p, {"jobs": [], "counts": {}})
            jobs = cron["jobs"]
            runs = [(j["name"], r) for j in jobs for r in j.get("recent", [])]
            timed = [(name, r["duration"]) for name, r in runs if r.get("duration") is not None]
            longest = max(timed, key=lambda x: x[1]) if timed else None
            streak_job = max(jobs, key=lambda j: j["failure_streak"]) if jobs else None
            incs = [i for i in st["incidents"] if i.get("profile") == p]
            tok = tokens.get(p, {})
            days_ = tok.get("days", {}).values()
            ok_runs = len([r for _, r in runs if r["status"] == "ok"])
            rows.append({
                "profile": p,
                "label": a["label"],
                "health": a["health"]["score"],
                "health_level": a["health"]["level"],
                "connected": a["connected"],
                "busy": a["busy"],
                "processes": a["processes"],
                "jobs_total": len(jobs),
                "jobs_failing": cron.get("counts", {}).get("error", 0),
                "jobs_overdue": len(parsing.overdue_jobs(cron, st["now"])),
                "max_streak": streak_job["failure_streak"] if streak_job else 0,
                "max_streak_job": streak_job["name"] if streak_job and streak_job["failure_streak"] else None,
                "longest_run_seconds": longest[1] if longest else None,
                "longest_run_job": longest[0] if longest else None,
                "run_success_rate": round(ok_runs / float(len(runs)), 3) if runs else None,
                "incidents_24h": len(incs),
                "critical_24h": len([i for i in incs if i["level"] == "critical"]),
                "errors_24h": len([i for i in incs if i["level"] == "error"]),
                "warnings_24h": len([i for i in incs if i["level"] == "warning"]),
                "tokens": round(sum(parsing.day_tokens(b) for b in days_)) if tok.get("available") else None,
                "cost_usd": round(sum(parsing.day_cost(b) for b in tok.get("days", {}).values()), 4)
                if tok.get("available") else None,
            })
        return {"now": st["now"], "days": days, "rows": rows}

    # -- export -------------------------------------------------------------
    def export(self, kind, window="all", days=14, profile=None, min_level=None, hours=24):
        """``(rows, columns)`` for CSV/JSON export, or None for unknown kind."""
        if kind == "usage":
            points = self.usage_points() or []
            rows = parsing.filter_window(points, window if window in parsing.WINDOWS else "all", time.time())
            return parsing.usage_export_rows(rows), parsing.USAGE_EXPORT_COLUMNS
        if kind == "tokens":
            return parsing.token_export_rows(self.tokens(days))
        if kind == "incidents":
            res = self.incidents_detail(profile, min_level, hours, limit=None)
            return parsing.incident_export_rows(res["incidents"]), parsing.INCIDENT_EXPORT_COLUMNS
        if kind == "compare":
            rows = self.compare(days)["rows"]
            return rows, list(rows[0].keys()) if rows else ["profile"]
        return None


def read_token_usage(path, since):
    """Aggregate ``session_model_usage`` JOIN ``sessions`` per local day.

    Opens the DB strictly read-only. Column names are introspected so minor
    schema differences do not break the dashboard.
    """
    uri = "file:%s?mode=ro" % path
    conn = sqlite3.connect(uri, uri=True, timeout=2)
    try:
        cols_u = [r[1] for r in conn.execute("PRAGMA table_info(session_model_usage)")]
        cols_s = [r[1] for r in conn.execute("PRAGMA table_info(sessions)")]
        if not cols_u or not cols_s:
            raise sqlite3.OperationalError("missing session_model_usage/sessions tables")
        token_cols = [c for c in cols_u if "token" in c.lower()]
        cost_cols = [c for c in ("estimated_cost_usd", "actual_cost_usd") if c in cols_u]
        fk = "session_id" if "session_id" in cols_u else None
        pk = "id" if "id" in cols_s else ("session_id" if "session_id" in cols_s else None)
        if not fk or not pk or "started_at" not in cols_s:
            raise sqlite3.OperationalError("unexpected schema (need session_id/started_at)")
        select = ", ".join(['s."started_at"'] + ['u."%s"' % c for c in token_cols + cost_cols])
        rows = conn.execute('SELECT %s FROM session_model_usage u JOIN sessions s ON u."%s" = s."%s"'
                            % (select, fk, pk))
        days, totals = {}, {}
        for row in rows:
            ts = parsing.parse_ts(row[0])
            if ts is None or ts < since:
                continue
            day = datetime.fromtimestamp(ts, display_tz()).strftime("%Y-%m-%d")
            bucket = days.setdefault(day, {})
            for name, value in zip(token_cols + cost_cols, row[1:]):
                try:
                    v = float(value or 0)
                except (TypeError, ValueError):
                    continue
                bucket[name] = bucket.get(name, 0) + v
                totals[name] = totals.get(name, 0) + v
        return days, totals
    finally:
        conn.close()
