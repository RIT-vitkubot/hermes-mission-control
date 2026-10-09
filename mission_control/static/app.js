/* Hermes Mission Control — dashboard logic (no build step, no deps).
 * Polls the read-only backend and renders panels. The 3D BMO lives in bmo.js
 * and listens to the `mc-state` event dispatched here. */
(function () {
  "use strict";

  var POLL_STATE_MS = 5000;
  var POLL_USAGE_MS = 30000;
  var POLL_SLOW_MS = 60000;
  var PROFILE_COLORS = {
    default: "#3ef2ff", editor: "#ff4fd8", obchodnik: "#ffc53d",
    programovani: "#3dffa8", skola: "#9b6bff", tegistic: "#ff8a3d"
  };

  // Optional colour-blind friendly palette (blue / yellow / orange instead of
  // green / red, plus shape cues). Per-browser preference only.
  var PALETTE_KEY = "hmc-palette";
  function getPalette() { try { return localStorage.getItem(PALETTE_KEY) === "cb" ? "cb" : "default"; } catch (e) { return "default"; } }
  function applyPalette(p) {
    if (p === "cb") document.documentElement.setAttribute("data-palette", "cb");
    else document.documentElement.removeAttribute("data-palette");
  }
  applyPalette(getPalette());

  var L = window.HMCLib;
  function stLabel(s) { return L.label("status", s); }
  function lvLabel(l) { return L.label("level", l); }
  function statusPill(s) { return '<span class="pill pill-' + esc(s) + '">' + esc(stLabel(s)) + "</span>"; }
  function connPill(a) {
    return a.connected === true ? '<span class="pill pill-ok">' + L.CS.conn.connected + "</span>"
      : a.connected === false ? '<span class="pill pill-error">' + L.CS.conn.disconnected + "</span>"
        : '<span class="pill pill-unknown">' + (a.served === false ? L.CS.conn.unserved : L.CS.conn.na) + "</span>";
  }

  var tzOffset = null; // host offset in seconds; null -> browser local
  var usageError = null, tokensError = null, lastForecast = null;
  var usageWindow = "24h";
  var tokenMode = "tokens";
  var lastUsage = null;
  var lastTokens = null;
  var lastBubble = null;

  // ---------------------------------------------------------------- utils
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function hostDate(ts) {
    if (tzOffset == null) {
      var d = new Date(ts * 1000);
      return { Y: d.getFullYear(), M: d.getMonth() + 1, D: d.getDate(), h: d.getHours(), m: d.getMinutes(), s: d.getSeconds() };
    }
    var u = new Date((ts + tzOffset) * 1000);
    return { Y: u.getUTCFullYear(), M: u.getUTCMonth() + 1, D: u.getUTCDate(), h: u.getUTCHours(), m: u.getUTCMinutes(), s: u.getUTCSeconds() };
  }
  function fmtTime(ts) { if (!ts) return "–"; var d = hostDate(ts); return pad(d.h) + ":" + pad(d.m); }
  function fmtDateTime(ts) {
    if (!ts) return "–";
    var d = hostDate(ts);
    return pad(d.D) + "." + pad(d.M) + ". " + pad(d.h) + ":" + pad(d.m);
  }
  function fmtDur(sec) {
    if (sec == null || isNaN(sec)) return "–";
    sec = Math.abs(sec);
    if (sec < 60) return Math.round(sec) + " s";
    // round to the displayed unit first so we never print "1 h 60 min"
    var min = Math.round(sec / 60);
    if (min < 60) return min + " min";
    if (min < 1440) { var h = Math.floor(min / 60), m = min % 60; return h + " h" + (m ? " " + m + " min" : ""); }
    var hrs = Math.round(sec / 3600), d = Math.floor(hrs / 24), hh = hrs % 24;
    return d + " d" + (hh ? " " + hh + " h" : "");
  }
  function rel(ts, now) {
    if (!ts) return "–";
    var diff = ts - now;
    return diff >= 0 ? "za " + fmtDur(diff) : "před " + fmtDur(diff);
  }
  function fmtNum(n) {
    if (n == null) return "–";
    if (n >= 1e9) return (n / 1e9).toFixed(2) + "G";
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
    return String(Math.round(n));
  }
  function pill(el, level, text) {
    el.className = "pill pill-" + level;
    el.textContent = text;
  }
  function getJSON(url) {
    return fetch(url, { cache: "no-store" }).then(function (r) {
      if (!r.ok && r.status !== 500) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }
  function agentHref(p) { return "#/agent/" + encodeURIComponent(p); }
  function jobHref(p, j) { return "#/cron/" + encodeURIComponent(p) + "/" + encodeURIComponent(j.id || j.name); }
  // While the gateway is down its state file is stale: grey dot, keep the
  // last known state only in the tooltip.
  function platformCell(p) { return p.stale ? "unknown" : p.status; }
  function platformTitle(p) {
    return (p.stale ? "gateway neběží — poslední známý stav: " : "") + p.state + (p.error ? " — " + p.error : "");
  }
  function setConn(ok) { $("conn").className = "conn " + (ok ? "ok" : "err"); }

  // Polling re-renders panels every few seconds. Replacing innerHTML blindly
  // collapsed opened <details>, reset scroll positions and made the UI blink,
  // so: skip identical markup, and carry open/scroll state across a change.
  var htmlCache = {};
  function setHTML(el, html) {
    if (htmlCache[el.id] === html) return false;
    htmlCache[el.id] = html;
    var open = {}, scrolls = {};
    Array.prototype.forEach.call(el.querySelectorAll("details[data-key]"), function (d) {
      if (d.open) open[d.getAttribute("data-key")] = true;
      var pre = d.querySelector("pre");
      if (pre && pre.scrollTop) scrolls[d.getAttribute("data-key")] = pre.scrollTop;
    });
    var top = el.scrollTop, left = el.scrollLeft;
    el.innerHTML = html;
    Array.prototype.forEach.call(el.querySelectorAll("details[data-key]"), function (d) {
      var k = d.getAttribute("data-key");
      if (open[k]) d.open = true;
      var pre = d.querySelector("pre");
      if (pre && scrolls[k]) pre.scrollTop = scrolls[k];
    });
    el.scrollTop = top; el.scrollLeft = left;
    return true;
  }
  function detailsKey(parts) { return esc(parts.join("|").slice(0, 160)); }

  // ---------------------------------------------------------------- state
  function renderState(st) {
    tzOffset = st.tz ? st.tz.offset_seconds : null;
    window.__mcLastState = st;
    window.dispatchEvent(new CustomEvent("mc-state", { detail: st }));
    var sum = st.summary;
    document.body.setAttribute("data-level", sum.level);
    pill($("overall-pill"), sum.level, L.label("overall", sum.level));

    var bubble = $("bubble");
    if (lastBubble !== sum.message) {
      $("bubble-text").textContent = sum.message;
      bubble.classList.remove("pop"); void bubble.offsetWidth; bubble.classList.add("pop");
      lastBubble = sum.message;
    }
    setHTML($("issues"), sum.issues.length
      ? sum.issues.map(function (i) { return '<li class="' + esc(i.level) + '">' + esc(i.text) + "</li>"; }).join("")
      : '<li class="ok">Žádné problémy. BMO je spokojený.</li>');

    var u = st.usage_latest;
    $("kpi-session").textContent = u && u.session_pct != null ? Math.round(u.session_pct) + " %" : "–";
    $("kpi-week").textContent = u && u.week_pct != null ? Math.round(u.week_pct) + " %" : "–";
    $("kpi-gateway").textContent = st.gateway.running ? "UP" : "DOWN";
    $("kpi-gateway").style.color = st.gateway.running ? "var(--ok)" : "var(--err)";
    $("kpi-procs").textContent = st.processes.estimate == null ? "N/A" : "~" + st.processes.estimate;

    updateFavicon(sum.level, sum.issues.length);
    renderRestarts(st.restarts || [], st.now);
    renderGateway(st.gateway, st.now);
    renderAgents(st.agents, st.now, st.processes);
    renderIncidents(st.incidents, st.now);
    renderCron(st.cron, st.now);
  }

  function renderGateway(gw, now) {
    pill($("gw-badge"), gw.running ? (gw.status === "warn" ? "warn" : "ok") : "error",
      gw.available ? (gw.running ? L.CS.gateway.up : L.CS.gateway.down) : L.CS.gateway.nodata);
    var rows = [
      ["stav", gw.state],
      ["PID", gw.pid != null ? gw.pid + (gw.pid_alive === false ? " (mrtvý)" : "") : "–"],
      ["doba běhu", gw.uptime_seconds != null ? fmtDur(gw.uptime_seconds) + (gw.started_at ? " (od " + fmtDateTime(gw.started_at) + ")" : "") : "–"],
      ["poslední tep", gw.updated_at ? fmtDateTime(gw.updated_at) + " (" + rel(gw.updated_at, now) + ")" : "–"],
      ["aktivní agenti", typeof gw.active_agents === "object" && gw.active_agents !== null ? JSON.stringify(gw.active_agents) : (gw.active_agents == null ? "–" : gw.active_agents)],
      ["verze", (gw.code_version || "–") + (gw.code_sha ? " @ " + String(gw.code_sha).slice(0, 10) : "")]
    ];
    setHTML($("gw-kv"), rows.map(function (r) { return "<dt>" + esc(r[0]) + "</dt><dd>" + esc(r[1]) + "</dd>"; }).join(""));

    var plats = gw.platforms || [];
    var platformNames = [];
    plats.forEach(function (p) { if (platformNames.indexOf(p.platform) < 0) platformNames.push(p.platform); });
    var profiles = gw.served_profiles || [];
    plats.forEach(function (p) { if (profiles.indexOf(p.profile) < 0) profiles.push(p.profile); });
    if (!platformNames.length) { setHTML($("gw-matrix"), '<tr><td class="empty">' + (gw.available ? "Žádné platformy v gateway_state.json" : "gateway_state.json nenalezen") + "</td></tr>"); return; }
    var html = "<tr><th>profil</th>" + platformNames.map(function (n) { return "<th>" + esc(n) + "</th>"; }).join("") + "</tr>";
    profiles.forEach(function (prof) {
      html += '<tr><td><a href="' + agentHref(prof) + '">' + esc(prof === "default" ? "default (BMO)" : prof) + "</a></td>";
      platformNames.forEach(function (n) {
        var p = plats.filter(function (x) { return x.profile === prof && x.platform === n; })[0];
        if (!p) { html += '<td><span class="muted">·</span></td>'; return; }
        html += '<td title="' + esc(platformTitle(p)) + '"><span class="cell ' + esc(platformCell(p)) + '"></span></td>';
      });
      html += "</tr>";
    });
    setHTML($("gw-matrix"), html);
  }

  function renderAgents(agents, now, procs) {
    var procTip = "Odhad podle child procesů gateway PID — ne přesný počet sub-agentů." +
      (procs.unattributed ? " Nepřiřazené procesy: " + procs.unattributed + "." : "");
    setHTML($("agents"), agents.map(function (a) {
      var cls = a.connected === true ? "ok" : (a.connected === false ? "error" : "");
      var conn = connPill(a);
      var c = a.cron;
      var counts = c.available ? Object.keys(c.counts).map(function (k) { return c.counts[k] + " " + stLabel(k); }).join(", ") || "žádné joby" : "jobs.json chybí";
      var lastRun = c.last_run_at ? rel(c.last_run_at, now) + (c.last_job ? " · " + c.last_job.name + " (" + stLabel(c.last_job.status) + ")" : "") : "–";
      var nextRun = c.next_run_at ? rel(c.next_run_at, now) + (c.next_job ? " · " + c.next_job.name : "") : "–";
      var platforms = a.platforms.map(function (p) {
        return '<span title="' + esc(platformTitle(p)) + '"><span class="cell ' + esc(platformCell(p)) + '"></span> ' + esc(p.platform) + "</span>";
      }).join(" &nbsp;");
      return '<div class="agent ' + cls + (a.busy ? " busy" : "") + '">' +
        '<div class="agent-head"><a class="agent-name" href="' + agentHref(a.profile) + '" style="color:' + (PROFILE_COLORS[a.profile] || "inherit") + '">' + esc(a.label) + "</a>" +
        '<span class="agent-badges">' + healthBadge(a.health) + conn + "</span></div>" +
        '<div class="agent-activity">' + (a.busy ? "⚡ " : "💤 ") + esc(L.activityLabel(a.activity)) + "</div>" +
        (platforms ? '<div class="agent-row"><span>platformy</span><span>' + platforms + "</span></div>" : "") +
        '<div class="agent-row"><span>cron</span><span>' + esc(counts) + "</span></div>" +
        '<div class="agent-row"><span>poslední běh</span><span>' + esc(lastRun) + "</span></div>" +
        '<div class="agent-row"><span>další běh</span><span>' + esc(nextRun) + "</span></div>" +
        '<div class="agent-row" title="' + esc(procTip) + '"><span>procesy ⓘ</span><span>' + (a.processes == null ? "N/A" : "~" + a.processes) + "</span></div>" +
        (a.log_tail && a.log_tail.length ? '<details data-key="log-' + esc(a.profile) + '"><summary class="muted">co dělal (agent.log)</summary><pre>' + esc(a.log_tail.join("\n")) + "</pre></details>" : "") +
        '<a class="link-more agent-more" href="' + agentHref(a.profile) + '">detail profilu ›</a>' +
        "</div>";
    }).join(""));
  }

  function renderIncidents(list, now) {
    var serious = list.filter(function (i) { return i.level === "error" || i.level === "critical"; }).length;
    pill($("inc-count"), serious ? "error" : (list.length ? "warn" : "ok"), String(list.length));
    if (!list.length) { setHTML($("incidents"), '<li class="empty">Nic nehoří. 🔥🚫</li>'); return; }
    setHTML($("incidents"), list.slice(0, 100).map(function (i) {
      return '<li class="' + esc(i.level) + '"><div class="inc-meta"><span class="inc-lvl">' + esc(lvLabel(i.level)) + "</span>" +
        "<span>" + esc(i.ts ? fmtDateTime(i.ts) + " (" + rel(i.ts, now) + ")" : "bez času") + "</span>" +
        (i.profile ? '<a href="#/incidents?profile=' + encodeURIComponent(i.profile) + '">' + esc(i.profile) + "</a>" : "") +
        "<span>" + esc(i.source || "") + "</span></div>" +
        '<div class="inc-msg">' + esc(i.message) + "</div>" +
        (i.details && i.details.length ? '<details data-key="' + detailsKey([i.ts, i.profile, i.source, i.message]) + '"><summary class="muted small">detail</summary><pre>' + esc(i.details.join("\n")) + "</pre></details>" : "") +
        "</li>";
    }).join(""));
  }

  function renderCron(crons, now) {
    var total = 0, failing = 0;
    setHTML($("cron"), crons.map(function (c) {
      if (!c.available) {
        return '<div class="cron-profile"><h4><span>' + esc(c.profile) + '</span><span class="muted">jobs.json nenalezen</span></h4></div>';
      }
      total += c.jobs.length;
      var rows = c.jobs.map(function (j) {
        if (j.status === "error") failing++;
        return '<tr class="job-' + esc(j.status) + '"><td data-label="job"><a href="' + jobHref(c.profile, j) + '">' + esc(j.name) + "</a></td>" + '<td data-label="rozvrh" class="mono">' + esc(j.schedule || "–") + "</td>" +
          '<td data-label="stav">' + statusPill(j.status) + "</td>" +
          '<td data-label="poslední" title="' + esc(fmtDateTime(j.last_run_at)) + '">' + esc(rel(j.last_run_at, now)) + (j.last_status ? " · " + esc(stLabel(j.last_status)) : "") + "</td>" +
          '<td data-label="další" title="' + esc(fmtDateTime(j.next_run_at)) + '">' + esc(j.enabled ? rel(j.next_run_at, now) : "–") + "</td>" +
          '<td data-label="běhy"><span class="runs-cell">' + sparkHTML(j.recent) + (j.failure_streak > 0 ? '<span class="streak">' + j.failure_streak + "×</span>" : '<span class="muted">0</span>') + "</span></td></tr>";
      }).join("");
      return '<div class="cron-profile"><h4><a href="' + agentHref(c.profile) + '" style="color:' + (PROFILE_COLORS[c.profile] || "inherit") + '">' + esc(c.profile) + "</a><span class=\"muted\">" + c.jobs.length + " jobů</span></h4>" +
        (rows ? "<table class=\"cron-table\"><tr class=\"cron-th\"><th>job</th><th>rozvrh</th><th>stav</th><th>poslední</th><th>další</th><th title=\"posledních až 12 běhů (výška = délka běhu, odhad) a počet chyb v řadě\">běhy</th></tr>" + rows + "</table>" : '<div class="empty">žádné joby</div>') +
        "</div>";
    }).join(""));
    $("cron-meta").textContent = total + " jobů celkem" + (failing ? " · " + failing + " v chybě" : "");
  }

  // Last runs as a tiny bar chart: colour = status, height = run duration
  // (estimated from output file name vs. mtime; full height when unknown).
  function sparkHTML(runs) {
    if (!runs || !runs.length) return '<span class="spark spark-empty muted" title="žádná historie běhů">–</span>';
    var maxD = 0, failed = 0;
    runs.forEach(function (r) { if (r.duration > maxD) maxD = r.duration; if (r.status === "error") failed++; });
    return '<span class="spark" role="img" aria-label="' + runs.length + " posledních běhů, " + failed + ' chyb">' + runs.map(function (r) {
      var h = r.duration != null && maxD > 0 ? 5 + Math.round(11 * r.duration / maxD) : 16;
      var tip = fmtDateTime(r.ts) + " · " + stLabel(r.status) + (r.duration != null ? " · ~" + fmtDur(r.duration) : "");
      return '<span class="spark-bar ' + esc(r.status) + '" style="height:' + h + 'px" title="' + esc(tip) + '"></span>';
    }).join("") + "</span>";
  }
  function healthTip(h) {
    return "Health " + h.score + "/100 — " + (h.factors.length
      ? h.factors.map(function (f) { return f.label + " (−" + f.penalty + ")"; }).join(", ") : "bez problémů");
  }
  function healthBadge(h) {
    if (!h) return "";
    return '<a class="health health-' + esc(h.level) + '" href="#/compare" title="' + esc(healthTip(h) + " · klik = srovnání profilů") +
      '" aria-label="' + esc(healthTip(h)) + '"><span class="health-k">HP</span>' + h.score + "</a>";
  }

  var RESTART_KINDS = {
    api_restart: "restart z dashboardu", restart: "gateway restartován", down: "gateway spadl", up: "gateway znovu běží"
  };
  function renderRestarts(list, now) {
    $("gw-restarts-count").textContent = list.length ? "(" + list.length + ")" : "";
    setHTML($("gw-restarts"), list.length ? list.map(function (e) {
      var ok = e.kind === "api_restart" ? e.ok : e.kind !== "down";
      var extra = e.kind === "api_restart"
        ? (e.ok ? "OK" : "selhal") + (e.returncode != null ? " · rc=" + e.returncode : "") + (e.duration != null ? " · " + e.duration + " s" : "") + (e.client ? " · z " + e.client : "")
        : (e.pid_from != null || e.pid_to != null ? "PID " + (e.pid_from == null ? "?" : e.pid_from) + " → " + (e.pid_to == null ? "?" : e.pid_to) : "");
      return '<li class="' + (ok ? "ok" : "error") + '"><span class="mono">' + esc(fmtDateTime(e.ts)) + '</span> <span class="muted">(' + esc(rel(e.ts, now)) + ")</span><br>" +
        esc(RESTART_KINDS[e.kind] || e.kind) + ' <span class="muted">' + esc(extra) + "</span>" +
        (e.message ? '<div class="muted small mono restart-msg">' + esc(e.message) + "</div>" : "") + "</li>";
    }).join("") : '<li class="empty">Od spuštění dashboardu žádný restart.</li>');
  }

  // Status-coloured BMO favicon + issue count in the tab title, so the state
  // is visible from another tab without opening the dashboard.
  var FAVICON_COLORS = { ok: "#4fe3c1", warn: "#ffc53d", error: "#ff4d6d", unknown: "#7d93b5" };
  var FAVICON_COLORS_CB = { ok: "#4db8ff", warn: "#f0e442", error: "#ff8f1f", unknown: "#7d93b5" };
  var faviconLevel = null, titleIssues = 0, modalTitle = null;
  function bmoIconSVG(color) {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="10" y="4" width="44" height="56" rx="9" fill="' + color + '"/>' +
      '<rect x="16" y="10" width="32" height="24" rx="4" fill="#d9fff2"/><circle cx="25" cy="20" r="2.6" fill="#0b2a24"/><circle cx="39" cy="20" r="2.6" fill="#0b2a24"/>' +
      '<path d="M26 26 q6 5 12 0" stroke="#0b2a24" stroke-width="2.4" fill="none" stroke-linecap="round"/>' +
      '<rect x="17" y="43" width="12" height="4" rx="1" fill="#ffd23f"/><rect x="21" y="39" width="4" height="12" rx="1" fill="#ffd23f"/>' +
      '<circle cx="44" cy="44" r="4" fill="#ff3b5c"/><circle cx="38" cy="51" r="2.5" fill="#3dffa8"/></svg>';
  }
  function updateFavicon(level, issues) {
    titleIssues = level === "ok" ? 0 : issues;
    applyTitle();
    var key = level + ":" + getPalette();
    if (key === faviconLevel) return;
    faviconLevel = key;
    var colors = getPalette() === "cb" ? FAVICON_COLORS_CB : FAVICON_COLORS;
    $("favicon").setAttribute("href", "data:image/svg+xml," + encodeURIComponent(bmoIconSVG(colors[level] || colors.unknown)));
  }
  function applyTitle() {
    document.title = (titleIssues ? "(" + titleIssues + ") " : "") + (modalTitle ? modalTitle + " · " : "") + "Hermes Mission Control";
  }

  // "updated Xs ago" next to the clock; turns amber/red when polls fail
  function tickUpdated() {
    var el = $("updated");
    if (!lastStateOk) {
      el.textContent = lastStateFail ? "bez dat" : "načítám…";
      el.className = "updated" + (lastStateFail ? " stale-err" : "");
      return;
    }
    var age = Math.max(0, (Date.now() - lastStateOk) / 1000);
    var stale = age > POLL_STATE_MS * 3 / 1000;
    el.innerHTML = (stale ? "⚠ " : "") + '<span class="hide-narrow">' + (stale ? "data stará " : "aktualizováno před ") + "</span>" +
      (age < 60 ? Math.floor(age) + " s" : esc(fmtDur(age)));
    el.className = "updated" + (lastStateFail ? " stale-err" : stale ? " stale" : "");
  }

  // ---------------------------------------------------------------- forecasts
  function etaText(f, label) {
    if (!f || f.latest == null) return "";
    if (f.rate_per_hour == null) return label + ": málo dat pro trend";
    if (f.resets_first) return label + ": +" + f.rate_per_hour.toFixed(1) + " %/h · do resetu na 100 % nedojde";
    if (f.eta == null) return label + ": " + (f.rate_per_hour > 0 ? "+" : "") + f.rate_per_hour.toFixed(1) + " %/h · nestoupá";
    var now = Date.now() / 1000;
    return label + ": +" + f.rate_per_hour.toFixed(1) + " %/h → 100 % " + (f.eta <= now ? "už teď" : rel(f.eta, now) + " (" + fmtDateTime(f.eta) + ")");
  }
  function renderUsageForecast(d) {
    var fc = d && d.forecast;
    var parts = fc ? [etaText(fc.session, "session"), etaText(fc.week, "týden")].filter(Boolean) : [];
    $("usage-forecast").textContent = parts.length ? "⏱ projekce — " + parts.join(" · ") : "";
    var short = function (f) {
      if (f && f.resets_first) return "do resetu OK";
      if (!f || f.eta == null) return "";
      var now = Date.now() / 1000;
      return f.eta <= now ? "plno" : "100 % " + rel(f.eta, now);
    };
    $("kpi-session-eta").textContent = fc ? short(fc.session) : "";
    $("kpi-week-eta").textContent = fc ? short(fc.week) : "";
  }
  function dailySparkHTML(fmt) {
    if (!lastTokens || !lastTokens.day_keys) return "";
    var days = lastTokens.day_keys, avail = lastTokens.profiles.filter(function (p) { return p.available; });
    var vals = days.map(function (d) { return avail.reduce(function (s, p) { return s + dayValue(p.days[d]); }, 0); });
    var max = Math.max.apply(null, vals.concat([0]));
    if (max <= 0) return "";
    return '<div class="day-spark" role="img" aria-label="Denní ' + (tokenMode === "cost" ? "náklady" : "tokeny") + " za " + days.length + ' dní">' + vals.map(function (v, i) {
      return '<span style="height:' + Math.max(4, Math.round(100 * v / max)) + '%" title="' + esc(days[i] + " · " + fmt(v)) + '"></span>';
    }).join("") + "</div>";
  }
  var MONTHS_CS = ["leden", "únor", "březen", "duben", "květen", "červen", "červenec", "srpen", "září", "říjen", "listopad", "prosinec"];
  function renderForecast() {
    var f = lastForecast, el = $("forecast");
    if (!f) { setHTML(el, '<span class="muted small loading">Počítám projekci měsíce…</span>'); return; }
    if (f.error) { setHTML(el, '<span class="muted small">⚠ Projekci měsíce nelze načíst.</span>'); return; }
    if (!f.available) { setHTML(el, '<span class="muted small">Projekce měsíce: žádný state.db.</span>'); return; }
    var cost = tokenMode === "cost", m = cost ? f.cost : f.tokens;
    var fmt = cost ? function (v) { return "$" + v.toFixed(v < 100 ? 2 : 0); } : fmtNum;
    var month = MONTHS_CS[parseInt(f.today.slice(5, 7), 10) - 1] || f.today.slice(0, 7);
    var delta = m.prev_month && !m.prev_partial ? Math.round((m.projected / m.prev_month - 1) * 100) : null;
    var per = f.profiles.filter(function (p) { return p.available; }).map(function (p) {
      var pm = cost ? p.cost : p.tokens;
      return '<span class="lg" style="--c:' + (PROFILE_COLORS[p.profile] || "#888") + '">' + esc(p.profile) + " " + fmt(pm.projected) + "</span>";
    }).join("");
    setHTML(el,
      '<div class="fc-cards">' +
      '<div class="fc"><div class="kpi-label">' + esc(month) + " dosud</div><div class=\"fc-val\">" + fmt(m.month_to_date) + '</div><div class="kpi-sub">' + m.day + ". z " + m.days_in_month + " dní</div></div>" +
      '<div class="fc"><div class="kpi-label">tempo</div><div class="fc-val">' + fmt(m.rate_per_day) + '<span class="muted small">/den</span></div><div class="kpi-sub">průměr 7 dní</div>' + dailySparkHTML(fmt) + "</div>" +
      '<div class="fc fc-main"><div class="kpi-label">projekce do konce měsíce</div><div class="fc-val">≈ ' + fmt(m.projected) + "</div>" +
      '<div class="kpi-sub">' + (m.prev_month ? "minulý měsíc " + (m.prev_partial ? "≥ " : "") + fmt(m.prev_month) + (m.prev_partial ? " (neúplná data)" : "") + (delta != null ? ' · <span class="' + (delta > 0 ? "up" : "down") + '">' + (delta > 0 ? "+" : "") + delta + " %</span>" : "") : "bez dat za minulý měsíc") + "</div></div>" +
      "</div>" +
      '<details class="fc-per" data-key="fc-per"><summary class="muted small">projekce per profil</summary><div class="legend">' + per + "</div></details>" +
      '<div class="muted small fc-note">Odhad: ' + esc(f.method) + (cost ? ", $ = actual_cost_usd, jinak estimated_cost_usd" : "") + ".</div>");
  }

  // ---------------------------------------------------------------- github
  var lastGithub = null;
  function renderGithub(gh) {
    lastGithub = gh;
    if (!gh.available) { setHTML($("repos"), '<li class="empty">' + esc(gh.reason || "nedostupné") + "</li>"); return; }
    if (gh.loading) { setHTML($("repos"), '<li class="empty loading">Načítám přes gh CLI…</li>'); setTimeout(pollGithub, 4000); return; }
    var now = Date.now() / 1000;
    $("gh-meta").textContent = gh.fetched_at ? "cache " + fmtTime(gh.fetched_at) : "";
    setHTML($("repos"), gh.repos.map(function (r) {
      var prs = r.open_prs || [];
      return "<li><div class=\"repo-head\"><a href=\"" + esc(r.url) + "\" target=\"_blank\" rel=\"noopener\">" + esc(r.name) + "</a>" +
        '<span class="muted">' + esc(r.default_branch || "") + " · push " + esc(rel(r.pushed_at, now)) + "</span></div>" +
        (r.error ? '<div class="repo-err small">' + esc(r.error) + "</div>" : "") +
        (prs.length ? '<ul class="repo-prs">' + prs.map(function (p) {
          return '<li><a href="' + esc(p.url) + '" target="_blank" rel="noopener">#' + esc(p.number) + "</a> " + esc(p.title) + "</li>";
        }).join("") + "</ul>" : '<div class="muted small">žádné otevřené PR</div>') +
        "</li>";
    }).join(""));
  }

  // ---------------------------------------------------------------- canvas helpers
  function setupCanvas(canvas) {
    var dpr = window.devicePixelRatio || 1;
    var w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    }
    var ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx: ctx, w: w, h: h };
  }
  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  // ---------------------------------------------------------------- usage chart
  var usageGeom = null;
  function drawUsage(data, hoverX) {
    var c = setupCanvas($("usage-chart"));
    var ctx = c.ctx, W = c.w, H = c.h;
    if (hoverX == null) $("usage-tip").classList.add("hidden"); // poll redraw: no stale tooltip
    var pad = { l: 44, r: 14, t: 10, b: 26 };
    var pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
    ctx.font = "11px ui-monospace, monospace";
    // fixed Y axis 0..100 %
    for (var y = 0; y <= 100; y += 25) {
      var yy = pad.t + ph - (y / 100) * ph;
      ctx.strokeStyle = y === 100 ? "rgba(255,77,109,0.35)" : "rgba(110,200,255,0.12)";
      ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(W - pad.r, yy); ctx.stroke();
      ctx.fillStyle = css("--muted"); ctx.textAlign = "right"; ctx.textBaseline = "middle";
      ctx.fillText(y + " %", pad.l - 6, yy);
    }
    var pts = (data && data.points) || [];
    if (!data || !data.available || !pts.length) {
      ctx.fillStyle = css("--muted"); ctx.textAlign = "center";
      ctx.fillText(usageError ? "⚠ Nelze načíst kvótu: " + usageError : !data ? "Načítám…" :
        !data.available ? "claude_usage_history.jsonl nenalezen" : "Žádná data v tomto okně", pad.l + pw / 2, pad.t + ph / 2);
      usageGeom = null; return;
    }
    var nowTs = Date.now() / 1000;
    var spans = { "6h": 6 * 3600, "24h": 86400, "7d": 7 * 86400, "30d": 30 * 86400 };
    var t1 = Math.max(nowTs, pts[pts.length - 1].ts);
    var t0 = spans[data.window] ? t1 - spans[data.window] : pts[0].ts;
    if (t1 - t0 < 60) t0 = t1 - 60;
    function X(t) { return pad.l + ((t - t0) / (t1 - t0)) * pw; }
    function Y(v) { return pad.t + ph - (v / 100) * ph; }
    // x labels
    ctx.fillStyle = css("--muted"); ctx.textAlign = "center"; ctx.textBaseline = "top";
    var ticks = Math.max(2, Math.floor(pw / 110));
    for (var i = 0; i <= ticks; i++) {
      var t = t0 + (i / ticks) * (t1 - t0);
      var label = (t1 - t0) > 2 * 86400 ? fmtDateTime(t).replace(/ /, " ") : fmtTime(t);
      ctx.fillText(label, Math.min(Math.max(X(t), pad.l + 20), W - pad.r - 20), pad.t + ph + 7);
    }
    function line(key, color) {
      ctx.save();
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.shadowColor = color; ctx.shadowBlur = 10;
      ctx.beginPath();
      var started = false, prev = null;
      pts.forEach(function (p) {
        if (p[key] == null) { started = false; return; }
        var x = X(p.ts), y = Y(p[key]);
        // break the line on gaps longer than 2h (collector downtime)
        if (!started || (prev && p.ts - prev > 7200)) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        prev = p.ts;
      });
      ctx.stroke();
      // area fill
      ctx.shadowBlur = 0;
      var grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + ph);
      grad.addColorStop(0, color + "33"); grad.addColorStop(1, color + "00");
      ctx.lineTo(X(pts[pts.length - 1].ts), Y(0)); ctx.lineTo(X(pts[0].ts), Y(0));
      ctx.fillStyle = grad; ctx.fill();
      ctx.restore();
    }
    line("week_pct", css("--magenta"));
    line("session_pct", css("--cyan"));
    usageGeom = { X: X, Y: Y, pts: pts, pad: pad, ph: ph };

    if (hoverX != null) {
      var best = null;
      pts.forEach(function (p) { var d = Math.abs(X(p.ts) - hoverX); if (!best || d < best.d) best = { d: d, p: p }; });
      if (best) {
        var bx = X(best.p.ts);
        ctx.strokeStyle = "rgba(255,255,255,0.3)"; ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(bx, pad.t); ctx.lineTo(bx, pad.t + ph); ctx.stroke(); ctx.setLineDash([]);
        var tip = $("usage-tip");
        tip.innerHTML = esc(fmtDateTime(best.p.ts)) + "<br><span style=\"color:var(--cyan)\">session " +
          (best.p.session_pct == null ? "–" : best.p.session_pct.toFixed(0) + " %") + "</span> · <span style=\"color:var(--magenta)\">týden " +
          (best.p.week_pct == null ? "–" : best.p.week_pct.toFixed(0) + " %") + "</span>";
        tip.classList.remove("hidden");
        tip.style.left = Math.min(bx + 10, W - tip.offsetWidth - 4) + "px";
        tip.style.top = "8px";
      }
    }
  }
  ["pointermove", "pointerdown"].forEach(function (ev) { // pointerdown = tap on touch screens
    $("usage-chart").addEventListener(ev, function (e) {
      var r = e.target.getBoundingClientRect(); drawUsage(lastUsage, e.clientX - r.left);
    });
  });
  $("usage-chart").addEventListener("pointerleave", function () { $("usage-tip").classList.add("hidden"); drawUsage(lastUsage); });

  // window switches call fetchUsage directly (never dropped by the guard);
  // a late answer for a previous window is ignored below
  function fetchUsage() {
    var w = usageWindow;
    return getJSON("/api/usage?window=" + encodeURIComponent(w)).then(function (d) {
      if (w !== usageWindow) return;
      lastUsage = d; usageError = null; if (d.tz) tzOffset = d.tz.offset_seconds;
      if (w === "24h") { spark24 = d; renderQuotaSparks(); }
      var meta = d.available ? d.count + " vzorků" : "";
      if (d.latest) meta += " · poslední " + fmtDateTime(d.latest.ts) +
        (d.latest.session_reset ? " · reset session " + d.latest.session_reset : "");
      $("usage-meta").textContent = meta;
      renderUsageForecast(d);
      drawUsage(d);
    }).catch(function (e) { if (w === usageWindow) { usageError = e.message; drawUsage(lastUsage); } });
  }
  var pollUsage = guarded(fetchUsage);

  // Hero KPI sparklines: always the last 24 h (own request only when the big
  // chart shows another window), a pulsing dot marks the newest sample.
  var spark24 = null, sparkDrawn = {};
  var pollSpark = guarded(function () {
    if (usageWindow === "24h") return null;
    return getJSON("/api/usage?window=24h").then(function (d) { spark24 = d; renderQuotaSparks(); }, function () {});
  });
  function quotaSparkHTML(points, key, label) {
    var t1 = Date.now() / 1000, t0 = t1 - 86400;
    var r = L.sparkPaths(points, key, 100, 30, t0, t1);
    if (!r.last) return "";
    return '<svg viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">' +
      '<line x1="0" y1="0.5" x2="100" y2="0.5" class="ks-max" vector-effect="non-scaling-stroke"/>' +
      r.paths.map(function (p) { return '<polyline points="' + p + '" vector-effect="non-scaling-stroke" pathLength="100"/>'; }).join("") +
      "</svg>" + '<span class="ks-dot" style="left:' + r.last.x.toFixed(1) + "%;top:" + (r.last.y / 30 * 100).toFixed(1) + '%" title="' +
      esc(label + " " + Math.round(r.last.v) + " %") + '"></span>';
  }
  function renderQuotaSparks() {
    var pts = (spark24 && spark24.points) || [];
    [["kpi-session-spark", "session_pct", "session"], ["kpi-week-spark", "week_pct", "týden"]].forEach(function (k) {
      var el = $(k[0]);
      // the line draws itself in once; later polls only update it in place
      if (setHTML(el, quotaSparkHTML(pts, k[1], k[2])) && !sparkDrawn[k[0]] && el.firstChild) {
        sparkDrawn[k[0]] = true; el.classList.add("draw-in");
        setTimeout(function () { el.classList.remove("draw-in"); }, 1400);
      }
    });
  }
  Array.prototype.forEach.call(document.querySelectorAll("#usage-windows button"), function (b) {
    b.addEventListener("click", function () {
      usageWindow = b.getAttribute("data-w");
      $("usage-export").innerHTML = exportLinks("kind=usage&window=" + usageWindow);
      Array.prototype.forEach.call(document.querySelectorAll("#usage-windows button"), function (x) { x.classList.toggle("active", x === b); });
      fetchUsage();
    });
  });

  // ---------------------------------------------------------------- tokens chart
  function dayValue(bucket) {
    if (!bucket) return 0;
    if (tokenMode === "cost") {
      return (bucket.actual_cost_usd > 0 ? bucket.actual_cost_usd : (bucket.estimated_cost_usd || 0));
    }
    if (bucket.total_tokens != null) return bucket.total_tokens;
    var s = 0;
    Object.keys(bucket).forEach(function (k) { if (k.indexOf("token") >= 0) s += bucket[k]; });
    return s;
  }
  var tokenGeom = null;
  function drawTokens(data, hoverX) {
    var c = setupCanvas($("token-chart"));
    var ctx = c.ctx, W = c.w, H = c.h;
    if (hoverX == null) $("token-tip").classList.add("hidden");
    var pad = { l: 56, r: 10, t: 10, b: 24 };
    var pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
    ctx.font = "11px ui-monospace, monospace";
    if (!data || tokensError) {
      ctx.fillStyle = css("--muted"); ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(tokensError ? "⚠ Nelze načíst state.db data: " + tokensError : "Načítám…", pad.l + pw / 2, pad.t + ph / 2);
      tokenGeom = null; return;
    }
    var days = data.day_keys || [];
    var avail = data.profiles.filter(function (p) { return p.available; });
    setHTML($("token-legend"), data.profiles.map(function (p) {
      var tot = dayValue(p.totals);
      return '<span class="lg" style="--c:' + (PROFILE_COLORS[p.profile] || "#888") + '">' + esc(p.profile) + ": " +
        (p.available ? (tokenMode === "cost" ? "$" + tot.toFixed(2) : fmtNum(tot)) : '<span class="muted">' + esc(p.error ? "chyba DB" : "bez state.db") + "</span>") + "</span>";
    }).join(""));
    var stacks = days.map(function (day) {
      return avail.map(function (p) { return { profile: p.profile, v: dayValue(p.days[day]) }; });
    });
    var max = 0;
    stacks.forEach(function (s) { var t = s.reduce(function (a, b) { return a + b.v; }, 0); if (t > max) max = t; });
    if (!avail.length || max <= 0) {
      ctx.fillStyle = css("--muted"); ctx.textAlign = "center";
      ctx.fillText(avail.length ? "Žádná spotřeba za posledních " + data.days + " dní" : "Nenalezen žádný state.db", pad.l + pw / 2, pad.t + ph / 2);
      tokenGeom = null; return;
    }
    for (var g = 0; g <= 4; g++) {
      var val = (max * g) / 4, yy = pad.t + ph - (g / 4) * ph;
      ctx.strokeStyle = "rgba(110,200,255,0.12)"; ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(W - pad.r, yy); ctx.stroke();
      ctx.fillStyle = css("--muted"); ctx.textAlign = "right"; ctx.textBaseline = "middle";
      ctx.fillText(tokenMode === "cost" ? "$" + val.toFixed(val < 10 ? 2 : 0) : fmtNum(val), pad.l - 6, yy);
    }
    var bw = pw / days.length;
    stacks.forEach(function (s, idx) {
      var x = pad.l + idx * bw + bw * 0.15, y = pad.t + ph;
      s.forEach(function (seg) {
        var h = (seg.v / max) * ph;
        if (h <= 0) return;
        ctx.fillStyle = PROFILE_COLORS[seg.profile] || "#888";
        ctx.globalAlpha = hoverX != null && Math.floor((hoverX - pad.l) / bw) === idx ? 1 : 0.75;
        ctx.fillRect(x, y - h, bw * 0.7, h);
        y -= h;
      });
      ctx.globalAlpha = 1;
      // ~44px per "dd.mm." label; skip labels instead of letting them overlap
      var every = Math.max(1, Math.ceil(44 / bw));
      if ((days.length - 1 - idx) % every === 0) {
        ctx.fillStyle = css("--muted"); ctx.textAlign = "center"; ctx.textBaseline = "top";
        ctx.fillText(days[idx].slice(8) + "." + days[idx].slice(5, 7) + ".", pad.l + idx * bw + bw / 2, pad.t + ph + 6);
      }
    });
    tokenGeom = { pad: pad, bw: bw, days: days, stacks: stacks };
    if (hoverX != null) {
      var di = Math.floor((hoverX - pad.l) / bw);
      if (di >= 0 && di < days.length) {
        var tip = $("token-tip");
        tip.innerHTML = esc(days[di]) + "<br>" + stacks[di].map(function (s) {
          return '<span style="color:' + PROFILE_COLORS[s.profile] + '">' + esc(s.profile) + "</span> " +
            (tokenMode === "cost" ? "$" + s.v.toFixed(3) : fmtNum(s.v));
        }).join("<br>");
        tip.classList.remove("hidden");
        tip.style.left = Math.min(pad.l + di * bw + bw, W - tip.offsetWidth - 4) + "px";
        tip.style.top = "8px";
      }
    }
  }
  ["pointermove", "pointerdown"].forEach(function (ev) { // pointerdown = tap on touch screens
    $("token-chart").addEventListener(ev, function (e) {
      var r = e.target.getBoundingClientRect(); drawTokens(lastTokens, e.clientX - r.left);
    });
  });
  $("token-chart").addEventListener("pointerleave", function () { $("token-tip").classList.add("hidden"); drawTokens(lastTokens); });
  Array.prototype.forEach.call(document.querySelectorAll("#token-mode button"), function (b) {
    b.addEventListener("click", function () {
      tokenMode = b.getAttribute("data-m");
      Array.prototype.forEach.call(document.querySelectorAll("#token-mode button"), function (x) { x.classList.toggle("active", x === b); });
      drawTokens(lastTokens); renderForecast();
    });
  });

  // ---------------------------------------------------------------- polling
  // At most one request per endpoint in flight (a slow backend must not pile
  // up requests), nothing while the tab is hidden, catch-up when it shows.
  function guarded(fn) {
    var busy = false;
    return function () {
      if (busy) return;
      busy = true;
      var p = fn();
      var done = function () { busy = false; };
      if (p && p.then) p.then(done, done); else done();
    };
  }
  function every(ms, fn) { setInterval(function () { if (!document.hidden) fn(); }, ms); }
  var lastStateOk = null, lastStateFail = null;
  var pollState = guarded(function () {
    return getJSON("/api/state").then(function (st) {
      if (st.error) throw new Error(st.error);
      setConn(true); lastStateOk = Date.now(); lastStateFail = null; renderState(st); tickUpdated();
    }).catch(function (e) {
      setConn(false); lastStateFail = Date.now(); tickUpdated();
      updateFavicon("error", 1);
      document.body.setAttribute("data-level", "error");
      $("bubble-text").textContent = "Ztratil jsem spojení s backendem! (" + e.message + ")";
      lastBubble = null;
      window.dispatchEvent(new CustomEvent("mc-state", { detail: { summary: { level: "error", mood: "alarmed", cause: "backend" } } }));
    });
  });

  function tickClock() {
    var t = Date.now() / 1000, d = hostDate(t);
    $("clock").textContent = pad(d.h) + ":" + pad(d.m) + ":" + pad(d.s) + (tzOffset != null ? " host" : "");
  }

  // ---------------------------------------------------------------- detail views
  // Client-side routing over the same read-only API:
  //   #/agent/<profile>            profile detail (log, cron, tokens, incidents)
  //   #/cron/<profile>/<job>       one cron job with its run history
  //   #/incidents?profile=&level=&hours=   full, filterable incident log
  var TOKEN_SERIES_COLORS = ["#3ef2ff", "#ff4fd8", "#ffc53d", "#3dffa8", "#9b6bff", "#ff8a3d"];
  var LEVELS = ["info", "warning", "error", "critical"];
  var modal = { open: false, depth: 0, pendingPush: false, route: null, lastFocus: null, seq: 0, chart: null };

  function parseRoute(hash) {
    var h = (hash || "").replace(/^#\/?/, "");
    if (!h) return null;
    var q = {}, qi = h.indexOf("?");
    if (qi >= 0) {
      h.slice(qi + 1).split("&").forEach(function (kv) {
        if (!kv) return;
        var i = kv.indexOf("=");
        q[decodeURIComponent(i < 0 ? kv : kv.slice(0, i))] = i < 0 ? "" : decodeURIComponent(kv.slice(i + 1));
      });
      h = h.slice(0, qi);
    }
    var parts = h.split("/").map(decodeURIComponent);
    if (parts[0] === "agent" && parts[1]) return { view: "agent", profile: parts[1] };
    if (parts[0] === "cron" && parts[1] && parts[2]) return { view: "cron", profile: parts[1], job: parts.slice(2).join("/") };
    if (parts[0] === "help") return { view: "help" };
    if (parts[0] === "compare") return { view: "compare", sort: q.sort || "", dir: q.dir || "" };
    if (parts[0] === "search") return { view: "search", q: q.q || "" };
    if (parts[0] === "incidents") return { view: "incidents", profile: q.profile || "", level: q.level || "", hours: q.hours || "24", q: q.q || "" };
    return null;
  }
  function incidentsHash(r) {
    var q = [];
    if (r.profile) q.push("profile=" + encodeURIComponent(r.profile));
    if (r.level) q.push("level=" + encodeURIComponent(r.level));
    if (r.hours && r.hours !== "24") q.push("hours=" + encodeURIComponent(r.hours));
    if (r.q) q.push("q=" + encodeURIComponent(r.q));
    return "#/incidents" + (q.length ? "?" + q.join("&") : "");
  }

  function openModal() {
    if (modal.open) return;
    modal.open = true;
    modal.lastFocus = document.activeElement;
    $("modal").classList.remove("hidden");
    document.body.classList.add("modal-open");
    var close = document.querySelector("#modal .modal-head [data-close]");
    if (close) close.focus();
  }
  function hideModal() {
    if (!modal.open) return;
    modal.open = false; modal.route = null; modal.chart = null;
    $("modal").classList.add("hidden");
    document.body.classList.remove("modal-open");
    $("modal-body").innerHTML = "";
    if (modal.lastFocus && modal.lastFocus.focus) modal.lastFocus.focus();
  }
  function closeModal() {
    // Opened via in-app links -> step back over them so Back/Forward stay sane;
    // opened from a deep link -> just drop the hash.
    if (modal.depth > 0) { var n = modal.depth; modal.depth = 0; history.go(-n); return; }
    history.replaceState(null, "", location.pathname + location.search);
    hideModal();
  }

  function setModalHead(crumb, title) {
    $("modal-crumb").innerHTML = crumb;
    $("modal-title").textContent = title;
    modalTitle = title; applyTitle();
  }
  function bodyLoading(text) {
    $("modal-body").innerHTML = '<div class="loading-block"><span class="spinner"></span>' + esc(text || "Načítám…") + "</div>";
  }
  function bodyError(msg) {
    $("modal-body").innerHTML = '<div class="error-block">⚠ ' + esc(msg) +
      ' <button class="btn btn-sm" type="button" data-retry>zkusit znovu</button></div>';
  }
  function stamp() { $("modal-stamp").textContent = "načteno " + fmtTime(Date.now() / 1000); }
  function getJSONStrict(url) {
    return fetch(url, { cache: "no-store" }).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok) throw new Error(d && d.error ? d.error : "HTTP " + r.status);
        return d;
      });
    });
  }

  function route(e) {
    var r = parseRoute(location.hash);
    if (modal.pendingPush) { modal.pendingPush = false; if (r) modal.depth++; }
    else if (e && e.type === "hashchange" && modal.depth > 0) modal.depth--; // browser Back
    if (!r) { modal.depth = 0; hideModal(); modalTitle = null; applyTitle(); return; }
    openModal();
    modal.route = r;
    var seq = ++modal.seq;
    var current = function () { return seq === modal.seq && modal.open; };
    $("modal-stamp").textContent = "";
    if (r.view === "agent") return renderAgentDetail(r, current);
    if (r.view === "cron") return renderCronDetail(r, current);
    if (r.view === "help") return renderHelp();
    if (r.view === "compare") return renderCompare(r, current);
    if (r.view === "search") return whenState(function () { if (current()) renderSearch(r); });
    renderIncidentDetail(r, current);
  }

  function whenState(cb) {
    if (window.__mcLastState) return cb(window.__mcLastState);
    bodyLoading("Čekám na první data z /api/state…");
    var once = function () { window.removeEventListener("mc-state", once); if (window.__mcLastState) cb(window.__mcLastState); };
    window.addEventListener("mc-state", once);
  }

  function crumbHome() { return '<a href="#" data-close>dashboard</a>'; }
  function profileLabel(p) { return p === "default" ? "default (BMO)" : p; }
  function levelOf(line) {
    var m = /\b(CRITICAL|FATAL|ERROR|EXCEPTION|WARNING|WARN)\b/.exec(line.slice(0, 80));
    if (!m) return "info";
    return { CRITICAL: "critical", FATAL: "critical", ERROR: "error", EXCEPTION: "error", WARNING: "warning", WARN: "warning" }[m[1]];
  }
  function sevRank(l) { return Math.max(0, LEVELS.indexOf(l)); }

  function incidentItems(list, now) {
    if (!list.length) return '<li class="empty">Žádné záznamy pro zvolený filtr.</li>';
    return list.map(function (i) {
      return '<li class="' + esc(i.level) + '"><div class="inc-meta"><span class="inc-lvl">' + esc(lvLabel(i.level)) + "</span>" +
        "<span>" + esc(i.ts ? fmtDateTime(i.ts) + " (" + rel(i.ts, now) + ")" : "bez času") + "</span>" +
        (i.profile ? '<a href="#/incidents?profile=' + encodeURIComponent(i.profile) + '">' + esc(i.profile) + "</a>" : "") +
        "<span>" + esc(i.source || "") + "</span></div>" +
        '<div class="inc-msg">' + esc(i.message) + "</div>" +
        (i.details && i.details.length ? "<details><summary class=\"muted small\">detail</summary><pre>" + esc(i.details.join("\n")) + "</pre></details>" : "") +
        "</li>";
    }).join("");
  }

  // -- generic stacked bar chart (profile detail) ------------------------
  function drawStacked(canvas, tip, chart, hoverX) {
    var c = setupCanvas(canvas), ctx = c.ctx, W = c.w, H = c.h;
    var pad = { l: 56, r: 10, t: 10, b: 24 }, pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
    ctx.font = "11px ui-monospace, monospace";
    var labels = chart.labels, series = chart.series, max = 0;
    labels.forEach(function (_, i) {
      var t = series.reduce(function (a, s) { return a + (s.values[i] || 0); }, 0);
      if (t > max) max = t;
    });
    if (max <= 0) {
      ctx.fillStyle = css("--muted"); ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(chart.empty, pad.l + pw / 2, pad.t + ph / 2); tip.classList.add("hidden"); return;
    }
    for (var g = 0; g <= 4; g++) {
      var yy = pad.t + ph - (g / 4) * ph;
      ctx.strokeStyle = "rgba(110,200,255,0.12)"; ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(W - pad.r, yy); ctx.stroke();
      ctx.fillStyle = css("--muted"); ctx.textAlign = "right"; ctx.textBaseline = "middle";
      ctx.fillText(chart.fmt((max * g) / 4), pad.l - 6, yy);
    }
    var bw = pw / labels.length, every = Math.max(1, Math.ceil(44 / bw));
    var hi = hoverX != null ? Math.floor((hoverX - pad.l) / bw) : -1;
    labels.forEach(function (lab, i) {
      var x = pad.l + i * bw + bw * 0.15, y = pad.t + ph;
      series.forEach(function (s) {
        var h = ((s.values[i] || 0) / max) * ph;
        if (h <= 0) return;
        ctx.fillStyle = s.color; ctx.globalAlpha = i === hi ? 1 : 0.75;
        ctx.fillRect(x, y - h, bw * 0.7, h); y -= h;
      });
      ctx.globalAlpha = 1;
      if ((labels.length - 1 - i) % every === 0) {
        ctx.fillStyle = css("--muted"); ctx.textAlign = "center"; ctx.textBaseline = "top";
        ctx.fillText(lab.slice(8) + "." + lab.slice(5, 7) + ".", pad.l + i * bw + bw / 2, pad.t + ph + 6);
      }
    });
    if (hi >= 0 && hi < labels.length) {
      tip.innerHTML = esc(labels[hi]) + "<br>" + series.map(function (s) {
        return '<span style="color:' + s.color + '">' + esc(s.name) + "</span> " + chart.fmt(s.values[hi] || 0);
      }).join("<br>");
      tip.classList.remove("hidden");
      tip.style.left = Math.max(0, Math.min(pad.l + hi * bw + bw, W - tip.offsetWidth - 4)) + "px";
      tip.style.top = "8px";
    } else tip.classList.add("hidden");
  }
  function profileTokenChart(entry, days, mode) {
    var keys = [];
    if (mode === "cost") keys = ["cost"];
    else Object.keys(entry.totals || {}).forEach(function (k) {
      if (k.indexOf("token") >= 0 && k !== "total_tokens" && keys.indexOf(k) < 0) keys.push(k);
    });
    return {
      labels: days,
      fmt: mode === "cost" ? function (v) { return "$" + v.toFixed(v < 10 ? 2 : 0); } : fmtNum,
      empty: entry.available ? "Žádná spotřeba v tomto období" : (entry.error ? "Chyba state.db: " + entry.error : "state.db nenalezen"),
      series: keys.map(function (k, i) {
        return {
          name: L.tokenSeriesName(k),
          color: TOKEN_SERIES_COLORS[i % TOKEN_SERIES_COLORS.length],
          values: days.map(function (d) {
            var b = entry.days[d];
            if (!b) return 0;
            return k === "cost" ? (b.actual_cost_usd > 0 ? b.actual_cost_usd : (b.estimated_cost_usd || 0)) : (b[k] || 0);
          })
        };
      })
    };
  }
  function bindChart(canvas, tip, getChart) {
    var draw = function (x) { var ch = getChart(); if (ch) drawStacked(canvas, tip, ch, x); };
    ["pointermove", "pointerdown"].forEach(function (ev) {
      canvas.addEventListener(ev, function (e) { draw(e.clientX - canvas.getBoundingClientRect().left); });
    });
    canvas.addEventListener("pointerleave", function () { draw(null); });
    modal.chart = function () { draw(null); };
    draw(null);
  }

  // -- agent / profile detail ---------------------------------------------
  function renderAgentDetail(r, current) {
    whenState(function (st) {
      if (!current()) return;
      var a = (st.agents || []).filter(function (x) { return x.profile === r.profile; })[0];
      if (!a) { setModalHead(crumbHome(), "Neznámý profil"); bodyError("Profil „" + r.profile + "“ neexistuje."); return; }
      setModalHead(crumbHome() + " › agenti", (a.label === "BMO" ? "BMO · default" : a.label));
      var cron = (st.cron || []).filter(function (c) { return c.profile === r.profile; })[0] || { jobs: [] };
      var procs = ((st.processes && st.processes.list) || []).filter(function (x) { return x.profile === r.profile; });
      var conn = connPill(a);
      var html = '<div class="detail-grid">' +
        '<section class="detail-card"><h4>Stav</h4><dl class="kv">' +
        "<dt>spojení</dt><dd>" + conn + "</dd>" +
        "<dt>teď</dt><dd>" + (a.busy ? "⚡ " : "💤 ") + esc(L.activityLabel(a.activity)) + "</dd>" +
        "<dt>platformy</dt><dd>" + (a.platforms.length ? a.platforms.map(function (p) {
          return '<span class="cell ' + esc(platformCell(p)) + '"></span> ' + esc(p.platform) + ' <span class="muted">' + esc(platformTitle(p)) + "</span>";
        }).join("<br>") : '<span class="muted">žádné</span>') + "</dd>" +
        '<dt title="Odhad podle child procesů gateway PID">procesy ⓘ</dt><dd>' + (a.processes == null ? "N/A" : "~" + a.processes) + "</dd>" +
        (a.health ? "<dt>zdraví</dt><dd>" + healthBadge(a.health) + (a.health.factors.length ? '<ul class="health-factors">' + a.health.factors.map(function (f) {
          return "<li>" + esc(f.label) + ' <span class="muted">−' + f.penalty + "</span></li>";
        }).join("") + "</ul>" : ' <span class="muted">bez problémů</span>') + "</dd>" : "") +
        "</dl>" +
        (procs.length ? '<div class="table-wrap"><table class="proc-table"><tr><th>PID</th><th>běží</th><th>příkaz</th></tr>' + procs.map(function (x) {
          return "<tr><td class=\"mono\">" + esc(x.pid) + "</td><td>" + esc(fmtDur(x.elapsed)) + '</td><td class="mono cmd">' + esc(x.cmd) + "</td></tr>";
        }).join("") + "</table></div>" : "") +
        "</section>" +
        '<section class="detail-card"><h4>Cron joby <span class="muted small">(' + cron.jobs.length + ")</span></h4>" +
        (cron.available === false ? '<div class="empty">jobs.json nenalezen</div>' : cron.jobs.length ? '<ul class="job-list">' + cron.jobs.map(function (j) {
          return '<li><a href="' + jobHref(r.profile, j) + '">' + esc(j.name) + "</a> " + statusPill(j.status) +
            '<span class="muted small">' + esc(j.schedule || "") + " · poslední " + esc(rel(j.last_run_at, st.now)) + (j.failure_streak ? ' · <span class="streak">' + j.failure_streak + "×</span>" : "") + "</span>" + sparkHTML(j.recent) + "</li>";
        }).join("") + "</ul>" : '<div class="empty">žádné joby</div>') +
        "</section></div>" +
        '<section class="detail-card"><div class="panel-head"><h4>Tokeny / náklady <span class="muted small">(state.db, 30 dní)</span></h4>' +
        '<div class="seg" id="d-token-mode"><button data-m="tokens" class="active">tokeny</button><button data-m="cost">$</button></div></div>' +
        '<div class="legend" id="d-token-legend"></div>' +
        '<div class="chart-wrap short"><canvas id="d-token-chart"></canvas><div id="d-token-tip" class="tip hidden"></div></div></section>' +
        '<section class="detail-card"><div class="panel-head"><h4>Incidenty <span class="muted small">(7 dní)</span></h4>' +
        '<a class="link-more" href="' + incidentsHash({ profile: r.profile, hours: "168" }) + '">filtrovat ›</a></div>' +
        '<ul class="incidents" id="d-incidents"><li class="empty loading">Načítám…</li></ul></section>' +
        '<section class="detail-card"><div class="panel-head"><h4>agent.log</h4><div class="filters">' +
        '<select id="d-log-lines" aria-label="počet řádků"><option value="100">100 řádků</option><option value="300" selected>300 řádků</option><option value="1000">1000 řádků</option></select>' +
        '<select id="d-log-level" aria-label="závažnost"><option value="">vše</option><option value="warning">varování+</option><option value="error">chyba+</option></select>' +
        '<input id="d-log-q" type="search" placeholder="hledat…" aria-label="hledat v logu"></div></div>' +
        '<pre class="log-view" id="d-log"><span class="muted">Načítám…</span></pre><div class="muted small" id="d-log-meta"></div></section>';
      $("modal-body").innerHTML = html;

      // tokens
      var tokenData = null, tokenMode = "tokens";
      var chartFor = function () {
        if (!tokenData) return null;
        var e = tokenData.profiles.filter(function (p) { return p.profile === r.profile; })[0] || { available: false, days: {}, totals: {} };
        var ch = profileTokenChart(e, tokenData.day_keys, tokenMode);
        $("d-token-legend").innerHTML = ch.series.map(function (s) {
          var tot = s.values.reduce(function (x, y) { return x + y; }, 0);
          return '<span class="lg" style="--c:' + s.color + '">' + esc(s.name) + ": " + ch.fmt(tot) + "</span>";
        }).join("");
        return ch;
      };
      Array.prototype.forEach.call(document.querySelectorAll("#d-token-mode button"), function (b) {
        b.addEventListener("click", function () {
          tokenMode = b.getAttribute("data-m");
          Array.prototype.forEach.call(document.querySelectorAll("#d-token-mode button"), function (x) { x.classList.toggle("active", x === b); });
          if (modal.chart) modal.chart();
        });
      });
      getJSONStrict("/api/tokens?days=30").then(function (d) {
        if (!current()) return;
        tokenData = d; bindChart($("d-token-chart"), $("d-token-tip"), chartFor);
      }).catch(function (e) { if (current()) $("d-token-legend").innerHTML = '<span class="repo-err">' + esc(e.message) + "</span>"; });

      // incidents
      getJSONStrict("/api/incidents?profile=" + encodeURIComponent(r.profile) + "&hours=168&limit=30").then(function (d) {
        if (!current()) return;
        $("d-incidents").innerHTML = incidentItems(d.incidents, d.now) +
          (d.total > d.incidents.length ? '<li class="muted small">… a dalších ' + (d.total - d.incidents.length) + "</li>" : "");
      }).catch(function (e) { if (current()) $("d-incidents").innerHTML = '<li class="empty">' + esc(e.message) + "</li>"; });

      // log
      var logLines = [];
      var renderLog = function () {
        var min = $("d-log-level").value, q = $("d-log-q").value.trim().toLowerCase();
        var shown = logLines.filter(function (l) {
          return (!min || sevRank(levelOf(l)) >= sevRank(min)) && (!q || l.toLowerCase().indexOf(q) >= 0);
        });
        var pre = $("d-log");
        pre.innerHTML = shown.length ? shown.map(function (l) { return '<span class="ll ll-' + levelOf(l) + '">' + esc(l) + "</span>"; }).join("\n")
          : '<span class="muted">' + (logLines.length ? "Nic neodpovídá filtru." : "agent.log je prázdný nebo neexistuje.") + "</span>";
        pre.scrollTop = pre.scrollHeight;
        $("d-log-meta").textContent = shown.length + " z " + logLines.length + " řádků";
      };
      var loadLog = function () {
        $("d-log").innerHTML = '<span class="muted">Načítám…</span>';
        getJSONStrict("/api/agent-log?profile=" + encodeURIComponent(r.profile) + "&lines=" + $("d-log-lines").value).then(function (d) {
          if (!current()) return;
          logLines = d.lines; renderLog(); stamp();
        }).catch(function (e) { if (current()) $("d-log").textContent = "⚠ " + e.message; });
      };
      $("d-log-lines").addEventListener("change", loadLog);
      $("d-log-level").addEventListener("change", renderLog);
      $("d-log-q").addEventListener("input", renderLog);
      loadLog();
    });
  }

  // -- cron job detail ------------------------------------------------------
  function renderCronDetail(r, current) {
    setModalHead(crumbHome() + ' › <a href="' + agentHref(r.profile) + '">' + esc(profileLabel(r.profile)) + "</a> › cron", r.job);
    bodyLoading("Načítám historii běhů…");
    getJSONStrict("/api/cron/runs?profile=" + encodeURIComponent(r.profile) + "&job=" + encodeURIComponent(r.job) + "&limit=100").then(function (d) {
      if (!current()) return;
      var j = d.job, now = Date.now() / 1000;
      setModalHead(crumbHome() + ' › <a href="' + agentHref(r.profile) + '">' + esc(profileLabel(r.profile)) + "</a> › cron", j.name);
      var strip = d.runs.slice().reverse().map(function (x) {
        return '<span class="run-dot ' + esc(x.status) + '" title="' + esc(fmtDateTime(x.ts) + " · " + stLabel(x.status)) + '"></span>';
      }).join("");
      var html = '<div class="detail-grid">' +
        '<section class="detail-card"><h4>Job</h4><dl class="kv">' +
        "<dt>stav</dt><dd>" + statusPill(j.status) + (j.enabled ? "" : ' <span class="muted">(vypnutý)</span>') + "</dd>" +
        "<dt>id</dt><dd class=\"mono\">" + esc(j.id || "–") + "</dd>" +
        "<dt>rozvrh</dt><dd class=\"mono\">" + esc(j.schedule || "–") + "</dd>" +
        "<dt>poslední běh</dt><dd>" + esc(fmtDateTime(j.last_run_at)) + " (" + esc(rel(j.last_run_at, now)) + ")" + (j.last_status ? " · " + esc(stLabel(j.last_status)) : "") + "</dd>" +
        "<dt>další běh</dt><dd>" + esc(j.enabled ? fmtDateTime(j.next_run_at) + " (" + rel(j.next_run_at, now) + ")" : "–") + "</dd>" +
        "<dt>chyb v řadě</dt><dd>" + (j.failure_streak ? '<span class="streak">' + j.failure_streak + "×</span>" : "0") + "</dd>" +
        (j.last_error ? '<dt>poslední chyba</dt><dd class="repo-err-full">' + esc(j.last_error) + "</dd>" : "") +
        "</dl></section>" +
        '<section class="detail-card"><h4>Statistika <span class="muted small">(posledních ' + d.count + " běhů)</span></h4>" +
        '<div class="kpis kpis-3">' +
        '<div class="kpi"><div class="kpi-label">úspěšnost</div><div class="kpi-value">' + (d.success_rate == null ? "–" : Math.round(d.success_rate * 100) + " %") + "</div></div>" +
        '<div class="kpi"><div class="kpi-label">selhání</div><div class="kpi-value"' + (d.failed ? ' style="color:var(--err)"' : "") + ">" + d.failed + "</div></div>" +
        '<div class="kpi"><div class="kpi-label">interval</div><div class="kpi-value small-val">' + esc(d.median_interval ? "~" + fmtDur(d.median_interval) : "–") + "</div></div></div>" +
        (strip ? '<div class="run-strip" aria-label="běhy od nejstaršího po nejnovější">' + strip + "</div>" : "") +
        '<div class="muted small">zdroj: ' + esc(d.source || "žádná historie") +
        (d.source === "cron/jobs.json" ? " — adresář cron/output pro tento job neexistuje, známe jen poslední běh" : " — stav běhu odhadnut z obsahu výstupu") + "</div>" +
        "</section></div>" +
        '<section class="detail-card"><div class="panel-head"><h4>Historie běhů</h4><div class="seg" id="d-run-filter">' +
        '<button data-f="" class="active">vše</button><button data-f="error">jen chyby</button></div></div>' +
        '<ul class="runs" id="d-runs"></ul></section>';
      $("modal-body").innerHTML = html;
      var filter = "";
      var renderRuns = function () {
        var list = d.runs.filter(function (x) { return !filter || x.status === filter; });
        $("d-runs").innerHTML = list.length ? list.map(function (x) {
          return '<li class="run ' + esc(x.status) + '"><div class="run-head">' + statusPill(x.status) +
            "<span>" + esc(fmtDateTime(x.ts)) + ' <span class="muted">(' + esc(rel(x.ts, now)) + ")</span></span>" +
            (x.file ? '<span class="muted small mono">' + esc(x.file) + "</span>" : "") + "</div>" +
            (x.preview ? "<details" + (x.status === "error" ? " open" : "") + '><summary class="muted small">výstup</summary><pre>' + esc(x.preview) + (x.truncated ? "\n…" : "") + "</pre></details>" : "") +
            "</li>";
        }).join("") : '<li class="empty">' + (d.runs.length ? "Žádné neúspěšné běhy. 🎉" : "Job zatím neběžel.") + "</li>";
      };
      Array.prototype.forEach.call(document.querySelectorAll("#d-run-filter button"), function (b) {
        b.addEventListener("click", function () {
          filter = b.getAttribute("data-f");
          Array.prototype.forEach.call(document.querySelectorAll("#d-run-filter button"), function (x) { x.classList.toggle("active", x === b); });
          renderRuns();
        });
      });
      renderRuns(); stamp();
    }).catch(function (e) { if (current()) bodyError(e.message === "HTTP 404" ? "Job nenalezen." : e.message); });
  }

  // -- incidents detail -----------------------------------------------------
  function renderIncidentDetail(r, current) {
    setModalHead(crumbHome(), "Incidenty a chyby");
    var profiles = (window.__mcLastState && window.__mcLastState.agents || []).map(function (a) { return a.profile; });
    if (!profiles.length) profiles = Object.keys(PROFILE_COLORS);
    var html = '<div class="filters filters-bar">' +
      '<label>profil <select id="d-inc-profile"><option value="">všechny</option>' + profiles.map(function (p) {
        return '<option value="' + esc(p) + '"' + (p === r.profile ? " selected" : "") + ">" + esc(profileLabel(p)) + "</option>";
      }).join("") + "</select></label>" +
      '<div class="seg" id="d-inc-level" role="group" aria-label="minimální závažnost">' + ["", "warning", "error", "critical"].map(function (l) {
        return '<button data-l="' + l + '"' + (l === r.level ? ' class="active"' : "") + ">" + (!l ? "vše" : l === "critical" ? lvLabel(l) : lvLabel(l) + "+") + "</button>";
      }).join("") + "</div>" +
      '<div class="seg" id="d-inc-hours" role="group" aria-label="období">' + [["24", "24h"], ["72", "3d"], ["168", "7d"]].map(function (h) {
        return '<button data-h="' + h[0] + '"' + (h[0] === r.hours ? ' class="active"' : "") + ">" + h[1] + "</button>";
      }).join("") + "</div>" +
      '<input id="d-inc-q" type="search" placeholder="hledat ve zprávě…" aria-label="hledat" value="' + esc(r.q || "") + '">' +
      exportLinks("kind=incidents&hours=" + encodeURIComponent(r.hours) + (r.profile ? "&profile=" + encodeURIComponent(r.profile) : "") +
        (r.level ? "&level=" + encodeURIComponent(r.level) : "")) + "</div>" +
      '<div class="inc-counts" id="d-inc-counts"></div>' +
      '<ul class="incidents incidents-full" id="d-inc-list"><li class="empty loading">Načítám…</li></ul>';
    $("modal-body").innerHTML = html;
    var nav = function (patch) {
      var next = { profile: r.profile, level: r.level, hours: r.hours, q: $("d-inc-q").value.trim() };
      Object.keys(patch).forEach(function (k) { next[k] = patch[k]; });
      history.replaceState(null, "", incidentsHash(next));
      route();
    };
    $("d-inc-profile").addEventListener("change", function () { nav({ profile: this.value }); });
    Array.prototype.forEach.call(document.querySelectorAll("#d-inc-level button"), function (b) {
      b.addEventListener("click", function () { nav({ level: b.getAttribute("data-l") }); });
    });
    Array.prototype.forEach.call(document.querySelectorAll("#d-inc-hours button"), function (b) {
      b.addEventListener("click", function () { nav({ hours: b.getAttribute("data-h") }); });
    });
    var data = null;
    var renderList = function () {
      if (!data) return;
      var q = $("d-inc-q").value.trim().toLowerCase();
      var list = data.incidents.filter(function (i) {
        return !q || (i.message + " " + (i.details || []).join(" ") + " " + (i.source || "")).toLowerCase().indexOf(q) >= 0;
      });
      $("d-inc-list").innerHTML = incidentItems(list.slice(0, 500), data.now) +
        (list.length > 500 ? '<li class="muted small">Zobrazeno prvních 500 z ' + list.length + " — zpřesni filtr.</li>" : "");
      $("d-inc-counts").innerHTML = LEVELS.slice().reverse().map(function (l) {
        return '<span class="cnt ' + l + '">' + lvLabel(l) + " " + (data.counts[l] || 0) + "</span>";
      }).join("") + '<span class="muted small">zobrazeno ' + Math.min(list.length, 500) + " z " + data.incidents.length +
        (data.incidents.length < data.total ? " (" + data.total + " bez filtru závažnosti)" : "") + "</span>";
    };
    $("d-inc-q").addEventListener("input", function () {
      renderList();
      history.replaceState(null, "", incidentsHash({ profile: r.profile, level: r.level, hours: r.hours, q: this.value.trim() }));
    });
    getJSONStrict("/api/incidents?hours=" + encodeURIComponent(r.hours) + (r.profile ? "&profile=" + encodeURIComponent(r.profile) : "") +
      (r.level ? "&level=" + encodeURIComponent(r.level) : "")).then(function (d) {
      if (!current()) return;
      data = d; renderList(); stamp();
    }).catch(function (e) { if (current()) $("d-inc-list").innerHTML = '<li class="empty">⚠ ' + esc(e.message) + "</li>"; });
  }

  // -- profile comparison ------------------------------------------------------
  // Columns: [key, header, formatter, "worst" direction for highlighting]
  // worst: "max" = highest value is the notable one, "min" = lowest is.
  var COMPARE_COLS = [
    ["health", "HP", function (v, r) { return healthBadge({ score: v, level: r.health_level, factors: [] }); }, "min"],
    ["connected", "spojení", function (v) { return v === true ? '<span class="cell ok"></span>' : v === false ? '<span class="cell error"></span>' : '<span class="cell unknown"></span>'; }, null],
    ["errors_24h", "chyby 24h", function (v, r) { return String(v + r.critical_24h) + (r.critical_24h ? ' <span class="muted">(' + r.critical_24h + " krit.)</span>" : ""); }, "max", function (r) { return r.errors_24h + r.critical_24h; }],
    ["warnings_24h", "varování 24h", String, "max"],
    ["jobs_failing", "joby v chybě", function (v, r) { return v + ' <span class="muted">/ ' + r.jobs_total + "</span>"; }, "max"],
    ["jobs_overdue", "po termínu", String, "max"],
    ["max_streak", "nejdelší streak", function (v, r) { return v ? '<span class="streak">' + v + "×</span>" + (r.max_streak_job ? ' <span class="muted">' + esc(r.max_streak_job) + "</span>" : "") : "0"; }, "max"],
    ["longest_run_seconds", "nejdelší běh cronu", function (v, r) { return v == null ? "–" : "~" + esc(fmtDur(v)) + ' <span class="muted">' + esc(r.longest_run_job || "") + "</span>"; }, "max"],
    ["run_success_rate", "úspěšnost běhů", function (v) { return v == null ? "–" : Math.round(v * 100) + " %"; }, "min"],
    ["tokens", "tokeny", function (v) { return v == null ? "–" : fmtNum(v); }, "max"],
    ["cost_usd", "$", function (v) { return v == null ? "–" : "$" + v.toFixed(2); }, "max"],
    ["processes", "procesy", function (v) { return v == null ? "N/A" : "~" + v; }, null]
  ];
  function colValue(col, r) { return col[4] ? col[4](r) : r[col[0]]; }
  function exportLinks(query, label) {
    return '<span class="export-links" title="Stáhnout data (read-only export)">' + (label ? esc(label) + " " : "") +
      '<a class="link-more" href="/api/export?' + query + '&format=csv" download>⤓ CSV</a>' +
      '<a class="link-more" href="/api/export?' + query + '&format=json" download>JSON</a></span>';
  }
  function renderCompare(r, current) {
    setModalHead(crumbHome(), "Srovnání profilů");
    bodyLoading("Načítám srovnání…");
    getJSONStrict("/api/compare?days=14").then(function (d) {
      if (!current()) return;
      var sortKey = r.sort || "health", dir = r.dir === "desc" ? -1 : 1;
      var extremes = {};
      COMPARE_COLS.forEach(function (c) {
        if (!c[3]) return;
        var vals = d.rows.map(function (row) { return colValue(c, row); }).filter(function (v) { return v != null; });
        if (!vals.length) return;
        var best = c[3] === "max" ? Math.max.apply(null, vals) : Math.min.apply(null, vals);
        // only highlight when it stands out (not all equal, not a harmless 0)
        if (Math.min.apply(null, vals) !== Math.max.apply(null, vals) && !(c[3] === "max" && best === 0)) extremes[c[0]] = best;
      });
      var leader = function (key, fmt) {
        var col = COMPARE_COLS.filter(function (c) { return c[0] === key; })[0];
        if (extremes[key] == null) return null;
        var hits = d.rows.filter(function (x) { return colValue(col, x) === extremes[key]; }), row = hits[0];
        return '<a href="' + agentHref(row.profile) + '" style="color:' + (PROFILE_COLORS[row.profile] || "inherit") + '">' + esc(profileLabel(row.profile)) + "</a> " + fmt(row) +
          (hits.length > 1 ? ' <span class="muted small">(+' + (hits.length - 1) + " se stejnou hodnotou)</span>" : "");
      };
      var facts = [
        ["nejnižší HP", leader("health", function (x) { return x.health; })],
        ["nejvíc chyb 24h", leader("errors_24h", function (x) { return x.errors_24h + x.critical_24h; })],
        ["nejvíc tokenů (" + d.days + " d)", leader("tokens", function (x) { return fmtNum(x.tokens); })],
        ["nejdelší běh cronu", leader("longest_run_seconds", function (x) { return "~" + esc(fmtDur(x.longest_run_seconds)) + ' <span class="muted">' + esc(x.longest_run_job) + "</span>"; })]
      ].filter(function (f) { return f[1]; });
      var draw = function () {
        var col = COMPARE_COLS.filter(function (c) { return c[0] === sortKey; })[0] || COMPARE_COLS[0];
        var rows = d.rows.slice().sort(function (a, b) {
          var va = colValue(col, a), vb = colValue(col, b);
          if (va == null && vb == null) return 0;
          if (va == null) return 1;
          if (vb == null) return -1;
          return (va > vb ? 1 : va < vb ? -1 : 0) * dir;
        });
        $("d-compare").innerHTML = "<thead><tr><th>profil</th>" + COMPARE_COLS.map(function (c) {
          var on = c[0] === sortKey;
          return '<th><button type="button" class="sort' + (on ? " on" : "") + '" data-k="' + c[0] + '" aria-sort="' + (on ? (dir > 0 ? "ascending" : "descending") : "none") + '">' +
            esc(c[1]) + (on ? (dir > 0 ? " ▲" : " ▼") : "") + "</button></th>";
        }).join("") + "</tr></thead><tbody>" + rows.map(function (row) {
          return '<tr><th scope="row"><a href="' + agentHref(row.profile) + '" style="color:' + (PROFILE_COLORS[row.profile] || "inherit") + '">' + esc(profileLabel(row.profile)) + "</a></th>" +
            COMPARE_COLS.map(function (c) {
              var v = row[c[0]], hit = extremes[c[0]] != null && colValue(c, row) === extremes[c[0]];
              return '<td class="' + (hit ? "extreme" : "") + '"' + (hit ? ' title="' + (c[3] === "max" ? "nejvíc" : "nejméně") + '"' : "") + ">" + c[2](v, row) + "</td>";
            }).join("") + "</tr>";
        }).join("") + "</tbody>";
        history.replaceState(null, "", "#/compare" + (sortKey !== "health" || dir < 0 ? "?sort=" + sortKey + (dir < 0 ? "&dir=desc" : "") : ""));
      };
      $("modal-body").innerHTML =
        (facts.length ? '<div class="compare-facts">' + facts.map(function (f) { return '<div class="fc"><div class="kpi-label">' + esc(f[0]) + '</div><div class="fc-fact">' + f[1] + "</div></div>"; }).join("") + "</div>" : "") +
        '<div class="table-wrap compare-wrap"><table class="compare" id="d-compare"></table></div>' +
        '<div class="panel-head compare-foot"><span class="muted small">Tokeny a $ za ' + d.days + " dní ze state.db, chyby/warningy z logů za 24 h, běhy = posledních až 12 běhů každého jobu (délka je odhad z času souboru). " +
        'HP = 100 − penalizace (odpojení, padající / zpožděné joby, chyby v logu, sdílená kvóta). Zvýrazněná hodnota = nejvíc / nejméně ve sloupci.</span>' +
        exportLinks("kind=compare&days=" + d.days) + "</div>";
      $("d-compare").addEventListener("click", function (e) {
        var b = e.target.closest ? e.target.closest("button.sort") : null;
        if (!b) return;
        var k = b.getAttribute("data-k");
        if (k === sortKey) dir = -dir; else { sortKey = k; dir = COMPARE_COLS.filter(function (c) { return c[0] === k; })[0][3] === "min" ? 1 : -1; }
        draw();
      });
      draw(); stamp();
    }).catch(function (e) { if (current()) bodyError(e.message); });
  }

  // -- global search ------------------------------------------------------------
  // Searches what the dashboard already loaded (agents, cron jobs, repos,
  // today's incidents, panels and views) — no extra backend calls.
  var fold = L.fold;
  var SEARCH_TYPES = { view: "pohled", panel: "panel", agent: "agent", cron: "cron job", repo: "GitHub", incident: "incident" };
  function searchIndex() {
    var st = window.__mcLastState || {}, items = [];
    [["#/compare", "Srovnání profilů", "HP, chyby, tokeny, nejdelší cron vedle sebe", "compare porovnani health"],
     ["#/incidents", "Plný log incidentů", "chyby + incidenty až 7 dní, filtry", "errors log chyby"],
     ["#/help", "Klávesové zkratky", "nápověda", "help shortcuts"]].forEach(function (v) {
      items.push({ type: "view", title: v[1], sub: v[2], href: v[0], extra: v[3] });
    });
    [["panel-usage", "Claude kvóta", "graf session / týden"], ["panel-gateway", "Gateway", "stav, PID, platformy, restarty"],
     ["panel-agents", "Agenti", "karty profilů"], ["panel-incidents", "Co teď hoří", "chyby 24 h"],
     ["panel-github", "GitHub repa", "push, otevřené PR"], ["panel-cron", "Cron úlohy", "všechny joby"],
     ["panel-tokens", "Tokeny / náklady", "state.db, projekce měsíce"]].forEach(function (pn) {
      items.push({ type: "panel", title: pn[1], sub: pn[2], panel: pn[0] });
    });
    (st.agents || []).forEach(function (a) {
      items.push({ type: "agent", title: profileLabel(a.profile), sub: (a.connected === false ? L.CS.conn.disconnected + " · " : "") + L.activityLabel(a.activity) + (a.health ? " · HP " + a.health.score : ""),
        href: agentHref(a.profile), extra: a.platforms.map(function (p) { return p.platform; }).join(" "), color: PROFILE_COLORS[a.profile] });
    });
    (st.cron || []).forEach(function (c) {
      c.jobs.forEach(function (j) {
        items.push({ type: "cron", title: j.name, sub: c.profile + " · " + (j.schedule || "") + " · " + stLabel(j.status) + (j.failure_streak ? " · " + j.failure_streak + "×" : ""),
          href: jobHref(c.profile, j), extra: (j.id || "") + " " + c.profile, level: j.status === "error" ? "error" : "" });
      });
    });
    ((lastGithub && lastGithub.repos) || []).forEach(function (r) {
      items.push({ type: "repo", title: r.name, sub: (r.open_prs || []).length + " otevřených PR", url: r.url,
        extra: (r.open_prs || []).map(function (p) { return "#" + p.number + " " + p.title; }).join(" ") });
    });
    (st.incidents || []).slice(0, 200).forEach(function (i) {
      items.push({ type: "incident", title: i.message, sub: (i.profile || "") + " · " + lvLabel(i.level) + " · " + (i.ts ? fmtDateTime(i.ts) : "bez času"),
        href: incidentsHash({ profile: i.profile || "", hours: "24", q: i.message.slice(0, 60) }), extra: (i.details || []).join(" ") + " " + (i.source || ""), level: i.level });
    });
    return items;
  }
  function searchItems(q) {
    var words = fold(q).split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    var order = Object.keys(SEARCH_TYPES);
    return searchIndex().map(function (it) {
      var title = fold(it.title), hay = title + " " + fold(it.sub) + " " + fold(it.extra);
      if (!words.every(function (w) { return hay.indexOf(w) >= 0; })) return null;
      it.rank = (title.indexOf(words[0]) === 0 ? 0 : title.indexOf(words[0]) > 0 ? 1 : 2) * 10 + order.indexOf(it.type);
      return it;
    }).filter(Boolean).sort(function (a, b) { return a.rank - b.rank; }).slice(0, 50);
  }
  function renderSearch(r) {
    setModalHead(crumbHome(), "Hledání");
    $("modal-body").innerHTML = '<div class="filters filters-bar"><input id="d-search-q" type="search" placeholder="agent, cron job, repo, chyba, panel…" aria-label="hledat na dashboardu" autocomplete="off" value="' + esc(r.q || "") + '"></div>' +
      '<ul class="search-results" id="d-search-list" role="listbox"></ul>';
    var sel = 0, results = [];
    var draw = function () {
      var q = $("d-search-q").value;
      results = searchItems(q);
      sel = Math.min(sel, Math.max(0, results.length - 1));
      $("d-search-list").innerHTML = !q.trim() ? '<li class="empty muted">Piš pro hledání v agentech, cron jobech, repech, dnešních incidentech a panelech. <kbd>↑</kbd> <kbd>↓</kbd> výběr, <kbd>Enter</kbd> otevřít.</li>'
        : results.length ? results.map(function (it, i) {
          var href = it.href || it.url || "#";
          return '<li role="option" aria-selected="' + (i === sel) + '" class="' + (i === sel ? "sel " : "") + esc(it.level || "") + '"><a href="' + esc(href) + '" data-i="' + i + '"' + (it.url ? ' target="_blank" rel="noopener"' : "") + ">" +
            '<span class="sr-type">' + esc(SEARCH_TYPES[it.type]) + '</span><span class="sr-title"' + (it.color ? ' style="color:' + it.color + '"' : "") + ">" + esc(it.title) + "</span>" +
            '<span class="sr-sub muted small">' + esc(it.sub) + "</span></a></li>";
        }).join("") + '<li class="sr-more"><a href="' + incidentsHash({ hours: "168", q: q }) + '">hledat „' + esc(q) + '“ v plném logu incidentů (7 dní) ›</a></li>'
        : '<li class="empty">Nic nenalezeno. <a href="' + incidentsHash({ hours: "168", q: q }) + '">Zkusit plný log incidentů (7 dní) ›</a></li>';
      history.replaceState(null, "", "#/search" + (q ? "?q=" + encodeURIComponent(q) : ""));
    };
    var open = function (it) {
      if (!it) return;
      if (it.panel) { closeModal(); setTimeout(function () { goPanel(it.panel); }, 80); return; }
      if (it.url) { window.open(it.url, "_blank", "noopener"); return; }
      modal.pendingPush = true; location.hash = it.href;
    };
    var input = $("d-search-q");
    input.addEventListener("input", function () { sel = 0; draw(); });
    input.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        sel = Math.max(0, Math.min(results.length - 1, sel + (e.key === "ArrowDown" ? 1 : -1)));
        draw();
        var cur = document.querySelector("#d-search-list li.sel");
        if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter") { e.preventDefault(); open(results[sel]); }
    });
    $("d-search-list").addEventListener("click", function (e) {
      var a = e.target.closest ? e.target.closest("a[data-i]") : null;
      if (!a) return;
      var it = results[+a.getAttribute("data-i")];
      if (it && it.panel) { e.preventDefault(); open(it); }
    });
    draw();
    input.focus();
    var v = input.value; input.value = ""; input.value = v; // caret to the end
  }

  // -- keyboard shortcuts -------------------------------------------------------
  var SHORTCUTS = [
    ["?", "tahle nápověda"],
    ["/", "hledat na celém dashboardu (v detailu s vlastním hledáním: hledat v něm)"],
    ["g a", "agenti"], ["g s", "gateway"], ["g u", "Claude kvóta"], ["g i", "co teď hoří"],
    ["g c", "cron úlohy"], ["g t", "tokeny / náklady"], ["g r", "GitHub repa"], ["g g", "nahoru (BMO)"],
    ["g l", "plný log incidentů"], ["g p", "srovnání profilů"],
    ["1 – 5", "okno grafu kvóty 6h / 24h / 7d / 30d / vše"],
    ["$", "přepnout tokeny ↔ $"],
    ["r", "načíst data hned (v detailu: obnovit detail)"],
    ["Esc", "zavřít detail / opustit pole"]
  ];
  var GO = { a: "panel-agents", s: "panel-gateway", u: "panel-usage", i: "panel-incidents", c: "panel-cron", t: "panel-tokens", r: "panel-github", g: "top" };
  var gPending = 0;

  function renderHelp() {
    setModalHead(crumbHome(), "Klávesové zkratky");
    $("modal-body").innerHTML = '<table class="keys">' + SHORTCUTS.map(function (k) {
      return "<tr><td>" + k[0].split(" ").map(function (x) { return x === "–" ? "–" : "<kbd>" + esc(x) + "</kbd>"; }).join(" ") + "</td><td>" + esc(k[1]) + "</td></tr>";
    }).join("") + "</table>" +
      '<h4 class="help-h">Zobrazení</h4><div class="palette-row"><span>barevná paleta stavů</span><div class="seg" id="d-palette" role="group" aria-label="paleta">' +
      [["default", "neonová"], ["cb", "pro barvoslepé"]].map(function (o) {
        return '<button type="button" data-p="' + o[0] + '"' + (getPalette() === o[0] ? ' class="active" aria-pressed="true"' : ' aria-pressed="false"') + ">" + o[1] + "</button>";
      }).join("") + '</div></div><p class="muted small">Pro barvoslepé: OK = modrá, varování = žlutá, chyba = oranžová a chybové tečky jsou kosočtverce. Uloží se jen v tomhle prohlížeči.</p>' +
      '<p class="muted small">Zkratky nefungují, když píšeš do pole (kromě <kbd>Esc</kbd>). Detailní pohledy mají sdílitelné URL (<code>#/agent/…</code>, <code>#/cron/…</code>, <code>#/incidents…</code>, <code>#/compare</code>, <code>#/search?q=…</code>, <code>#/help</code>).</p>';
  }
  document.addEventListener("click", function (e) {
    var b = e.target.closest ? e.target.closest("#d-palette button") : null;
    if (!b) return;
    var p = b.getAttribute("data-p");
    try { localStorage.setItem(PALETTE_KEY, p); } catch (err) { /* private mode: this page only */ }
    applyPalette(p);
    Array.prototype.forEach.call(document.querySelectorAll("#d-palette button"), function (x) {
      x.classList.toggle("active", x === b); x.setAttribute("aria-pressed", String(x === b));
    });
    if (window.__mcLastState) updateFavicon(window.__mcLastState.summary.level, window.__mcLastState.summary.issues.length);
    drawUsage(lastUsage); drawTokens(lastTokens);
  });
  function navigate(hash) {
    if (location.hash === hash) { route(); return; }
    modal.pendingPush = true;
    location.hash = hash;
  }
  function goPanel(id) {
    var go = function () {
      if (id === "top") { window.scrollTo({ top: 0, behavior: "smooth" }); return; }
      var el = $(id);
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
    };
    if (modal.open) { closeModal(); setTimeout(go, 60); } else go();
  }
  function showKeyHint(text) {
    var el = $("key-hint");
    el.textContent = text;
    el.classList.toggle("hidden", !text);
  }
  function isTyping(el) {
    return el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
  }
  document.addEventListener("keydown", function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTyping(e.target)) {
      if (e.key === "Escape" && !modal.open) e.target.blur();
      return;
    }
    if (e.defaultPrevented) return;
    var k = e.key;
    if (gPending) {
      gPending = 0; showKeyHint("");
      if (k === "l") { e.preventDefault(); navigate("#/incidents"); return; }
      if (k === "p") { e.preventDefault(); navigate("#/compare"); return; }
      if (GO[k]) { e.preventDefault(); goPanel(GO[k]); }
      return;
    }
    if (k === "g") { gPending = 1; showKeyHint("g …"); setTimeout(function () { if (gPending) { gPending = 0; showKeyHint(""); } }, 1500); return; }
    if (k === "?") { e.preventDefault(); if (modal.route && modal.route.view === "help") closeModal(); else navigate("#/help"); return; }
    if (k === "/") {
      e.preventDefault();
      var box = modal.open && (document.getElementById("d-search-q") || document.getElementById("d-inc-q") || document.getElementById("d-log-q"));
      if (box) { box.focus(); return; }
      navigate("#/search");
      return;
    }
    if (k === "r") { e.preventDefault(); if (modal.open) route(); else pollAll(); return; }
    if (!modal.open && k >= "1" && k <= "5") {
      var btn = document.querySelectorAll("#usage-windows button")[parseInt(k, 10) - 1];
      if (btn) { e.preventDefault(); btn.click(); }
      return;
    }
    if (!modal.open && k === "$") {
      var other = document.querySelector("#token-mode button:not(.active)");
      if (other) { e.preventDefault(); other.click(); }
    }
  });
  $("help-btn").addEventListener("click", function () { navigate("#/help"); });
  $("search-btn").addEventListener("click", function () { navigate("#/search"); });

  // -- wiring -----------------------------------------------------------------
  document.addEventListener("click", function (e) {
    var a = e.target.closest ? e.target.closest("a[href^='#/']") : null;
    if (a && !e.metaKey && !e.ctrlKey && !e.shiftKey && a.getAttribute("href") !== location.hash) modal.pendingPush = true;
    if (e.target.closest && e.target.closest("[data-close]")) { e.preventDefault(); closeModal(); }
    if (e.target.closest && e.target.closest("[data-retry]")) route();
  });
  $("modal-refresh").addEventListener("click", function () { route(); });
  document.addEventListener("keydown", function (e) {
    if (!modal.open) return;
    if (e.key === "Escape") { e.preventDefault(); closeModal(); return; }
    if (e.key === "Tab") { // keep focus inside the dialog
      var f = Array.prototype.filter.call($("modal").querySelectorAll("a[href], button, input, select, summary, [tabindex]"),
        function (el) { return !el.disabled && el.offsetParent !== null; });
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  window.addEventListener("hashchange", route);
  window.addEventListener("resize", function () { if (modal.chart) modal.chart(); });

  // ---------------------------------------------------------------- restart
  $("restart-btn").addEventListener("click", function () {
    if (!confirm("Opravdu restartovat celý Hermes gateway (všech 6 profilů)?")) return;
    var btn = $("restart-btn");
    var label = btn.innerHTML;
    btn.disabled = true; btn.textContent = "⟲ Restartuji…";
    fetch("/api/restart", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        var out = (res.stdout || "") + (res.stderr ? "\n" + res.stderr : "");
        alert((res.ok ? "✅ Gateway restartován" : "❌ Restart selhal") +
          (res.error ? ": " + res.error : "") + (res.returncode != null ? " (rc=" + res.returncode + ")" : "") +
          (out.trim() ? "\n\n" + out.trim().slice(-1500) : ""));
      })
      .catch(function (e) { alert("❌ Restart request selhal: " + e.message); })
      .then(function () { btn.disabled = false; btn.innerHTML = label; pollState(); });
  });

  window.addEventListener("resize", function () { drawUsage(lastUsage); drawTokens(lastTokens); });

  // Sticky header height -> CSS var used by scroll-padding / scroll-margin so
  // jumping to a section never hides its first rows under the header.
  function syncTopbar() {
    var h = document.querySelector(".topbar").getBoundingClientRect().height;
    document.documentElement.style.setProperty("--topbar-h", Math.round(h) + "px");
  }
  syncTopbar();
  if (window.ResizeObserver) new ResizeObserver(syncTopbar).observe(document.querySelector(".topbar"));
  else window.addEventListener("resize", syncTopbar);

  // bmo.js is a module importing Three.js from a CDN; if that never loads
  // (offline, blocked CDN) show the static fallback instead of an empty stage.
  setTimeout(function () { if (!window.__bmoReady) $("bmo-fallback").classList.remove("hidden"); }, 5000);

  var pollGithub = guarded(function () {
    return getJSON("/api/github").then(renderGithub).catch(function (e) {
      setHTML($("repos"), '<li class="empty error-inline">⚠ GitHub stav nelze načíst (' + esc(e.message) + ") — zkusím znovu za minutu.</li>");
    });
  });
  var pollTokens = guarded(function () {
    return Promise.all([
      getJSON("/api/tokens?days=14").then(function (d) { lastTokens = d; tokensError = null; }, function (e) { tokensError = e.message; }),
      getJSON("/api/forecast").then(function (f) { lastForecast = f; }, function () { lastForecast = { error: true }; })
    ]).then(function () { drawTokens(lastTokens); renderForecast(); });
  });
  function pollAll() { pollState(); pollUsage(); pollSpark(); pollGithub(); pollTokens(); }
  document.addEventListener("visibilitychange", function () { if (!document.hidden) pollAll(); });
  $("usage-export").innerHTML = exportLinks("kind=usage&window=" + usageWindow);
  $("token-export").innerHTML = exportLinks("kind=tokens&days=14");
  $("inc-export").innerHTML = exportLinks("kind=incidents&hours=24");
  drawUsage(null); drawTokens(null);
  pollAll(); tickClock(); tickUpdated();
  route();
  // PWA: offline fallback + static cache (see sw.js). Browsers only allow
  // service workers in a secure context, i.e. on 127.0.0.1 / localhost.
  if ("serviceWorker" in navigator && window.isSecureContext) {
    navigator.serviceWorker.register("/sw.js").catch(function () { /* optional */ });
  }
  every(POLL_STATE_MS, pollState);
  every(POLL_USAGE_MS, pollUsage);
  every(POLL_USAGE_MS, pollSpark);
  every(POLL_SLOW_MS, pollGithub);
  every(POLL_SLOW_MS, pollTokens);
  setInterval(function () { tickClock(); tickUpdated(); }, 1000);
})();
