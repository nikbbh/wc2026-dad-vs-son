// ---------------------------------------------------------------------------
// Store: app state, localStorage persistence, Supabase sync, ESPN live data.
// ---------------------------------------------------------------------------
"use strict";

const USERS = ["dad", "son"];
const USER_META = {
  dad: { name: "Dad", emoji: "👨", color: "#3b82f6" },
  son: { name: "Son", emoji: "👦", color: "#f59e0b" },
};

// Synced state. Each section keyed per user maps to one Supabase kv row, so
// devices editing different profiles never clash.
const State = {
  pred: { dad: {}, son: {} },     // matchId -> 'H'|'D'|'A' (group) | teamId (KO)
  bank: { dad: {}, son: {} },     // roundKey -> matchId
  quals: { dad: {}, son: {} },    // group letter -> [teamId, teamId]
  bonus: { dad: {}, son: {} },    // {champion, topscorer, tsCorrect}
  pins: {},                       // user -> pin (4 digits, honor-system)
  overrides: {},                  // matchId -> {hs, as, pens, winnerId}
};

const Local = {
  get profile() { return localStorage.getItem("wc.profile") || ""; },
  set profile(v) { localStorage.setItem("wc.profile", v); },
  get unlocked() { return JSON.parse(localStorage.getItem("wc.unlocked") || "{}"); },
  unlock(u) { const x = Local.unlocked; x[u] = true; localStorage.setItem("wc.unlocked", JSON.stringify(x)); },
};

let SCHEDULE = [];      // static schedule, enriched with live data
let TEAMS = {};         // teamId -> team
let LIVE = {};          // matchId -> live info from ESPN
let onChange = () => {};
let syncStatus = "local"; // local | ok | error | syncing

// ---- persistence helpers ---------------------------------------------------

function saveLocalState() {
  localStorage.setItem("wc.state", JSON.stringify(State));
}
function loadLocalState() {
  try {
    const s = JSON.parse(localStorage.getItem("wc.state") || "null");
    if (s) for (const k of Object.keys(State)) if (s[k]) State[k] = s[k];
  } catch (e) { /* corrupted cache: start fresh */ }
}

// ---- Supabase kv sync -------------------------------------------------------
// Table: kv(key text primary key, value jsonb, updated_at timestamptz)

const KV_KEYS = () => {
  const keys = { pins: "pins", overrides: "overrides" };
  for (const u of USERS) for (const s of ["pred", "bank", "quals", "bonus"]) keys[`${s}.${u}`] = `${s}:${u}`;
  return keys;
};

function sbConfigured() {
  return !!(WC_CONFIG.supabaseUrl && WC_CONFIG.supabaseKey);
}

async function sbFetch(path, opts = {}) {
  const headers = {
    apikey: WC_CONFIG.supabaseKey,
    Authorization: "Bearer " + WC_CONFIG.supabaseKey,
    "Content-Type": "application/json",
    ...(opts.headers || {}),
  };
  const res = await fetch(WC_CONFIG.supabaseUrl + "/rest/v1/" + path, { ...opts, headers });
  if (!res.ok) throw new Error("supabase " + res.status);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function pullRemote() {
  if (!sbConfigured()) return;
  const rows = await sbFetch("kv?select=key,value");
  const byKey = Object.fromEntries(rows.map(r => [r.key, r.value]));
  for (const [local, remote] of Object.entries(KV_KEYS())) {
    const v = byKey[remote];
    if (v == null) continue;
    const [section, user] = local.split(".");
    if (user) State[section][user] = v; else State[section] = v;
  }
  saveLocalState();
}

const pushQueue = new Set();
let pushTimer = null;
function queuePush(localKey) {
  saveLocalState();
  if (!sbConfigured()) { onChange(); return; }
  pushQueue.add(localKey);
  clearTimeout(pushTimer);
  pushTimer = setTimeout(flushPush, 400);
  onChange();
}
async function flushPush() {
  const keys = [...pushQueue]; pushQueue.clear();
  const mapping = KV_KEYS();
  const rows = keys.map(k => {
    const [section, user] = k.split(".");
    return { key: mapping[k], value: user ? State[section][user] : State[section], updated_at: new Date().toISOString() };
  });
  try {
    setSync("syncing");
    await sbFetch("kv?on_conflict=key", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify(rows),
    });
    setSync("ok");
  } catch (e) {
    setSync("error");
    keys.forEach(k => pushQueue.add(k));   // retry on next sync tick
  }
}

function setSync(s) { syncStatus = s; onChange(); }

// ---- live results from ESPN -------------------------------------------------

function applyLiveEvent(e) {
  try {
    const c = e.competitions[0];
    const comps = { home: null, away: null };
    for (const x of c.competitors) comps[x.homeAway] = x;
    const info = {
      state: c.status.type.state,                    // pre | in | post
      detail: c.status.type.shortDetail || c.status.type.detail || "",
      hs: comps.home.score != null ? +comps.home.score : null,
      as: comps.away.score != null ? +comps.away.score : null,
      hShoot: comps.home.shootoutScore != null ? +comps.home.shootoutScore : null,
      aShoot: comps.away.shootoutScore != null ? +comps.away.shootoutScore : null,
      home: { id: String(comps.home.team.id), name: comps.home.team.displayName, abbrev: comps.home.team.abbreviation || "" },
      away: { id: String(comps.away.team.id), name: comps.away.team.displayName, abbrev: comps.away.team.abbreviation || "" },
      winnerId: null,
      pens: false,
    };
    if (comps.home.winner) info.winnerId = info.home.id;
    if (comps.away.winner) info.winnerId = info.away.id;
    if (info.hShoot != null && info.aShoot != null && info.hShoot !== info.aShoot) {
      info.pens = true;
      info.winnerId = info.hShoot > info.aShoot ? info.home.id : info.away.id;
    }
    if (info.state === "post" && !info.winnerId && info.hs !== info.as) {
      info.winnerId = info.hs > info.as ? info.home.id : info.away.id;
    }
    LIVE[String(e.id)] = info;
  } catch (err) { /* skip malformed event */ }
}

async function fetchLive() {
  try {
    const res = await fetch(WC_CONFIG.espnScoreboard);
    if (!res.ok) throw new Error("espn " + res.status);
    const data = await res.json();
    (data.events || []).forEach(applyLiveEvent);
    localStorage.setItem("wc.live", JSON.stringify(LIVE));
    localStorage.setItem("wc.liveAt", String(Date.now()));
    onChange();
  } catch (e) { /* offline — keep cached results */ }
}

function loadCachedLive() {
  try { LIVE = JSON.parse(localStorage.getItem("wc.live") || "{}"); } catch (e) { LIVE = {}; }
}

// ---- match accessors ---------------------------------------------------------

// A match merged with live info and manual override (override wins).
function matchView(m) {
  const live = LIVE[m.id] || {};
  const ov = State.overrides[m.id];
  const v = {
    ...m,
    home: live.home && !live.home.name.includes("Winner") ? { ...m.home, ...live.home } : m.home,
    away: live.away ? { ...m.away, ...live.away } : m.away,
    state: live.state || "pre",
    detail: live.detail || "",
    hs: live.hs, as: live.as, pens: !!live.pens, winnerId: live.winnerId,
  };
  // While ESPN still has a placeholder, keep schedule name; once real team fills in, use it.
  if (live.home) v.home = { ...m.home, ...live.home };
  if (live.away) v.away = { ...m.away, ...live.away };
  if (ov) {
    v.state = "post"; v.hs = ov.hs; v.as = ov.as; v.pens = !!ov.pens;
    v.winnerId = ov.winnerId || (ov.hs > ov.as ? v.home.id : ov.as > ov.hs ? v.away.id : null);
    v.detail = "FT (corrected)"; v.overridden = true;
  }
  const kickoff = new Date(m.date).getTime();
  v.started = Date.now() >= kickoff || v.state !== "pre";
  v.finished = v.state === "post";
  v.isTBD = !TEAMS[v.home.id] || !TEAMS[v.away.id];
  return v;
}

function allMatches() { return SCHEDULE.map(matchView); }

function roundKey(m) {
  if (m.stage === "GROUP") return "G" + m.matchday;
  if (m.stage === "THIRD" || m.stage === "FINAL") return "FIN";
  return m.stage;
}

const ROUND_LABELS = { G1: "Group · Matchday 1", G2: "Group · Matchday 2", G3: "Group · Matchday 3", R32: "Round of 32", R16: "Round of 16", QF: "Quarter-finals", SF: "Semi-finals", FIN: "Final weekend" };
const STAGE_LABELS = { GROUP: "Group", R32: "R32", R16: "R16", QF: "QF", SF: "SF", THIRD: "3rd place", FINAL: "FINAL" };

// Lock time for a group's qualifier picks: first kickoff of that group's matchday 2.
function qualsLockDate(group) {
  const ds = SCHEDULE.filter(m => m.stage === "GROUP" && m.group === group && m.matchday === 2).map(m => new Date(m.date).getTime());
  return ds.length ? Math.min(...ds) : Infinity;
}
// Champion / top scorer lock: first knockout kickoff.
function bonusLockDate() {
  const ds = SCHEDULE.filter(m => m.stage === "R32").map(m => new Date(m.date).getTime());
  return ds.length ? Math.min(...ds) : Infinity;
}

// ---- boot ---------------------------------------------------------------------

async function initStore(rerender) {
  onChange = rerender;
  loadLocalState();
  loadCachedLive();
  const [sch, tms] = await Promise.all([
    fetch("data/schedule.json").then(r => r.json()),
    fetch("data/teams.json").then(r => r.json()),
  ]);
  SCHEDULE = sch.matches;
  TEAMS = Object.fromEntries(tms.teams.map(t => [t.id, t]));
  if (sbConfigured()) {
    try { await pullRemote(); setSync("ok"); } catch (e) { setSync("error"); }
    setInterval(async () => {
      if (document.hidden) return;
      try { await pullRemote(); if (pushQueue.size) flushPush(); else setSync("ok"); } catch (e) { setSync("error"); }
    }, 30000);
  }
  fetchLive();
  setInterval(() => { if (!document.hidden) fetchLive(); }, 90000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { fetchLive(); if (sbConfigured()) pullRemote().then(onChange).catch(() => {}); } });
}
