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
    if (sec < 3600) return Math.round(sec / 60) + " min";
    if (sec < 86400) return Math.floor(sec / 3600) + " h " + Math.round((sec % 3600) / 60) + " min";
    return Math.floor(sec / 86400) + " d " + Math.round((sec % 86400) / 3600) + " h";
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
      html += "<tr><td>" + esc(prof === "default" ? "default (BMO)" : prof) + "</td>";
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
        '<div class="agent-head"><span class="agent-name" style="color:' + (PROFILE_COLORS[a.profile] || "inherit") + '">' + esc(a.label) + "</span>" + conn + "</div>" +
        '<div class="agent-activity">' + (a.busy ? "⚡ " : "💤 ") + esc(a.activity) + "</div>" +
        (platforms ? '<div class="agent-row"><span>platformy</span><span>' + platforms + "</span></div>" : "") +
        '<div class="agent-row"><span>cron</span><span>' + esc(counts) + "</span></div>" +
        '<div class="agent-row"><span>poslední run</span><span>' + esc(lastRun) + "</span></div>" +
        '<div class="agent-row"><span>další run</span><span>' + esc(nextRun) + "</span></div>" +
        '<div class="agent-row" title="' + esc(procTip) + '"><span>procesy ⓘ</span><span>' + (a.processes == null ? "N/A" : "~" + a.processes) + "</span></div>" +
        (a.log_tail && a.log_tail.length ? "<details><summary class=\"muted\">co dělal (agent.log)</summary><pre>" + esc(a.log_tail.join("\n")) + "</pre></details>" : "") +
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
        "<span>" + esc(i.profile || "") + "</span><span>" + esc(i.source || "") + "</span></div>" +
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
        return '<tr class="job-' + esc(j.status) + '"><td>' + esc(j.name) + "</td><td class=\"mono\">" + esc(j.schedule || "–") + "</td>" +
          '<td><span class="pill pill-' + esc(j.status) + '">' + esc(j.status) + "</span></td>" +
          '<td title="' + esc(fmtDateTime(j.last_run_at)) + '">' + esc(rel(j.last_run_at, now)) + (j.last_status ? " · " + esc(j.last_status) : "") + "</td>" +
          '<td title="' + esc(fmtDateTime(j.next_run_at)) + '">' + esc(j.enabled ? rel(j.next_run_at, now) : "–") + "</td>" +
          "<td>" + (j.failure_streak > 0 ? '<span class="streak">' + j.failure_streak + "×</span>" : "0") + "</td></tr>";
      }).join("");
      return '<div class="cron-profile"><h4><span style="color:' + (PROFILE_COLORS[c.profile] || "inherit") + '">' + esc(c.profile) + "</span><span class=\"muted\">" + c.jobs.length + " jobů</span></h4>" +
        (rows ? "<table><tr><th>job</th><th>rozvrh</th><th>stav</th><th>poslední</th><th>další</th><th>streak</th></tr>" + rows + "</table>" : '<div class="empty">žádné joby</div>') +
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
  $("usage-chart").addEventListener("mousemove", function (e) {
    var r = e.target.getBoundingClientRect(); drawUsage(lastUsage, e.clientX - r.left);
  });
  $("usage-chart").addEventListener("mouseleave", function () { $("usage-tip").classList.add("hidden"); drawUsage(lastUsage); });

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
      if (days.length <= 16 || idx % 2 === 0) {
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
  $("token-chart").addEventListener("mousemove", function (e) {
    var r = e.target.getBoundingClientRect(); drawTokens(lastTokens, e.clientX - r.left);
  });
  $("token-chart").addEventListener("mouseleave", function () { $("token-tip").classList.add("hidden"); drawTokens(lastTokens); });
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

  // ---------------------------------------------------------------- restart
  $("restart-btn").addEventListener("click", function () {
    if (!confirm("Opravdu restartovat celý Hermes gateway (všech 6 profilů)?")) return;
    var btn = $("restart-btn");
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
      .then(function () { btn.disabled = false; btn.textContent = "⟲ Restart Hermes gateway"; pollState(); });
  });

  window.addEventListener("resize", function () { drawUsage(lastUsage); drawTokens(lastTokens); });

  pollState(); pollUsage(); pollGithub(); pollTokens(); tickClock();
  setInterval(pollState, POLL_STATE_MS);
  setInterval(pollUsage, POLL_USAGE_MS);
  setInterval(pollGithub, POLL_SLOW_MS);
  setInterval(pollTokens, POLL_SLOW_MS);
  setInterval(tickClock, 1000);
})();
