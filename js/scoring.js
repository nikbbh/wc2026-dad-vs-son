// ---------------------------------------------------------------------------
// Scoring engine — implements the agreed rulebook.
// ---------------------------------------------------------------------------
"use strict";

const BASE_POINTS = { GROUP: 1, R32: 2, R16: 2, QF: 3, SF: 3, THIRD: 3, FINAL: 5 };

function outcomeOf(v) {
  if (v.hs == null || v.as == null) return null;
  return v.hs > v.as ? "H" : v.hs < v.as ? "A" : "D";
}

// Grade one finished match for one user. Returns null if nothing to grade yet.
function gradeMatch(user, v) {
  if (!v.finished) return null;
  const pick = State.pred[user][v.id];
  const banker = State.bank[user][roundKey(v)] === v.id;
  const base = BASE_POINTS[v.stage];
  let correct = false;
  if (v.stage === "GROUP") {
    correct = pick != null && pick === outcomeOf(v);
  } else {
    correct = pick != null && v.winnerId != null && pick === v.winnerId;
  }
  let points = correct ? base : 0;
  let mult = 1;
  if (correct && v.pens && v.stage !== "GROUP") mult *= 2;   // penalty-shootout double
  if (correct && banker) mult *= 2;                           // banker double
  points *= mult;
  return { points, correct, banker, pens: v.pens && v.stage !== "GROUP", base, mult, picked: pick != null };
}

// Teams that actually reached the knockout stage = real teams named in R32 fixtures.
function advancedTeamIds(views) {
  const ids = new Set();
  for (const v of views) {
    if (v.stage !== "R32") continue;
    if (TEAMS[v.home.id]) ids.add(v.home.id);
    if (TEAMS[v.away.id]) ids.add(v.away.id);
  }
  return ids;
}

// Group standings computed from live results (for display + smart hints).
function groupTable(views, letter) {
  const rows = {};
  for (const t of Object.values(TEAMS)) if (t.group === letter) rows[t.id] = { team: t, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 };
  for (const v of views) {
    if (v.stage !== "GROUP" || v.group !== letter || v.hs == null || v.as == null || (!v.finished && v.state !== "in")) continue;
    const h = rows[v.home.id], a = rows[v.away.id];
    if (!h || !a) continue;
    h.p++; a.p++; h.gf += v.hs; h.ga += v.as; a.gf += v.as; a.ga += v.hs;
    if (v.hs > v.as) { h.w++; a.l++; h.pts += 3; }
    else if (v.hs < v.as) { a.w++; h.l++; a.pts += 3; }
    else { h.d++; a.d++; h.pts++; a.pts++; }
  }
  return Object.values(rows).sort((x, y) => y.pts - x.pts || (y.gf - y.ga) - (x.gf - x.ga) || y.gf - x.gf || x.team.name.localeCompare(y.team.name));
}

// Full scorecard for one user.
function scorecard(user, views) {
  const card = { match: 0, quals: 0, champion: 0, topscorer: 0, total: 0, graded: [], qualHits: [] };
  for (const v of views) {
    const g = gradeMatch(user, v);
    if (g) { card.match += g.points; card.graded.push({ v, g }); }
  }
  const adv = advancedTeamIds(views);
  for (const [, picks] of Object.entries(State.quals[user] || {})) {
    for (const tid of picks || []) if (adv.has(tid)) { card.quals++; card.qualHits.push(tid); }
  }
  const finalV = views.find(v => v.stage === "FINAL");
  const bonus = State.bonus[user] || {};
  if (finalV && finalV.finished && finalV.winnerId && bonus.champion === finalV.winnerId) card.champion = 10;
  if (bonus.tsCorrect) card.topscorer = 5;
  card.total = card.match + card.quals + card.champion + card.topscorer;
  return card;
}

// Cumulative points over time for the head-to-head chart.
// Returns [{t, dad, son}] sorted by time, one entry per scoring event.
function timeline(views) {
  const events = [];
  for (const u of USERS) {
    for (const v of views) {
      const g = gradeMatch(u, v);
      if (g && g.points) events.push({ t: new Date(v.date).getTime(), u, pts: g.points });
    }
  }
  // qualifier points land when the R32 bracket is known: use first R32 kickoff.
  const adv = advancedTeamIds(views);
  if (adv.size) {
    const t = bonusLockDate();
    for (const u of USERS) {
      let n = 0;
      for (const picks of Object.values(State.quals[u] || {})) for (const tid of picks || []) if (adv.has(tid)) n++;
      if (n) events.push({ t, u, pts: n });
    }
  }
  events.sort((a, b) => a.t - b.t);
  const series = [{ t: 0, dad: 0, son: 0 }];
  let dad = 0, son = 0;
  for (const e of events) {
    if (e.u === "dad") dad += e.pts; else son += e.pts;
    series.push({ t: e.t, dad, son });
  }
  return series;
}

// Last n graded picks for the "form" strip.
function form(user, views, n = 5) {
  const graded = views.filter(v => v.finished && State.pred[user][v.id] != null)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  return graded.slice(-n).map(v => gradeMatch(user, v).correct);
}

// ---------------------------------------------------------------------------
// Bracket projection — shapes the official R32 bracket from the user's OWN
// group-stage predictions, until the real teams are confirmed.
// ---------------------------------------------------------------------------

// Predicted final table of one group from the user's 1/X/2 picks.
// Returns null until the user has predicted all 6 matches of the group.
// Tiebreaks (simplified, goals are unknown): points → predicted head-to-head
// → the user's explicit qualifier pick → alphabetical.
function predictedTable(user, letter) {
  const ms = SCHEDULE.filter(m => m.stage === "GROUP" && m.group === letter);
  const pts = {}, beat = {};
  for (const t of Object.values(TEAMS)) if (t.group === letter) pts[t.id] = 0;
  for (const m of ms) {
    const p = State.pred[user][m.id];
    if (!p) return null;
    if (p === "H") { pts[m.home.id] += 3; (beat[m.home.id] = beat[m.home.id] || new Set()).add(m.away.id); }
    else if (p === "A") { pts[m.away.id] += 3; (beat[m.away.id] = beat[m.away.id] || new Set()).add(m.home.id); }
    else { pts[m.home.id] += 1; pts[m.away.id] += 1; }
  }
  const qp = State.quals[user][letter] || [];
  const order = Object.keys(pts).sort((a, b) =>
    pts[b] - pts[a]
    || ((beat[b] && beat[b].has(a)) ? 1 : 0) - ((beat[a] && beat[a].has(b)) ? 1 : 0)
    || (qp.includes(b) ? 1 : 0) - (qp.includes(a) ? 1 : 0)
    || TEAMS[a].name.localeCompare(TEAMS[b].name));
  return { order, pts };
}

// matchId -> {home, away} of projected team ids for R32 matches (sides may be
// null where the projection isn't possible yet).
function projectBracket(user) {
  const winners = {}, runners = {}, thirds = [];
  const letters = [...new Set(Object.values(TEAMS).map(t => t.group))];
  let allGroupsDone = true;
  for (const L of letters) {
    const t = predictedTable(user, L);
    if (!t) { allGroupsDone = false; continue; }
    winners[L] = t.order[0];
    runners[L] = t.order[1];
    thirds.push({ id: t.order[2], group: L, pts: t.pts[t.order[2]] });
  }
  // Best 8 thirds are only knowable once every group is fully predicted.
  const thirdByGroup = {};
  if (allGroupsDone) {
    thirds.sort((a, b) => b.pts - a.pts || TEAMS[a.id].name.localeCompare(TEAMS[b.id].name));
    const qualified = thirds.slice(0, 8);
    // Assign thirds to slots honoring each slot's allowed-groups list (backtracking).
    const slots = [];
    for (const m of SCHEDULE.filter(x => x.stage === "R32")) {
      for (const side of ["home", "away"]) {
        if (m[side].abbrev !== "3RD") continue;
        const g = /Group ([A-L/]+)/.exec(m[side].name);
        slots.push({ key: m.id + ":" + side, allowed: new Set(g ? g[1].split("/") : []) });
      }
    }
    slots.sort((a, b) => a.allowed.size - b.allowed.size);
    const used = new Set(), assign = {};
    (function bt(i) {
      if (i === slots.length) return true;
      for (const t of qualified) {
        if (used.has(t.group) || !slots[i].allowed.has(t.group)) continue;
        used.add(t.group); assign[slots[i].key] = t.id;
        if (bt(i + 1)) return true;
        used.delete(t.group); delete assign[slots[i].key];
      }
      return false;
    })(0);
    for (const [key, tid] of Object.entries(assign)) thirdByGroup[key] = tid;
  }
  const proj = {};
  for (const m of SCHEDULE.filter(x => x.stage === "R32")) {
    const side = (s, key) => {
      const ab = m[s].abbrev;
      if (/^1[A-L]$/.test(ab)) return winners[ab[1]] || null;
      if (/^2[A-L]$/.test(ab)) return runners[ab[1]] || null;
      if (ab === "3RD") return thirdByGroup[key] || null;
      return null;
    };
    proj[m.id] = { home: side("home", m.id + ":home"), away: side("away", m.id + ":away") };
  }
  return proj;
}

// Disagreement stats: matches where picks differ, and who won them.
function disagreements(views) {
  let total = 0, dad = 0, son = 0;
  for (const v of views) {
    const pd = State.pred.dad[v.id], ps = State.pred.son[v.id];
    if (pd == null || ps == null || pd === ps) continue;
    if (!v.started) continue;          // only count once both picks are revealed
    total++;
    if (!v.finished) continue;
    const gd = gradeMatch("dad", v), gs = gradeMatch("son", v);
    if (gd.correct) dad++;
    if (gs.correct) son++;
  }
  return { total, dad, son };
}
