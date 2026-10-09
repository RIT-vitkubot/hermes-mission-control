// Headless UI audit (dev tool, not needed at runtime): loads the dashboard
// and its detail views at 375 / 768 / 1280 / 1920 px and reports JS errors
// and horizontal overflow; screenshots go to OUT_DIR.
//
//   python3 tools/make_demo_home.py /tmp/demo && HERMES_HOME=/tmp/demo python3 server.py --no-cli &
//   node tools/ui_audit.js /tmp/shots [http://127.0.0.1:8090/]
//
// Needs Playwright (npm i -g playwright). Env: CHROMIUM=<executable>,
// THREE_JS=<local three.module.js> to serve Three.js when the CDN is blocked.
"use strict";
let chromium;
try { ({ chromium } = require("playwright")); } catch (e) { ({ chromium } = require(require("child_process").execSync("npm root -g").toString().trim() + "/playwright")); }
const OUT = process.argv[2] || ".";
const BASE = process.argv[3] || "http://127.0.0.1:8090/";
const ROUTES = ["", "#/agent/skola", "#/cron/skola/skola-sync", "#/incidents", "#/compare", "#/search?q=sk", "#/help"];
const WIDTHS = [375, 768, 1280, 1920];

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  let problems = 0;
  for (const w of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width: w, height: w < 800 ? 812 : 1000 } });
    if (process.env.THREE_JS) {
      await ctx.route("https://unpkg.com/three@*/build/three.module.js",
        (rt) => rt.fulfill({ path: process.env.THREE_JS, contentType: "application/javascript" }));
    }
    const page = await ctx.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
    for (const r of ROUTES) {
      await page.goto(BASE + r, { waitUntil: "load" });
      await page.waitForTimeout(r ? 1500 : 3000);
      const info = await page.evaluate(() => {
        const cw = document.documentElement.clientWidth, wide = [];
        document.querySelectorAll("body *").forEach((el) => {
          const b = el.getBoundingClientRect();
          if (!b.width || b.right <= cw + 1 || getComputedStyle(el).position === "fixed") return;
          for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
            if (/auto|hidden|scroll/.test(getComputedStyle(p).overflowX)) return; // clipped / scrollable box
          }
          wide.push((el.id ? "#" + el.id : el.tagName.toLowerCase() + "." + el.className).slice(0, 60));
        });
        return { sw: document.documentElement.scrollWidth, cw, wide: wide.slice(0, 8) };
      });
      const name = (r || "home").replace(/[#/?=&]+/g, "_");
      await page.screenshot({ path: `${OUT}/${w}${name}.png`, fullPage: !r });
      const bad = info.sw > info.cw || info.wide.length;
      if (bad) problems++;
      console.log(`${w}px ${r || "/"}${bad ? "  OVERFLOW " + info.wide.join(", ") : "  ok"}`);
    }
    if (errs.length) { problems += errs.length; console.log(`${w}px JS errors:\n  ` + [...new Set(errs)].join("\n  ")); }
    await ctx.close();
  }
  await browser.close();
  console.log(problems ? `PROBLEMS: ${problems}` : "OK: no JS errors, no horizontal overflow");
  process.exit(problems ? 1 : 0);
})();
