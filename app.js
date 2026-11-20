(function () {
  var SALT = new TextEncoder().encode("fomo-desk-v1");
  var WRITES = "changes: ask in Grok Bot chat";
  var SCREEN_MS = 15000;
  var PULL_MS = 15000;
  var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function b64urlToBytes(text) {
    var pad = "=".repeat((4 - (text.length % 4)) % 4);
    var s = (text + pad).replace(/-/g, "+").replace(/_/g, "/");
    var raw = atob(s);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  function bytesToB64url(buf) {
    var bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }
  async function hkdfBits(secret, info) {
    var ikm = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "HKDF", false, ["deriveBits"]);
    return crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: SALT, info: new TextEncoder().encode(info) },
      ikm, 256
    );
  }
  async function derivePath(secret) {
    var bits = await hkdfBits(secret, "data-path-v1");
    return bytesToB64url(bits);
  }
  async function decryptPayload(secret, payload) {
    if (!payload || payload.v !== 1 || !payload.n || !payload.c) throw new Error("bad ciphertext envelope");
    var keyBits = await hkdfBits(secret, "aes-gcm-v1");
    var key = await crypto.subtle.importKey("raw", keyBits, { name: "AES-GCM" }, false, ["decrypt"]);
    var pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64urlToBytes(payload.n) }, key, b64urlToBytes(payload.c));
    return new Uint8Array(pt);
  }
  async function decryptJson(secret, payload) {
    return JSON.parse(new TextDecoder().decode(await decryptPayload(secret, payload)));
  }

  function readHashParams() {
    return new URLSearchParams((location.hash || "").replace(/^#/, ""));
  }
  var SECRET_RE = /^[A-Za-z0-9_-]{32,}$/;
  var SECRET_STORE = "desk_data_secret";

  function readDataSecret() {
    var params = readHashParams();
    var d = params.get("d");
    if (d) { try { localStorage.setItem(SECRET_STORE, d); } catch (e) {} }
    else { try { d = localStorage.getItem(SECRET_STORE); } catch (e) { d = null; } }
    if (d && SECRET_RE.test(d)) return d;
    return null;
  }
  function parseKeyFromLink(text) {
    var s = String(text || "").trim().replace(/^['"]+|['"]+$/g, "").trim();
    if (!s) return null;
    var hash = "";
    try {
      hash = new URL(s, "https://local.invalid").hash || "";
    } catch (e) {
      hash = "";
    }
    if (!hash) {
      var i = s.indexOf("#");
      if (i >= 0) hash = s.slice(i);
    }
    if (hash.charAt(0) === "#") hash = hash.slice(1);
    if (!hash) return null;
    var d = null;
    try { d = new URLSearchParams(hash).get("d"); } catch (e) { d = null; }
    if (d && SECRET_RE.test(d)) return d;
    return null;
  }
  function forgetStoredKey() {
    try { localStorage.removeItem(SECRET_STORE); } catch (e) {}
  }
  function readAppToken() {
    var params = readHashParams();
    var t = params.get("t");
    if (t) { try { localStorage.setItem("desk_app_token", t); } catch (e) {} }
    else { try { t = localStorage.getItem("desk_app_token"); } catch (e) { t = null; } }
    if (t && t.length >= 16) return t;
    return null;
  }
  function stripTokenFromHash() {
    var params = readHashParams();
    if (!params.has("t")) return;
    params.delete("t");
    var next = params.toString();
    var url = location.pathname + location.search + (next ? "#" + next : "");
    try { history.replaceState(null, "", url); } catch (e) {}
  }

  var secret = readDataSecret();
  var appToken = readAppToken();
  stripTokenFromHash();
  var dataBasePromise = secret ? derivePath(secret).then(function (p) { return "d/" + p; }) : Promise.resolve(null);

  function authHeaders() { return appToken ? { Authorization: "Bearer " + appToken } : {}; }
  function qs() { return new URLSearchParams(location.search || ""); }
  function shotMode() { return (qs().get("shot") || "").toLowerCase(); }

  var store = {
    state: null, charts: {}, activity: null, bots: {}, account: null, settings: null,
    coins: {}, audits: {}, lastOkAt: null, offline: false, range: "LIVE",
    screenUrl: null, screenFront: "A", screenAt: null
  };

  function linksFrom() {
    return (store.state && store.state.links) || (store.account && store.account.links) || (store.settings && store.settings.links) || {};
  }
  function writesNote() {
    return (store.state && store.state.writes) || (store.account && store.account.writes) || WRITES;
  }
  function fmtMoney(n, digits) {
    var d = digits == null ? 2 : digits;
    var x = Number(n);
    if (!isFinite(x)) return "—";
    var sign = x < 0 ? "-" : "";
    return sign + "$" + Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function fmtPct(n, plus) {
    var x = Number(n);
    if (!isFinite(x)) return "—";
    var s = (plus && x > 0 ? "+" : "") + x.toFixed(2) + "%";
    return s;
  }
  function fmtTime(ts) {
    if (!ts) return "";
    var d = new Date(ts);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  function fmtAgo(ts) {
    if (!ts) return "";
    var t = Date.parse(ts);
    if (isNaN(t)) return "";
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 5) return "just now";
    if (s < 60) return s + "s ago";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    return Math.round(s / 3600) + "h ago";
  }
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function coinHref(url) {
    if (!url || typeof url !== "string") return "";
    if (url.indexOf("https://") !== 0 && url.indexOf("http://") !== 0) return "";
    return url;
  }
  function fomoBtn(url, label) {
    var href = coinHref(url);
    if (!href) return "";
    return '<a class="btn-fomo fomo" href="' + escapeHtml(href) + '" target="_blank" rel="noopener">' + escapeHtml(label || "Open on FOMO") + "</a>";
  }

  /* ---------- odometer ---------- */
  function renderOdometer(el, value) {
    var text = fmtMoney(value);
    if (!el) return;
    if (reduced) { el.textContent = text; return; }
    var next = text.split("");
    var cur = [];
    el.querySelectorAll(".ch").forEach(function (n) { cur.push(n.dataset.ch || n.textContent); });
    if (!el.childElementCount) {
      el.textContent = "";
      next.forEach(function (ch) { el.appendChild(makeChar(ch, ch)); });
      return;
    }
    if (cur.join("") === text) return;
    el.textContent = "";
    next.forEach(function (ch, i) {
      el.appendChild(makeChar(cur[i] == null ? ch : cur[i], ch, i));
    });
  }
  function makeChar(from, to, idx) {
    var wrap = document.createElement("span");
    wrap.className = "ch" + (/[0-9]/.test(to) ? " digit" : "");
    wrap.dataset.ch = to;
    if (/[0-9]/.test(to) && /[0-9]/.test(from) && from !== to && !reduced) {
      var stack = document.createElement("span");
      var start = Number(from), end = Number(to);
      var html = "";
      var seq = [];
      var n = start;
      seq.push(n);
      while (n !== end) { n = (n + 1) % 10; seq.push(n); }
      seq.forEach(function (d) { html += "<i>" + d + "</i>"; });
      stack.innerHTML = html;
      stack.style.transform = "translateY(0)";
      wrap.appendChild(stack);
      var delay = (idx || 0) * 30;
      requestAnimationFrame(function () {
        setTimeout(function () {
          stack.style.transform = "translateY(-" + (seq.length - 1) * 100 + "%)";
        }, delay);
      });
    } else {
      wrap.textContent = to;
    }
    return wrap;
  }
  // odometer stack layout
  var styleBoost = document.createElement("style");
  styleBoost.textContent = ".odometer .digit{display:inline-block;height:1em;overflow:hidden;vertical-align:bottom}.odometer .digit>span{display:block}.odometer .digit i{display:block;height:1em;font-style:normal}";
  document.head.appendChild(styleBoost);

  /* ---------- fetch ---------- */
  async function getJson(path) {
    var base = await dataBasePromise;
    if (base && secret) {
      var res = await fetch(base + "/" + path, { cache: "no-store" });
      if (!res.ok) throw new Error(path + " " + res.status);
      return decryptJson(secret, await res.json());
    }
    if (appToken) {
      var map = {
        "state.json": "/api/state",
        "activity.json": "/api/activity",
        "account.json": "/api/account",
        "settings.json": "/api/settings",
        "orders.json": "/api/orders"
      };
      var url = map[path];
      if (!url && path.indexOf("chart_") === 0) url = "/api/chart?range=" + path.replace("chart_", "").replace(".json", "");
      if (!url && path.indexOf("coin/") === 0) url = "/api/coin/" + path.slice(5).replace(".json", "");
      if (!url && path.indexOf("audit/") === 0) url = "/api/audit/" + path.slice(6).replace(".json", "");
      if (!url && path.indexOf("bots/") === 0) url = "/api/bots/" + path.slice(5).replace(".json", "") + "/decisions";
      if (!url) throw new Error("no api map for " + path);
      var r = await fetch(url, { cache: "no-store", headers: authHeaders() });
      if (!r.ok) throw new Error(path + " " + r.status);
      return r.json();
    }
    throw new Error("locked");
  }

  async function pullCore() {
    var state = await getJson("state.json");
    if (shotMode() === "empty") {
      state.open_positions = [];
      state.open_position_count = 0;
      state.last_order = null;
      state.today_pct = 0;
      state.multiplier = 1;
      state.balance = 100;
      state.cash_usd = 100;
      state.equity = [100, 100];
      state.bots = (state.bots || []).map(function (b) {
        return Object.assign({}, b, { feed: [], count_today: 0, headline: b.name === "risk" ? "Guarding" : "0", layers: [], bar: null, score: null, size_text: "" });
      });
    }
    store.state = state;
    store.lastOkAt = new Date();
    store.offline = shotMode() === "error" ? true : false;
    try { store.activity = await getJson("activity.json"); } catch (e) { if (!store.activity) store.activity = { items: [] }; }
    if (shotMode() === "empty") store.activity = { items: [] };
    try { store.account = await getJson("account.json"); } catch (e) {}
    try { store.settings = await getJson("settings.json"); } catch (e) {}
    var range = store.range || "LIVE";
    try {
      var ch = await getJson("chart_" + range + ".json");
      store.charts[range] = ch;
    } catch (e) {
      try { store.charts[range] = await getJson("chart.json"); } catch (e2) {}
    }
    if (shotMode() === "empty" && store.charts[range]) {
      store.charts[range].marks = [];
      store.charts[range].points = [{ ts: state.ts, value: 100 }];
      store.charts[range].equity = [100];
    }
    var names = ["scanner", "analyst", "brain", "executor", "risk"];
    for (var i = 0; i < names.length; i++) {
      try { store.bots[names[i]] = await getJson("bots/" + names[i] + ".json"); } catch (e) {}
    }
    return state;
  }

  async function pullScreen() {
    var base = await dataBasePromise;
    var idle = !(store.state && store.state.lane);
    var status = (store.state && store.state.screen) || "Idle";
    if (idle || status === "Idle" || status === "no frame yet") {
      showIdleScreen();
      return;
    }
    if (!(base && secret)) {
      // local plan A
      if (!appToken) { showIdleScreen(); return; }
      try {
        var r = await fetch("/api/screen.jpg?t=" + Date.now(), { cache: "no-store", headers: authHeaders() });
        if (!r.ok) { showIdleScreen(); return; }
        var blob = await r.blob();
        swapScreen(URL.createObjectURL(blob), store.state && store.state.screen_ts);
      } catch (e) { showIdleScreen(); }
      return;
    }
    try {
      var encRes = await fetch(base + "/screen.enc?t=" + Date.now(), { cache: "no-store" });
      if (!encRes.ok) { showIdleScreen(); return; }
      var bytes = await decryptPayload(secret, await encRes.json());
      swapScreen(URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" })), store.state && store.state.screen_ts);
    } catch (e) { showIdleScreen(); }
  }

  function showIdleScreen() {
    var idle = document.getElementById("screenIdle");
    var a = document.getElementById("screenA");
    var b = document.getElementById("screenB");
    if (idle) { idle.hidden = false; idle.textContent = (store.state && store.state.screen) || "Idle"; }
    if (a) a.classList.remove("show");
    if (b) b.classList.remove("show");
    setScreenChrome(null);
  }

  function swapScreen(url, ts) {
    var idle = document.getElementById("screenIdle");
    if (idle) idle.hidden = true;
    var next = store.screenFront === "A" ? "B" : "A";
    var img = document.getElementById("screen" + next);
    var prev = document.getElementById("screen" + store.screenFront);
    if (!img) return;
    img.onload = function () {
      img.classList.add("show");
      if (prev) prev.classList.remove("show");
      if (store.screenUrl && store.screenUrl !== url) {
        try { URL.revokeObjectURL(store.screenUrl); } catch (e) {}
      }
      store.screenUrl = url;
      store.screenFront = next;
      store.screenAt = ts || new Date().toISOString();
      setScreenChrome(store.screenAt);
      var fs = document.getElementById("fsImg");
      if (fs) fs.src = url;
    };
    img.src = url;
  }

  function setScreenChrome(ts) {
    var live = document.getElementById("screenLive");
    var laneEl = document.getElementById("screenLane");
    var lane = store.state && store.state.lane;
    var ageMs = ts ? (Date.now() - Date.parse(ts)) : Infinity;
    if (live) {
      if (ts && isFinite(ageMs) && ageMs < 5000) {
        live.innerHTML = '<span class="dot"></span> Live · Bot\'s computer';
      } else if (ts) {
        live.innerHTML = '<span class="dot grey"></span> Last frame ' + escapeHtml(fmtAgo(ts) || fmtTime(ts));
      } else {
        live.innerHTML = '<span class="dot grey"></span> Idle';
      }
    }
    if (laneEl) {
      if (lane && lane.bot) {
        var verb = (lane.side === "sell") ? "selling" : (lane.side === "buy" ? "buying" : (lane.status || "clicking"));
        laneEl.textContent = cap(lane.bot) + " · " + verb;
        laneEl.style.color = lane.color || "";
      } else {
        laneEl.textContent = "Idle";
        laneEl.style.color = "";
      }
    }
    var orderEl = document.getElementById("screenOrder");
    var last = store.state && store.state.last_order;
    if (orderEl) {
      if (last) {
        var label = orderLabel(last);
        var ch = last.checks || {};
        orderEl.innerHTML = "<span>" + escapeHtml(label) + "</span><span class=\"checks\">" +
          check("screen", ch.screen) + check("api", ch.api) + check("chain", ch.chain) + "</span>";
      } else {
        orderEl.textContent = "";
      }
    }
    var fomo = document.getElementById("screenFomo");
    if (fomo) {
      var href = coinHref(last && last.coin_url);
      if (href) { fomo.href = href; fomo.hidden = false; }
      else { fomo.removeAttribute("href"); fomo.hidden = true; }
    }
  }
  function check(name, ok) {
    return '<span class="check ' + (ok ? "ok" : "off") + '">' + (ok ? "✓ " : "○ ") + escapeHtml(name) + "</span>";
  }
  function cap(s) { s = String(s || ""); return s ? s.charAt(0).toUpperCase() + s.slice(1) : ""; }
  function orderLabel(o) {
    var sym = o.symbol || "coin";
    var usd = o.fill_usd != null ? o.fill_usd : o.usd;
    var verb = o.side === "sell" ? "Sold" : "Bought";
    var st = o.status === "done" ? "verified" : (o.status || "");
    return verb + " " + sym + (usd != null ? " · " + fmtMoney(usd) : "") + (st ? " · " + st : "");
  }

  /* ---------- render ---------- */
  function renderAll() {
    var st = store.state;
    if (!st) return;
    document.getElementById("homeSkeleton").hidden = true;
    hideKeyUnlock();
    document.getElementById("homeBody").hidden = false;
    var handle = (st.health && st.health.fomo_handle) || (store.account && store.account.handle) || "";
    var av = document.getElementById("avatarBtn");
    if (av) av.textContent = (handle || "F").charAt(0).toUpperCase();
    var mode = (st.mode || "PAPER").toUpperCase();
    document.querySelectorAll(".badge.paper, #paperBadge, #coinPaper").forEach(function (el) {
      if (mode === "LIVE") { el.classList.add("live"); el.hidden = true; }
      else { el.classList.remove("live"); el.hidden = false; el.textContent = "PAPER"; }
    });
    renderOdometer(document.getElementById("balanceOdo"), st.balance != null ? st.balance : st.cash_usd);
    var tp = document.getElementById("todayPct");
    if (tp) {
      var p = Number(st.today_pct || 0);
      tp.textContent = fmtPct(p, true);
      tp.classList.toggle("down", p < 0);
    }
    var mul = document.getElementById("multiplier");
    if (mul) mul.textContent = (Number(st.multiplier || 1)).toFixed(2) + "×";
    drawRange();
    renderHomeBots();
    renderHomeActivity();
    renderBotsTab();
    renderActivityTab();
    renderAccount();
    setScreenChrome(store.screenAt || (st && st.screen_ts));
    var unver = st.last_order && st.last_order.status === "unverified";
    document.getElementById("bellDot").hidden = !unver;
    renderErrorBanner();
    var nRun = (st.bots || []).filter(function (b) { return b.ok && !b.paused; }).length;
    var bh = document.getElementById("botsHeading");
    if (bh) bh.textContent = "Bots · " + nRun + " running";
  }

  function drawRange() {
    var range = store.range || "LIVE";
    document.querySelectorAll("#rangeSwitch button").forEach(function (b) {
      b.classList.toggle("on", b.getAttribute("data-range") === range);
    });
    var ch = store.charts[range] || {};
    var st = store.state || {};
    var start = (store.account && store.account.start_cash) != null ? store.account.start_cash : (ch.points && ch.points[0] && ch.points[0].value);
    var canvas = document.getElementById("chart");
    if (canvas && globalThis.DeskChart) {
      DeskChart.drawEquity(canvas, {
        points: ch.points || (st.equity || []).map(function (v) { return { value: v }; }),
        marks: ch.marks || [],
        start: start
      });
    }
  }

  function renderHomeBots() {
    var el = document.getElementById("botCarousel");
    if (!el) return;
    var bots = (store.state && store.state.bots) || [];
    if (!bots.length) { el.innerHTML = ""; return; }
    el.innerHTML = bots.map(miniBotCard).join("");
    el.querySelectorAll("[data-open-bot]").forEach(function (n) {
      n.addEventListener("click", function () { showTab("bots"); });
    });
  }

  function miniBotCard(b) {
    var color = b.color || "#fff";
    var head = "<h3 style=\"color:" + escapeHtml(color) + "\">" + escapeHtml(b.title || cap(b.name)) + "</h3>";
    var count = "<div class=\"count\">" + escapeHtml(b.headline || "") + "</div>";
    var body = "";
    if (b.name === "scanner") {
      body = "<ul class=\"bot-feed\">" + (b.feed || []).slice(0, 4).map(function (f) {
        var name = f.symbol || (f.mint ? f.mint.slice(0, 6) : "pool");
        if (f.killed) return "<li class=\"killed\">" + escapeHtml(name) + "<span class=\"why\">" + escapeHtml(f.reason || "killed") + "</span></li>";
        if (f.passed) return "<li class=\"passed\">" + escapeHtml(name) + " → Analyst</li>";
        return "<li>" + escapeHtml(name) + "</li>";
      }).join("") + "</ul>";
    } else if (b.name === "analyst") {
      var strips = (b.layers || []).slice(0, 8).map(function (L) {
        return "<i class=\"" + (L.pass ? "ok" : (L.pass === false ? "bad" : "")) + "\"></i>";
      }).join("");
      var social = (b.social_pts != null) ? ("Social +" + b.social_pts) : "Social: off";
      var score = b.score != null ? Number(b.score).toFixed(0) : "—";
      body = "<div class=\"layers-mini\">" + strips + "</div><div class=\"count\">" + escapeHtml(social) + " · " + score + "</div>";
    } else if (b.name === "brain") {
      body = "<div class=\"count\">" + escapeHtml(b.size_text || "") + "</div><div class=\"count\">" + escapeHtml(b.size_rule || "") + "<br>" + escapeHtml(b.size_rule_low || "") + "</div>";
    } else if (b.name === "executor") {
      body = "<div class=\"bar-status\">" + escapeHtml(b.bar || "") + "</div>";
    } else if (b.name === "risk") {
      body = "<div class=\"bot-pills\">" + (b.pills || []).map(function (p) {
        return "<span class=\"bot-pill " + escapeHtml(p.tone || "") + "\">" + escapeHtml(p.text) + "</span>";
      }).join("") + "</div>";
    }
    return "<article class=\"bot-card\" data-open-bot=\"" + escapeHtml(b.name) + "\">" + head + count + body + "</article>";
  }

  function activityItems() {
    var items = (store.activity && (store.activity.items || store.activity.activity)) || [];
    return items;
  }

  function renderHomeActivity() {
    var el = document.getElementById("homeActivity");
    var empty = document.getElementById("homeEmpty");
    if (!el) return;
    var items = activityItems();
    if (empty) empty.hidden = items.length > 0;
    if (!items.length) {
      el.innerHTML = "";
      return;
    }
    el.innerHTML = items.slice(0, 5).map(activityRow).join("");
    bindActivity(el);
  }
  function renderActivityTab() {
    var el = document.getElementById("activityList");
    if (!el) return;
    var items = activityItems();
    if (!items.length) {
      el.innerHTML = "<li class=\"empty-msg\">Nothing yet tonight</li>";
      return;
    }
    el.innerHTML = items.map(activityRow).join("");
    bindActivity(el);
  }
  function activityRow(it) {
    var title = it.title || it.kind || "Event";
    var sub = [cap(it.bot), fmtTime(it.ts), it.subtitle].filter(Boolean).join(" · ");
    var val = it.value || "";
    return "<li class=\"row-act\" data-kind=\"" + escapeHtml(it.kind || "") + "\" data-mint=\"" + escapeHtml(it.mint || "") + "\">" +
      "<div class=\"title\">" + escapeHtml(title) + "</div>" +
      "<div class=\"value num\">" + escapeHtml(val) + "</div>" +
      "<div class=\"sub\">" + escapeHtml(sub) + "</div>" +
      fomoBtn(it.coin_url) +
      "</li>";
  }
  function bindActivity(el) {
    el.querySelectorAll(".row-act").forEach(function (n) {
      n.addEventListener("click", function (ev) {
        if (ev.target.closest && ev.target.closest("a")) return;
        var mint = n.getAttribute("data-mint");
        var kind = n.getAttribute("data-kind");
        if (!mint) return;
        if (kind === "rejected") openAudit(mint);
        else openCoin(mint);
      });
    });
  }

  function renderBotsTab() {
    var el = document.getElementById("botsList");
    if (!el) return;
    var bots = (store.state && store.state.bots) || [];
    var posOpen = !!(store.state && store.state.open_position_count);
    el.innerHTML = bots.map(function (b) {
      var dec = (store.bots[b.name] && store.bots[b.name].items) || [];
      var rows = dec.slice(0, 20).map(function (d) {
        var label = d.verdict || d.reason || d.title || (d.score != null ? ("score " + d.score) : d.status) || d.kind || "decision";
        var name = d.symbol || (d.mint ? d.mint.slice(0, 8) : "");
        var link = coinHref(d.coin_url);
        var mid = name && link ? ("<a href=\"" + escapeHtml(link) + "\" target=\"_blank\" rel=\"noopener\">" + escapeHtml(name) + "</a>") : escapeHtml(name);
        return "<li>" + mid + (mid ? " · " : "") + escapeHtml(String(label)) + "</li>";
      }).join("");
      var lock = b.name === "risk" && posOpen;
      return "<article class=\"bot-full\" id=\"botfull-" + escapeHtml(b.name) + "\">" +
        "<div class=\"bot-full-head\">" +
        "<span class=\"status-dot" + (b.ok ? "" : " off") + "\"></span>" +
        "<h3 style=\"color:" + escapeHtml(b.color || "") + "\">" + escapeHtml(b.title || cap(b.name)) + "</h3>" +
        "<span class=\"num muted\">" + escapeHtml(String(b.count_today || 0)) + "</span>" +
        "<div class=\"switch" + (lock ? " locked" : "") + "\" title=\"" + (lock ? "Risk is locked while a position is open" : writesNote()) + "\"><i></i></div>" +
        "</div>" +
        "<p class=\"writes-note\">" + escapeHtml(lock ? "Risk is locked while a position is open. " + writesNote() : writesNote()) + "</p>" +
        "<ul class=\"bot-decisions\">" + (rows || "<li class=\"muted\">No decisions yet</li>") + "</ul>" +
        "<button type=\"button\" class=\"settings-jump\" data-jump=\"" + escapeHtml(b.name) + "\">Settings</button>" +
        "</article>";
    }).join("");
    el.querySelectorAll("[data-jump]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        showTab("account");
        var id = "settings-" + btn.getAttribute("data-jump");
        setTimeout(function () {
          var n = document.getElementById(id);
          if (n) n.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
        }, 50);
      });
    });
  }

  function renderAccount() {
    var el = document.getElementById("accountBody");
    if (!el) return;
    var acc = store.account || {};
    var st = store.state || {};
    var mode = (acc.mode || st.mode || "PAPER").toUpperCase();
    var L = linksFrom();
    var note = writesNote();
    var profile = coinHref(L.profile_url);
    var signup = coinHref(L.signup_url);
    var groups = (store.settings && store.settings.groups) || [];
    var html = "";
    html += "<div class=\"group\"><div class=\"row\"><div class=\"left\"><strong>Mode</strong><span class=\"muted\">" + escapeHtml(note) + "</span></div>" +
      "<div class=\"seg disabled\"><button type=\"button\" class=\"" + (mode === "PAPER" ? "on" : "") + "\" disabled>PAPER</button>" +
      "<button type=\"button\" class=\"" + (mode === "LIVE" ? "on" : "") + "\" disabled>LIVE</button></div></div></div>";
    html += "<div class=\"group\"><div class=\"row\"><div class=\"left\"><strong>Cash</strong></div><span class=\"num\">" + escapeHtml(fmtMoney(acc.balance != null ? acc.balance : st.balance)) + "</span></div></div>";
    html += "<div class=\"group\">";
    html += "<div class=\"row\"><div class=\"left\"><strong>Your FOMO profile</strong></div>" +
      (profile ? "<a href=\"" + escapeHtml(profile) + "\" target=\"_blank\" rel=\"noopener\">Open</a>" : "<span class=\"muted\">—</span>") + "</div>";
    html += "<div class=\"row\"><div class=\"left\"><strong>Invite a friend</strong></div>" +
      "<button type=\"button\" class=\"text-btn\" id=\"inviteBtn\">Invite</button></div>";
    html += "<p class=\"copied\" id=\"inviteCopied\" hidden>Link copied</p>";
    html += "</div>";
    groups.forEach(function (g) {
      html += "<div class=\"group\" id=\"settings-" + escapeHtml(g.id) + "\">";
      html += "<div class=\"row\"><strong style=\"color:" + escapeHtml(g.color || "") + "\">" + escapeHtml(g.title) + "</strong></div>";
      (g.items || []).forEach(function (it) {
        var val = it.value;
        var numeric = (it.kind === "int" || it.kind === "float") && val != null && it.lo != null && it.hi != null;
        var hint = (numeric && it.lo != null && it.hi != null) ? (String(it.lo) + "–" + String(it.hi) + (it.unit ? " " + it.unit : "")) : "";
        var show = val == null ? "—" : String(val);
        if (it.kind === "bool") show = val ? "on" : "off";
        if (numeric) {
          html += "<div class=\"slider-row\"><label><span>" + escapeHtml(it.label) + "</span><span class=\"range-hint\">" + escapeHtml(hint || show) + "</span></label>";
          var lo = it.lo != null ? it.lo : 0, hi = it.hi != null ? it.hi : 100;
          var step = it.step != null ? it.step : (it.kind === "int" ? 1 : "any");
          var v = val == null ? lo : val;
          html += "<div class=\"slider-controls\">";
          html += "<input type=\"range\" disabled min=\"" + lo + "\" max=\"" + hi + "\" step=\"" + step + "\" value=\"" + escapeHtml(v) + "\" aria-label=\"" + escapeHtml(it.label) + "\">";
          html += "<input type=\"number\" class=\"num exact\" disabled min=\"" + lo + "\" max=\"" + hi + "\" step=\"" + step + "\" value=\"" + escapeHtml(v) + "\" aria-label=\"" + escapeHtml(it.label + " value") + "\">";
          html += "</div></div>";
        } else {
          html += "<div class=\"field-row row\"><div class=\"left\"><strong>" + escapeHtml(it.label) + "</strong></div><span class=\"value num\">" + escapeHtml(show) + "</span></div>";
        }
      });
      html += "<p class=\"writes-note\">" + escapeHtml(note) + "</p></div>";
    });
    html += "<div class=\"group\"><div class=\"row\"><div class=\"left\"><strong>Copy picks</strong><span class=\"muted\">off</span></div>" +
      "<div class=\"seg disabled\"><button type=\"button\" class=\"on\" disabled>off</button>" +
      "<button type=\"button\" disabled>24h</button><button type=\"button\" disabled>12h</button><button type=\"button\" disabled>6h</button></div></div></div>";
    var push = acc.push || { plan: "Plan B: Telegram only", telegram: "not connected — send /start to @ChainGangCabalBot" };
    var tg = acc.telegram || {};
    var tgNote = push.telegram || tg.note || "not connected — send /start to @ChainGangCabalBot";
    var bell = document.getElementById("bellTelegram");
    if (bell) bell.textContent = tgNote;
    html += "<div class=\"group\"><div class=\"row\"><div class=\"left\"><strong>Pushes</strong><span class=\"muted\">" + escapeHtml(push.plan || "Plan B: Telegram only") + "</span></div><span class=\"muted\">" + escapeHtml(tgNote) + "</span></div>" +
      "<div class=\"row\"><div class=\"left\"><strong>Telegram</strong></div><span class=\"muted\">" + escapeHtml(tg.note || tgNote) + "</span></div>" +
      "<div class=\"row\"><div class=\"left\"><strong>Send test push</strong><span class=\"muted\">" + escapeHtml(note) + "</span></div><span class=\"muted\">off</span></div></div>";
    html += "<div class=\"group\"><div class=\"row\"><div class=\"left\"><strong>Watch in Grok Bot</strong></div><span class=\"disabled-text\">Open Grok Bot → FOMO Bot</span></div></div>";
    if (secret) {
      html += "<div class=\"group\"><div class=\"row\"><div class=\"left\"><strong>Saved key</strong><span class=\"muted\">Stored on this phone only</span></div>" +
        "<button type=\"button\" class=\"text-btn\" id=\"forgetKeyBtn\">Forget key</button></div></div>";
    }
    el.innerHTML = html;
    var invite = document.getElementById("inviteBtn");
    if (invite) invite.addEventListener("click", function () { inviteFriend(signup); });
    var forget = document.getElementById("forgetKeyBtn");
    if (forget) forget.addEventListener("click", onForgetKey);
  }

  function inviteFriend(url) {
    var href = coinHref(url);
    if (!href) return;
    var done = function (copied) {
      var n = document.getElementById("inviteCopied");
      if (n && copied) { n.hidden = false; setTimeout(function () { n.hidden = true; }, 2000); }
    };
    if (navigator.share) {
      navigator.share({ title: "FOMO", url: href }).catch(function () { copyLink(href, done); });
      return;
    }
    copyLink(href, done);
  }
  function copyLink(href, done) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(href).then(function () { done(true); }).catch(function () { fallbackCopy(href, done); });
    } else fallbackCopy(href, done);
  }
  function fallbackCopy(href, done) {
    var t = document.createElement("textarea");
    t.value = href; document.body.appendChild(t); t.select();
    try { document.execCommand("copy"); done(true); } catch (e) { done(false); }
    t.remove();
  }

  async function openCoin(mint) {
    showOverlay("view-coin");
    var body = document.getElementById("coinBody");
    body.innerHTML = "<div class=\"sk sk-chart\"></div>";
    var data = store.coins[mint];
    try { data = await getJson("coin/" + mint + ".json"); store.coins[mint] = data; } catch (e) {}
    if (!data) { body.innerHTML = "<p class=\"muted\">No coin data.</p>"; return; }
    document.getElementById("coinName").textContent = data.symbol || data.name || "Coin";
    var sh = document.getElementById("coinShield");
    sh.textContent = data.shield || "";
    sh.hidden = !data.shield;
    var since = data.since_entry_pct;
    var sinceHtml = since == null ? "" : ("<div class=\"since" + (since < 0 ? " down" : "") + "\">▲ " + fmtPct(since, true) + " since entry</div>");
    if (since != null && since < 0) sinceHtml = "<div class=\"since down\">▼ " + fmtPct(since, true) + " since entry</div>";
    var pos = data.position;
    var posHtml = pos ? ("<div class=\"pos-card\"><div class=\"muted\">Your position</div><div>" + fmtMoney(pos.size_usd) + " in · Executor</div></div>") : "";
    body.innerHTML =
      "<p class=\"coin-meta\">" + escapeHtml([data.symbol || data.name, data.chain || "Solana", data.age].filter(Boolean).join(" · ")) + "</p>" +
      "<div class=\"price num\">" + (data.price == null ? "—" : escapeHtml(fmtMoney(data.price, 6))) + "</div>" + sinceHtml +
      "<canvas id=\"coinChart\" width=\"358\" height=\"180\"></canvas>" +
      "<div class=\"stats\">" +
      stat("Market cap", data.market_cap) + stat("Liquidity", data.liquidity_usd) + stat("Holders", data.holders) +
      "</div>" + posHtml +
      "<div class=\"actions\">" +
      (coinHref(data.coin_url) ? "<a class=\"btn btn-fomo primary\" href=\"" + escapeHtml(coinHref(data.coin_url)) + "\" target=\"_blank\" rel=\"noopener\">Open on FOMO</a>" : "") +
      "<button type=\"button\" class=\"btn danger\" id=\"sellNow\">Sell now</button>" +
      "</div>";
    if (globalThis.DeskChart) {
      DeskChart.drawCandles(document.getElementById("coinChart"), {
        candles: data.candles || [],
        exit: data.exit_price || data.stop_price
      });
    }
    var sell = document.getElementById("sellNow");
    if (sell) sell.addEventListener("click", function () {
      document.getElementById("sellSheet").hidden = false;
    });
  }
  function stat(k, v) {
    var show = v == null || v === "" ? "—" : (typeof v === "number" && v > 1000 ? fmtMoney(v, 0) : String(v));
    if (k !== "Holders" && typeof v === "number") show = fmtMoney(v, v >= 100 ? 0 : 2);
    if (k === "Holders" && v != null) show = String(v);
    return "<div><div class=\"k\">" + escapeHtml(k) + "</div><div class=\"v num\">" + escapeHtml(show) + "</div></div>";
  }

  async function openAudit(mint) {
    showOverlay("view-audit");
    var body = document.getElementById("auditBody");
    body.innerHTML = "<div class=\"sk sk-chart\"></div>";
    var data = store.audits[mint];
    try { data = await getJson("audit/" + mint + ".json"); store.audits[mint] = data; } catch (e) {}
    document.getElementById("auditTitle").textContent = (data && (data.symbol || data.name)) || "Audit";
    if (!data) { body.innerHTML = "<p class=\"muted\">No audit yet.</p>"; return; }
    var layers = data.layers || [];
    var discs = layers.map(function (L, i) {
      var mark = L.pass ? "<span class=\"ok\">✓</span>" : (L.pass === false ? "<span class=\"bad\">✕</span>" : "");
      return "<div class=\"disc\" data-i=\"" + i + "\"><span class=\"n\">" + escapeHtml(String(L.n || i + 1)) + "</span>" +
        "<div><div>" + escapeHtml(L.name || ("Layer " + (i + 1))) + "</div><div class=\"muted\">" + escapeHtml(L.value || "") + "</div></div>" + mark + "</div>";
    }).join("");
    body.innerHTML = "<div class=\"discs\">" + discs + "</div><div class=\"social-row\">" + escapeHtml(data.social_line || "Social: off") + "</div>" +
      (coinHref(data.coin_url) ? "<div class=\"actions\">" + fomoBtn(data.coin_url) + "</div>" : "");
    var nodes = body.querySelectorAll(".disc");
    if (reduced || !nodes.length) { nodes.forEach(function (n) { n.classList.add("on"); }); return; }
    var i = 0;
    function beam() {
      nodes.forEach(function (n) { n.classList.remove("on"); });
      if (i < nodes.length) nodes[i].classList.add("on");
      i += 1;
      if (i < nodes.length) setTimeout(beam, 220);
    }
    beam();
  }

  function renderErrorBanner() {
    var el = document.getElementById("errorBanner");
    if (!store.offline) {
      el.hidden = true;
      document.body.classList.remove("has-error-banner");
      return;
    }
    el.hidden = false;
    document.body.classList.add("has-error-banner");
    el.dataset.until = String(Date.now() + retryLeft * 1000);
    if (!secret) {
      el.textContent = "This link is missing its key. Re-open the original full link and keep the # part.";
      return;
    }
    var last = store.lastOkAt ? store.lastOkAt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" }) : "—";
    el.textContent = "Desk offline · retrying in " + retryLeft + "s · last update " + last;
  }
  var retryLeft = 15;
  function tickRetry() {
    if (!store.offline) return;
    retryLeft -= 1;
    if (retryLeft <= 0) {
      retryLeft = 15;
      if (secret) pull().catch(function () {});
    }
    var el = document.getElementById("errorBanner");
    if (!el.hidden && store.lastOkAt) {
      var last = store.lastOkAt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });
      el.textContent = "Desk offline · retrying in " + retryLeft + "s · last update " + last;
    }
  }

  /* ---------- navigation ---------- */
  function showTab(name) {
    ["home", "bots", "activity", "account"].forEach(function (t) {
      var v = document.getElementById("view-" + t);
      if (v) v.hidden = t !== name;
      var tab = document.querySelector('.tab[data-tab="' + t + '"]');
      if (tab) tab.classList.toggle("on", t === name);
    });
    hideOverlays();
    if (name === "home") drawRange();
  }
  function syncOverlayClass() {
    var open = ["view-coin", "view-audit", "view-search", "view-bell", "view-screen"].some(function (id) {
      var n = document.getElementById(id);
      return n && !n.hidden;
    });
    document.body.classList.toggle("has-overlay", open);
  }
  function hideOverlays() {
    ["view-coin", "view-audit", "view-search", "view-bell", "view-screen", "sellSheet"].forEach(function (id) {
      var n = document.getElementById(id);
      if (n) n.hidden = true;
    });
    syncOverlayClass();
  }
  function showOverlay(id) {
    ["view-coin", "view-audit", "view-search", "view-bell", "view-screen"].forEach(function (x) {
      var n = document.getElementById(x);
      if (n) n.hidden = x !== id;
    });
    syncOverlayClass();
  }

  document.getElementById("tabbar").addEventListener("click", function (e) {
    var b = e.target.closest("[data-tab]");
    if (b) showTab(b.getAttribute("data-tab"));
  });
  document.getElementById("avatarBtn").addEventListener("click", function () { showTab("account"); });
  document.getElementById("seeAllActivity").addEventListener("click", function () { showTab("activity"); });
  document.getElementById("searchBtn").addEventListener("click", function () {
    showOverlay("view-search");
    document.getElementById("searchInput").focus();
  });
  document.getElementById("bellBtn").addEventListener("click", function () { showOverlay("view-bell"); });
  document.getElementById("searchBack").addEventListener("click", hideOverlays);
  document.getElementById("bellBack").addEventListener("click", hideOverlays);
  document.getElementById("coinBack").addEventListener("click", hideOverlays);
  document.getElementById("auditBack").addEventListener("click", hideOverlays);
  document.getElementById("screenBack").addEventListener("click", hideOverlays);
  document.getElementById("sellClose").addEventListener("click", function () {
    document.getElementById("sellSheet").hidden = true;
  });
  document.getElementById("rangeSwitch").addEventListener("click", function (e) {
    var b = e.target.closest("[data-range]");
    if (!b) return;
    store.range = b.getAttribute("data-range");
    getJson("chart_" + store.range + ".json").then(function (ch) {
      store.charts[store.range] = ch;
      if (shotMode() === "empty") store.charts[store.range].marks = [];
      drawRange();
    }).catch(function () { drawRange(); });
  });
  document.getElementById("screenCard").addEventListener("click", function () {
    var fs = document.getElementById("fsImg");
    if (store.screenUrl) fs.src = store.screenUrl;
    showOverlay("view-screen");
  });
  var keySave = document.getElementById("keyLinkSave");
  var keyInput = document.getElementById("keyLinkInput");
  if (keySave) keySave.addEventListener("click", function () { savePastedLink(); });
  if (keyInput) keyInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); savePastedLink(); }
  });

  document.getElementById("searchInput").addEventListener("input", function () {
    var q = (this.value || "").trim().toLowerCase();
    var el = document.getElementById("searchResults");
    if (!q) { el.innerHTML = ""; return; }
    var hits = [];
    activityItems().forEach(function (it) {
      var hay = [(it.symbol || ""), (it.name || ""), (it.mint || ""), (it.title || "")].join(" ").toLowerCase();
      if (it.mint && hay.indexOf(q) >= 0) hits.push(it);
    });
    Object.keys(store.coins).forEach(function (m) {
      var c = store.coins[m];
      var hay = [(c.symbol || ""), (c.name || ""), m].join(" ").toLowerCase();
      if (hay.indexOf(q) >= 0) hits.push({ mint: m, symbol: c.symbol, name: c.name, title: c.symbol || c.name, coin_url: c.coin_url, kind: "coin" });
    });
    var seen = {};
    hits = hits.filter(function (h) { if (seen[h.mint]) return false; seen[h.mint] = 1; return true; });
    el.innerHTML = hits.length ? hits.map(function (h) {
      return "<li data-mint=\"" + escapeHtml(h.mint) + "\">" + escapeHtml(h.symbol || h.name || h.title || h.mint) + "</li>";
    }).join("") : "<li class=\"muted\">No matches</li>";
    el.querySelectorAll("[data-mint]").forEach(function (n) {
      n.addEventListener("click", function () { openCoin(n.getAttribute("data-mint")); });
    });
  });

  /* pinch zoom on fullscreen */
  (function () {
    var stage = document.getElementById("fsStage");
    var img = document.getElementById("fsImg");
    var scale = 1, last = 1;
    function dist(e) {
      var a = e.touches[0], b = e.touches[1];
      var dx = a.clientX - b.clientX, dy = a.clientY - b.clientY;
      return Math.hypot(dx, dy);
    }
    stage.addEventListener("touchstart", function (e) {
      if (e.touches.length === 2) last = dist(e);
    }, { passive: true });
    stage.addEventListener("touchmove", function (e) {
      if (e.touches.length !== 2) return;
      e.preventDefault();
      var d = dist(e);
      scale = Math.min(4, Math.max(1, scale * (d / last)));
      last = d;
      img.style.transform = "scale(" + scale + ")";
    }, { passive: false });
    stage.addEventListener("touchend", function () { if (scale < 1.05) { scale = 1; img.style.transform = ""; } });
  })();

  function hideKeyUnlock() {
    var box = document.getElementById("keyUnlock");
    if (box) box.hidden = true;
  }
  function showKeyUnlock() {
    var box = document.getElementById("keyUnlock");
    var skel = document.getElementById("homeSkeleton");
    var body = document.getElementById("homeBody");
    if (skel) skel.hidden = true;
    if (body) body.hidden = true;
    if (box) box.hidden = false;
  }
  function setKeyUnlockStatus(msg) {
    var st = document.getElementById("keyUnlockStatus");
    if (!st) return;
    if (!msg) { st.hidden = true; st.textContent = ""; return; }
    st.hidden = false;
    st.textContent = msg;
  }
  async function adoptSecret(next) {
    secret = next;
    try { localStorage.setItem(SECRET_STORE, next); } catch (e) {}
    dataBasePromise = derivePath(next).then(function (p) { return "d/" + p; });
  }
  async function validateAndAdopt(next) {
    var path = "d/" + await derivePath(next);
    var res = await fetch(path + "/state.json", { cache: "no-store" });
    if (!res.ok) throw new Error("bad-key");
    var envelope = await res.json();
    await decryptJson(next, envelope);
    await adoptSecret(next);
  }
  async function savePastedLink() {
    var input = document.getElementById("keyLinkInput");
    var btn = document.getElementById("keyLinkSave");
    var raw = input ? input.value : "";
    var key = parseKeyFromLink(raw);
    if (!key) {
      setKeyUnlockStatus("That paste has no # key. Use the original full link.");
      return;
    }
    if (btn) btn.disabled = true;
    setKeyUnlockStatus("");
    try {
      await validateAndAdopt(key);
      if (input) input.value = "";
      hideKeyUnlock();
      store.offline = false;
      renderErrorBanner();
      await pull();
    } catch (e) {
      setKeyUnlockStatus("That link did not unlock the desk. Check you pasted the full original link.");
    } finally {
      if (btn) btn.disabled = false;
    }
  }
  function onForgetKey() {
    forgetStoredKey();
    secret = null;
    dataBasePromise = Promise.resolve(null);
    store.state = null;
    store.lastOkAt = null;
    store.offline = true;
    var again = readDataSecret();
    if (again) {
      adoptSecret(again).then(function () {
        store.offline = false;
        pull();
      });
      return;
    }
    document.getElementById("homeBody").hidden = true;
    showKeyUnlock();
    showTab("home");
    renderErrorBanner();
  }

  /* ---------- loop ---------- */
  async function pull() {
    try {
      await pullCore();
      if (shotMode() !== "error") store.offline = false;
      renderAll();
      await pullScreen();
      /* ready is set after applyQuery */
    } catch (err) {
      store.offline = true;
      if (!secret && !store.state) showKeyUnlock();
      else if (store.state) renderAll();
      else document.getElementById("homeSkeleton").hidden = false;
      renderErrorBanner();
      /* ready is set after applyQuery */
    }
  }

  async function applyQuery() {
    var tab = (qs().get("tab") || "home").toLowerCase();
    if (["home", "bots", "activity", "account"].indexOf(tab) >= 0) showTab(tab);
    var screen = (qs().get("screen") || "").toLowerCase();
    var mint = qs().get("mint");
    if (screen === "coin" && mint) await openCoin(mint);
    if (screen === "audit" && mint) await openAudit(mint);
    if (screen === "search") showOverlay("view-search");
  }

  if ("serviceWorker" in navigator && location.hostname !== "127.0.0.1" && location.hostname !== "localhost") {
    navigator.serviceWorker.register("sw.js").catch(function () {});
  }

  pull().then(applyQuery).then(function () { window.__APP_READY__ = true; }).catch(function () { window.__APP_READY__ = true; });
  window.addEventListener("hashchange", function () {
    var d = readHashParams().get("d");
    if (d && SECRET_RE.test(d) && d !== secret) {
      adoptSecret(d).then(function () { pull(); });
    }
  });
  setInterval(pull, PULL_MS);
  setInterval(tickRetry, 1000);
  setInterval(function () { if (store.state) pullScreen(); }, SCREEN_MS);
  window.addEventListener("resize", function () { drawRange(); });
})();
