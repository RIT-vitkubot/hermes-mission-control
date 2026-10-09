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

  var tzOffset = null; // host offset in seconds; null -> browser local
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
  function setConn(ok) { $("conn").className = "conn " + (ok ? "ok" : "err"); }

  // ---------------------------------------------------------------- state
  function renderState(st) {
    tzOffset = st.tz ? st.tz.offset_seconds : null;
    window.__mcLastState = st;
    window.dispatchEvent(new CustomEvent("mc-state", { detail: st }));
    var sum = st.summary;
    document.body.setAttribute("data-level", sum.level);
    pill($("overall-pill"), sum.level, { ok: "all systems nominal", warn: "warning", error: "alert" }[sum.level]);

    var bubble = $("bubble");
    if (lastBubble !== sum.message) {
      $("bubble-text").textContent = sum.message;
      bubble.classList.remove("pop"); void bubble.offsetWidth; bubble.classList.add("pop");
      lastBubble = sum.message;
    }
    $("issues").innerHTML = sum.issues.length
      ? sum.issues.map(function (i) { return '<li class="' + esc(i.level) + '">' + esc(i.text) + "</li>"; }).join("")
      : '<li class="ok">Žádné problémy. BMO je spokojený.</li>';

    var u = st.usage_latest;
    $("kpi-session").textContent = u && u.session_pct != null ? Math.round(u.session_pct) + " %" : "–";
    $("kpi-week").textContent = u && u.week_pct != null ? Math.round(u.week_pct) + " %" : "–";
    $("kpi-gateway").textContent = st.gateway.running ? "UP" : "DOWN";
    $("kpi-gateway").style.color = st.gateway.running ? "var(--ok)" : "var(--err)";
    $("kpi-procs").textContent = st.processes.estimate == null ? "N/A" : "~" + st.processes.estimate;

    renderGateway(st.gateway, st.now);
    renderAgents(st.agents, st.now, st.processes);
    renderIncidents(st.incidents, st.now);
    renderCron(st.cron, st.now);
  }

  function renderGateway(gw, now) {
    pill($("gw-badge"), gw.running ? (gw.status === "warn" ? "warn" : "ok") : "error",
      gw.available ? (gw.running ? "running" : "down") : "no data");
    var rows = [
      ["stav", gw.state],
      ["PID", gw.pid != null ? gw.pid + (gw.pid_alive === false ? " (mrtvý)" : "") : "–"],
      ["uptime", gw.uptime_seconds != null ? fmtDur(gw.uptime_seconds) : "–"],
      ["heartbeat", gw.updated_at ? fmtDateTime(gw.updated_at) + " (" + rel(gw.updated_at, now) + ")" : "–"],
      ["active agents", typeof gw.active_agents === "object" && gw.active_agents !== null ? JSON.stringify(gw.active_agents) : (gw.active_agents == null ? "–" : gw.active_agents)],
      ["verze", (gw.code_version || "–") + (gw.code_sha ? " @ " + String(gw.code_sha).slice(0, 10) : "")]
    ];
    $("gw-kv").innerHTML = rows.map(function (r) { return "<dt>" + esc(r[0]) + "</dt><dd>" + esc(r[1]) + "</dd>"; }).join("");

    var plats = gw.platforms || [];
    var platformNames = [];
    plats.forEach(function (p) { if (platformNames.indexOf(p.platform) < 0) platformNames.push(p.platform); });
    var profiles = gw.served_profiles || [];
    plats.forEach(function (p) { if (profiles.indexOf(p.profile) < 0) profiles.push(p.profile); });
    if (!platformNames.length) { $("gw-matrix").innerHTML = '<tr><td class="empty">Žádné platformy v gateway_state.json</td></tr>'; return; }
    var html = "<tr><th>profil</th>" + platformNames.map(function (n) { return "<th>" + esc(n) + "</th>"; }).join("") + "</tr>";
    profiles.forEach(function (prof) {
      html += '<tr><td><a href="' + agentHref(prof) + '">' + esc(prof === "default" ? "default (BMO)" : prof) + "</a></td>";
      platformNames.forEach(function (n) {
        var p = plats.filter(function (x) { return x.profile === prof && x.platform === n; })[0];
        if (!p) { html += '<td><span class="muted">·</span></td>'; return; }
        var title = p.state + (p.error ? " — " + p.error : "");
        html += '<td title="' + esc(title) + '"><span class="cell ' + esc(p.status) + '"></span></td>';
      });
      html += "</tr>";
    });
    $("gw-matrix").innerHTML = html;
  }

  function renderAgents(agents, now, procs) {
    var procTip = "Odhad podle child procesů gateway PID — ne přesný počet sub-agentů." +
      (procs.unattributed ? " Nepřiřazené procesy: " + procs.unattributed + "." : "");
    $("agents").innerHTML = agents.map(function (a) {
      var cls = a.connected === true ? "ok" : (a.connected === false ? "error" : "");
      var conn = a.connected === true ? '<span class="pill pill-ok">connected</span>'
        : a.connected === false ? '<span class="pill pill-error">disconnected</span>'
          : '<span class="pill pill-unknown">' + (a.served ? "n/a" : "not served") + "</span>";
      var c = a.cron;
      var counts = c.available ? Object.keys(c.counts).map(function (k) { return c.counts[k] + " " + k; }).join(", ") || "žádné joby" : "jobs.json chybí";
      var lastRun = c.last_run_at ? rel(c.last_run_at, now) + (c.last_job ? " · " + c.last_job.name + " (" + c.last_job.status + ")" : "") : "–";
      var nextRun = c.next_run_at ? rel(c.next_run_at, now) + (c.next_job ? " · " + c.next_job.name : "") : "–";
      var platforms = a.platforms.map(function (p) {
        return '<span title="' + esc(p.state + (p.error ? " — " + p.error : "")) + '"><span class="cell ' + esc(p.status) + '"></span> ' + esc(p.platform) + "</span>";
      }).join(" &nbsp;");
      return '<div class="agent ' + cls + (a.busy ? " busy" : "") + '">' +
        '<div class="agent-head"><a class="agent-name" href="' + agentHref(a.profile) + '" style="color:' + (PROFILE_COLORS[a.profile] || "inherit") + '">' + esc(a.label) + "</a>" + conn + "</div>" +
        '<div class="agent-activity">' + (a.busy ? "⚡ " : "💤 ") + esc(a.activity) + "</div>" +
        (platforms ? '<div class="agent-row"><span>platformy</span><span>' + platforms + "</span></div>" : "") +
        '<div class="agent-row"><span>cron</span><span>' + esc(counts) + "</span></div>" +
        '<div class="agent-row"><span>poslední run</span><span>' + esc(lastRun) + "</span></div>" +
        '<div class="agent-row"><span>další run</span><span>' + esc(nextRun) + "</span></div>" +
        '<div class="agent-row" title="' + esc(procTip) + '"><span>procesy ⓘ</span><span>' + (a.processes == null ? "N/A" : "~" + a.processes) + "</span></div>" +
        (a.log_tail && a.log_tail.length ? "<details><summary class=\"muted\">co dělal (agent.log)</summary><pre>" + esc(a.log_tail.join("\n")) + "</pre></details>" : "") +
        '<a class="link-more agent-more" href="' + agentHref(a.profile) + '">detail profilu ›</a>' +
        "</div>";
    }).join("");
  }

  function renderIncidents(list, now) {
    var serious = list.filter(function (i) { return i.level === "error" || i.level === "critical"; }).length;
    pill($("inc-count"), serious ? "error" : (list.length ? "warn" : "ok"), String(list.length));
    if (!list.length) { $("incidents").innerHTML = '<li class="empty">Nic nehoří. 🔥🚫</li>'; return; }
    $("incidents").innerHTML = list.slice(0, 100).map(function (i) {
      return '<li class="' + esc(i.level) + '"><div class="inc-meta"><span class="inc-lvl">' + esc(i.level) + "</span>" +
        "<span>" + esc(i.ts ? fmtDateTime(i.ts) + " (" + rel(i.ts, now) + ")" : "bez času") + "</span>" +
        (i.profile ? '<a href="#/incidents?profile=' + encodeURIComponent(i.profile) + '">' + esc(i.profile) + "</a>" : "") +
        "<span>" + esc(i.source || "") + "</span></div>" +
        '<div class="inc-msg">' + esc(i.message) + "</div>" +
        (i.details && i.details.length ? "<details><summary class=\"muted small\">detail</summary><pre>" + esc(i.details.join("\n")) + "</pre></details>" : "") +
        "</li>";
    }).join("");
  }

  function renderCron(crons, now) {
    var total = 0, failing = 0;
    $("cron").innerHTML = crons.map(function (c) {
      if (!c.available) {
        return '<div class="cron-profile"><h4><span>' + esc(c.profile) + '</span><span class="muted">jobs.json nenalezen</span></h4></div>';
      }
      total += c.jobs.length;
      var rows = c.jobs.map(function (j) {
        if (j.status === "error") failing++;
        return '<tr class="job-' + esc(j.status) + '"><td data-label="job"><a href="' + jobHref(c.profile, j) + '">' + esc(j.name) + "</a></td>" + '<td data-label="rozvrh" class="mono">' + esc(j.schedule || "–") + "</td>" +
          '<td data-label="stav"><span class="pill pill-' + esc(j.status) + '">' + esc(j.status) + "</span></td>" +
          '<td data-label="poslední" title="' + esc(fmtDateTime(j.last_run_at)) + '">' + esc(rel(j.last_run_at, now)) + (j.last_status ? " · " + esc(j.last_status) : "") + "</td>" +
          '<td data-label="další" title="' + esc(fmtDateTime(j.next_run_at)) + '">' + esc(j.enabled ? rel(j.next_run_at, now) : "–") + "</td>" +
          '<td data-label="streak">' + (j.failure_streak > 0 ? '<span class="streak">' + j.failure_streak + "×</span>" : "0") + "</td></tr>";
      }).join("");
      return '<div class="cron-profile"><h4><a href="' + agentHref(c.profile) + '" style="color:' + (PROFILE_COLORS[c.profile] || "inherit") + '">' + esc(c.profile) + "</a><span class=\"muted\">" + c.jobs.length + " jobů</span></h4>" +
        (rows ? "<table class=\"cron-table\"><tr class=\"cron-th\"><th>job</th><th>rozvrh</th><th>stav</th><th>poslední</th><th>další</th><th>streak</th></tr>" + rows + "</table>" : '<div class="empty">žádné joby</div>') +
        "</div>";
    }).join("");
    $("cron-meta").textContent = total + " jobů celkem" + (failing ? " · " + failing + " v chybě" : "");
  }

  // ---------------------------------------------------------------- github
  function renderGithub(gh) {
    if (!gh.available) { $("repos").innerHTML = '<li class="empty">' + esc(gh.reason || "nedostupné") + "</li>"; return; }
    if (gh.loading) { $("repos").innerHTML = '<li class="empty">Načítám přes gh CLI…</li>'; setTimeout(pollGithub, 4000); return; }
    var now = Date.now() / 1000;
    $("gh-meta").textContent = gh.fetched_at ? "cache " + fmtTime(gh.fetched_at) : "";
    $("repos").innerHTML = gh.repos.map(function (r) {
      var prs = r.open_prs || [];
      return "<li><div class=\"repo-head\"><a href=\"" + esc(r.url) + "\" target=\"_blank\" rel=\"noopener\">" + esc(r.name) + "</a>" +
        '<span class="muted">' + esc(r.default_branch || "") + " · push " + esc(rel(r.pushed_at, now)) + "</span></div>" +
        (r.error ? '<div class="repo-err small">' + esc(r.error) + "</div>" : "") +
        (prs.length ? '<ul class="repo-prs">' + prs.map(function (p) {
          return '<li><a href="' + esc(p.url) + '" target="_blank" rel="noopener">#' + esc(p.number) + "</a> " + esc(p.title) + "</li>";
        }).join("") + "</ul>" : '<div class="muted small">žádné otevřené PR</div>') +
        "</li>";
    }).join("");
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
      ctx.fillText(data && !data.available ? "claude_usage_history.jsonl nenalezen" : "Žádná data v tomto okně", pad.l + pw / 2, pad.t + ph / 2);
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

  function pollUsage() {
    var w = usageWindow;
    getJSON("/api/usage?window=" + encodeURIComponent(w)).then(function (d) {
      if (w !== usageWindow) return;
      lastUsage = d; if (d.tz) tzOffset = d.tz.offset_seconds;
      var meta = d.available ? d.count + " vzorků" : "";
      if (d.latest) meta += " · poslední " + fmtDateTime(d.latest.ts) +
        (d.latest.session_reset ? " · reset session " + d.latest.session_reset : "");
      $("usage-meta").textContent = meta;
      drawUsage(d);
    }).catch(function () { setConn(false); });
  }
  Array.prototype.forEach.call(document.querySelectorAll("#usage-windows button"), function (b) {
    b.addEventListener("click", function () {
      usageWindow = b.getAttribute("data-w");
      Array.prototype.forEach.call(document.querySelectorAll("#usage-windows button"), function (x) { x.classList.toggle("active", x === b); });
      pollUsage();
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
    var pad = { l: 56, r: 10, t: 10, b: 24 };
    var pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
    ctx.font = "11px ui-monospace, monospace";
    if (!data) return;
    var days = data.day_keys || [];
    var avail = data.profiles.filter(function (p) { return p.available; });
    $("token-legend").innerHTML = data.profiles.map(function (p) {
      var tot = dayValue(p.totals);
      return '<span class="lg" style="--c:' + (PROFILE_COLORS[p.profile] || "#888") + '">' + esc(p.profile) + ": " +
        (p.available ? (tokenMode === "cost" ? "$" + tot.toFixed(2) : fmtNum(tot)) : '<span class="muted">' + esc(p.error ? "chyba DB" : "bez state.db") + "</span>") + "</span>";
    }).join("");
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
      drawTokens(lastTokens);
    });
  });

  // ---------------------------------------------------------------- polling
  function pollState() {
    getJSON("/api/state").then(function (st) {
      if (st.error) throw new Error(st.error);
      setConn(true); renderState(st);
    }).catch(function (e) {
      setConn(false);
      document.body.setAttribute("data-level", "error");
      $("bubble-text").textContent = "Ztratil jsem spojení s backendem! (" + e.message + ")";
      lastBubble = null;
      window.dispatchEvent(new CustomEvent("mc-state", { detail: { summary: { level: "error", mood: "alarmed" } } }));
    });
  }
  function pollGithub() { getJSON("/api/github").then(renderGithub).catch(function () {}); }
  function pollTokens() { getJSON("/api/tokens?days=14").then(function (d) { lastTokens = d; drawTokens(d); }).catch(function () {}); }

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
    if (parts[0] === "incidents") return { view: "incidents", profile: q.profile || "", level: q.level || "", hours: q.hours || "24" };
    return null;
  }
  function incidentsHash(r) {
    var q = [];
    if (r.profile) q.push("profile=" + encodeURIComponent(r.profile));
    if (r.level) q.push("level=" + encodeURIComponent(r.level));
    if (r.hours && r.hours !== "24") q.push("hours=" + encodeURIComponent(r.hours));
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
    document.title = title + " · Hermes Mission Control";
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
    if (!r) { modal.depth = 0; hideModal(); document.title = "Hermes Mission Control"; return; }
    openModal();
    modal.route = r;
    var seq = ++modal.seq;
    var current = function () { return seq === modal.seq && modal.open; };
    $("modal-stamp").textContent = "";
    if (r.view === "agent") return renderAgentDetail(r, current);
    if (r.view === "cron") return renderCronDetail(r, current);
    return renderIncidentDetail(r, current);
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
      return '<li class="' + esc(i.level) + '"><div class="inc-meta"><span class="inc-lvl">' + esc(i.level) + "</span>" +
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
          name: k === "cost" ? "náklady" : k.replace(/_tokens?$/, "").replace(/_/g, " "),
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
      var conn = a.connected === true ? '<span class="pill pill-ok">connected</span>'
        : a.connected === false ? '<span class="pill pill-error">disconnected</span>' : '<span class="pill pill-unknown">n/a</span>';
      var html = '<div class="detail-grid">' +
        '<section class="detail-card"><h4>Stav</h4><dl class="kv">' +
        "<dt>spojení</dt><dd>" + conn + "</dd>" +
        "<dt>teď</dt><dd>" + (a.busy ? "⚡ " : "💤 ") + esc(a.activity) + "</dd>" +
        "<dt>platformy</dt><dd>" + (a.platforms.length ? a.platforms.map(function (p) {
          return '<span class="cell ' + esc(p.status) + '"></span> ' + esc(p.platform) + ' <span class="muted">' + esc(p.state) + (p.error ? " — " + esc(p.error) : "") + "</span>";
        }).join("<br>") : '<span class="muted">žádné</span>') + "</dd>" +
        '<dt title="Odhad podle child procesů gateway PID">procesy ⓘ</dt><dd>' + (a.processes == null ? "N/A" : "~" + a.processes) + "</dd>" +
        "</dl>" +
        (procs.length ? '<div class="table-wrap"><table class="proc-table"><tr><th>PID</th><th>běží</th><th>příkaz</th></tr>' + procs.map(function (x) {
          return "<tr><td class=\"mono\">" + esc(x.pid) + "</td><td>" + esc(fmtDur(x.elapsed)) + '</td><td class="mono cmd">' + esc(x.cmd) + "</td></tr>";
        }).join("") + "</table></div>" : "") +
        "</section>" +
        '<section class="detail-card"><h4>Cron joby <span class="muted small">(' + cron.jobs.length + ")</span></h4>" +
        (cron.available === false ? '<div class="empty">jobs.json nenalezen</div>' : cron.jobs.length ? '<ul class="job-list">' + cron.jobs.map(function (j) {
          return '<li><a href="' + jobHref(r.profile, j) + '">' + esc(j.name) + '</a> <span class="pill pill-' + esc(j.status) + '">' + esc(j.status) + "</span>" +
            '<span class="muted small">' + esc(j.schedule || "") + " · poslední " + esc(rel(j.last_run_at, st.now)) + (j.failure_streak ? ' · <span class="streak">' + j.failure_streak + "×</span>" : "") + "</span></li>";
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
        '<select id="d-log-level" aria-label="závažnost"><option value="">vše</option><option value="warning">warning+</option><option value="error">error+</option></select>' +
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
        return '<span class="run-dot ' + esc(x.status) + '" title="' + esc(fmtDateTime(x.ts) + " · " + x.status) + '"></span>';
      }).join("");
      var html = '<div class="detail-grid">' +
        '<section class="detail-card"><h4>Job</h4><dl class="kv">' +
        "<dt>stav</dt><dd><span class=\"pill pill-" + esc(j.status) + "\">" + esc(j.status) + "</span>" + (j.enabled ? "" : ' <span class="muted">(vypnutý)</span>') + "</dd>" +
        "<dt>id</dt><dd class=\"mono\">" + esc(j.id || "–") + "</dd>" +
        "<dt>rozvrh</dt><dd class=\"mono\">" + esc(j.schedule || "–") + "</dd>" +
        "<dt>poslední run</dt><dd>" + esc(fmtDateTime(j.last_run_at)) + " (" + esc(rel(j.last_run_at, now)) + ")" + (j.last_status ? " · " + esc(j.last_status) : "") + "</dd>" +
        "<dt>další run</dt><dd>" + esc(j.enabled ? fmtDateTime(j.next_run_at) + " (" + rel(j.next_run_at, now) + ")" : "–") + "</dd>" +
        "<dt>failure streak</dt><dd>" + (j.failure_streak ? '<span class="streak">' + j.failure_streak + "×</span>" : "0") + "</dd>" +
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
          return '<li class="run ' + esc(x.status) + '"><div class="run-head"><span class="pill pill-' + esc(x.status) + '">' + esc(x.status) + "</span>" +
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
        return '<button data-l="' + l + '"' + (l === r.level ? ' class="active"' : "") + ">" + (!l ? "vše" : l === "critical" ? l : l + "+") + "</button>";
      }).join("") + "</div>" +
      '<div class="seg" id="d-inc-hours" role="group" aria-label="období">' + [["24", "24h"], ["72", "3d"], ["168", "7d"]].map(function (h) {
        return '<button data-h="' + h[0] + '"' + (h[0] === r.hours ? ' class="active"' : "") + ">" + h[1] + "</button>";
      }).join("") + "</div>" +
      '<input id="d-inc-q" type="search" placeholder="hledat ve zprávě…" aria-label="hledat"></div>' +
      '<div class="inc-counts" id="d-inc-counts"></div>' +
      '<ul class="incidents incidents-full" id="d-inc-list"><li class="empty loading">Načítám…</li></ul>';
    $("modal-body").innerHTML = html;
    var nav = function (patch) {
      var next = { profile: r.profile, level: r.level, hours: r.hours };
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
        return '<span class="cnt ' + l + '">' + l + " " + (data.counts[l] || 0) + "</span>";
      }).join("") + '<span class="muted small">zobrazeno ' + Math.min(list.length, 500) + " z " + data.incidents.length +
        (data.incidents.length < data.total ? " (" + data.total + " bez filtru závažnosti)" : "") + "</span>";
    };
    $("d-inc-q").addEventListener("input", renderList);
    getJSONStrict("/api/incidents?hours=" + encodeURIComponent(r.hours) + (r.profile ? "&profile=" + encodeURIComponent(r.profile) : "") +
      (r.level ? "&level=" + encodeURIComponent(r.level) : "")).then(function (d) {
      if (!current()) return;
      data = d; renderList(); stamp();
    }).catch(function (e) { if (current()) $("d-inc-list").innerHTML = '<li class="empty">⚠ ' + esc(e.message) + "</li>"; });
  }

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

  pollState(); pollUsage(); pollGithub(); pollTokens(); tickClock();
  route();
  setInterval(pollState, POLL_STATE_MS);
  setInterval(pollUsage, POLL_USAGE_MS);
  setInterval(pollGithub, POLL_SLOW_MS);
  setInterval(pollTokens, POLL_SLOW_MS);
  setInterval(tickClock, 1000);
})();
