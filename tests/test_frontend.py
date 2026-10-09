"""Frontend checks that need no browser: JS unit tests (via node, skipped
when node is missing) and static consistency between index.html, the
server's static file map and the service worker cache list."""

import os
import re
import shutil
import subprocess
import unittest

from mission_control.server import STATIC_DIR, STATIC_FILES

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")


def read_static(name):
    with open(os.path.join(STATIC_DIR, name), encoding="utf-8") as f:
        return f.read()


class JsUnitTest(unittest.TestCase):
    @unittest.skipUnless(NODE, "node not installed")
    def test_lib_js(self):
        p = subprocess.run([NODE, os.path.join(ROOT, "tests", "js", "lib.test.js")],
                           capture_output=True, text=True, timeout=60)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)

    @unittest.skipUnless(NODE, "node not installed")
    def test_scripts_parse(self):
        for name in ("lib.js", "app.js", "sw.js"):
            p = subprocess.run([NODE, "--check", os.path.join(STATIC_DIR, name)],
                               capture_output=True, text=True, timeout=60)
            self.assertEqual(p.returncode, 0, name + ": " + p.stderr)


class StaticConsistencyTest(unittest.TestCase):
    def test_index_assets_are_served(self):
        html = read_static("index.html")
        for ref in re.findall(r'(?:src|href)="(/[^"#?]*)"', html):
            self.assertIn(ref, STATIC_FILES, ref)
        # lib.js must load before app.js (app.js reads window.HMCLib)
        self.assertLess(html.index('src="/lib.js"'), html.index('src="/app.js"'))

    def test_service_worker_caches_all_scripts_and_styles(self):
        sw = read_static("sw.js")
        cached = set(re.findall(r'"(/[^"]*)"', sw.split("var STATIC", 1)[1].split("];", 1)[0]))
        for path, (_name, ctype) in STATIC_FILES.items():
            if ctype.startswith(("application/javascript", "text/css")) and path != "/sw.js":
                self.assertIn(path, cached, path)

    def test_ui_is_czech(self):
        # leftovers of the old CZ/EN mix must not come back
        html = read_static("index.html")
        app = read_static("app.js")
        for s in ("all systems nominal", "LLM tokens", ">connected<", ">disconnected<",
                  "not served", "failure streak", "active agents", "warning+", "poslední run"):
            self.assertFalse(s in html + app, "leftover English UI text: " + s)

    def test_icon_buttons_have_labels(self):
        html = read_static("index.html")
        for m in re.finditer(r"<button\b[^>]*>", html):
            tag = m.group(0)
            if "btn-icon" in tag or "btn-ghost" in tag or "data-close" in tag:
                self.assertIn("aria-label=", tag, tag)


if __name__ == "__main__":
    unittest.main()
