import os
import shutil
import sys
import tempfile
import time
import unittest

from mission_control.collectors import Collector, Config, read_text, read_token_usage

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools"))
import make_demo_home  # noqa: E402


class CollectorTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="mc-test-")
        make_demo_home.build(cls.tmp)
        cls.c = Collector(Config(hermes_home=cls.tmp, use_cli=False, gh_bin="/nonexistent/gh"))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_usage(self):
        u = self.c.usage("24h")
        self.assertTrue(u["available"])
        self.assertGreater(u["count"], 100)
        self.assertTrue(all(0 <= p["session_pct"] <= 100 for p in u["points"]))
        self.assertGreater(len(self.c.usage("all")["points"]), len(u["points"]))

    def test_state(self):
        st = self.c.state()
        self.assertTrue(st["gateway"]["running"])  # pid is our own process
        self.assertEqual(len(st["agents"]), 6)
        by = {a["profile"]: a for a in st["agents"]}
        self.assertFalse(by["obchodnik"]["connected"])
        self.assertTrue(by["default"]["connected"])
        self.assertEqual(by["programovani"]["activity"], "review PR #12 (telegram)")
        self.assertEqual(by["default"]["activity"], "idle")
        self.assertEqual(by["skola"]["cron"]["counts"]["error"], 1)
        # 1 platform error + 2 failing jobs + recent log errors -> warning, not alarm
        self.assertEqual(st["summary"]["level"], "warn")
        self.assertEqual(st["summary"]["mood"], "worried")
        self.assertEqual(len(st["summary"]["issues"]), 3)
        levels = {(i["profile"], i["source"]) for i in st["incidents"]}
        self.assertIn(("default", os.path.join("logs", "errors.log")), levels)
        self.assertIn(("skola", "cron/jobs.json"), levels)
        # error older than 24h is filtered
        self.assertFalse(any("outside 24h" in i["message"] for i in st["incidents"]))
        self.assertIsNotNone(st["processes"]["estimate"])

    def test_usage_forecast(self):
        f = self.c.usage("24h")["forecast"]
        self.assertIn("eta", f["session"])
        self.assertIsNotNone(f["week"]["rate_per_hour"])

    def test_forecast(self):
        f = self.c.forecast()
        self.assertTrue(f["available"])
        self.assertEqual(len(f["profiles"]), 6)
        self.assertGreater(f["cost"]["month_to_date"], 0)
        self.assertGreaterEqual(f["cost"]["projected"], f["cost"]["month_to_date"])
        self.assertGreater(f["tokens"]["rate_per_day"], 0)
        missing = Collector(Config(hermes_home=os.path.join(self.tmp, "nope"), use_cli=False, gh_bin="/x"))
        self.assertFalse(missing.forecast()["available"])

    def test_restart_timeline(self):
        c = Collector(Config(hermes_home=self.tmp, use_cli=False, gh_bin="/x", hermes_bin="/bin/true"))
        c.state()  # baseline snapshot, no event
        self.assertEqual(c.restart_events(), [])
        res = c.restart_gateway(client="10.8.0.2")
        self.assertTrue(res["ok"])
        # simulate the gateway coming back with a new PID
        c._observe_gateway({"pid": 999999, "running": True, "started_at": time.time()}, time.time())
        events = c.restart_events()
        self.assertEqual([e["kind"] for e in events], ["restart", "api_restart"])
        self.assertEqual(events[1]["client"], "10.8.0.2")
        # the next real poll sees the original PID again -> one more restart event
        self.assertEqual([e["kind"] for e in c.state()["restarts"]], ["restart", "restart", "api_restart"])
        fail = Collector(Config(hermes_home=self.tmp, use_cli=False, gh_bin="/x", hermes_bin="/bin/false"))
        self.assertFalse(fail.restart_gateway()["ok"])
        self.assertFalse(fail.restart_events()[0]["ok"])

    def test_missing_home(self):
        c = Collector(Config(hermes_home=os.path.join(self.tmp, "nope"), use_cli=False, gh_bin="/x"))
        st = c.state()
        self.assertFalse(st["gateway"]["available"])
        self.assertEqual(st["summary"]["level"], "error")
        self.assertFalse(c.usage("24h")["available"])

    def test_tokens(self):
        t = self.c.tokens(14)
        self.assertEqual(len(t["day_keys"]), 14)
        prof = {p["profile"]: p for p in t["profiles"]}
        self.assertTrue(prof["default"]["available"])
        self.assertGreater(prof["editor"]["totals"]["input_tokens"], 0)
        self.assertIn("estimated_cost_usd", prof["default"]["totals"])

    def test_token_db_is_read_only(self):
        path = os.path.join(self.tmp, "state.db")
        before = os.path.getmtime(path)
        read_token_usage(path, time.time() - 86400)
        self.assertEqual(before, os.path.getmtime(path))

    def test_github_without_gh(self):
        g = Collector(Config(hermes_home=self.tmp, use_cli=False, gh_bin=None))
        g.cfg.gh_bin = None
        self.assertFalse(g.github()["available"])

    def test_read_text_tail(self):
        p = os.path.join(self.tmp, "agent.log")
        tail = read_text(p, max_bytes=100)
        self.assertLessEqual(len(tail), 100)
        self.assertTrue(tail.endswith("\n"))


    def test_agent_log_detail(self):
        d = self.c.agent_log_detail("editor", 50)
        self.assertTrue(d["available"])
        self.assertEqual(len(d["lines"]), 50)
        self.assertIn("handled message 119", d["lines"][-1])
        self.assertEqual(len(self.c.agent_log_detail("editor", 1000)["lines"]), 120)

    def test_cron_runs(self):
        r = self.c.cron_runs("skola", "skola-sync")
        self.assertTrue(r["found"])
        self.assertEqual(r["source"], "cron/output/skola-sync")
        self.assertEqual(r["count"], 30)
        # newest first; demo failure_streak=3 -> three newest runs failed
        self.assertEqual([x["status"] for x in r["runs"][:4]], ["error", "error", "error", "ok"])
        self.assertAlmostEqual(r["median_interval"], 1800, delta=2)
        # lookup by name works too, limit is honoured
        self.assertEqual(self.c.cron_runs("skola", "inbox-sync", limit=5)["count"], 5)
        self.assertFalse(self.c.cron_runs("skola", "../../etc")["found"])

    def test_cron_runs_fallback_to_jobs_json(self):
        r = self.c.cron_runs("default", "legacy-cleanup")
        self.assertEqual(r["source"], "cron/jobs.json")
        self.assertEqual(r["count"], 1)

    def test_incidents_detail(self):
        day = self.c.incidents_detail(hours=24)
        week = self.c.incidents_detail(hours=168)
        self.assertGreater(week["total"], day["total"])
        self.assertTrue(any("outside 24h" in i["message"] for i in week["incidents"]))
        only = self.c.incidents_detail(profile="obchodnik", hours=168)
        self.assertTrue(only["incidents"])
        self.assertTrue(all(i["profile"] == "obchodnik" for i in only["incidents"]))
        errs = self.c.incidents_detail(min_level="error", hours=168)
        self.assertFalse(any(i["level"] == "warning" for i in errs["incidents"]))
        self.assertIn("warning", errs["counts"])  # counts are before the level filter

if __name__ == "__main__":
    unittest.main()
