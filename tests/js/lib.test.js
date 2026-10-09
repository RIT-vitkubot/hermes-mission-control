// Unit tests for mission_control/static/lib.js (plain node, no deps).
// Run: node tests/js/lib.test.js   (also driven by tests/test_frontend.py)
"use strict";
const assert = require("assert");
const path = require("path");
const L = require(path.join(__dirname, "..", "..", "mission_control", "static", "lib.js"));

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test("labels are Czech and unknown values pass through", () => {
  assert.strictEqual(L.label("status", "error"), "chyba");
  assert.strictEqual(L.label("status", "paused"), "pauza");
  assert.strictEqual(L.label("level", "critical"), "kritické");
  assert.strictEqual(L.label("level", "warning"), "varování");
  assert.strictEqual(L.label("overall", "ok"), "vše v pořádku");
  assert.strictEqual(L.label("status", "weird"), "weird");
  assert.strictEqual(L.label("nope", null), "");
  assert.strictEqual(L.label("status", "hasOwnProperty"), "hasOwnProperty");
});

test("activity and token series names", () => {
  assert.strictEqual(L.activityLabel("idle"), "nečinný");
  assert.strictEqual(L.activityLabel(null), "nečinný");
  assert.strictEqual(L.activityLabel("review PR #12"), "review PR #12");
  assert.strictEqual(L.tokenSeriesName("input_tokens"), "vstup");
  assert.strictEqual(L.tokenSeriesName("cache_read_tokens"), "cache čtení");
  assert.strictEqual(L.tokenSeriesName("cost"), "náklady");
  assert.strictEqual(L.tokenSeriesName("foo_bar_tokens"), "foo bar");
});

test("fold strips diacritics", () => {
  assert.strictEqual(L.fold("Škola ČÁST"), "skola cast");
  assert.strictEqual(L.fold(null), "");
});

test("matchRank: all words required, prefix first", () => {
  assert.strictEqual(L.matchRank("sk", "skola", ""), 0);
  assert.strictEqual(L.matchRank("ola", "skola", ""), 1);
  assert.strictEqual(L.matchRank("telegram", "skola", "telegram discord"), 2);
  assert.strictEqual(L.matchRank("skola xyz", "skola", ""), null);
  assert.strictEqual(L.matchRank("   ", "skola", ""), null);
  assert.strictEqual(L.matchRank("škola", "skola", ""), 0);
});

test("sparkPaths scales 0..100 and splits on gaps", () => {
  const pts = [{ ts: 0, s: 0 }, { ts: 50, s: 50 }, { ts: 60, s: null }, { ts: 100, s: 100 }];
  const r = L.sparkPaths(pts, "s", 100, 20, 0, 100);
  assert.deepStrictEqual(r.paths, ["0.0,20.0 50.0,10.0", "100.0,0.0 100.0,0.0"]);
  assert.deepStrictEqual(r.last, { x: 100, y: 0, v: 100 });
  // out-of-window points are dropped, values clamped
  const r2 = L.sparkPaths([{ ts: -5, s: 10 }, { ts: 10, s: 150 }], "s", 100, 20, 0, 100);
  assert.deepStrictEqual(r2.paths, ["10.0,0.0 10.0,0.0"]);
  assert.deepStrictEqual(L.sparkPaths([], "s", 10, 10, 0, 1), { paths: [], last: null });
});

test("mergeBuckets merges runs of equal state", () => {
  assert.deepStrictEqual(L.mergeBuckets(["none", "none", "ok", "error", "error"]), [
    { state: "none", start: 0, end: 2 }, { state: "ok", start: 2, end: 3 }, { state: "error", start: 3, end: 5 }]);
  assert.deepStrictEqual(L.mergeBuckets([]), []);
});

test("clusterByPosition groups close markers (chained), keeps order", () => {
  const c = L.clusterByPosition([{ pos: 10 }, { pos: 50 }, { pos: 11 }, { pos: 12.4 }, { pos: 51 }], 1.5);
  assert.deepStrictEqual(c.map((x) => [x.pos, x.items.length]), [[10, 3], [50, 2]]);
  assert.deepStrictEqual(L.clusterByPosition([], 1), []);
});

test("newCriticals primes silently, then reports only new criticals once", () => {
  const seen = { keys: {}, primed: false };
  const a = { ts: 1, profile: "skola", level: "critical", message: "x" };
  const b = { ts: 2, profile: "editor", level: "critical", message: "y" };
  const w = { ts: 3, level: "error", message: "z" };
  assert.deepStrictEqual(L.newCriticals(seen, [a, w]), []);
  assert.deepStrictEqual(L.newCriticals(seen, [a, b, w]), [b]);
  assert.deepStrictEqual(L.newCriticals(seen, [a, b]), []);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log("ok   " + name); } catch (e) { failed++; console.log("FAIL " + name + "\n     " + e.message); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
