import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import urlopen

from mission_control.collectors import Collector, Config
from mission_control.server import int_param, make_handler, profile_param

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools"))
import make_demo_home  # noqa: E402


class ParamTest(unittest.TestCase):
    def test_int_param(self):
        self.assertEqual(int_param({}, "n", 5, 1, 10), 5)
        self.assertEqual(int_param({"n": ["99"]}, "n", 5, 1, 10), 10)
        self.assertEqual(int_param({"n": ["-3"]}, "n", 5, 1, 10), 1)
        self.assertEqual(int_param({"n": ["x"]}, "n", 5, 1, 10), 5)

    def test_profile_param(self):
        profiles = ("default", "skola")
        self.assertEqual(profile_param({"profile": ["skola"]}, profiles), ("skola", None))
        self.assertEqual(profile_param({}, profiles), (None, "missing profile"))
        self.assertEqual(profile_param({}, profiles, required=False), (None, None))
        self.assertEqual(profile_param({"profile": ["../x"]}, profiles), (None, "unknown profile"))


class DetailEndpointsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="mc-srv-")
        make_demo_home.build(cls.tmp)
        collector = Collector(Config(hermes_home=cls.tmp, use_cli=False, gh_bin=None))
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(collector))
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.base = "http://127.0.0.1:%d" % cls.httpd.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def get(self, path):
        try:
            with urlopen(self.base + path) as r:
                return r.status, json.loads(r.read())
        except HTTPError as e:
            return e.code, json.loads(e.read())

    def test_endpoints(self):
        code, body = self.get("/api/agent-log?profile=skola&lines=20")
        self.assertEqual((code, len(body["lines"])), (200, 20))
        code, body = self.get("/api/cron/runs?profile=skola&job=skola-sync&limit=3")
        self.assertEqual((code, body["count"]), (200, 3))
        code, body = self.get("/api/incidents?hours=168&level=error")
        self.assertEqual(code, 200)
        self.assertTrue(body["incidents"])

    def test_forecast_and_state_restarts(self):
        code, body = self.get("/api/forecast")
        self.assertEqual(code, 200)
        self.assertTrue(body["available"])
        self.assertIn("projected", body["cost"])
        code, body = self.get("/api/state")
        self.assertEqual(code, 200)
        self.assertIn("restarts", body)
        self.assertIn(body["summary"]["cause"], ("ok", "gateway", "platform", "cron", "logs", "quota"))

    def test_static_assets(self):
        for path, ctype in (("/favicon.svg", "image/svg+xml"), ("/icon-192.png", "image/png"),
                            ("/icon-512.png", "image/png"), ("/manifest.webmanifest", "application/manifest+json"),
                            ("/sw.js", "application/javascript"), ("/offline.html", "text/html")):
            with urlopen(self.base + path) as r:
                self.assertEqual(r.status, 200)
                self.assertTrue(r.headers["Content-Type"].startswith(ctype), path)
                data = r.read()
                self.assertTrue(data)
        with urlopen(self.base + "/manifest.webmanifest") as r:
            manifest = json.loads(r.read())
        self.assertEqual(manifest["start_url"], "/")
        self.assertIn("/#/compare", [x["url"] for x in manifest["shortcuts"]])
        with urlopen(self.base + "/sw.js") as r:
            sw = r.read().decode("utf-8")
        # every precached path must actually be served, and the API never cached
        for path in __import__("re").search(r"var STATIC = \[([^\]]*)\]", sw).group(1).replace("\n", "").split(","):
            path = path.strip().strip('"')
            with urlopen(self.base + path) as r:
                self.assertEqual(r.status, 200, path)
        self.assertIn('url.pathname.indexOf("/api/") === 0', sw)

    def test_compare_and_export(self):
        code, body = self.get("/api/compare")
        self.assertEqual((code, len(body["rows"])), (200, 6))
        with urlopen(self.base + "/api/export?kind=incidents&format=csv&hours=168") as r:
            self.assertTrue(r.headers["Content-Type"].startswith("text/csv"))
            self.assertIn('attachment; filename="hermes-incidents-', r.headers["Content-Disposition"])
            text = r.read().decode("utf-8")
        self.assertTrue(text.startswith("\ufefftime,ts,level,profile,source,message,details\r\n"))
        code, body = self.get("/api/export?kind=usage&format=json&window=6h")
        self.assertEqual(code, 200)
        self.assertEqual(body["columns"][:2], ["time", "ts"])
        self.assertTrue(body["rows"])
        self.assertEqual(self.get("/api/export?kind=secrets")[0], 400)
        self.assertEqual(self.get("/api/export?kind=usage&format=xml")[0], 400)
        self.assertEqual(self.get("/api/export?kind=incidents&profile=../x")[0], 400)
        self.assertEqual(self.get("/api/export?kind=incidents&level=bogus")[0], 400)

    def test_validation(self):
        self.assertEqual(self.get("/api/agent-log")[0], 400)
        self.assertEqual(self.get("/api/agent-log?profile=nope")[0], 400)
        self.assertEqual(self.get("/api/cron/runs?profile=skola")[0], 400)
        self.assertEqual(self.get("/api/cron/runs?profile=skola&job=missing")[0], 404)
        self.assertEqual(self.get("/api/incidents?level=bogus")[0], 400)


if __name__ == "__main__":
    unittest.main()
