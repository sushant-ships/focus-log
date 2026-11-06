(function () {
"use strict";

var CFG = window.FOCUSLOG_CONFIG || {};
var $ = function (id) { return document.getElementById(id); };
var DEFAULTS = {
  goal: 3.5,
  dmin: 30,
  dideal: 4,
  cats: ["School", "Arabic", "Business", "Career", "Other"],
  presets: [{ work: 25, brk: 5 }, { work: 50, brk: 10 }]
};
var K_TIMER = "focuslog.timer.v2", K_CACHE = "focuslog.cache.v2", K_PEND = "focuslog.pending.v2";
var R = 108, C = 2 * Math.PI * R;
var DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

var sb = null, user = null, appStarted = false;
var settings = clone(DEFAULTS);
var sessions = [], loaded = false, weekOffset = 0, showCount = 30;
var armed = null, armTimer = null, audioCtx = null, toastTimer = null, tickHandle = null;
var S = { phase: "idle", preset: "25/5", running: false, endAt: 0, remaining: 25 * 60000, startedAt: null, cat: "School", sound: true };

/* ---------- helpers ---------- */
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function pad(n) { return n < 10 ? "0" + n : "" + n; }
function clock(ms) { var s = Math.ceil(ms / 1000); return pad(Math.floor(s / 60)) + ":" + pad(s % 60); }
function dur(secs) { var m = Math.round(secs / 60); if (m < 60) return m + " min"; var h = Math.floor(m / 60), r = m % 60; return r ? h + "h " + r + "m" : h + "h"; }
function hm(secs) { var m = Math.round(secs / 60), h = Math.floor(m / 60), r = m % 60; return h ? (r ? h + "h " + r + "m" : h + "h") : r + "m"; }
function tm(iso) { var d = new Date(iso); return isNaN(d) ? "" : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }
function dayLabel(d) { return d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" }); }
function ymd(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
function uuid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  var b = new Uint8Array(16); crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  var h = Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join("");
  return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
}
function lsGet(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }
function label(p) { return p.work + "/" + p.brk; }
function P() {
  for (var i = 0; i < settings.presets.length; i++) if (label(settings.presets[i]) === S.preset) return settings.presets[i];
  return settings.presets[0];
}
function totalMs() { var p = P(); return (S.phase === "break" ? p.brk : p.work) * 60000; }

function toast(msg) {
  var t = $("toast"); t.textContent = msg; t.className = "show";
  clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.className = ""; }, 3200);
}
function addBanner(key, text, actions) {
  removeBanner(key);
  var box = document.createElement("div"); box.className = "banner"; box.setAttribute("data-key", key);
  var s = document.createElement("span"); s.textContent = text; box.appendChild(s);
  (actions || []).forEach(function (a) {
    var b = document.createElement("button"); b.type = "button"; b.className = "small"; b.textContent = a.label; b.addEventListener("click", a.fn); box.appendChild(b);
  });
  $("banners").appendChild(box);
}
function removeBanner(key) { var n = $("banners").querySelector('[data-key="' + key + '"]'); if (n) n.remove(); }

function ensureAudio() {
  try {
    if (!audioCtx) { var AC = window.AudioContext || window.webkitAudioContext; if (AC) audioCtx = new AC(); }
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
  } catch (e) {}
}
function bell() {
  if (!S.sound) return;
  try {
    if (!audioCtx) return;
    var t = audioCtx.currentTime;
    [0, 0.28, 0.56].forEach(function (o) {
      var osc = audioCtx.createOscillator(), g = audioCtx.createGain();
      osc.type = "sine"; osc.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, t + o);
      g.gain.exponentialRampToValueAtTime(0.25, t + o + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + o + 0.22);
      osc.connect(g); g.connect(audioCtx.destination); osc.start(t + o); osc.stop(t + o + 0.24);
    });
  } catch (e) {}
}

/* ---------- views / auth ---------- */
function show(view) {
  ["setupView", "loginView", "appView"].forEach(function (id) { $(id).hidden = (id !== view); });
}

function initAuth() {
  if (!CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY) { show("setupView"); return; }
  if (!window.supabase || !window.supabase.createClient) {
    show("loginView"); $("loginErr").textContent = "Couldn't load the sign-in library. Check your connection and reload."; return;
  }
  sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  sb.auth.onAuthStateChange(function (ev, sess) {
    setTimeout(function () {
      if (ev === "PASSWORD_RECOVERY") { recovering = true; showRecovery(); return; }
      if (!recovering) onSession(sess);
    }, 0);
  });
  sb.auth.getSession().then(function (r) { onSession(r && r.data ? r.data.session : null); }).catch(function () { onSession(null); });
}

function onSession(sess) {
  if (sess && sess.user) {
    if (user && user.id === sess.user.id && appStarted) return;
    user = sess.user;
    startApp();
  } else {
    if (!user && !appStarted) { show("loginView"); }
    else if (user) { user = null; appStarted = false; show("loginView"); }
  }
}

var signupMode = false, recovering = false;
function setMode(up) {
  signupMode = up;
  $("authBtn").textContent = up ? "Create account" : "Sign in";
  $("modeBtn").textContent = up ? "I already have an account" : "Create an account";
  $("password").setAttribute("autocomplete", up ? "new-password" : "current-password");
  $("password").placeholder = up ? "Password (8+ characters)" : "Password";
  $("authMsg").textContent = up ? "Create your account. You only do this once." : "Sign in to sync your sessions across devices.";
  $("loginErr").textContent = "";
}
function authErr(r) {
  var m = (r && r.error && r.error.message) || "";
  if (/invalid login credentials/i.test(m)) return "Wrong email or password.";
  if (/signups? not allowed|signup is disabled/i.test(m)) return "New accounts are turned off for this app.";
  if (/already registered/i.test(m)) return "That email already has an account. Sign in instead.";
  return m || "Something went wrong.";
}
function submitAuth(e) {
  e.preventDefault();
  var email = $("email").value.trim(), pw = $("password").value;
  if (!email || pw.length < 8) { $("loginErr").textContent = "Enter your email and a password of at least 8 characters."; return; }
  $("loginErr").textContent = ""; $("authBtn").disabled = true;
  var call = signupMode ? sb.auth.signUp({ email: email, password: pw, options: { emailRedirectTo: location.origin + location.pathname } })
                        : sb.auth.signInWithPassword({ email: email, password: pw });
  call.then(function (r) {
    $("authBtn").disabled = false;
    if (r.error) { $("loginErr").textContent = authErr(r); return; }
    if (signupMode && r.data && !r.data.session) {
      $("authMsg").textContent = "Account created. Check your email for a confirmation link, then come back and sign in.";
      setTimeout(function () { setMode(false); $("authMsg").textContent = "Confirm your email, then sign in here."; }, 50);
    }
  }).catch(function () { $("authBtn").disabled = false; $("loginErr").textContent = "Couldn't reach the server. Check your connection."; });
}
function forgot() {
  var email = $("email").value.trim();
  if (!email) { $("loginErr").textContent = "Type your email above first, then tap Forgot password."; return; }
  $("loginErr").textContent = "";
  sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname }).then(function (r) {
    if (r.error) { $("loginErr").textContent = authErr(r); return; }
    $("authMsg").textContent = "If that email has an account, a reset link is on its way. Open it on this device.";
  }).catch(function () { $("loginErr").textContent = "Couldn't reach the server."; });
}
function showRecovery() {
  show("loginView");
  $("authForm").hidden = true; $("authLinks").hidden = true; $("newPwForm").hidden = false;
  $("authMsg").textContent = "Choose a new password.";
  $("newPw").focus();
}
function saveNewPw(e) {
  e.preventDefault();
  var pw = $("newPw").value;
  if (pw.length < 8) { $("loginErr").textContent = "Use at least 8 characters."; return; }
  $("newPwBtn").disabled = true;
  sb.auth.updateUser({ password: pw }).then(function (r) {
    $("newPwBtn").disabled = false;
    if (r.error) { $("loginErr").textContent = authErr(r); return; }
    recovering = false;
    $("authForm").hidden = false; $("authLinks").hidden = false; $("newPwForm").hidden = true; $("newPw").value = "";
    sb.auth.getSession().then(function (s) { onSession(s && s.data ? s.data.session : null); });
    toast("Password updated");
  }).catch(function () { $("newPwBtn").disabled = false; $("loginErr").textContent = "Couldn't reach the server."; });
}
function signOut() {
  if (!sb) return;
  sb.auth.signOut().then(function () {
    lsDel(K_CACHE); lsDel(K_PEND); sessions = []; loaded = false; settings = clone(DEFAULTS);
    user = null; appStarted = false; show("loginView");
  });
}

/* ---------- data ---------- */
function rowToSession(r) {
  return { id: r.id, startedAt: r.started_at, endedAt: r.ended_at, seconds: r.seconds, category: r.category, note: r.note || "", preset: r.preset || "", completed: r.completed !== false };
}
function sessionToRow(s) {
  return { id: s.id, started_at: s.startedAt, ended_at: s.endedAt, seconds: s.seconds, category: s.category, note: s.note || "", preset: s.preset || "", completed: s.completed !== false };
}
function sortSessions() { sessions.sort(function (a, b) { return Date.parse(b.startedAt) - Date.parse(a.startedAt); }); }
function cacheNow() { if (user) lsSet(K_CACHE, { uid: user.id, sessions: sessions, settings: settings }); }
function pendingList() { var p = lsGet(K_PEND); return (p && p.uid === (user && user.id) && p.items) ? p.items : []; }
function setPending(items) { if (items.length) lsSet(K_PEND, { uid: user.id, items: items }); else lsDel(K_PEND); updatePendingBanner(); }
function updatePendingBanner() {
  var n = pendingList().length;
  if (n) addBanner("pending", n + " session" + (n > 1 ? "s" : "") + " not synced yet. They are safe on this device.", [{ label: "Sync now", fn: flushPending }]);
  else removeBanner("pending");
}
function flushPending() {
  var items = pendingList(); if (!items.length || !sb || !user) return;
  sb.from("sessions").upsert(items.map(sessionToRow)).then(function (r) {
    if (r.error) { toast("Still can't sync (" + r.error.message + ")"); return; }
    setPending([]); toast("Synced " + items.length + " session" + (items.length > 1 ? "s" : ""));
  }).catch(function () { toast("Still offline. Will retry."); });
}

function startApp() {
  appStarted = true;
  show("appView");
  $("who").textContent = user.email || "";
  var cache = lsGet(K_CACHE);
  if (cache && cache.uid === user.id) {
    sessions = cache.sessions || []; if (cache.settings) mergeSettings(cache.settings);
    loaded = true;
  } else { sessions = []; loaded = false; }
  restoreTimer();
  buildAll();
  updatePendingBanner();
  fetchRemote();
}
function mergeSettings(s) {
  if (typeof s.goal === "number" && s.goal > 0) settings.goal = s.goal;
  if (Array.isArray(s.cats) && s.cats.length) settings.cats = s.cats;
  if (Array.isArray(s.presets) && s.presets.length) settings.presets = s.presets;
  if (typeof s.dmin === "number" && s.dmin > 0) settings.dmin = s.dmin;
  if (typeof s.dideal === "number" && s.dideal > 0) settings.dideal = s.dideal;
}
function fetchRemote() {
  if (!sb || !user) return;
  var slow = setTimeout(function () { if (!loaded) addBanner("slow", "Loading is taking a while. The timer works in the meantime.", []); }, 10000);
  Promise.all([
    sb.from("sessions").select("*").order("started_at", { ascending: false }).limit(5000),
    sb.from("user_settings").select("*").maybeSingle()
  ]).then(function (res) {
    clearTimeout(slow); removeBanner("slow");
    var a = res[0], b = res[1];
    if (a.error) { addBanner("loaderr", "Couldn't load sessions (" + a.error.message + "). Showing saved copy.", [{ label: "Retry", fn: function () { removeBanner("loaderr"); fetchRemote(); } }]); loaded = true; renderAll(); saveRecovered(); return; }
    removeBanner("loaderr");
    var remote = a.data.map(rowToSession);
    var ids = {}; remote.forEach(function (s) { ids[s.id] = 1; });
    pendingList().forEach(function (s) { if (!ids[s.id]) remote.push(s); });
    sessions = remote; sortSessions();
    if (b && !b.error && b.data) {
      mergeSettings({ goal: Number(b.data.goal_hours), dmin: Number(b.data.daily_min_minutes), dideal: Number(b.data.daily_ideal_hours), cats: b.data.categories, presets: b.data.presets });
      buildSettings(); buildTimerChoices();
    }
    loaded = true; cacheNow(); renderAll(); renderTimer(); flushPending(); saveRecovered();
  }).catch(function () {
    clearTimeout(slow); removeBanner("slow"); loaded = true;
    addBanner("offline", "Offline. Showing your saved copy.", []); renderAll(); saveRecovered();
  });
}

function saveSession(s) {
  s.id = uuid();
  sessions.push(s); sortSessions(); cacheNow(); renderAll();
  if (!sb || !user) return;
  sb.from("sessions").upsert(sessionToRow(s)).then(function (r) {
    if (r.error) throw r.error;
    toast("Saved " + dur(s.seconds) + " of " + s.category.toLowerCase());
  }).catch(function () {
    setPending(pendingList().concat([s]));
    toast("Saved on this device. Will sync when online.");
  });
}
function deleteSession(id) {
  var idx = -1; sessions.forEach(function (s, i) { if (s.id === id) idx = i; });
  if (idx < 0) return;
  var gone = sessions.splice(idx, 1)[0];
  cacheNow(); renderAll();
  var pend = pendingList();
  if (pend.some(function (s) { return s.id === id; })) { setPending(pend.filter(function (s) { return s.id !== id; })); toast("Session deleted"); return; }
  sb.from("sessions").delete().eq("id", id).then(function (r) {
    if (r.error) throw r.error;
    toast("Session deleted");
  }).catch(function () {
    sessions.push(gone); sortSessions(); cacheNow(); renderAll(); toast("Couldn't delete. Check your connection.");
  });
}
function saveSettings() {
  cacheNow();
  if (!sb || !user) return;
  sb.from("user_settings").upsert({ user_id: user.id, goal_hours: settings.goal, daily_min_minutes: settings.dmin, daily_ideal_hours: settings.dideal, categories: settings.cats, presets: settings.presets, updated_at: new Date().toISOString() }).then(function (r) {
    if (r.error) toast("Couldn't sync settings (" + r.error.message + ")");
  }).catch(function () { toast("Settings saved on this device only for now."); });
}

function saveRecovered() {
  if (!pendingRecovery) return;
  var rec = pendingRecovery; pendingRecovery = null;
  if (sessions.some(function (s) { return s.startedAt === rec.startedAt; })) return;
  saveSession(rec);
  addBanner("recovered", "Saved a " + dur(rec.seconds) + " session that finished at " + tm(rec.endedAt) + " while the app was closed.", [{ label: "OK", fn: function () { removeBanner("recovered"); } }]);
}

/* ---------- timer ---------- */
function persistTimer() {
  lsSet(K_TIMER, { uid: user && user.id, phase: S.phase, preset: S.preset, running: S.running, endAt: S.endAt, remaining: S.remaining, startedAt: S.startedAt, pausedAt: S.pausedAt || null, cat: S.cat, sound: S.sound, note: $("note").value });
}
var AUTO_STOP_MS = 15 * 60000, pendingRecovery = null;
function toIdle() { S.phase = "idle"; S.running = false; S.remaining = P().work * 60000; S.startedAt = null; S.pausedAt = null; }

function renderTimer() {
  var rem = S.running ? Math.max(0, S.endAt - Date.now()) : S.remaining;
  var total = totalMs();
  $("clock").textContent = clock(rem);
  $("ring").style.strokeDasharray = String(C);
  $("ring").style.strokeDashoffset = String(C * (1 - (total ? rem / total : 1)));
  $("timer").setAttribute("data-phase", S.phase);
  $("phase").textContent = S.phase === "idle" ? "Ready" : S.phase === "break" ? "Break" : (S.running ? "Focus" : "Paused");
  if (pipWin) {
    var pd = pipWin.document;
    pd.getElementById("pc").textContent = clock(rem);
    pd.getElementById("pp").textContent = $("phase").textContent;
    pd.getElementById("pb").textContent = $("main").textContent;
    pd.body.setAttribute("data-phase", S.phase);
  }
  if ($("focusLabel")) $("focusLabel").textContent = S.cat + ($("note").value.trim() ? "  \u00b7  " + $("note").value.trim() : "");
  document.title = S.running ? clock(rem) + " " + (S.phase === "work" ? "Focus" : "Break") + " | Focus Log" : "Focus Log";
}
function renderControls() {
  var main = $("main"), stop = $("stop"), disc = $("discard");
  if (S.phase === "idle") { main.textContent = "Start"; stop.hidden = true; disc.hidden = true; }
  else if (S.phase === "work") { main.textContent = S.running ? "Pause" : "Resume"; stop.hidden = false; disc.hidden = S.running; }
  else { main.textContent = "Skip break"; stop.hidden = true; disc.hidden = true; }
  var locked = S.phase !== "idle";
  document.querySelectorAll('input[name="preset"]').forEach(function (r) { r.disabled = locked; r.checked = (r.value === S.preset); });
  disc.textContent = "Discard";
}
function makeRec(seconds, endedISO, completed) {
  return { startedAt: S.startedAt, endedAt: endedISO, seconds: seconds, category: S.cat, note: $("note").value.trim().slice(0, 200), preset: label(P()), completed: completed };
}
function mainClick() {
  if (S.phase === "idle") {
    ensureAudio();
    S.phase = "work"; S.remaining = P().work * 60000; S.startedAt = new Date().toISOString();
    S.running = true; S.endAt = Date.now() + S.remaining;
  } else if (S.phase === "work") {
    ensureAudio();
    if (S.running) { S.remaining = Math.max(0, S.endAt - Date.now()); S.running = false; S.pausedAt = Date.now(); }
    else { S.running = true; S.endAt = Date.now() + S.remaining; S.pausedAt = null; }
  } else { toIdle(); }
  persistTimer(); renderControls(); renderTimer();
}
function stopSave(endISO, auto) {
  if (S.phase !== "work") return;
  var rem = S.running ? Math.max(0, S.endAt - Date.now()) : S.remaining;
  var workMs = P().work * 60000 - rem;
  var end = typeof endISO === "string" ? endISO : new Date().toISOString();
  if (workMs >= 60000) {
    saveSession(makeRec(Math.round(workMs / 1000), end, false));
    if (auto) addBanner("autostop", "You were paused for 15 minutes, so your " + dur(workMs / 1000) + " session was saved and the timer stopped.", [{ label: "OK", fn: function () { removeBanner("autostop"); } }]);
  } else if (!auto) toast("Under 1 minute, so nothing was saved.");
  toIdle(); persistTimer(); renderControls(); renderTimer();
}
function discardClick() {
  if (armed !== "discard") {
    armed = "discard"; $("discard").textContent = "Tap again to discard";
    clearTimeout(armTimer); armTimer = setTimeout(function () { armed = null; $("discard").textContent = "Discard"; }, 4000);
    return;
  }
  armed = null; clearTimeout(armTimer);
  toIdle(); persistTimer(); renderControls(); renderTimer();
}
function phaseDone() {
  if (S.phase === "work") {
    var p = P();
    saveSession(makeRec(p.work * 60, new Date(S.endAt).toISOString(), true));
    bell();
    if (p.brk > 0) { S.phase = "break"; S.remaining = p.brk * 60000; S.endAt = S.endAt + S.remaining; S.running = true; S.startedAt = null; }
    else toIdle();
  } else { bell(); toIdle(); }
  persistTimer(); renderControls(); renderTimer();
}
function tick() {
  if (S.running && Date.now() >= S.endAt) phaseDone();
  else if (S.phase === "work" && !S.running && S.pausedAt && Date.now() - S.pausedAt >= AUTO_STOP_MS) stopSave(new Date(S.pausedAt).toISOString(), true);
  renderTimer();
}
function restoreTimer() {
  var o = lsGet(K_TIMER); if (!o || o.uid !== (user && user.id)) return;
  if (typeof o.sound === "boolean") S.sound = o.sound;
  if (typeof o.note === "string") $("note").value = o.note;
  if (o.preset) S.preset = o.preset;
  if (o.cat) S.cat = o.cat;
}
function resumeRunning() {
  var o = lsGet(K_TIMER); if (!o || o.uid !== (user && user.id)) return;
  var now = Date.now(), p = P();
  S.remaining = p.work * 60000;
  if (o.phase === "work" && o.startedAt) {
    if (o.running && isFinite(o.endAt)) {
      if (o.endAt > now) { S.phase = "work"; S.running = true; S.endAt = o.endAt; S.startedAt = o.startedAt; S.remaining = o.endAt - now; }
      else {
        var rec = { startedAt: o.startedAt, endedAt: new Date(o.endAt).toISOString(), seconds: p.work * 60, category: S.cat, note: (o.note || "").trim().slice(0, 200), preset: label(p), completed: true };
        pendingRecovery = rec;
        toIdle(); persistTimer();
      }
    } else if (isFinite(o.remaining)) {
      S.phase = "work"; S.running = false; S.remaining = Math.min(Math.max(0, o.remaining), p.work * 60000); S.startedAt = o.startedAt; S.pausedAt = o.pausedAt || Date.now();
    }
  } else if (o.phase === "break" && o.running && o.endAt > now) {
    S.phase = "break"; S.running = true; S.endAt = o.endAt; S.remaining = o.endAt - now;
  }
}

/* ---------- derived views ---------- */
function weekStart(offset) {
  var d = new Date(); d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + 7 * offset);
  return d;
}
function weekSessions(offset) {
  var ws = weekStart(offset), we = new Date(ws); we.setDate(we.getDate() + 7);
  return sessions.filter(function (s) { var d = new Date(Date.parse(s.startedAt)); return d >= ws && d < we; });
}
function dayTotals() {
  var m = {}, first = null;
  sessions.forEach(function (s) {
    var d = new Date(Date.parse(s.startedAt)); if (isNaN(d)) return;
    var k = ymd(d); m[k] = (m[k] || 0) + (s.seconds || 0);
    if (!first || d < first) first = d;
  });
  if (first) first.setHours(0, 0, 0, 0);
  return { map: m, first: first };
}
function streakDays(t) {
  var min = settings.dmin * 60, d = new Date(); d.setHours(0, 0, 0, 0);
  if ((t.map[ymd(d)] || 0) < min) d.setDate(d.getDate() - 1);
  var n = 0;
  while ((t.map[ymd(d)] || 0) >= min) { n++; d.setDate(d.getDate() - 1); }
  return n;
}
function renderDaily(t) {
  var min = settings.dmin * 60, ideal = settings.dideal * 3600;
  var secs = t.map[ymd(new Date())] || 0;
  var bar = $("dbar");
  bar.className = "dbar" + (secs >= ideal ? " ideal" : secs >= min ? " hit" : "");
  $("dfill").style.width = Math.min(100, secs / ideal * 100) + "%";
  $("dminMark").style.left = "calc(" + Math.min(100, min / ideal * 100) + "% - 1px)";
  var msg;
  if (!secs) msg = "Nothing yet. " + hm(min) + " gets today's minimum.";
  else if (secs < min) msg = hm(secs) + " so far. " + hm(min - secs) + " to your " + hm(min) + " minimum.";
  else if (secs < ideal) msg = hm(secs) + ". Minimum done. " + hm(ideal - secs) + " to your " + hm(ideal) + " ideal.";
  else msg = hm(secs) + ". Ideal day hit.";
  $("today").textContent = msg;
  var st = streakDays(t), el = $("streak");
  el.textContent = st ? st + " day streak" : "No streak yet";
  el.className = "streak" + (st ? " on" : "");
}
function renderWeek() {
  var ws = weekStart(weekOffset), we = new Date(ws); we.setDate(we.getDate() + 7);
  var last = new Date(we); last.setDate(last.getDate() - 1);
  var now = new Date(), todayIdx = (now.getDay() + 6) % 7;
  var days = [0, 0, 0, 0, 0, 0, 0], cats = {}, todaySecs = 0, todayN = 0;
  sessions.forEach(function (s) {
    var d = new Date(Date.parse(s.startedAt)); if (isNaN(d)) return;
    var secs = s.seconds || 0;
    if (d >= ws && d < we) { var i = (d.getDay() + 6) % 7; days[i] += secs; cats[s.category || "Other"] = (cats[s.category || "Other"] || 0) + secs; }
    if (d.toDateString() === now.toDateString()) { todaySecs += secs; todayN++; }
  });
  var total = days.reduce(function (a, b) { return a + b; }, 0), goal = settings.goal * 3600;
  $("weektitle").textContent = weekOffset === 0 ? "This week" : weekOffset === -1 ? "Last week" : "Week of " + ws.toLocaleDateString([], { month: "short", day: "numeric" });
  $("range").textContent = ws.toLocaleDateString([], { month: "short", day: "numeric" }) + " to " + last.toLocaleDateString([], { month: "short", day: "numeric" });
  $("nextWeek").disabled = weekOffset >= 0;
  var wt = $("weektotal"); wt.textContent = hm(total) + " ";
  var sm = document.createElement("small"); sm.textContent = "of " + hm(goal); wt.appendChild(sm);
  $("weekbar").style.width = Math.min(100, goal ? total / goal * 100 : 0) + "%";
  $("weekstatus").textContent = !loaded ? "Loading your sessions." :
    total >= goal ? "Goal reached. " + hm(total - goal) + " extra." : hm(goal - total) + " to go" + (weekOffset === 0 ? " this week." : ".");
  var tot = dayTotals();
  var scale = Math.max(Math.max.apply(null, days), 3600);
  var box = $("days"); box.textContent = "";
  days.forEach(function (secs, i) {
    var dayDate = new Date(ws); dayDate.setDate(ws.getDate() + i);
    var isToday = dayDate.toDateString() === now.toDateString();
    var past = dayDate < new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var tracked = tot.first && dayDate >= tot.first;
    var cls = "";
    if (secs >= settings.dideal * 3600) cls = " ideal";
    else if (secs >= settings.dmin * 60) cls = " hit";
    else if (past && tracked) cls = " miss";
    else if (secs) cls = " part";
    var d = document.createElement("div"); d.className = "day" + cls + (isToday ? " today" : "");
    d.title = DAY_NAMES[i] + ": " + (secs ? hm(secs) : "nothing logged") + (cls === " miss" ? " (under minimum)" : "");
    var v = document.createElement("div"); v.className = "dval"; v.textContent = secs ? hm(secs) : (cls === " miss" ? "0m" : "");
    var col = document.createElement("div"); col.className = "col"; var bar = document.createElement("div"); bar.style.height = Math.max(cls === " miss" ? 6 : 3, secs / scale * 84) + "px"; col.appendChild(bar);
    var n = document.createElement("div"); n.className = "dname"; n.textContent = DAY_NAMES[i];
    d.appendChild(v); d.appendChild(col); d.appendChild(n); box.appendChild(d);
  });
  var names = Object.keys(cats).sort(function (a, b) { return cats[b] - cats[a]; });
  $("weekcats").textContent = names.length ? names.map(function (k) { return k + " " + hm(cats[k]); }).join("  |  ") : "";
  renderDaily(tot);
}

function renderHistory() {
  var box = $("list"); box.textContent = "";
  $("count").textContent = sessions.length ? sessions.length + " saved" : "";
  $("more").hidden = sessions.length <= showCount;
  if (!sessions.length) {
    var e = document.createElement("p"); e.className = "empty";
    e.textContent = loaded ? "No sessions yet. Pick a preset, choose a category, and press Start. Finished sessions show up here with their start and end times." : "Loading your sessions.";
    box.appendChild(e); return;
  }
  var totals = {};
  sessions.forEach(function (s) { var d = new Date(Date.parse(s.startedAt)); if (isNaN(d)) return; var k = d.toDateString(); totals[k] = (totals[k] || 0) + (s.seconds || 0); });
  var curKey = null;
  sessions.slice(0, showCount).forEach(function (s) {
    var d = new Date(Date.parse(s.startedAt)); if (isNaN(d)) return;
    var k = d.toDateString();
    if (k !== curKey) {
      curKey = k;
      var h = document.createElement("div"); h.className = "dayhead";
      var a = document.createElement("span"); a.textContent = dayLabel(d);
      var b = document.createElement("span"); b.textContent = hm(totals[k]);
      h.appendChild(a); h.appendChild(b); box.appendChild(h);
    }
    var r = document.createElement("div"); r.className = "row";
    var t = document.createElement("div"); t.className = "t"; t.textContent = tm(s.startedAt) + " to " + tm(s.endedAt);
    var du = document.createElement("div"); du.className = "d"; du.appendChild(document.createTextNode(dur(s.seconds || 0)));
    if (s.completed === false) { var em = document.createElement("em"); em.textContent = " (stopped early)"; du.appendChild(em); }
    var tag = document.createElement("div"); tag.className = "tag"; tag.textContent = s.category || "";
    var n = document.createElement("div"); n.className = "n"; n.textContent = s.note || "";
    var del = document.createElement("button"); del.type = "button"; del.className = "del" + (armed === s.id ? " armed" : "");
    del.textContent = armed === s.id ? "Tap to delete" : "Delete";
    del.addEventListener("click", function () { onDelete(s.id); });
    r.appendChild(t); r.appendChild(du); r.appendChild(tag); r.appendChild(n); r.appendChild(del);
    box.appendChild(r);
  });
}
function onDelete(id) {
  if (armed !== id) {
    armed = id; clearTimeout(armTimer); armTimer = setTimeout(function () { armed = null; renderHistory(); }, 4000);
    renderHistory(); return;
  }
  armed = null; clearTimeout(armTimer);
  deleteSession(id);
}
function renderAll() { renderWeek(); renderHistory(); }

/* ---------- timer choices + settings UI ---------- */
function buildTimerChoices() {
  if (!settings.cats.length) settings.cats = clone(DEFAULTS.cats);
  if (settings.cats.indexOf(S.cat) < 0) S.cat = settings.cats[0];
  var labels = settings.presets.map(label);
  if (labels.indexOf(S.preset) < 0) { S.preset = labels[0]; if (S.phase === "idle") S.remaining = P().work * 60000; }

  var pb = $("presets"); pb.textContent = "";
  settings.presets.forEach(function (p, i) {
    var inp = document.createElement("input"); inp.type = "radio"; inp.name = "preset"; inp.id = "pr" + i; inp.value = label(p);
    var lab = document.createElement("label"); lab.htmlFor = "pr" + i; lab.textContent = label(p);
    inp.addEventListener("change", function () {
      if (S.phase !== "idle") { renderControls(); return; }
      S.preset = inp.value; S.remaining = P().work * 60000; persistTimer(); renderTimer();
    });
    pb.appendChild(inp); pb.appendChild(lab);
  });

  var cb = $("cats"); cb.textContent = "";
  settings.cats.forEach(function (c, i) {
    var inp = document.createElement("input"); inp.type = "radio"; inp.name = "cat"; inp.id = "cat" + i; inp.value = c; inp.checked = (c === S.cat);
    var lab = document.createElement("label"); lab.htmlFor = "cat" + i; lab.textContent = c;
    inp.addEventListener("change", function () { S.cat = c; persistTimer(); });
    cb.appendChild(inp); cb.appendChild(lab);
  });

  var mc = $("mCat"); mc.textContent = "";
  settings.cats.forEach(function (c) { var o = document.createElement("option"); o.value = c; o.textContent = c; mc.appendChild(o); });
  renderControls();
}
function chip(text, onRemove, canRemove) {
  var s = document.createElement("span"); s.className = "tag-chip"; s.appendChild(document.createTextNode(text));
  if (canRemove) {
    var b = document.createElement("button"); b.type = "button"; b.setAttribute("aria-label", "Remove " + text); b.textContent = "×"; b.addEventListener("click", onRemove); s.appendChild(b);
  }
  return s;
}
function buildSettings() {
  if (document.activeElement !== $("goal")) $("goal").value = settings.goal;
  if (document.activeElement !== $("dmin")) $("dmin").value = settings.dmin;
  if (document.activeElement !== $("dideal")) $("dideal").value = settings.dideal;
  var ct = $("catTags"); ct.textContent = "";
  settings.cats.forEach(function (c, i) {
    ct.appendChild(chip(c, function () { settings.cats.splice(i, 1); afterSettingsChange(); }, settings.cats.length > 1));
  });
  var pt = $("presetTags"); pt.textContent = "";
  settings.presets.forEach(function (p, i) {
    pt.appendChild(chip(label(p) + " min", function () { settings.presets.splice(i, 1); afterSettingsChange(); }, settings.presets.length > 1));
  });
}
function afterSettingsChange() {
  buildSettings(); buildTimerChoices(); renderAll(); renderTimer(); saveSettings();
}

/* ---------- CSV ---------- */
function csvCell(v) {
  var s = String(v == null ? "" : v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function exportCsv(list, name) {
  if (!list.length) { toast("Nothing to export for that range."); return; }
  var rows = [["Date", "Start", "End", "Minutes", "Category", "Preset", "Note", "Finished"]];
  list.slice().sort(function (a, b) { return Date.parse(a.startedAt) - Date.parse(b.startedAt); }).forEach(function (s) {
    var a = new Date(Date.parse(s.startedAt)), b = new Date(Date.parse(s.endedAt));
    rows.push([ymd(a), pad(a.getHours()) + ":" + pad(a.getMinutes()), pad(b.getHours()) + ":" + pad(b.getMinutes()), Math.round(s.seconds / 6) / 10, s.category, s.preset, s.note, s.completed === false ? "no" : "yes"]);
  });
  var text = "﻿" + rows.map(function (r) { return r.map(csvCell).join(","); }).join("\r\n");
  var url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  var a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  toast("Exported " + list.length + " session" + (list.length > 1 ? "s" : ""));
}

/* ---------- focus mode + pop out ---------- */
var wakeLock = null, pipWin = null;
function keepAwake(on) {
  try {
    if (on && !wakeLock && navigator.wakeLock) navigator.wakeLock.request("screen").then(function (l) { wakeLock = l; l.addEventListener("release", function () { wakeLock = null; }); }).catch(function () {});
    if (!on && wakeLock) { wakeLock.release().catch(function () {}); wakeLock = null; }
  } catch (e) {}
}
function inFocus() { return document.body.classList.contains("focusmode"); }
function enterFocus() {
  document.body.classList.add("focusmode");
  keepAwake(true); renderTimer();
  try { var r = document.documentElement.requestFullscreen && document.documentElement.requestFullscreen(); if (r && r.catch) r.catch(function () {}); } catch (e) {}
}
function exitFocus() {
  document.body.classList.remove("focusmode");
  keepAwake(false);
  try { if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(function () {}); } catch (e) {}
}
function popOut() {
  if (!window.documentPictureInPicture) return;
  if (pipWin) { try { pipWin.focus(); } catch (e) {} return; }
  ensureAudio();
  window.documentPictureInPicture.requestWindow({ width: 240, height: 200 }).then(function (w) {
    pipWin = w;
    var cs = getComputedStyle(document.documentElement), v = function (n) { return cs.getPropertyValue(n).trim(); };
    var st = w.document.createElement("style");
    st.textContent = "body{margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;background:" + v("--bg") + ";color:" + v("--ink") + ";font-family:'DM Mono',ui-monospace,Menlo,monospace}" +
      "#pc{font-size:44px;font-weight:500;font-variant-numeric:tabular-nums}#pp{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:" + v("--accent") + "}" +
      "body[data-phase=break] #pp{color:" + v("--break") + "}#pb{margin-top:8px;font:600 14px system-ui,sans-serif;padding:8px 18px;border-radius:9px;border:0;cursor:pointer;background:" + v("--accent") + ";color:" + v("--accent-ink") + "}" +
      "body[data-phase=break] #pb{background:" + v("--break") + "}";
    w.document.head.appendChild(st);
    w.document.body.innerHTML = '<div id="pc"></div><div id="pp"></div><button id="pb" type="button"></button>';
    w.document.getElementById("pb").addEventListener("click", mainClick);
    w.addEventListener("pagehide", function () { pipWin = null; });
    renderTimer();
  }).catch(function () { toast("Couldn't open the pop-out window."); });
}

/* ---------- buildAll + wiring ---------- */
function buildAll() {
  buildSettings(); buildTimerChoices(); resumeRunning();
  $("sound").checked = S.sound;
  var now = new Date();
  if (!$("mDate").value) $("mDate").value = ymd(now);
  renderControls(); renderTimer(); renderAll();
  if (!tickHandle) tickHandle = setInterval(tick, 250);
}

function wire() {
  $("focusBtn").addEventListener("click", enterFocus);
  $("exitFocus").addEventListener("click", exitFocus);
  if (window.documentPictureInPicture) { $("popBtn").hidden = false; $("popBtn").addEventListener("click", popOut); }
  document.addEventListener("fullscreenchange", function () { if (!document.fullscreenElement && inFocus()) exitFocus(); });
  document.addEventListener("keydown", function (e) {
    if (!appStarted || $("appView").hidden) return;
    var t = e.target, tag = t && t.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (t && t.isContentEditable)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "Escape" && inFocus()) { exitFocus(); }
    else if (e.key === "f" || e.key === "F") { e.preventDefault(); inFocus() ? exitFocus() : enterFocus(); }
    else if (e.key === " " && (!t || tag !== "BUTTON")) { e.preventDefault(); mainClick(); }
  });
  $("authForm").addEventListener("submit", submitAuth);
  $("newPwForm").addEventListener("submit", saveNewPw);
  $("modeBtn").addEventListener("click", function () { setMode(!signupMode); });
  $("forgotBtn").addEventListener("click", forgot);
  $("signout").addEventListener("click", signOut);
  $("sound").addEventListener("change", function () { S.sound = this.checked; persistTimer(); if (S.sound) ensureAudio(); });
  $("note").addEventListener("input", persistTimer);
  $("main").addEventListener("click", mainClick);
  $("stop").addEventListener("click", stopSave);
  $("discard").addEventListener("click", discardClick);
  $("prevWeek").addEventListener("click", function () { weekOffset--; renderWeek(); });
  $("nextWeek").addEventListener("click", function () { if (weekOffset < 0) { weekOffset++; renderWeek(); } });
  $("more").addEventListener("click", function () { showCount += 60; renderHistory(); });
  $("exportWeek").addEventListener("click", function () {
    var ws = weekStart(weekOffset);
    exportCsv(weekSessions(weekOffset), "focus-log-week-" + ymd(ws) + ".csv");
  });
  $("exportAll").addEventListener("click", function () { exportCsv(sessions, "focus-log-all-" + ymd(new Date()) + ".csv"); });

  $("dmin").addEventListener("change", function () {
    var v = parseInt(this.value, 10);
    if (!(v >= 5 && v <= 600)) { this.value = settings.dmin; return; }
    if (v === settings.dmin) return;
    settings.dmin = v; renderWeek(); saveSettings();
  });
  $("dideal").addEventListener("change", function () {
    var v = parseFloat(this.value);
    if (!(v >= 0.5 && v <= 16)) { this.value = settings.dideal; return; }
    if (v === settings.dideal) return;
    settings.dideal = v; renderWeek(); saveSettings();
  });
  $("goal").addEventListener("change", function () {
    var v = parseFloat(this.value);
    if (!(v > 0) || v > 100) { this.value = settings.goal; return; }
    if (v === settings.goal) return;
    settings.goal = v; renderWeek(); saveSettings();
  });
  $("addCat").addEventListener("click", function () {
    var v = $("newCat").value.trim().slice(0, 24);
    if (!v) return;
    if (settings.cats.some(function (c) { return c.toLowerCase() === v.toLowerCase(); })) { toast("That category already exists."); return; }
    settings.cats.push(v); $("newCat").value = ""; afterSettingsChange();
  });
  $("newCat").addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); $("addCat").click(); } });
  $("addPreset").addEventListener("click", function () {
    var w = parseInt($("newWork").value, 10), b = parseInt($("newBreak").value, 10);
    if (!(w >= 1 && w <= 180) || !(b >= 0 && b <= 60)) { toast("Work 1 to 180 minutes, break 0 to 60."); return; }
    if (settings.presets.some(function (p) { return p.work === w && p.brk === b; })) { toast("That preset already exists."); return; }
    settings.presets.push({ work: w, brk: b }); $("newWork").value = ""; $("newBreak").value = ""; afterSettingsChange();
  });

  $("manual").addEventListener("toggle", function () {
    if (!this.open) return;
    var d = new Date(Date.now() - 25 * 60000);
    if (!$("mDate").value) $("mDate").value = ymd(d);
    if (!$("mTime").value) $("mTime").value = pad(d.getHours()) + ":" + pad(d.getMinutes());
    if (!$("mMin").value) $("mMin").value = 25;
  });
  $("manualForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var d = $("mDate").value, t = $("mTime").value, m = parseInt($("mMin").value, 10);
    if (!d || !t || !(m >= 1 && m <= 720)) { toast("Fill in date, start time and minutes."); return; }
    var start = new Date(d + "T" + t);
    if (isNaN(start)) { toast("That date or time isn't valid."); return; }
    var end = new Date(start.getTime() + m * 60000);
    saveSession({ startedAt: start.toISOString(), endedAt: end.toISOString(), seconds: m * 60, category: $("mCat").value, note: $("mNote").value.trim().slice(0, 200), preset: "manual", completed: true });
    $("mMin").value = ""; $("mNote").value = "";
  });

  document.addEventListener("visibilitychange", function () { if (!document.hidden && appStarted) tick(); });
  window.addEventListener("online", function () { if (appStarted) { removeBanner("offline"); flushPending(); } });
}

wire();
initAuth();
})();
