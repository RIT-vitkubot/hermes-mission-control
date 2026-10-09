"""stdlib-only HTTP server for Hermes Mission Control.

Endpoints::

    GET  /                  dashboard (static files from ./static)
    GET  /healthz           liveness for process-supervisor
    GET  /api/state         gateway + agents + cron + incidents + BMO summary
    GET  /api/usage?window= Claude quota history (6h|24h|7d|30d|all)
    GET  /api/tokens?days=  per-profile token/cost aggregates from state.db
    GET  /api/forecast      month-to-date spend/tokens + projection to month end
    GET  /api/github        repo + open PR status (cached 5 min)
    GET  /api/agent-log?profile=&lines=     longer agent.log tail (detail view)
    GET  /api/cron/runs?profile=&job=&limit= run history of one cron job
    GET  /api/incidents?profile=&level=&hours= incidents up to 7 days back
    POST /api/restart       runs `hermes gateway restart` (no auth, by design)

No LLM API is ever called by this process.
"""

import argparse
import logging
import os
import signal
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from . import __version__
from . import parsing
from .collectors import Collector, Config

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "application/javascript; charset=utf-8"),
    "/bmo.js": ("bmo.js", "application/javascript; charset=utf-8"),
}

log = logging.getLogger("mission_control")
STARTED_AT = time.time()


def int_param(qs, name, default, lo, hi):
    """Clamp an integer query parameter; bad values fall back to ``default``."""
    try:
        value = int((qs.get(name) or [default])[0])
    except (TypeError, ValueError):
        value = default
    return max(lo, min(hi, value))


def profile_param(qs, profiles, required=True):
    """Return ``(profile, error)``; profile must be one of the configured ones."""
    value = (qs.get("profile") or [""])[0].strip()
    if not value:
        return None, ("missing profile" if required else None)
    if value not in profiles:
        return None, "unknown profile"
    return value, None


def make_handler(collector):
    class Handler(BaseHTTPRequestHandler):
        server_version = "HermesMissionControl/" + __version__
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):  # route through logging, quieter
            log.debug("%s - %s", self.address_string(), fmt % args)

        # -- helpers -----------------------------------------------------
        def _send(self, code, body, ctype, extra_headers=None):
            if isinstance(body, str):
                body = body.encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            for k, v in (extra_headers or {}).items():
                self.send_header(k, v)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _json(self, obj, code=200):
            self._send(code, parsing.json_dumps(obj), "application/json; charset=utf-8")

        # -- GET ---------------------------------------------------------
        def do_HEAD(self):
            self.do_GET()

        def do_GET(self):
            url = urlparse(self.path)
            qs = parse_qs(url.query)
            path = url.path
            try:
                if path == "/healthz":
                    return self._json({"ok": True, "version": __version__,
                                       "uptime": round(time.time() - STARTED_AT, 1)})
                if path == "/api/state":
                    return self._json(collector.state())
                if path == "/api/usage":
                    window = (qs.get("window") or ["24h"])[0]
                    return self._json(collector.usage(window))
                if path == "/api/tokens":
                    try:
                        days = max(1, min(90, int((qs.get("days") or ["14"])[0])))
                    except ValueError:
                        days = 14
                    return self._json(collector.tokens(days))
                if path == "/api/forecast":
                    return self._json(collector.forecast())
                if path == "/api/github":
                    return self._json(collector.github())
                if path == "/api/agent-log":
                    profile, err = profile_param(qs, collector.cfg.profiles)
                    if err:
                        return self._json({"error": err}, 400)
                    return self._json(collector.agent_log_detail(profile, int_param(qs, "lines", 300, 10, 2000)))
                if path == "/api/cron/runs":
                    profile, err = profile_param(qs, collector.cfg.profiles)
                    job = (qs.get("job") or [""])[0]
                    if err or not job:
                        return self._json({"error": err or "missing job"}, 400)
                    res = collector.cron_runs(profile, job, int_param(qs, "limit", 50, 1, 200))
                    return self._json(res, 200 if res["found"] else 404)
                if path == "/api/incidents":
                    profile, err = profile_param(qs, collector.cfg.profiles, required=False)
                    if err:
                        return self._json({"error": err}, 400)
                    level = (qs.get("level") or [""])[0] or None
                    if level is not None and level not in parsing.SEVERITY_ORDER:
                        return self._json({"error": "unknown level"}, 400)
                    return self._json(collector.incidents_detail(
                        profile, level, int_param(qs, "hours", 24, 1, 168), int_param(qs, "limit", 1000, 1, 5000)))
                if path in STATIC_FILES:
                    name, ctype = STATIC_FILES[path]
                    with open(os.path.join(STATIC_DIR, name), "rb") as fh:
                        return self._send(200, fh.read(), ctype)
                return self._json({"error": "not found"}, 404)
            except Exception as exc:  # keep the dashboard alive no matter what
                log.exception("error handling %s", path)
                return self._json({"error": str(exc)}, 500)

        # -- POST --------------------------------------------------------
        def do_POST(self):
            path = urlparse(self.path).path
            length = int(self.headers.get("Content-Length") or 0)
            if length:
                self.rfile.read(min(length, 65536))
            if path != "/api/restart":
                return self._json({"error": "not found"}, 404)
            # No authentication by design (private VPN/LAN only). We only
            # require a JSON content type so that a random cross-site HTML form
            # cannot fire a restart without a CORS preflight (which we never
            # approve). This is not auth, just a guard against accidents.
            ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            if ctype != "application/json":
                return self._json({"ok": False, "error": "Content-Type must be application/json"}, 415)
            log.warning("gateway restart requested from %s", self.client_address[0])
            result = collector.restart_gateway(client=self.client_address[0])
            log.warning("gateway restart result: ok=%s rc=%s", result.get("ok"), result.get("returncode"))
            return self._json(result, 200 if result.get("ok") else 500)

    return Handler


def parse_binds(value):
    return [b.strip() for b in (value or "").split(",") if b.strip()]


def main(argv=None):
    ap = argparse.ArgumentParser(description="Hermes Mission Control (read-only, zero-LLM-token dashboard)")
    ap.add_argument("--port", type=int, default=int(os.environ.get("MC_PORT", "8090")))
    ap.add_argument("--bind", default=os.environ.get("MC_BIND", "127.0.0.1"),
                    help="comma separated bind addresses, e.g. 127.0.0.1,10.8.0.25 (env MC_BIND)")
    ap.add_argument("--hermes-home", default=None, help="Hermes home dir (env HERMES_HOME, default ~/.hermes)")
    ap.add_argument("--no-cli", action="store_true",
                    help="never call `hermes logs/cron incidents`; read files only")
    ap.add_argument("--verbose", "-v", action="store_true")
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    config = Config(hermes_home=args.hermes_home, use_cli=not args.no_cli)
    collector = Collector(config)
    handler = make_handler(collector)

    servers = []
    for addr in parse_binds(args.bind) or ["127.0.0.1"]:
        try:
            httpd = ThreadingHTTPServer((addr, args.port), handler)
        except OSError as exc:
            log.error("cannot bind %s:%d: %s", addr, args.port, exc)
            continue
        httpd.daemon_threads = True
        servers.append(httpd)
        log.info("listening on http://%s:%d/", addr, args.port)
    if not servers:
        log.error("no address could be bound, exiting")
        return 2
    log.info("hermes home: %s (hermes=%s, gh=%s)", config.hermes_home, config.hermes_bin, config.gh_bin)

    stop = threading.Event()

    def _stop(*_):
        stop.set()

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    threads = [threading.Thread(target=s.serve_forever, daemon=True) for s in servers]
    for t in threads:
        t.start()
    try:
        while not stop.wait(1):
            pass
    finally:
        for s in servers:
            s.shutdown()
            s.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
