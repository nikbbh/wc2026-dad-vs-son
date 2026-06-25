// ---------------------------------------------------------------------------
// UI — rendering and interactions. Vanilla JS, no build step.
// ---------------------------------------------------------------------------
"use strict";

let TAB = "matches";
let ROUND_FILTER = "ALL";
let FOCUS_MID = null;        // id of the "current" match to scroll to on open
let autoScrolledOnce = false; // gates the one-time highlight flash
let userInteracted = false;   // once true, we stop auto-positioning the feed

// Don't let the browser restore a stale scroll position on relaunch (notably
// iOS home-screen standalone apps); we position the feed ourselves.
if ("scrollRestoration" in history) history.scrollRestoration = "manual";

// A genuine user gesture means "hands off" — stop forcing the feed position.
["touchstart", "wheel", "keydown", "mousedown"].forEach(ev =>
  window.addEventListener(ev, () => { userInteracted = true; }, { passive: true, capture: true }));

// The match worth jumping to: one in progress, else the next to kick off,
// else the most recent (tournament over). `list` is sorted by date.
function currentMatchId(list) {
  const live = list.find(v => v.state === "in");
  if (live) return live.id;
  const next = list.find(v => !v.started);
  if (next) return next.id;
  return list.length ? list[list.length - 1].id : null;
}

// Position the matches feed on the current match. Runs after every render
// (until the user takes over) so a late data load that rebuilds the feed
// can't strand it at the top. Double-rAF waits for layout to settle.
function autoScrollToCurrent() {
  if (userInteracted || TAB !== "matches" || !FOCUS_MID) return;
  const go = () => {
    if (userInteracted) return;
    const el = document.getElementById("match-" + FOCUS_MID);
    if (!el) return;
    el.scrollIntoView({ block: "start" });
    if (!autoScrolledOnce) {
      autoScrolledOnce = true;
      el.classList.add("focus-flash");
      setTimeout(() => el.classList.remove("focus-flash"), 1800);
    }
  };
  go();               // layout is ready right after innerHTML is set
  setTimeout(go, 90); // re-assert once more after any async settle
}

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function flagImg(team, cls = "flag") {
  const t = TEAMS[team.id];
  if (!t || !t.logo) return `<span class="${cls} flag-tbd">?</span>`;
  return `<img class="${cls}" src="${esc(t.logo)}" alt="" loading="lazy">`;
}

const timeOf = (d) => new Date(d).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const dayOf = (d) => new Date(d).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
const dayKey = (d) => new Date(d).toDateString();

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), 2200);
}

function me() { return Local.profile; }
function opp() { return me() === "dad" ? "son" : "dad"; }

// ---- render root -----------------------------------------------------------

function render() {
  // header
  const u = me();
  $("#profile-chip").innerHTML = u
    ? `${USER_META[u].emoji} ${USER_META[u].name}`
    : "Choose player";
  const dot = $("#sync-dot");
  dot.className = "sync-dot " + (sbConfigured() ? (syncStatus === "error" ? "err" : syncStatus === "syncing" ? "busy" : "ok") : "off");
  dot.title = sbConfigured() ? "Sync: " + syncStatus : "Local mode — sync not configured yet";

  document.querySelectorAll("#tabs button").forEach(b => b.classList.toggle("active", b.dataset.tab === TAB));

  const view = $("#view");
  if (!u) { view.innerHTML = ""; showProfileModal(true); return; }
  const views = allMatches();
  if (TAB === "matches") view.innerHTML = renderMatches(views);
  else if (TAB === "groups") view.innerHTML = renderGroups(views);
  else if (TAB === "bonus") view.innerHTML = renderBonus(views);
  else if (TAB === "score") view.innerHTML = renderScore(views);
  else view.innerHTML = renderRules();

  autoScrollToCurrent();
}

// ---- matches tab -------------------------------------------------------------

let PROJ = {}; // projected R32 bracket from the viewer's own group predictions

function renderMatches(views) {
  PROJ = projectBracket(me());
  const rounds = ["ALL", "G1", "G2", "G3", "R32", "R16", "QF", "SF", "FIN"];
  const filtered = ROUND_FILTER === "ALL" ? views : views.filter(v => roundKey(v) === ROUND_FILTER);
  FOCUS_MID = currentMatchId(filtered);
  const mine = State.pred[me()];
  const pickable = filtered.filter(v => !v.started && !v.isTBD);
  const done = pickable.filter(v => mine[v.id] != null).length;

  let html = `<div class="filter-bar">` + rounds.map(r =>
    `<button class="pill ${ROUND_FILTER === r ? "on" : ""}" data-round="${r}">${r === "ALL" ? "All" : r === "FIN" ? "Final" : r}</button>`).join("") + `</div>`;

  if (pickable.length) {
    html += `<div class="banner ${done < pickable.length ? "warn" : "good"}">${done < pickable.length
      ? `✍️ You've picked <b>${done}/${pickable.length}</b> open matches${ROUND_FILTER === "ALL" ? "" : " in this round"} — picks lock at kickoff!`
      : `✅ All open picks in${ROUND_FILTER === "ALL" ? " view" : " this round"} are in. Good luck!`}</div>`;
  }

  let lastDay = "";
  for (const v of filtered) {
    const dk = dayKey(v.date);
    if (dk !== lastDay) {
      lastDay = dk;
      html += `<h3 class="day-h" id="day-${dk}">${dayOf(v.date)}</h3>`;
    }
    html += matchCard(v);
  }
  return html;
}

function pickLabel(v, pick) {
  if (pick == null) return "—";
  if (v.stage === "GROUP") return pick === "H" ? (v.home.abbrev || "1") : pick === "A" ? (v.away.abbrev || "2") : "Draw";
  const t = TEAMS[pick];
  return t ? t.abbrev || t.name : "—";
}

function matchCard(v) {
  const u = me(), o = opp();
  const myPick = State.pred[u][v.id];
  const oppPick = State.pred[o][v.id];
  const rk = roundKey(v);
  const myBanker = State.bank[u][rk] === v.id;
  const oppBanker = State.bank[o][rk] === v.id;
  const stageChip = v.stage === "GROUP" ? `Group ${v.group} · MD${v.matchday}` : STAGE_LABELS[v.stage];
  const live = v.state === "in";

  let scoreHtml;
  if (v.hs != null && v.state !== "pre") {
    scoreHtml = `<div class="score ${live ? "live" : ""}">${v.hs}<span>:</span>${v.as}</div>`;
  } else {
    scoreHtml = `<div class="ko-time">${timeOf(v.date)}</div>`;
  }

  // pick controls (before kickoff) or graded reveal (after)
  let bottom = "";
  if (!v.started) {
    if (v.isTBD) {
      const p = v.stage === "R32" ? PROJ[v.id] : null;
      if (p && (p.home || p.away)) {
        const side = tid => tid ? `${flagImg(TEAMS[tid], "flag sm")} <b>${esc(TEAMS[tid].name)}</b>` : `<span class="dim">?</span>`;
        bottom = `<div class="proj">📋 Your projection: ${side(p.home)} <span class="dim">vs</span> ${side(p.away)}</div>
          <div class="opp-hint">Based on your group picks — the real tie appears when the groups finish, then you lock in your knockout pick.</div>`;
      } else if (v.stage === "R32") {
        bottom = `<div class="tbd-note">📋 Predict all matches of the feeding groups${v.away.abbrev === "3RD" ? " (all 12 groups for third-place slots)" : ""} to see your projected tie here.</div>`;
      } else {
        bottom = `<div class="tbd-note">Teams not decided yet — come back later</div>`;
      }
    } else if (v.stage === "GROUP") {
      bottom = `<div class="seg" data-match="${v.id}">
        <button class="${myPick === "H" ? "on" : ""}" data-pick="H">1 · ${esc(v.home.abbrev)}</button>
        <button class="${myPick === "D" ? "on" : ""}" data-pick="D">X</button>
        <button class="${myPick === "A" ? "on" : ""}" data-pick="A">2 · ${esc(v.away.abbrev)}</button>
      </div>`;
    } else {
      bottom = `<div class="seg" data-match="${v.id}">
        <button class="${myPick === v.home.id ? "on" : ""}" data-pick="${esc(v.home.id)}">${esc(v.home.abbrev || v.home.name)} wins</button>
        <button class="${myPick === v.away.id ? "on" : ""}" data-pick="${esc(v.away.id)}">${esc(v.away.abbrev || v.away.name)} wins</button>
      </div>`;
    }
    if (!v.isTBD) {
      const oppHint = oppPick != null ? `🙈 ${USER_META[o].name} has picked — revealed at kickoff` : `⏳ ${USER_META[o].name} hasn't picked yet`;
      bottom += `<div class="opp-hint">${oppHint}</div>`;
    }
  } else {
    const rows = [u, o].map(p => {
      const pk = State.pred[p][v.id];
      const g = gradeMatch(p, v);
      const isBank = State.bank[p][rk] === v.id;
      let mark = "", pts = "";
      if (v.finished && g) {
        mark = pk == null ? "·" : g.correct ? "✓" : "✗";
        pts = g.points ? `+${g.points}` : pk != null ? "0" : "";
      }
      return `<div class="reveal ${v.finished && g && g.correct ? "hit" : v.finished && pk != null ? "miss" : ""}">
        <span>${USER_META[p].emoji} ${USER_META[p].name}</span>
        <span>${esc(pickLabel(v, pk))} ${isBank ? "⭐" : ""}</span>
        <span class="mark">${mark} <b>${pts}</b></span>
      </div>`;
    }).join("");
    const pensNote = v.pens ? `<div class="pens-note">🎯 Decided on penalties — correct pick pays double!</div>` : "";
    bottom = `<div class="reveals">${rows}</div>${pensNote}`;
  }

  const bankerBtn = !v.started && !v.isTBD
    ? `<button class="banker ${myBanker ? "on" : ""}" data-banker="${v.id}" title="Banker: double points">⭐${myBanker ? " ×2" : ""}</button>`
    : (myBanker || oppBanker) ? `<span class="banker-tag">⭐ ${[myBanker && USER_META[u].name, oppBanker && USER_META[o].name].filter(Boolean).join(" & ")}</span>` : "";

  const fixBtn = u === "dad" && v.started && !v.isTBD
    ? `<button class="fix-link" data-fix="${v.id}">${v.overridden ? "✏️ corrected" : "✏️"}</button>` : "";

  return `<div class="card ${live ? "card-live" : ""}" id="match-${v.id}">
    <div class="card-top">
      <span class="chip">${stageChip}</span>
      <span class="detail">${live ? `<span class="live-dot"></span>` : ""}${esc(v.detail || (v.started ? "" : ""))}</span>
      <span class="card-top-right">${fixBtn}${bankerBtn}</span>
    </div>
    <div class="teams">
      <div class="team">${flagImg(v.home)}<span>${esc(v.home.name)}</span></div>
      ${scoreHtml}
      <div class="team away">${flagImg(v.away)}<span>${esc(v.away.name)}</span></div>
    </div>
    ${bottom}
  </div>`;
}

// ---- groups tab ----------------------------------------------------------------

function renderGroups(views) {
  const u = me(), o = opp();
  let html = `<div class="banner info">🏆 Pick the <b>2 teams</b> you think qualify from each group — <b>1 point each</b> if they reach the Round of 32. Picks lock when the group's Matchday 2 begins.</div>`;
  const letters = [...new Set(Object.values(TEAMS).map(t => t.group))].sort();
  const adv = advancedTeamIds(views);
  for (const L of letters) {
    const lock = qualsLockDate(L);
    const locked = Date.now() >= lock;
    const myPicks = State.quals[u][L] || [];
    const oppPicks = State.quals[o][L] || [];
    const table = groupTable(views, L);
    html += `<div class="card">
      <div class="card-top"><span class="chip">Group ${L}</span>
        <span class="detail">${locked ? "🔒 locked" : "🔓 locks " + dayOf(lock) + " " + timeOf(lock)}</span></div>
      <table class="gtable"><tr><th></th><th class="num">P</th><th class="num">GD</th><th class="num">Pts</th><th class="picks-h">${USER_META[u].emoji}</th><th class="picks-h">${locked ? USER_META[o].emoji : "🙈"}</th></tr>` +
      table.map(r => {
        const mine = myPicks.includes(r.team.id);
        const theirs = oppPicks.includes(r.team.id);
        const hit = adv.size && locked ? (mine && adv.has(r.team.id) ? " qhit" : "") : "";
        return `<tr class="${hit}">
          <td class="tname">${flagImg(r.team, "flag sm")} ${esc(r.team.name)}</td>
          <td class="num">${r.p}</td><td class="num">${r.gf - r.ga > 0 ? "+" : ""}${r.gf - r.ga}</td><td class="num"><b>${r.pts}</b></td>
          <td class="pickcell">${locked
            ? (mine ? (adv.size ? (adv.has(r.team.id) ? "✓" : "✗") : "✔︎") : "")
            : `<button class="qpick ${mine ? "on" : ""}" data-qual="${L}" data-team="${r.team.id}">${mine ? "✔︎" : "+"}</button>`}</td>
          <td class="pickcell">${locked ? (theirs ? "✔︎" : "") : (theirs ? "•" : "")}</td>
        </tr>`;
      }).join("") + `</table></div>`;
  }
  return html;
}

// ---- bonus tab -------------------------------------------------------------------

function renderBonus(views) {
  const u = me(), o = opp();
  const lock = bonusLockDate();
  const locked = Date.now() >= lock;
  const myB = State.bonus[u] || {};
  const oppB = State.bonus[o] || {};
  const finalV = views.find(v => v.stage === "FINAL");
  const finalDone = finalV && finalV.finished;

  let html = `<div class="banner info">⭐ Big swings: pick the <b>Champion (+10)</b> and the <b>tournament top scorer (+5)</b>. Locks at the first knockout kickoff${locked ? "" : " — " + dayOf(lock)}.</div>`;

  // champion
  html += `<div class="card"><div class="card-top"><span class="chip">🏆 Champion (+10)</span><span class="detail">${locked ? "🔒 locked" : "🔓 open"}</span></div>`;
  if (!locked) {
    const sorted = Object.values(TEAMS).sort((a, b) => a.name.localeCompare(b.name));
    html += `<div class="champ-grid">` + sorted.map(t =>
      `<button class="champ ${myB.champion === t.id ? "on" : ""}" data-champ="${t.id}">${flagImg(t, "flag sm")}<span>${esc(t.abbrev || t.name)}</span></button>`).join("") + `</div>`;
    html += `<div class="opp-hint">${oppB.champion ? "🙈 " + USER_META[o].name + " has picked" : "⏳ " + USER_META[o].name + " hasn't picked yet"}</div>`;
  } else {
    html += `<div class="bonus-reveal">` + [u, o].map(p => {
      const t = TEAMS[(State.bonus[p] || {}).champion];
      const won = finalDone && finalV.winnerId && t && t.id === finalV.winnerId;
      return `<div class="reveal ${finalDone ? (won ? "hit" : "miss") : ""}"><span>${USER_META[p].emoji} ${USER_META[p].name}</span><span>${t ? esc(t.name) : "no pick"}</span><span class="mark">${finalDone ? (won ? "✓ +10" : "✗") : ""}</span></div>`;
    }).join("") + `</div>`;
  }
  html += `</div>`;

  // top scorer
  html += `<div class="card"><div class="card-top"><span class="chip">⚽ Top scorer (+5)</span><span class="detail">${locked ? "🔒 locked" : "🔓 open"}</span></div>`;
  if (!locked) {
    html += `<div class="ts-row"><input id="ts-input" type="text" placeholder="e.g. Kylian Mbappé" value="${esc(myB.topscorer || "")}" maxlength="40"><button id="ts-save">Save</button></div>
      <div class="opp-hint">${oppB.topscorer ? "🙈 " + USER_META[o].name + " has picked" : "⏳ " + USER_META[o].name + " hasn't picked yet"}</div>`;
  } else {
    html += `<div class="bonus-reveal">` + [u, o].map(p => {
      const b = State.bonus[p] || {};
      const mark = b.tsCorrect === true ? "✓ +5" : b.tsCorrect === false ? "✗" : "";
      return `<div class="reveal ${b.tsCorrect === true ? "hit" : b.tsCorrect === false ? "miss" : ""}"><span>${USER_META[p].emoji} ${USER_META[p].name}</span><span>${esc(b.topscorer || "no pick")}</span><span class="mark">${mark}</span></div>`;
    }).join("") + `</div>`;
    if (u === "dad" && finalDone) {
      html += `<div class="admin-row">Referee Dad — mark top scorer picks: ` + USERS.map(p =>
        `<button class="mini" data-ts-user="${p}" data-ts-val="1">${USER_META[p].emoji} ✓</button><button class="mini" data-ts-user="${p}" data-ts-val="0">${USER_META[p].emoji} ✗</button>`).join(" ") + `</div>`;
    }
  }
  html += `</div>`;
  return html;
}

// ---- score tab ----------------------------------------------------------------------

function renderScore(views) {
  const cd = scorecard("dad", views), cs = scorecard("son", views);
  const lead = cd.total === cs.total ? null : cd.total > cs.total ? "dad" : "son";
  const fd = form("dad", views), fs = form("son", views);
  const dis = disagreements(views);
  const series = timeline(views);

  const title = lead
    ? `${USER_META[lead].emoji} ${USER_META[lead].name} is the 🔮 Oracle — leading by ${Math.abs(cd.total - cs.total)}!`
    : "🤝 All square — it's anyone's cup!";

  const row = (label, a, b) => `<tr><td>${label}</td><td class="num">${a}</td><td class="num">${b}</td></tr>`;

  return `
  <div class="h2h card">
    <div class="h2h-score">
      <div class="h2h-side"><div class="h2h-emoji">👨</div><div class="h2h-name">Dad</div><div class="h2h-pts ${lead === "dad" ? "lead" : ""}">${cd.total}</div></div>
      <div class="h2h-vs">vs</div>
      <div class="h2h-side"><div class="h2h-emoji">👦</div><div class="h2h-name">Son</div><div class="h2h-pts ${lead === "son" ? "lead" : ""}">${cs.total}</div></div>
    </div>
    <div class="h2h-title">${title}</div>
    ${chartSVG(series)}
    <table class="break"><tr><th></th><th class="num">👨</th><th class="num">👦</th></tr>
      ${row("Match results", cd.match, cs.match)}
      ${row("Qualifiers (1 pt/team)", cd.quals, cs.quals)}
      ${row("Champion bonus", cd.champion, cs.champion)}
      ${row("Top scorer bonus", cd.topscorer, cs.topscorer)}
      ${row("<b>Total</b>", `<b>${cd.total}</b>`, `<b>${cs.total}</b>`)}
    </table>
    <div class="formrow"><span>👨 form</span>${formDots(fd)}</div>
    <div class="formrow"><span>👦 form</span>${formDots(fs)}</div>
    ${dis.total ? `<div class="spicy">🌶️ You disagreed on <b>${dis.total}</b> matches so far — Dad won <b>${dis.dad}</b>, Son won <b>${dis.son}</b>.</div>` : `<div class="spicy">🌶️ No revealed disagreements yet — dare to differ!</div>`}
  </div>`;
}

function formDots(f) {
  if (!f.length) return `<span class="dim">no graded picks yet</span>`;
  return f.map(ok => `<span class="dot ${ok ? "w" : "l"}">${ok ? "✓" : "✗"}</span>`).join("");
}

function chartSVG(series) {
  if (series.length < 2) return `<div class="dim chart-empty">The race chart appears after the first results.</div>`;
  const W = 320, H = 110, P = 8;
  const t0 = series[1].t, t1 = series[series.length - 1].t || t0 + 1;
  const max = Math.max(2, ...series.map(s => Math.max(s.dad, s.son)));
  const x = t => P + (W - 2 * P) * (t1 === t0 ? 1 : (t - t0) / (t1 - t0));
  const y = v => H - P - (H - 2 * P) * (v / max);
  const path = (key) => series.slice(1).map((s, i) => `${i ? "L" : "M"}${x(s.t).toFixed(1)},${y(s[key]).toFixed(1)}`).join(" ");
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <path d="${path("dad")}" fill="none" stroke="${USER_META.dad.color}" stroke-width="2.5" stroke-linecap="round"/>
    <path d="${path("son")}" fill="none" stroke="${USER_META.son.color}" stroke-width="2.5" stroke-linecap="round"/>
  </svg>`;
}

// ---- rules tab -------------------------------------------------------------------------

function renderRules() {
  return `<div class="card rules">
  <h2>📜 The Rulebook</h2>
  <ul>
    <li>⚽ <b>Group matches:</b> pick 1 / X / 2 before kickoff — correct outcome = <b>1 pt</b>.</li>
    <li>🏆 <b>Qualifiers:</b> pick 2 teams per group; <b>1 pt</b> for each that reaches the Round of 32. Locks when that group's Matchday 2 starts.</li>
    <li>🥊 <b>Knockouts:</b> pick who goes through. R32 &amp; R16 = <b>2 pts</b>, QF &amp; SF = <b>3 pts</b>, 3rd place = <b>3 pts</b>, Final = <b>5 pts</b>.</li>
    <li>🎯 <b>Penalty double:</b> a knockout match decided on penalties pays <b>double</b> to whoever called the winner.</li>
    <li>⭐ <b>Banker:</b> in every round (each group matchday, R32, R16, QF, SF, final weekend) mark ONE match as your banker — its points are <b>doubled</b>. Yes, a banker won on penalties pays ×4.</li>
    <li>👑 <b>Champion pick:</b> before the knockouts begin, pick the World Champion — <b>+10 pts</b>.</li>
    <li>🥇 <b>Top scorer pick:</b> before the knockouts, name the tournament top scorer — <b>+5 pts</b>.</li>
    <li>📋 <b>Projected bracket:</b> until the real qualifiers are known, knockout fixtures show YOUR projected teams, shaped from your own group picks via the official bracket. It's a preview only — actual knockout picks open once teams are confirmed, and you can adjust them up to each kickoff.</li>
    <li>🔒 Every pick locks at kickoff. No edits, no excuses.</li>
    <li>🙈 You can't see each other's pick until the match kicks off.</li>
    <li>✏️ Dad is the referee: he can correct a result if the data feed gets one wrong (visible to both as “corrected”).</li>
  </ul>
  <p class="dim">Results update automatically a few minutes after each match. May the best forecaster win! 🍀</p>
  </div>`;
}

// ---- profile & PIN ------------------------------------------------------------------------

function showProfileModal(force) {
  const root = $("#modal-root");
  root.innerHTML = `<div class="modal-bg"><div class="modal">
    <h2>Who's playing?</h2>
    <div class="profile-btns">
      ${USERS.map(u => `<button class="profile-big" data-prof="${u}">${USER_META[u].emoji}<span>${USER_META[u].name}</span></button>`).join("")}
    </div>
    ${force ? "" : `<button class="mini" data-close>Cancel</button>`}
  </div></div>`;
}

function showPinModal(user, mode) { // mode: 'enter' | 'create'
  const root = $("#modal-root");
  root.innerHTML = `<div class="modal-bg"><div class="modal">
    <h2>${USER_META[user].emoji} ${mode === "create" ? "Create a 4-digit PIN" : "Enter your PIN"}</h2>
    <input id="pin-input" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" placeholder="••••">
    <div class="modal-actions">
      <button class="mini" data-close>Cancel</button>
      ${mode === "create" ? `<button class="mini" data-pin-skip="${user}">Skip PIN</button>` : ""}
      <button class="primary" data-pin-ok="${user}" data-pin-mode="${mode}">OK</button>
    </div>
    <p class="dim">${mode === "create" ? "Stops the other player peeking at your picks on this device." : ""}<span id="pin-err" class="err"></span></p>
  </div></div>`;
  setTimeout(() => $("#pin-input").focus(), 60);
}

function selectProfile(u) {
  if (State.pins[u] && !Local.unlocked[u]) { showPinModal(u, "enter"); return; }
  if (!State.pins[u]) { Local.profile = u; showPinModal(u, "create"); return; }
  Local.profile = u;
  $("#modal-root").innerHTML = "";
  render();
}

// ---- result override (Dad the referee) -------------------------------------------------------

function showFixModal(matchId) {
  const v = allMatches().find(m => m.id === matchId);
  const ov = State.overrides[matchId] || {};
  const root = $("#modal-root");
  const isKO = v.stage !== "GROUP";
  root.innerHTML = `<div class="modal-bg"><div class="modal">
    <h2>✏️ Correct result</h2>
    <p>${esc(v.home.name)} vs ${esc(v.away.name)}</p>
    <div class="fix-row">
      <input id="fix-hs" type="number" min="0" max="20" value="${ov.hs ?? v.hs ?? 0}">
      <span>:</span>
      <input id="fix-as" type="number" min="0" max="20" value="${ov.as ?? v.as ?? 0}">
    </div>
    ${isKO ? `<label class="fix-pens"><input id="fix-pens" type="checkbox" ${ov.pens || v.pens ? "checked" : ""}> Decided on penalties — winner:
      <select id="fix-winner">
        <option value="${esc(v.home.id)}" ${(ov.winnerId || v.winnerId) === v.home.id ? "selected" : ""}>${esc(v.home.name)}</option>
        <option value="${esc(v.away.id)}" ${(ov.winnerId || v.winnerId) === v.away.id ? "selected" : ""}>${esc(v.away.name)}</option>
      </select></label>` : ""}
    <div class="modal-actions">
      <button class="mini" data-close>Cancel</button>
      ${State.overrides[matchId] ? `<button class="mini" data-fix-clear="${matchId}">Use feed result</button>` : ""}
      <button class="primary" data-fix-save="${matchId}" data-fix-ko="${isKO ? 1 : 0}">Save</button>
    </div>
  </div></div>`;
}

// ---- events ------------------------------------------------------------------------------------

document.addEventListener("click", (ev) => {
  const t = ev.target.closest("button, a");
  if (!t) return;

  if (t.dataset.tab) { TAB = t.dataset.tab; render(); return; }
  if (t.id === "profile-chip") { showProfileModal(false); return; }
  if (t.dataset.close != null) { $("#modal-root").innerHTML = ""; render(); return; }
  if (t.dataset.prof) { $("#modal-root").innerHTML = ""; selectProfile(t.dataset.prof); return; }

  if (t.dataset.pinOk) {
    const u = t.dataset.pinOk, mode = t.dataset.pinMode;
    const val = ($("#pin-input").value || "").trim();
    if (!/^\d{4}$/.test(val)) { $("#pin-err").textContent = " 4 digits please."; return; }
    if (mode === "create") {
      State.pins[u] = val; queuePush("pins"); Local.unlock(u); Local.profile = u;
      $("#modal-root").innerHTML = ""; toast("PIN set. Your picks are safe 🙈"); render();
    } else {
      if (val === State.pins[u]) { Local.unlock(u); Local.profile = u; $("#modal-root").innerHTML = ""; render(); }
      else $("#pin-err").textContent = " Wrong PIN — try again.";
    }
    return;
  }
  if (t.dataset.pinSkip) { Local.profile = t.dataset.pinSkip; Local.unlock(t.dataset.pinSkip); $("#modal-root").innerHTML = ""; render(); return; }

  if (t.dataset.round) { ROUND_FILTER = t.dataset.round; render(); return; }

  // prediction pick
  const seg = t.closest(".seg");
  if (seg && t.dataset.pick != null) {
    const id = seg.dataset.match;
    const v = allMatches().find(m => m.id === id);
    if (v.started) { toast("⛔ Too late — match has kicked off"); render(); return; }
    State.pred[me()][id] = State.pred[me()][id] === t.dataset.pick ? undefined : t.dataset.pick;
    if (State.pred[me()][id] === undefined) delete State.pred[me()][id];
    queuePush("pred." + me());
    return;
  }

  // banker
  if (t.dataset.banker) {
    const id = t.dataset.banker;
    const v = allMatches().find(m => m.id === id);
    const rk = roundKey(v);
    const cur = State.bank[me()][rk];
    if (cur && cur !== id) {
      const curV = allMatches().find(m => m.id === cur);
      if (curV && curV.started) { toast("⛔ Your banker for this round already kicked off"); return; }
    }
    if (v.started) { toast("⛔ Too late for a banker here"); return; }
    State.bank[me()][rk] = cur === id ? undefined : id;
    if (!State.bank[me()][rk]) delete State.bank[me()][rk];
    else toast(`⭐ Banker set: ${ROUND_LABELS[rk]}`);
    queuePush("bank." + me());
    return;
  }

  // group qualifier pick
  if (t.dataset.qual) {
    const L = t.dataset.qual, tid = t.dataset.team;
    if (Date.now() >= qualsLockDate(L)) { toast("⛔ Group " + L + " picks are locked"); render(); return; }
    const cur = State.quals[me()][L] || [];
    let next;
    if (cur.includes(tid)) next = cur.filter(x => x !== tid);
    else if (cur.length >= 2) { toast("Only 2 per group — remove one first"); return; }
    else next = [...cur, tid];
    State.quals[me()][L] = next;
    queuePush("quals." + me());
    return;
  }

  // champion
  if (t.dataset.champ) {
    if (Date.now() >= bonusLockDate()) { toast("⛔ Champion pick is locked"); render(); return; }
    const b = State.bonus[me()] || {};
    b.champion = b.champion === t.dataset.champ ? undefined : t.dataset.champ;
    State.bonus[me()] = b;
    queuePush("bonus." + me());
    return;
  }
  if (t.id === "ts-save") {
    if (Date.now() >= bonusLockDate()) { toast("⛔ Top scorer pick is locked"); render(); return; }
    const b = State.bonus[me()] || {};
    b.topscorer = $("#ts-input").value.trim();
    State.bonus[me()] = b;
    queuePush("bonus." + me());
    toast("Saved ⚽");
    return;
  }
  if (t.dataset.tsUser) {
    const b = State.bonus[t.dataset.tsUser] || {};
    b.tsCorrect = t.dataset.tsVal === "1";
    State.bonus[t.dataset.tsUser] = b;
    queuePush("bonus." + t.dataset.tsUser);
    return;
  }

  // referee corrections
  if (t.dataset.fix) { showFixModal(t.dataset.fix); return; }
  if (t.dataset.fixSave) {
    const id = t.dataset.fixSave;
    const hs = +$("#fix-hs").value, as = +$("#fix-as").value;
    const isKO = t.dataset.fixKo === "1";
    const pens = isKO && $("#fix-pens") && $("#fix-pens").checked;
    const ov = { hs, as, pens };
    if (isKO && (pens || hs === as)) ov.winnerId = $("#fix-winner").value;
    State.overrides[id] = ov;
    queuePush("overrides");
    $("#modal-root").innerHTML = "";
    toast("Result corrected ✏️");
    return;
  }
  if (t.dataset.fixClear) {
    delete State.overrides[t.dataset.fixClear];
    queuePush("overrides");
    $("#modal-root").innerHTML = "";
    return;
  }
});

// ---- boot ---------------------------------------------------------------------------------------

initStore(render).then(render);
setInterval(() => { if (!document.hidden && TAB === "matches") render(); }, 60000); // keep lock states fresh
