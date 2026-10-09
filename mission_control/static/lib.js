/* Hermes Mission Control — pure helpers shared by app.js (no DOM access).
 * Loaded as a classic script before app.js (window.HMCLib) and required by
 * the node unit tests (module.exports), so keep it side-effect free. */
(function (root) {
  "use strict";

  // ---------------------------------------------------------------- i18n
  // The backend sends machine values (ok / error / warning …); everything a
  // person reads is Czech. Unknown values pass through unchanged.
  var CS = {
    status: { ok: "ok", error: "chyba", paused: "pauza", pending: "čeká", warn: "varování", unknown: "?" },
    level: { info: "info", warning: "varování", warn: "varování", error: "chyba", critical: "kritické" },
    overall: { ok: "vše v pořádku", warn: "varování", error: "poplach", unknown: "…" },
    conn: { connected: "připojeno", disconnected: "odpojeno", na: "n/a", unserved: "neobsluhován" },
    gateway: { up: "běží", down: "neběží", nodata: "bez dat" },
    tokens: { input: "vstup", output: "výstup", cache_read: "cache čtení", cache_write: "cache zápis",
      cache_creation: "cache zápis", reasoning: "uvažování", cost: "náklady" }
  };
  function label(group, value) {
    var g = CS[group] || {};
    return Object.prototype.hasOwnProperty.call(g, value) ? g[value] : String(value == null ? "" : value);
  }
  function activityLabel(a) { return !a || a === "idle" ? "nečinný" : String(a); }
  // "input_tokens" / "cache_read_tokens" -> Czech series name
  function tokenSeriesName(key) {
    var k = String(key).replace(/_tokens?$/, "");
    return CS.tokens[k] || k.replace(/_/g, " ");
  }

  // ---------------------------------------------------------------- text search
  function fold(t) { return String(t == null ? "" : t).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase(); }
  // Every query word must appear somewhere; rank prefix hits in the title first.
  function matchRank(query, title, hay) {
    var words = fold(query).split(/\s+/).filter(Boolean);
    if (!words.length) return null;
    var t = fold(title), h = t + " " + fold(hay);
    for (var i = 0; i < words.length; i++) if (h.indexOf(words[i]) < 0) return null;
    var at = t.indexOf(words[0]);
    return at === 0 ? 0 : at > 0 ? 1 : 2;
  }

  // ---------------------------------------------------------------- sparkline
  // SVG polyline points for values over time; gaps (null) split the line.
  // Returns {paths: ["x,y x,y …", …], last: {x, y, v} | null}.
  function sparkPaths(points, key, w, h, t0, t1, vmax) {
    var out = [], cur = [], last = null, span = Math.max(1, t1 - t0), top = vmax || 100;
    (points || []).forEach(function (p) {
      var v = p[key];
      if (v == null || p.ts < t0 || p.ts > t1) { if (cur.length) out.push(cur); cur = []; return; }
      var x = ((p.ts - t0) / span) * w, y = h - (Math.max(0, Math.min(top, v)) / top) * h;
      cur.push(x.toFixed(1) + "," + y.toFixed(1));
      last = { x: x, y: y, v: v };
    });
    if (cur.length) out.push(cur);
    return { paths: out.map(function (c) { return c.length === 1 ? c[0] + " " + c[0] : c.join(" "); }), last: last };
  }

  // ---------------------------------------------------------------- timeline
  // Merge consecutive buckets with the same state into [start, end) segments.
  function mergeBuckets(states) {
    var segs = [];
    (states || []).forEach(function (s, i) {
      var prev = segs[segs.length - 1];
      if (prev && prev.state === s) prev.end = i + 1;
      else segs.push({ state: s, start: i, end: i + 1 });
    });
    return segs;
  }

  // Group items ({pos, …}, any order) whose positions lie within `gap` of the
  // previous one, so markers on a narrow strip never stack on top of each
  // other. Returns [{pos: first position, items: […]}], sorted by position.
  function clusterByPosition(items, gap) {
    var out = [];
    (items || []).slice().sort(function (a, b) { return a.pos - b.pos; }).forEach(function (it) {
      var last = out[out.length - 1];
      if (last && it.pos - last.items[last.items.length - 1].pos <= gap) last.items.push(it);
      else out.push({ pos: it.pos, items: [it] });
    });
    return out;
  }

  // ---------------------------------------------------------------- notifications
  function incidentKey(i) { return [i.ts, i.profile || "", i.source || "", i.message || ""].join("|"); }
  // Critical incidents not seen before. `seen` = {keys: {}, primed: false} is
  // updated in place; the first call only remembers what is already there,
  // so opening the page never floods the user with notifications.
  function newCriticals(seen, incidents) {
    var fresh = [];
    (incidents || []).forEach(function (i) {
      if (i.level !== "critical") return;
      var k = incidentKey(i);
      if (seen.keys[k]) return;
      seen.keys[k] = true;
      if (seen.primed) fresh.push(i);
    });
    seen.primed = true;
    return fresh;
  }

  var api = {
    CS: CS, label: label, activityLabel: activityLabel, tokenSeriesName: tokenSeriesName,
    fold: fold, matchRank: matchRank, sparkPaths: sparkPaths, mergeBuckets: mergeBuckets, clusterByPosition: clusterByPosition,
    incidentKey: incidentKey, newCriticals: newCriticals
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HMCLib = api;
})(this);
