import json
import unittest
from datetime import datetime, timezone

from mission_control import parsing


def ts(s):
    return datetime.fromisoformat(s).replace(tzinfo=timezone.utc).timestamp()


class ParseTsTest(unittest.TestCase):
    def test_iso_variants(self):
        base = ts("2026-10-08T12:00:00")
        self.assertEqual(parsing.parse_ts("2026-10-08T12:00:00Z"), base)
        self.assertEqual(parsing.parse_ts("2026-10-08T12:00:00+00:00"), base)
        self.assertEqual(parsing.parse_ts("2026-10-08T14:00:00+0200"), base)
        self.assertAlmostEqual(parsing.parse_ts("2026-10-08T12:00:00.123456789Z"), base + 0.123456, places=5)
        self.assertAlmostEqual(parsing.parse_ts("2026-10-08 12:00:00,500+00:00"), base + 0.5)

    def test_epoch_variants(self):
        self.assertEqual(parsing.parse_ts(1700000000), 1700000000.0)
        self.assertEqual(parsing.parse_ts(1700000000000), 1700000000.0)
        self.assertEqual(parsing.parse_ts("1700000000"), 1700000000.0)

    def test_garbage(self):
        for v in (None, "", "nope", True, {}, -5):
            self.assertIsNone(parsing.parse_ts(v))


class UsageTest(unittest.TestCase):
    SAMPLE = "\n".join([
        json.dumps({"ts": "2026-10-08T10:00:00Z", "session_pct": 27, "session_reset": "x", "week_pct": 34, "week_reset": "y"}),
        "{broken json",
        "",
        json.dumps({"ts": "2026-10-08T08:00:00Z", "session_pct": 120, "week_pct": -3}),
        json.dumps({"ts": "2026-10-08T11:00:00Z", "session_pct": None, "week_pct": 40}),
        json.dumps({"ts": "bad", "session_pct": 1, "week_pct": 1}),
        json.dumps({"ts": "2026-10-08T11:30:00Z"}),
        json.dumps([1, 2]),
    ])

    def test_parse_sorts_clamps_skips(self):
        pts = parsing.parse_usage_jsonl(self.SAMPLE)
        self.assertEqual(len(pts), 3)
        self.assertEqual([p["ts"] for p in pts], sorted(p["ts"] for p in pts))
        self.assertEqual(pts[0]["session_pct"], 100.0)
        self.assertEqual(pts[0]["week_pct"], 0.0)
        self.assertEqual(pts[1]["session_reset"], "x")
        self.assertIsNone(pts[2]["session_pct"])

    def test_window(self):
        pts = parsing.parse_usage_jsonl(self.SAMPLE)
        now = ts("2026-10-08T12:00:00")
        self.assertEqual(len(parsing.filter_window(pts, "6h", now)), 3)
        self.assertEqual(len(parsing.filter_window(pts, "all", now)), 3)
        later = now + 3 * 3600  # 15:00 -> 6h window starts 09:00
        self.assertEqual(len(parsing.filter_window(pts, "6h", later)), 2)
        # unknown window falls back to 24h
        self.assertEqual(parsing.usage_series(pts, "bogus", now)["window"], "24h")

    def test_downsample_keeps_peaks_and_last(self):
        pts = [{"ts": i, "session_pct": (100 if i == 503 else 1), "week_pct": 1} for i in range(5000)]
        out = parsing.downsample(pts, 100)
        self.assertLessEqual(len(out), 101)
        self.assertIs(out[-1], pts[-1])
        self.assertIn(100, [p["session_pct"] for p in out])


class GatewayTest(unittest.TestCase):
    def test_platform_shapes(self):
        nested = parsing.normalize_platforms({"default": {"telegram": "connected", "discord": {"state": "error", "error": "x"}}})
        self.assertEqual({(p["profile"], p["platform"], p["status"]) for p in nested},
                         {("default", "telegram", "ok"), ("default", "discord", "error")})
        combined = parsing.normalize_platforms({"editor:telegram": {"connected": True}, "skola/discord": "failed"})
        self.assertEqual({(p["profile"], p["platform"], p["status"]) for p in combined},
                         {("editor", "telegram", "ok"), ("skola", "discord", "error")})
        flat = parsing.normalize_platforms({"telegram": "connected"})
        self.assertEqual(flat[0]["profile"], "default")
        lst = parsing.normalize_platforms([{"profile": "tegistic", "platform": "slack", "status": "connected"}])
        self.assertEqual((lst[0]["profile"], lst[0]["status"]), ("tegistic", "ok"))
        self.assertEqual(parsing.normalize_platforms(None), [])

    def test_summarize(self):
        state = {"pid": 42, "gateway_state": "running", "updated_at": "2026-10-08T12:00:00Z",
                 "platforms": {"default": {"telegram": {"state": "error"}}}, "served_profiles": ["default"]}
        s = parsing.summarize_gateway(state, now=ts("2026-10-08T12:01:00"), pid_alive=True)
        self.assertTrue(s["running"])
        self.assertEqual(s["status"], "warn")
        self.assertEqual(s["platform_errors"], 1)
        self.assertEqual(s["updated_age"], 60)
        dead = parsing.summarize_gateway(state, pid_alive=False)
        self.assertFalse(dead["running"])
        self.assertEqual(dead["status"], "error")
        missing = parsing.summarize_gateway(None)
        self.assertFalse(missing["available"])

    def test_uptime(self):
        self.assertEqual(parsing.proc_uptime_seconds(1000, "110.0", 100), 100.0)
        self.assertIsNone(parsing.proc_uptime_seconds("x", "1", 100))

    def test_active_work(self):
        self.assertIsNone(parsing.active_work_for(None, "default"))
        per = {"editor": {"summary": "writing"}}
        self.assertEqual(parsing.active_work_for(per, "editor"), {"summary": "writing"})
        self.assertIsNone(parsing.active_work_for(per, "skola"))
        lst = [{"profile": "skola", "task": "a"}, {"profile": "editor", "task": "b"}]
        self.assertEqual(parsing.describe_work(parsing.active_work_for(lst, "skola")), "a")
        self.assertEqual(parsing.describe_work(None), "idle")
        self.assertEqual(parsing.describe_work({"summary": "x", "platform": "tg"}), "x (tg)")


class CronTest(unittest.TestCase):
    JOBS = [
        {"name": "ok-job", "schedule_display": "0 7 * * *", "next_run_at": "2026-10-09T07:00:00Z",
         "last_run_at": "2026-10-08T07:00:00Z", "last_status": "ok", "failure_streak": 0, "enabled": True},
        {"name": "bad-job", "schedule_display": "every 30m", "next_run_at": "2026-10-08T12:30:00Z",
         "last_run_at": "2026-10-08T12:00:00Z", "last_status": "error", "failure_streak": 4, "enabled": True},
        {"name": "paused-job", "next_run_at": "2026-10-08T12:05:00Z", "enabled": False, "last_status": "error",
         "failure_streak": 2},
        {"name": "new-job", "enabled": True},
    ]

    def test_parse_shapes(self):
        self.assertEqual(len(parsing.parse_jobs_json(json.dumps(self.JOBS))), 4)
        self.assertEqual(len(parsing.parse_jobs_json(json.dumps({"jobs": self.JOBS}))), 4)
        keyed = parsing.parse_jobs_json(json.dumps({"a": {"enabled": True}}))
        self.assertEqual(keyed[0]["name"], "a")
        self.assertIsNone(parsing.parse_jobs_json("not json"))
        self.assertIsNone(parsing.parse_jobs_json('"string"'))

    def test_status(self):
        self.assertEqual([parsing.job_status(j) for j in self.JOBS], ["ok", "error", "paused", "pending"])

    def test_summary(self):
        s = parsing.summarize_jobs(self.JOBS, "editor")
        self.assertTrue(s["available"])
        self.assertEqual(s["counts"], {"ok": 1, "error": 1, "paused": 1, "pending": 1})
        self.assertEqual(s["jobs"][0]["name"], "bad-job")  # errors first
        self.assertEqual(s["last_job"]["name"], "bad-job")
        self.assertEqual(s["next_job"]["name"], "bad-job")  # paused job's earlier next_run ignored
        self.assertFalse(parsing.summarize_jobs(None, "x")["available"])
        inc = parsing.incidents_from_jobs(s)
        self.assertEqual(len(inc), 1)
        self.assertEqual(inc[0]["level"], "critical")
        self.assertIn("4x", inc[0]["message"])


class LogsTest(unittest.TestCase):
    LOG = "\n".join([
        "2026-10-08 10:00:00,123 ERROR [gateway] telegram poll failed",
        "Traceback (most recent call last):",
        "  File \"x.py\", line 1",
        "ValueError: boom",
        "2026-10-08T11:00:00Z WARNING cron: slow job",
        "[2026-10-08 11:30:00] CRITICAL db locked",
        "2026-10-07 01:00:00 ERROR old",
    ])

    def test_parse(self):
        entries = parsing.parse_log_lines(self.LOG, profile="default", source="errors.log")
        self.assertEqual(len(entries), 4)
        self.assertEqual(entries[0]["level"], "error")
        self.assertIn("telegram poll failed", entries[0]["message"])
        self.assertEqual(len(entries[0]["details"]), 3)
        self.assertEqual(entries[1]["level"], "warning")
        self.assertEqual(entries[2]["level"], "critical")
        self.assertEqual(entries[2]["message"], "db locked")

    def test_since(self):
        since = parsing.parse_ts("2026-10-08 00:00:00")
        self.assertEqual(len(parsing.parse_log_lines(self.LOG, since=since)), 3)

    def test_cron_incidents(self):
        text = "JOB      PROFILE   SINCE\n-----------------\nbackup   default   2026-10-08 09:00  failed 3x\n\n"
        inc = parsing.parse_cron_incidents(text, "default")
        self.assertEqual(len(inc), 1)
        self.assertEqual(inc[0]["ts"], parsing.parse_ts("2026-10-08 09:00:00"))
        self.assertEqual(parsing.parse_cron_incidents("No open incidents.", "x"), [])

    def test_merge(self):
        a = [{"ts": 1, "level": "error"}, {"ts": None, "level": "critical"}]
        b = [{"ts": 5, "level": "warning"}]
        merged = parsing.merge_incidents(a, b, None)
        self.assertEqual([m["ts"] for m in merged], [5, 1, None])


class OverallTest(unittest.TestCase):
    def gw(self, running=True, errors=0):
        return {"available": True, "running": running, "platform_errors": errors}

    def test_ok(self):
        s = parsing.overall_status(self.gw(), [{"counts": {"ok": 3}}], [], {"session_pct": 10, "week_pct": 20}, now=100)
        self.assertEqual(s["level"], "ok")
        self.assertEqual(s["mood"], "happy")
        self.assertIn("Všechno běží", s["message"])

    def test_cron_failures_czech_plural(self):
        s = parsing.overall_status(self.gw(), [{"counts": {"error": 2}}, {"counts": {"error": 1}}], [], now=100)
        self.assertEqual(s["level"], "error")
        self.assertEqual(s["message"], "3 cron joby padly")
        one = parsing.overall_status(self.gw(), [{"counts": {"error": 1}}], [], now=100)
        self.assertEqual((one["level"], one["message"]), ("warn", "1 cron job padl"))

    def test_gateway_down_wins(self):
        s = parsing.overall_status(self.gw(running=False), [{"counts": {"error": 1}}], [], now=100)
        self.assertEqual(s["level"], "error")
        self.assertTrue(s["message"].startswith("Gateway je dole!"))
        self.assertIn("+1", s["message"])

    def test_recent_log_errors_and_quota(self):
        inc = [{"ts": 90, "level": "error", "source": "errors.log"}, {"ts": 90, "level": "error", "source": "cron/jobs.json"}]
        s = parsing.overall_status(self.gw(), [], inc, {"session_pct": 95, "week_pct": 50}, now=100)
        self.assertEqual(s["level"], "warn")
        self.assertEqual(len(s["issues"]), 2)
        self.assertIn("1 chyba", s["issues"][0]["text"])

    def test_cause_drives_mood(self):
        down = parsing.overall_status(self.gw(running=False), [{"counts": {"error": 1}}], [], now=100)
        self.assertEqual((down["cause"], down["mood"]), ("gateway", "down"))
        self.assertEqual([i["cause"] for i in down["issues"]], ["gateway", "cron"])
        quota = parsing.overall_status(self.gw(), [], [], {"session_pct": 10, "week_pct": 93}, now=100)
        self.assertEqual((quota["level"], quota["cause"], quota["mood"]), ("warn", "quota", "tired"))
        cron = parsing.overall_status(self.gw(), [{"counts": {"error": 3}}], [], now=100)
        self.assertEqual((cron["cause"], cron["mood"]), ("cron", "alarmed"))
        plat = parsing.overall_status(self.gw(errors=1), [], [], now=100)
        self.assertEqual((plat["cause"], plat["mood"]), ("platform", "worried"))
        ok = parsing.overall_status(self.gw(), [], [], now=100)
        self.assertEqual(ok["cause"], "ok")

    def test_error_outranks_quota_cause(self):
        # quota warning is listed first chronologically but cron error wins
        s = parsing.overall_status(self.gw(), [{"counts": {"error": 4}}], [], {"week_pct": 99}, now=100)
        self.assertEqual((s["cause"], s["mood"]), ("cron", "alarmed"))


class ForecastTest(unittest.TestCase):
    def pts(self, key, values, step=600, t0=0):
        return [{"ts": t0 + i * step, key: v} for i, v in enumerate(values)]

    def test_quota_eta_linear(self):
        # +6 % per 10 min = 36 %/h, latest 60 -> 100 in 40/36 h
        p = self.pts("session_pct", [30, 36, 42, 48, 54, 60])
        f = parsing.quota_eta(p, "session_pct", now=3000)
        self.assertAlmostEqual(f["rate_per_hour"], 36.0)
        self.assertAlmostEqual(f["eta"], 3000 + 40 / 36.0 * 3600, delta=1)
        self.assertEqual(f["basis_points"], 6)

    def test_quota_eta_uses_only_points_after_reset(self):
        p = self.pts("session_pct", [80, 90, 95, 2, 4, 6, 8])
        f = parsing.quota_eta(p, "session_pct", now=3600)
        self.assertEqual(f["basis_points"], 4)
        self.assertAlmostEqual(f["rate_per_hour"], 12.0)

    def test_quota_eta_flat_or_sparse(self):
        flat = parsing.quota_eta(self.pts("week_pct", [40, 40, 40, 40]), "week_pct", now=1800)
        self.assertEqual(flat["rate_per_hour"], 0)
        self.assertIsNone(flat["eta"])
        sparse = parsing.quota_eta(self.pts("week_pct", [10, 20]), "week_pct", now=600)
        self.assertIsNone(sparse["eta"])
        self.assertIsNone(parsing.quota_eta([], "week_pct", now=0)["latest"])
        # points with None for the key are ignored, future points too
        mixed = [{"ts": 0, "week_pct": None}, {"ts": 10 ** 9, "week_pct": 50}]
        self.assertIsNone(parsing.quota_eta(mixed, "week_pct", now=100)["latest"])

    def test_quota_eta_reset_comes_first(self):
        # reset at t=1800, +1 % per 10 min from 2 % -> 100 % would take ~16 h,
        # far after the 5 h window resets
        p = self.pts("session_pct", [90, 95, 99, 2, 3, 4, 5, 6])
        f = parsing.quota_eta(p, "session_pct", now=4200, period=5 * 3600)
        self.assertIsNone(f["eta"])
        self.assertTrue(f["resets_first"])
        # fast enough to hit 100 % within the window -> ETA kept
        q = self.pts("session_pct", [90, 95, 99, 2, 22, 42, 62])
        g = parsing.quota_eta(q, "session_pct", now=3600, period=5 * 3600)
        self.assertIsNotNone(g["eta"])
        self.assertFalse(g["resets_first"])
        # without a seen reset we cannot know when the window ends -> keep ETA
        r = parsing.quota_eta(self.pts("session_pct", [2, 3, 4, 5]), "session_pct", now=1800, period=5 * 3600)
        self.assertIsNotNone(r["eta"])

    def test_quota_eta_already_full(self):
        f = parsing.quota_eta(self.pts("session_pct", [70, 85, 100, 100]), "session_pct", now=1800)
        self.assertEqual(f["eta"], 1800)

    def test_day_cost_and_tokens(self):
        self.assertEqual(parsing.day_cost({"actual_cost_usd": 0, "estimated_cost_usd": 1.5}), 1.5)
        self.assertEqual(parsing.day_cost({"actual_cost_usd": 2.0, "estimated_cost_usd": 1.5}), 2.0)
        self.assertEqual(parsing.day_cost(None), 0)
        self.assertEqual(parsing.day_tokens({"input_tokens": 10, "output_tokens": 5, "estimated_cost_usd": 9}), 15)
        self.assertEqual(parsing.day_tokens({"total_tokens": 7, "input_tokens": 10}), 7)

    def test_month_forecast(self):
        from datetime import date
        today = date(2026, 10, 9)
        vals = {"2026-10-%02d" % d: 2.0 for d in range(1, 9)}  # 8 full days at $2
        vals["2026-10-09"] = 0.5   # today, partial
        vals["2026-09-30"] = 10.0  # previous month
        f = parsing.month_forecast(vals, today)
        self.assertEqual((f["days_in_month"], f["remaining_days"], f["day"]), (31, 22, 9))
        self.assertAlmostEqual(f["month_to_date"], 16.5)
        self.assertAlmostEqual(f["rate_per_day"], 2.0)
        # 16 (1.-8.) + max(0.5, 2) for today + 22 * 2
        self.assertAlmostEqual(f["projected"], 62.0)
        self.assertEqual(f["prev_month"], 10.0)
        self.assertTrue(f["prev_partial"])  # data starts 30.9., not 1.9.
        vals["2026-09-01"] = 1.0
        self.assertFalse(parsing.month_forecast(vals, today)["prev_partial"])

    def test_month_forecast_first_day_and_no_history(self):
        from datetime import date
        f = parsing.month_forecast({"2026-11-01": 3.0}, date(2026, 11, 1))
        self.assertEqual(f["rate_per_day"], 0)
        self.assertAlmostEqual(f["projected"], 3.0)
        self.assertIsNone(f["prev_month"])
        # missing days inside the rate window count as zero
        g = parsing.month_forecast({"2026-02-27": 7.0}, date(2026, 2, 28))
        self.assertAlmostEqual(g["rate_per_day"], 1.0)
        self.assertEqual(g["days_in_month"], 28)


class GatewayTransitionTest(unittest.TestCase):
    def snap(self, pid=1, running=True, started_at=1000.0):
        return {"pid": pid, "running": running, "started_at": started_at}

    def test_no_event(self):
        self.assertIsNone(parsing.gateway_transition(None, self.snap()))
        self.assertIsNone(parsing.gateway_transition(self.snap(), self.snap(started_at=1003)))
        self.assertIsNone(parsing.gateway_transition(self.snap(running=False), self.snap(running=False)))

    def test_restart_by_pid_or_start(self):
        self.assertEqual(parsing.gateway_transition(self.snap(), self.snap(pid=2))["kind"], "restart")
        ev = parsing.gateway_transition(self.snap(), self.snap(started_at=2000))
        self.assertEqual((ev["kind"], ev["started_at"]), ("restart", 2000))

    def test_down_up(self):
        self.assertEqual(parsing.gateway_transition(self.snap(), self.snap(running=False))["kind"], "down")
        up = parsing.gateway_transition(self.snap(running=False), self.snap(pid=5))
        self.assertEqual((up["kind"], up["pid_to"]), ("up", 5))


class GithubAndProcTest(unittest.TestCase):
    def test_repo_view(self):
        v = parsing.parse_repo_view(json.dumps({"pushedAt": "2026-10-08T12:00:00Z", "defaultBranchRef": {"name": "master"}}))
        self.assertEqual(v["default_branch"], "master")
        self.assertEqual(v["pushed_at"], ts("2026-10-08T12:00:00"))
        self.assertIsNone(parsing.parse_repo_view("err"))
        prs = parsing.parse_pr_list(json.dumps([{"number": 1, "title": "t", "url": "u", "extra": 1}]))
        self.assertEqual(prs, [{"number": 1, "title": "t", "url": "u"}])

    def test_proc(self):
        stat = "123 (python3 (x)) S 1 123 123 0 -1 4194560 " + " ".join(["0"] * 12) + " 5555 0 0"
        self.assertEqual(parsing.parse_proc_stat(stat), (123, "python3 (x)", 1, 5555))
        self.assertIsNone(parsing.parse_proc_stat("garbage"))
        tree = {2: 1, 3: 2, 4: 3, 5: 1, 6: 99}
        self.assertEqual(parsing.descendants(tree, 1), [2, 3, 4, 5])
        self.assertEqual(parsing.attribute_process("hermes -p skola agent"), "skola")
        self.assertEqual(parsing.attribute_process("/home/u/.hermes/profiles/editor/x"), "editor")
        self.assertIsNone(parsing.attribute_process("python worker.py"))



class DetailViewsTest(unittest.TestCase):
    ENTRIES = [
        {"ts": 300, "level": "critical", "profile": "skola", "message": "a"},
        {"ts": 200, "level": "warning", "profile": "default", "message": "b"},
        {"ts": 100, "level": "error", "profile": "default", "message": "c"},
        {"ts": None, "level": "info", "profile": "skola", "message": "d"},
    ]

    def test_filter_incidents(self):
        f = parsing.filter_incidents
        self.assertEqual(len(f(self.ENTRIES)), 4)
        self.assertEqual([e["message"] for e in f(self.ENTRIES, profile="default")], ["b", "c"])
        self.assertEqual([e["message"] for e in f(self.ENTRIES, min_level="error")], ["a", "c"])
        # entries without ts are kept, old ones dropped
        self.assertEqual([e["message"] for e in f(self.ENTRIES, since=150)], ["a", "b", "d"])
        self.assertEqual(len(f(self.ENTRIES, limit=2)), 2)
        self.assertEqual(parsing.count_levels(self.ENTRIES), {"critical": 1, "warning": 1, "error": 1, "info": 1})

    def test_merge_without_limit(self):
        big = [{"ts": i, "level": "error"} for i in range(300)]
        self.assertEqual(len(parsing.merge_incidents(big)), 200)
        self.assertEqual(len(parsing.merge_incidents(big, limit=None)), 300)

    def test_run_name_ts(self):
        expected = datetime(2026, 10, 8, 7, 0, 3).timestamp()  # host-local
        self.assertEqual(parsing.run_ts_from_name("2026-10-08_07-00-03.md"), expected)
        self.assertEqual(parsing.run_ts_from_name("2026-10-08T07:00:03.md"), expected)
        self.assertIsNone(parsing.run_ts_from_name("notes.md"))

    def test_parse_cron_run(self):
        ok = parsing.parse_cron_run("2026-10-08_07-00-03.md",
                                    "# Cron Job: x\n\n## Prompt\nfix errors\n\n## Response\nall good")
        self.assertEqual(ok["status"], "ok")
        self.assertEqual(ok["preview"], "all good")
        bad = parsing.parse_cron_run("2026-10-08_07-00-03.md", "# Cron Job: x (FAILED)\n\n## Error\nboom")
        self.assertEqual(bad["status"], "error")
        self.assertEqual(bad["preview"], "boom")
        long = parsing.parse_cron_run("x.md", "## Response\n" + "y" * 50, mtime=42, preview_chars=10)
        self.assertEqual(long["ts"], 42)
        self.assertTrue(long["truncated"])
        self.assertEqual(len(long["preview"]), 10)

    def test_run_history(self):
        runs = [{"ts": t, "status": s} for t, s in ((100, "ok"), (300, "error"), (200, "ok"), (400, "ok"))]
        h = parsing.run_history(runs)
        self.assertEqual([r["ts"] for r in h["runs"]], [400, 300, 200, 100])
        self.assertEqual((h["ok"], h["failed"]), (3, 1))
        self.assertEqual(h["success_rate"], 0.75)
        self.assertEqual(h["median_interval"], 100)
        self.assertEqual(parsing.run_history(runs, limit=2)["count"], 2)
        self.assertIsNone(parsing.run_history([])["success_rate"])

    def test_find_job(self):
        summary = parsing.summarize_jobs([{"id": "j1", "name": "sync"}, {"name": "daily"}], "default")
        self.assertEqual(parsing.find_job(summary, "j1")["name"], "sync")
        self.assertEqual(parsing.find_job(summary, "daily")["name"], "daily")
        self.assertIsNone(parsing.find_job(summary, "nope"))
        self.assertIsNone(parsing.find_job(summary, None))

if __name__ == "__main__":
    unittest.main()
