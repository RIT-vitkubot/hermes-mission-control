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


if __name__ == "__main__":
    unittest.main()
