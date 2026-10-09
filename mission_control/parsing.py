"""Pure parsing / aggregation functions.

Everything here works on already-loaded text or Python objects so it can be
unit-tested without touching the host. No I/O, no subprocesses, no LLM calls.
"""

import json
import re
from datetime import datetime, timezone

from . import PROFILES

# ---------------------------------------------------------------------------
# Timestamps
# ---------------------------------------------------------------------------

_ISO_FRACTION_RE = re.compile(r"(\.\d+)")


def parse_ts(value):
    """Convert an ISO-8601 string / epoch seconds / epoch millis to epoch seconds.

    Naive ISO strings are interpreted as host-local time. Returns ``None`` for
    anything that cannot be parsed.
    """
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        v = float(value)
        if v <= 0:
            return None
        if v > 1e14:  # microseconds
            return v / 1e6
        if v > 1e11:  # milliseconds
            return v / 1e3
        return v
    if not isinstance(value, str):
        return None
    s = value.strip()
    if not s:
        return None
    try:
        return parse_ts(float(s))
    except ValueError:
        pass
    if s.endswith("Z") or s.endswith("z"):
        s = s[:-1] + "+00:00"
    s = s.replace(",", ".", 1) if re.match(r"^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2},\d", s) else s
    # Python < 3.11 fromisoformat only accepts 3 or 6 fractional digits.
    m = _ISO_FRACTION_RE.search(s)
    if m:
        frac = m.group(1)
        fixed = (frac + "000000")[:7]
        s = s[: m.start()] + fixed + s[m.end():]
    if len(s) >= 5 and s[-5] in "+-" and s[-4:].isdigit() and ":" not in s[-5:]:
        s = s[:-2] + ":" + s[-2:]  # +0200 -> +02:00
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.astimezone()  # host local
    return dt.timestamp()


def iso(ts):
    """Epoch seconds -> ISO string in UTC (or None)."""
    if ts is None:
        return None
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat().replace("+00:00", "Z")


# ---------------------------------------------------------------------------
# 1. Claude usage history (JSONL)
# ---------------------------------------------------------------------------

WINDOWS = {
    "6h": 6 * 3600,
    "24h": 24 * 3600,
    "7d": 7 * 86400,
    "30d": 30 * 86400,
    "all": None,
}


def _pct(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    if v != v:  # NaN
        return None
    return max(0.0, min(100.0, v))


def parse_usage_jsonl(text):
    """Parse ``claude_usage_history.jsonl`` content.

    Returns a list of dicts ``{ts, session_pct, week_pct, session_reset,
    week_reset}`` sorted by ``ts``. Broken lines are skipped silently.
    """
    points = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        if not isinstance(obj, dict):
            continue
        ts = parse_ts(obj.get("ts"))
        if ts is None:
            continue
        session = _pct(obj.get("session_pct"))
        week = _pct(obj.get("week_pct"))
        if session is None and week is None:
            continue
        points.append({
            "ts": ts,
            "session_pct": session,
            "week_pct": week,
            "session_reset": obj.get("session_reset"),
            "week_reset": obj.get("week_reset"),
        })
    points.sort(key=lambda p: p["ts"])
    return points


def filter_window(points, window, now):
    """Keep only points within ``window`` (key of WINDOWS) before ``now``."""
    seconds = WINDOWS.get(window, WINDOWS["24h"]) if window in WINDOWS else WINDOWS["24h"]
    if seconds is None:
        return list(points)
    start = now - seconds
    return [p for p in points if p["ts"] >= start]


def downsample(points, max_points=1500):
    """Reduce the number of points while preserving the peaks.

    Points are grouped into equal-size buckets; for each bucket the point with
    the highest ``session_pct`` is kept (plus always the last point).
    """
    n = len(points)
    if n <= max_points or max_points < 2:
        return list(points)
    bucket = n / float(max_points - 1)
    out = []
    i = 0.0
    while int(i) < n - 1:
        chunk = points[int(i): max(int(i + bucket), int(i) + 1)]
        out.append(max(chunk, key=lambda p: (p["session_pct"] or 0, p["week_pct"] or 0)))
        i += bucket
    if out[-1] is not points[-1]:
        out.append(points[-1])
    return out


def usage_series(points, window, now, max_points=1500):
    selected = filter_window(points, window, now)
    latest = points[-1] if points else None
    return {
        "window": window if window in WINDOWS else "24h",
        "count": len(selected),
        "points": [
            {"ts": p["ts"], "session_pct": p["session_pct"], "week_pct": p["week_pct"]}
            for p in downsample(selected, max_points)
        ],
        "latest": latest,
    }


# ---------------------------------------------------------------------------
# 2. Gateway state
# ---------------------------------------------------------------------------

_GOOD_STATES = {"connected", "running", "ok", "online", "ready", "up", "active", "healthy"}
_BAD_STATES = {"error", "failed", "disconnected", "down", "offline", "crashed", "stopped", "dead"}


def classify_state(state):
    """Map a free-form state string to ``ok`` / ``error`` / ``unknown``."""
    if state is True:
        return "ok"
    if state is False:
        return "error"
    if not isinstance(state, str):
        return "unknown"
    s = state.strip().lower()
    if s in _GOOD_STATES:
        return "ok"
    if s in _BAD_STATES or "error" in s or "fail" in s:
        return "error"
    return "unknown"


def _platform_entry(profile, platform, value):
    error = None
    detail = None
    if isinstance(value, dict):
        state = None
        for key in ("state", "status", "connected", "connection"):
            if key in value:
                state = value[key]
                break
        error = value.get("error") or value.get("last_error")
        detail = value.get("updated_at") or value.get("since")
    else:
        state = value
    if isinstance(state, bool):
        state_str = "connected" if state else "disconnected"
    elif state is None:
        state_str = "error" if error else "unknown"
    else:
        state_str = str(state)
    return {
        "profile": profile,
        "platform": str(platform),
        "state": state_str,
        "status": classify_state(state_str),
        "error": str(error) if error else None,
        "detail": detail,
    }


def normalize_platforms(platforms, profiles=PROFILES):
    """Normalize the many plausible shapes of ``gateway_state.json.platforms``.

    Supported shapes::

        {"default": {"telegram": "connected"}}                 # profile -> platform
        {"default": {"telegram": {"state": "error", ...}}}
        {"default:telegram": "connected"}                      # combined key
        {"telegram": "connected"}                              # platform only
        [{"profile": "default", "platform": "telegram", "state": "connected"}]

    Returns a list of ``{profile, platform, state, status, error, detail}``.
    """
    out = []
    known = set(profiles)
    if isinstance(platforms, list):
        for item in platforms:
            if not isinstance(item, dict):
                continue
            profile = item.get("profile") or item.get("profile_name") or "default"
            platform = item.get("platform") or item.get("name") or "?"
            out.append(_platform_entry(str(profile), platform, item))
        return out
    if not isinstance(platforms, dict):
        return out
    for key, value in platforms.items():
        key = str(key)
        split = re.split(r"[:/]", key, maxsplit=1)
        if len(split) == 2 and (split[0] in known or split[1] not in known):
            out.append(_platform_entry(split[0], split[1], value))
        elif key in known and isinstance(value, dict) and not _looks_like_state_dict(value):
            for platform, pvalue in value.items():
                out.append(_platform_entry(key, platform, pvalue))
        elif isinstance(value, dict) and value.get("profile"):
            out.append(_platform_entry(str(value["profile"]), value.get("platform") or key, value))
        else:
            out.append(_platform_entry("default", key, value))
    return out


def _looks_like_state_dict(value):
    return any(k in value for k in ("state", "status", "connected", "connection"))


def proc_uptime_seconds(start_time_jiffies, system_uptime, clk_tck):
    """Uptime of a process from /proc/<pid>/stat ``starttime`` (jiffies)."""
    try:
        start = float(start_time_jiffies) / float(clk_tck)
        up = float(system_uptime) - start
    except (TypeError, ValueError, ZeroDivisionError):
        return None
    return up if up >= 0 else None


def summarize_gateway(state, profiles=PROFILES, now=None, pid_alive=None, uptime=None):
    """Build the gateway panel payload from parsed ``gateway_state.json``."""
    if not isinstance(state, dict):
        return {
            "available": False,
            "running": False,
            "state": "missing",
            "status": "error",
            "platforms": [],
            "served_profiles": list(profiles),
        }
    gw_state = state.get("gateway_state") or state.get("state") or "unknown"
    running = classify_state(gw_state) == "ok"
    if pid_alive is False:
        running = False
    updated_ts = parse_ts(state.get("updated_at"))
    served = state.get("served_profiles")
    if not isinstance(served, list) or not served:
        served = list(profiles)
    platforms = normalize_platforms(state.get("platforms"), profiles=tuple(served) + tuple(profiles))
    errors = [p for p in platforms if p["status"] == "error"]
    if not running:
        status = "error"
    elif errors:
        status = "warn"
    else:
        status = "ok"
    return {
        "available": True,
        "running": running,
        "state": str(gw_state) if pid_alive is not False else "%s (pid dead)" % gw_state,
        "status": status,
        "pid": state.get("pid"),
        "pid_alive": pid_alive,
        "uptime_seconds": uptime,
        "active_agents": state.get("active_agents"),
        "active_work": state.get("active_work"),
        "served_profiles": [str(p) for p in served],
        "platforms": platforms,
        "platform_errors": len(errors),
        "code_version": state.get("code_version"),
        "code_sha": state.get("code_sha"),
        "updated_at": updated_ts,
        "updated_age": (now - updated_ts) if (now is not None and updated_ts is not None) else None,
    }


def active_work_for(active_work, profile, profiles=PROFILES):
    """Extract what ``profile`` is doing from ``gateway_state.active_work``.

    ``active_work`` may be null, a dict keyed by profile, a list of items with
    a ``profile`` key, or a single item. Returns ``None`` when idle.
    """
    if not active_work:
        return None
    if isinstance(active_work, dict):
        if any(k in profiles for k in active_work):
            return active_work.get(profile) or None
        owner = active_work.get("profile")
        if owner is None:
            return active_work if profile == "default" else None
        return active_work if owner == profile else None
    if isinstance(active_work, list):
        mine = [w for w in active_work
                if isinstance(w, dict) and (w.get("profile") or "default") == profile]
        return mine or None
    return active_work if profile == "default" else None


def describe_work(work):
    """Short human readable string for an ``active_work`` entry."""
    if not work:
        return "idle"
    if isinstance(work, str):
        return work
    if isinstance(work, list):
        parts = [describe_work(w) for w in work]
        return "; ".join(p for p in parts if p) or "busy"
    if isinstance(work, dict):
        for key in ("summary", "description", "task", "title", "message", "kind", "type"):
            if work.get(key):
                text = str(work[key])
                if work.get("platform"):
                    text = "%s (%s)" % (text, work["platform"])
                return text
        return "busy"
    return str(work)


# ---------------------------------------------------------------------------
# 4. Cron jobs
# ---------------------------------------------------------------------------

def parse_jobs_json(text):
    """Parse a ``cron/jobs.json`` file. Accepts a list or ``{"jobs": [...]}``."""
    try:
        data = json.loads(text)
    except ValueError:
        return None
    if isinstance(data, dict):
        for key in ("jobs", "items", "cron"):
            if isinstance(data.get(key), list):
                data = data[key]
                break
        else:
            # dict keyed by job id/name
            if all(isinstance(v, dict) for v in data.values()):
                data = [dict(v, name=v.get("name") or k) for k, v in data.items()]
            else:
                return None
    if not isinstance(data, list):
        return None
    return [j for j in data if isinstance(j, dict)]


def job_status(job):
    """Classify a cron job: ``paused`` / ``error`` / ``ok`` / ``pending``."""
    enabled = job.get("enabled", True)
    if enabled is False or str(job.get("state", "")).lower() == "paused":
        return "paused"
    last = str(job.get("last_status") or "").strip().lower()
    streak = _int(job.get("failure_streak"))
    if streak > 0 or last in ("error", "failed", "failure", "timeout", "crashed"):
        return "error"
    if not last and not job.get("last_run_at"):
        return "pending"
    return "ok"


def _int(value):
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def normalize_job(job, profile):
    return {
        "profile": profile,
        "id": job.get("id") or job.get("job_id"),
        "name": job.get("name") or job.get("id") or "?",
        "schedule": job.get("schedule_display") or job.get("schedule") or job.get("cron"),
        "enabled": job.get("enabled", True) is not False,
        "next_run_at": parse_ts(job.get("next_run_at")),
        "last_run_at": parse_ts(job.get("last_run_at")),
        "last_status": job.get("last_status"),
        "last_error": job.get("last_error"),
        "failure_streak": _int(job.get("failure_streak")),
        "status": job_status(job),
    }


def summarize_jobs(jobs, profile):
    """Normalize jobs for ``profile`` and compute per-profile aggregates."""
    if jobs is None:
        return {"profile": profile, "available": False, "jobs": [], "counts": {},
                "last_run_at": None, "next_run_at": None, "last_job": None, "next_job": None}
    items = [normalize_job(j, profile) for j in jobs]
    items.sort(key=lambda j: ({"error": 0, "ok": 1, "pending": 2, "paused": 3}[j["status"]], str(j["name"])))
    counts = {}
    for j in items:
        counts[j["status"]] = counts.get(j["status"], 0) + 1
    with_last = [j for j in items if j["last_run_at"]]
    with_next = [j for j in items if j["next_run_at"] and j["enabled"]]
    last = max(with_last, key=lambda j: j["last_run_at"]) if with_last else None
    nxt = min(with_next, key=lambda j: j["next_run_at"]) if with_next else None
    return {
        "profile": profile,
        "available": True,
        "jobs": items,
        "counts": counts,
        "last_run_at": last["last_run_at"] if last else None,
        "last_job": {"name": last["name"], "status": last["status"]} if last else None,
        "next_run_at": nxt["next_run_at"] if nxt else None,
        "next_job": {"name": nxt["name"]} if nxt else None,
    }


# ---------------------------------------------------------------------------
# 5. Errors / incidents
# ---------------------------------------------------------------------------

_LOG_TS_RE = re.compile(
    r"^\s*\[?(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\]?"
)
_LEVEL_RE = re.compile(r"\b(DEBUG|INFO|WARNING|WARN|ERROR|CRITICAL|FATAL|EXCEPTION)\b", re.I)

SEVERITY_ORDER = {"critical": 3, "error": 2, "warning": 1, "info": 0}


def normalize_level(level):
    level = (level or "").upper()
    if level in ("CRITICAL", "FATAL"):
        return "critical"
    if level in ("ERROR", "EXCEPTION"):
        return "error"
    if level in ("WARNING", "WARN"):
        return "warning"
    return "info"


def parse_log_lines(text, profile=None, source=None, since=None, default_level="error"):
    """Parse log text into entries ``{ts, level, message, profile, source}``.

    Lines without a leading timestamp (tracebacks, wrapped messages) are
    appended to the previous entry's ``details``. Entries older than
    ``since`` (epoch seconds) are dropped.
    """
    entries = []
    current = None
    for raw in text.splitlines():
        line = raw.rstrip()
        if not line.strip():
            continue
        m = _LOG_TS_RE.match(line)
        if m:
            ts = parse_ts(m.group(1))
            rest = line[m.end():].strip(" -|:]")
            lm = _LEVEL_RE.search(rest[:60])
            level = normalize_level(lm.group(1)) if lm else default_level
            message = rest
            if lm:
                message = (rest[:lm.start()] + rest[lm.end():]).strip(" -|:[]")
                message = re.sub(r"\s{2,}", " ", message)
            current = {"ts": ts, "level": level, "message": message or rest,
                       "details": [], "profile": profile, "source": source}
            entries.append(current)
        elif current is not None:
            if len(current["details"]) < 30:
                current["details"].append(line)
            if current["level"] != "critical" and re.search(r"\b(CRITICAL|FATAL)\b", line):
                current["level"] = "critical"
        else:
            lm = _LEVEL_RE.search(line[:60])
            current = {"ts": None, "level": normalize_level(lm.group(1)) if lm else default_level,
                       "message": line.strip(), "details": [], "profile": profile, "source": source}
            entries.append(current)
    if since is not None:
        entries = [e for e in entries if e["ts"] is None or e["ts"] >= since]
    return entries


_NO_INCIDENTS_RE = re.compile(r"^\s*(no\b|none\b|0 (open )?incidents|nothing)", re.I)


def parse_cron_incidents(text, profile):
    """Parse ``hermes cron incidents`` text output (format is free-form).

    Each non-empty, non-header line becomes an incident. Header/separator
    lines and "no incidents" messages are skipped.
    """
    incidents = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or _NO_INCIDENTS_RE.match(line):
            continue
        if set(line) <= set("-=+|─━═ "):
            continue
        if re.match(r"^(job|name|id)\s{2,}", line, re.I):  # table header
            continue
        ts = None
        m = re.search(r"\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?", line)
        if m:
            ts = parse_ts(m.group(0) if len(m.group(0)) > 16 else m.group(0) + ":00")
        lm = _LEVEL_RE.search(line)
        incidents.append({
            "ts": ts,
            "level": normalize_level(lm.group(1)) if lm else "error",
            "message": line,
            "details": [],
            "profile": profile,
            "source": "hermes cron incidents",
        })
    return incidents


def incidents_from_jobs(cron_summary):
    """Derive incidents from failing jobs in a :func:`summarize_jobs` result."""
    out = []
    for job in cron_summary.get("jobs", []):
        if job["status"] != "error":
            continue
        streak = job["failure_streak"]
        level = "critical" if streak >= 3 else "error"
        msg = "cron job '%s' failed" % job["name"]
        if streak > 1:
            msg += " (%dx in a row)" % streak
        details = [str(job["last_error"])] if job.get("last_error") else []
        out.append({"ts": job["last_run_at"], "level": level, "message": msg, "details": details,
                    "profile": job["profile"], "source": "cron/jobs.json"})
    return out


def merge_incidents(*groups, limit=200):
    """Merge incident lists, newest first, then by severity."""
    merged = []
    for g in groups:
        merged.extend(g or [])
    merged.sort(key=lambda e: (e["ts"] or 0, SEVERITY_ORDER.get(e["level"], 0)), reverse=True)
    return merged[:limit]


# ---------------------------------------------------------------------------
# Overall status for BMO
# ---------------------------------------------------------------------------

def _plural_cs(n, one, few, many):
    if n == 1:
        return one
    if 2 <= n <= 4:
        return few
    return many


def overall_status(gateway, cron_summaries, incidents, usage_latest=None, now=None, recent_seconds=3600):
    """Compute the global system mood used by BMO + the speech bubble text.

    Returns ``{level: ok|warn|error, mood, message, issues: [..]}``.
    """
    issues = []  # (level, text)
    if not gateway or not gateway.get("available"):
        issues.append(("error", "Nevidím gateway_state.json!"))
    elif not gateway.get("running"):
        issues.append(("error", "Gateway je dole!"))
    elif gateway.get("platform_errors"):
        n = gateway["platform_errors"]
        issues.append(("warn", "%d %s v chybě" % (n, _plural_cs(n, "platforma", "platformy", "platforem"))))

    failing = sum(c.get("counts", {}).get("error", 0) for c in cron_summaries)
    if failing:
        issues.append(("error" if failing >= 3 else "warn",
                       "%d cron %s %s" % (failing, _plural_cs(failing, "job", "joby", "jobů"),
                                          _plural_cs(failing, "padl", "padly", "padlo"))))

    if now is not None:
        recent = [i for i in incidents if i.get("ts") and now - i["ts"] <= recent_seconds
                  and i.get("source") != "cron/jobs.json"]
    else:
        recent = []
    crit = [i for i in recent if i["level"] == "critical"]
    errs = [i for i in recent if i["level"] == "error"]
    if crit:
        issues.append(("error", "%d kritick%s %s za poslední hodinu" % (
            len(crit), _plural_cs(len(crit), "á chyba", "é chyby", "ých chyb"), "")))
    elif errs:
        issues.append(("warn", "%d %s v logu za poslední hodinu" % (
            len(errs), _plural_cs(len(errs), "chyba", "chyby", "chyb"))))

    if usage_latest:
        s = usage_latest.get("session_pct")
        w = usage_latest.get("week_pct")
        if w is not None and w >= 90:
            issues.append(("warn", "Týdenní kvóta na %d %%" % round(w)))
        elif s is not None and s >= 90:
            issues.append(("warn", "Session kvóta na %d %%" % round(s)))

    if any(lvl == "error" for lvl, _ in issues):
        level = "error"
    elif issues:
        level = "warn"
    else:
        level = "ok"
    issues.sort(key=lambda it: 0 if it[0] == "error" else 1)
    if level == "ok":
        message = "Všechno běží, šéfe! ✨"
    else:
        message = issues[0][1]
        if len(issues) > 1:
            message += " (+%d další)" % (len(issues) - 1)
    mood = {"ok": "happy", "warn": "worried", "error": "alarmed"}[level]
    return {
        "level": level,
        "mood": mood,
        "message": re.sub(r"\s+", " ", message).strip(),
        "issues": [{"level": lvl, "text": re.sub(r"\s+", " ", t).strip()} for lvl, t in issues],
    }


# ---------------------------------------------------------------------------
# 6. GitHub
# ---------------------------------------------------------------------------

def parse_repo_view(text):
    try:
        data = json.loads(text)
    except ValueError:
        return None
    if not isinstance(data, dict):
        return None
    branch = data.get("defaultBranchRef")
    return {
        "pushed_at": parse_ts(data.get("pushedAt")),
        "default_branch": branch.get("name") if isinstance(branch, dict) else branch,
        "url": data.get("url"),
    }


def parse_pr_list(text):
    try:
        data = json.loads(text)
    except ValueError:
        return None
    if not isinstance(data, list):
        return None
    return [{"number": p.get("number"), "title": p.get("title"), "url": p.get("url")}
            for p in data if isinstance(p, dict)]


# ---------------------------------------------------------------------------
# Processes (best-effort sub-agent estimate)
# ---------------------------------------------------------------------------

def parse_proc_stat(text):
    """Parse ``/proc/<pid>/stat`` -> ``(pid, comm, ppid, starttime)``."""
    try:
        lpar = text.index("(")
        rpar = text.rindex(")")
        pid = int(text[:lpar].strip())
        comm = text[lpar + 1:rpar]
        fields = text[rpar + 2:].split()
        # fields[0] is state (field 3), ppid is field 4, starttime field 22
        return pid, comm, int(fields[1]), int(fields[19])
    except (ValueError, IndexError):
        return None


def descendants(ppid_map, root):
    """All descendant PIDs of ``root`` given ``{pid: ppid}``."""
    children = {}
    for pid, ppid in ppid_map.items():
        children.setdefault(ppid, []).append(pid)
    out = []
    stack = list(children.get(root, []))
    seen = set()
    while stack:
        pid = stack.pop()
        if pid in seen:
            continue
        seen.add(pid)
        out.append(pid)
        stack.extend(children.get(pid, []))
    return sorted(out)


def attribute_process(cmdline, profiles=PROFILES):
    """Guess which profile a process belongs to from its command line."""
    for p in profiles:
        if re.search(r"(?:-p|--profile)[ =]%s\b" % re.escape(p), cmdline) or \
                ("/profiles/%s/" % p) in cmdline:
            return p
    return None


def json_dumps(obj):
    return json.dumps(obj, ensure_ascii=False, default=str, separators=(",", ":"))
