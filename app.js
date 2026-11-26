/* Off-Night Hockey site logic (research 25). All scoring happens here, so any league's weights work.
   Value = rest-of-season production above replacement: blended per-game rate (70% season, 30% last 14 days)
   times games left, minus a replacement-level player's rate. 2-for-1 trades stay fair: the player you'd cut is worth ~0. */
"use strict";
const FORMATS = {
  espn: { name: "ESPN points (default)", type: "points", sk: { G: 2, A: 1, PPP: 0.5, SHP: 0.5, SOG: 0.1, HIT: 0.1, BLK: 0.5 }, g: { W: 4, GA: -2, SV: 0.2, SO: 3, OTL: 1 } },
  yahoo: { name: "Yahoo points (default)", type: "points", sk: { G: 6, A: 4, PM: 2, PPP: 2, SOG: 0.9, BLK: 1 }, g: { W: 5, GA: -3, SV: 0.6, SO: 5 } },
  cats: { name: "Yahoo categories (G A +/- PPP SOG HIT)", type: "cats", sk: ["G", "A", "PM", "PPP", "SOG", "HIT"], g: ["W", "GAA", "SVP", "SO"] },
  roto: { name: "Roto (G A +/- PPP SOG BLK)", type: "cats", sk: ["G", "A", "PM", "PPP", "SOG", "BLK"], g: ["W", "GAA", "SVP", "SO"] },
  bangers: { name: "Bangers (G A PPP SOG HIT BLK PIM)", type: "cats", sk: ["G", "A", "PPP", "SOG", "HIT", "BLK", "PIM"], g: ["W", "GAA", "SVP", "SO"] },
};
const SK_KEYS = ["G", "A", "PPP", "SHP", "SOG", "HIT", "BLK", "PM", "PIM"], G_KEYS = ["W", "GA", "SV", "SO", "OTL"];
const LABEL = { G: "G", A: "A", PPP: "PPP", SHP: "SHP", SOG: "SOG", HIT: "HIT", BLK: "BLK", PM: "+/-", PIM: "PIM", W: "W", GA: "GA", SV: "SV", SO: "SO", OTL: "OTL" };
const REPL = { F: 110, D: 60, G: 30 };   // replacement rank per position group in a 12-team league (6 F, 4 D, 2 G starters plus bench)
const group = p => p.p === "G" ? "G" : p.p === "D" ? "D" : "F";
let DATA = null;

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (x, d = 1) => (Math.round(x * 10 ** d) / 10 ** d).toFixed(d);
async function load(name) {   // hourly version tag: new daily data reaches every browser within the hour
  const r = await fetch(`data/${name}.json?h=${new Date().toISOString().slice(0, 13)}`); if (!r.ok) throw new Error(name); return r.json(); }

/* ---------- saved in this browser only (league and team); private windows may block storage, so every call is guarded ---------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem("onh." + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("onh." + k, JSON.stringify(v)); } catch { /* storage blocked: the page still works, it just won't remember */ } },
};
function league() {
  const L = store.get("league", { k: "espn" });
  if (L.k === "custom" && L.custom) FORMATS.custom = { name: L.customName || "Your league (custom points)", type: "points", sk: L.custom, g: L.customG || FORMATS.espn.g };
  if (!FORMATS[L.k]) L.k = "espn";
  return L;
}
const todayISO = () => new Date().toLocaleDateString("en-CA");   // YYYY-MM-DD in the visitor's own time zone

/* ---------- rates and values ---------- */
/* Rates that respect sample size. His season so far is steadied by his own last season (counted like 20 extra games) or,
   with no full season behind him, by a typical regular at his position (like 10 games), so one big night can't make a
   depth player look like a star. Recent form (last 14 days) adds up to 30%, and only gets all of it with 6+ games behind it. */
const LS_SK = ["G", "A", "PPP", "SHP", "SOG", "PM", "PIM", "HIT", "BLK"], LS_G = ["W", "L", "OTL", "GA", "SV", "SA", "SO"];
const PRIOR_OWN = 20, PRIOR_BASE = 10, RECENT_MAX = 0.3, RECENT_FULL = 6;
let BASE = null;
function baseRates() {   // median per game among regulars (10+ games this season) at each position group
  if (BASE) return BASE;
  const med = a => { const v = a.filter(Number.isFinite).sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : 0; };
  BASE = { G: {} };
  ["F", "D"].forEach(gr => { const pool = DATA.skaters.filter(p => group(p) === gr && p.gp >= 10); BASE[gr] = {};
    LS_SK.forEach(k => { BASE[gr][k] = med(pool.map(p => (p.s[k] || 0) / p.gp)); }); });
  const gpool = DATA.goalies.filter(g => g.gs >= 5);
  LS_G.forEach(k => { BASE.G[k] = med(gpool.map(g => (g.s[k] || 0) / g.gs)); });
  return BASE;
}
const ownLast = p => p.ls && p.ls[0] >= 20;
function prior(p, k) {
  if (ownLast(p)) return { rate: (p.ls[1 + (isG(p) ? LS_G : LS_SK).indexOf(k)] || 0) / p.ls[0], K: PRIOR_OWN };
  return { rate: baseRates()[group(p)][k] || 0, K: PRIOR_BASE };
}
const recentWeight = n => RECENT_MAX * Math.min(n || 0, RECENT_FULL) / RECENT_FULL;
function steady(p, k, denomKey) {   // season so far plus the prior, before recent form
  const n = p[denomKey] || 0, pr = prior(p, k);
  return ((p.s[k] || 0) + pr.K * pr.rate) / (n + pr.K);
}
function blend(p, k, denomKey) {
  const est = steady(p, k, denomKey), rd = denomKey === "gs" ? p.rgs : p.rgp, w = recentWeight(rd);
  return p.r && rd ? (1 - w) * est + w * ((p.r[k] || 0) / rd) : est;
}
const BIG_NIGHT = 2.5;   // in recent form, one night counts at most 2.5x his usual, so a single 4-goal game can't carry the number
function bigNights(p, f) {
  if (isG(p) || !p.g5 || !p.rgp) return { excess: 0, games: [] };
  const usual = Object.entries(f.sk).reduce((a, [k, w]) => a + w * steady(p, k, "gp"), 0), cap = Math.max(BIG_NIGHT * usual, 3);
  const games = p.g5.map(g => G5_KEYS.reduce((a, k, i) => a + (f.sk[k] || 0) * g[i], 0)).filter(x => x > cap);
  return { cap, games, excess: games.reduce((a, x) => a + x - cap, 0) };
}
const isG = p => p.p === "G";
function gamesLeft(p) {
  const t = DATA.teams[p.t];
  if (!isG(p)) return t.left;
  return Math.round(t.left * Math.min(1, p.gs / Math.max(t.played, 1)));   // projected starts from his share so far
}
function perGamePoints(p, f) {
  if (isG(p)) return Object.entries(f.g).reduce((s, [k, w]) => s + w * blend(p, k, "gs"), 0);
  const raw = Object.entries(f.sk).reduce((s, [k, w]) => s + w * blend(p, k, "gp"), 0);
  return raw - recentWeight(p.rgp) * bigNights(p, f).excess / Math.max(p.rgp || 1, 1);
}
function goalieRates(p) {
  const sv = p.s.SA ? p.s.SV / p.s.SA : 0, gaa = p.s.GA / Math.max(p.gs, 1);
  return { W: blend(p, "W", "gs"), SO: blend(p, "SO", "gs"), SVP: sv, GAA: -gaa, share: p.gs / Math.max(DATA.teams[p.t].played, 1) };
}
let ZCACHE = {};
function zTable(f, key) {
  if (ZCACHE[key]) return ZCACHE[key];
  const pool = DATA.skaters.filter(p => p.gp >= 8).sort((a, b) => b.gp - a.gp).slice(0, 360);
  const gpool = DATA.goalies.filter(p => p.gs >= 5);
  const stat = (arr, fn) => { const v = arr.map(fn), m = v.reduce((a, b) => a + b, 0) / v.length; const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length) || 1; return [m, sd]; };
  const z = { sk: {}, g: {} };
  f.sk.forEach(k => z.sk[k] = stat(pool, p => blend(p, k, "gp")));
  f.g.forEach(k => z.g[k] = stat(gpool, p => goalieRates(p)[k]));
  return (ZCACHE[key] = z);
}
function perGameCats(p, f, key) {
  const z = zTable(f, key);
  if (isG(p)) { const r = goalieRates(p); return f.g.reduce((s, k) => s + (r[k] - z.g[k][0]) / z.g[k][1] * (k === "SVP" || k === "GAA" ? Math.min(1, r.share * 1.4) : 1), 0); }
  return f.sk.reduce((s, k) => s + (blend(p, k, "gp") - z.sk[k][0]) / z.sk[k][1], 0);
}
function perGame(p, f, key) { return f.type === "points" ? perGamePoints(p, f) : perGameCats(p, f, key); }
let RCACHE = {};
function replacement(f, key) {
  if (RCACHE[key]) return RCACHE[key];
  const rank = (arr, n) => { const v = arr.map(p => perGame(p, f, key)).sort((a, b) => b - a); return v[Math.min(n, v.length - 1)] || 0; };
  return (RCACHE[key] = { F: rank(DATA.skaters.filter(p => p.gp >= 5 && group(p) === "F"), REPL.F),
    D: rank(DATA.skaters.filter(p => p.gp >= 5 && p.p === "D"), REPL.D), G: rank(DATA.goalies.filter(p => p.gs >= 3), REPL.G) });
}
function value(p, f, key, games) {
  const r = replacement(f, key)[group(p)];
  return Math.max(0, perGame(p, f, key) - r) * games;
}
function everyone() { return DATA.skaters.concat(DATA.goalies); }

/* ---------- shared bits ---------- */
function gamesPill(team, week) {
  if (!week) return "";
  const n = week.plays.filter(([t]) => t === team).length;
  return n >= 4 ? ` <span class="pill">${n}G</span>` : n <= 2 ? ` <span class="pill two">${n}G</span>` : "";
}

/* ---------- leaders (home + fantasy hub) ---------- */
/* ---------- the evidence behind a number: games played, last 5 games, where the points come from ---------- */
const G5_KEYS = ["G", "A", "PPP", "SHP", "SOG", "HIT", "BLK", "PM"];
const STAT_NAME = { G: "goals", A: "assists", PPP: "power-play points", SHP: "shorthanded points", SOG: "shots", HIT: "hits", BLK: "blocks", PM: "plus/minus", PIM: "penalty minutes" };
const scale = f => f.type === "points" ? f : FORMATS.espn;   // category leagues read the bars on the ESPN points scale
const ratePts = (f, stat) => Object.entries(scale(f).sk).reduce((a, [k, w]) => a + w * (stat(k) || 0), 0);
const gamePts = (g, f) => G5_KEYS.reduce((a, k, i) => a + (scale(f).sk[k] || 0) * g[i], 0);
function sparks(p, f) {
  if (isG(p) || !p.g5 || !p.g5.length) return `<span class="muted small">none</span>`;
  const pts = p.g5.slice().reverse().map(g => gamePts(g, f)), avg = perGamePoints(p, scale(f)), top = Math.max(3, ...pts);
  const label = pts.map(x => fmt(x, 1)).join(", ");
  return `<span class="spark" role="img" aria-label="Last ${pts.length} games, oldest first: ${label}" title="Last ${pts.length} games, oldest first: ${label}">${
    pts.map(x => `<i class="${x >= avg ? "hi" : ""}" style="height:${Math.round(10 + 90 * Math.max(0, x) / top)}%"></i>`).join("")}</span>`;
}
const played = p => `${p.gp}<span class="meta">${p.rgp || 0} in 14d</span>`;
const whyBtn = `<button class="why" type="button" aria-expanded="false">Why</button>`;
function why(p, f) {
  const sc = scale(f), v = perGamePoints(p, sc), rate = (src, n) => ratePts(f, k => src[k]) / n;
  const parts = Object.keys(sc.sk).map(k => [k, sc.sk[k] * blend(p, k, "gp")]).filter(([, x]) => x >= 0.01).sort((a, b) => b[1] - a[1]);
  const tot = parts.reduce((a, [, x]) => a + x, 0) || 1, share = ks => parts.filter(([k]) => ks.includes(k)).reduce((a, [, x]) => a + x, 0) / tot;
  const last = ownLast(p) ? rate(Object.fromEntries(LS_SK.map((k, i) => [k, p.ls[1 + i]])), p.ls[0]) : null;
  const w = p.r && p.rgp ? recentWeight(p.rgp) : 0, g5 = (p.g5 || []).slice().reverse().map(g => gamePts(g, f));
  const atAvg = g5.filter(x => x >= v).length, grind = share(["HIT", "BLK", "SOG"]), scoring = share(["G", "A", "PPP", "SHP"]);
  return `<div class="whybox"><p><strong>${fmt(v, 2)} ${sc === f ? "points" : "points on the ESPN scale"} a game.</strong> Where it comes from: ${
      parts.map(([k, x]) => `${STAT_NAME[k]} ${fmt(x, 2)}`).join(", ")}.</p>
    <p>Built from <strong>${p.gp} games this season</strong> (${fmt(rate(p.s, Math.max(p.gp, 1)), 2)} a game)${last !== null
      ? `, steadied by <strong>${p.ls[0]} games last season</strong> (${fmt(last, 2)} a game, counted like ${PRIOR_OWN} games)`
      : `, steadied toward a typical regular at his position (no full season behind him, counted like ${PRIOR_BASE} games)`}${w
      ? `, plus the <strong>last 14 days: ${p.rgp} games</strong> (${fmt(rate(p.r, p.rgp), 2)} a game) at ${Math.round(w * 100)}% weight${p.rgp < RECENT_FULL ? ` (full 30% needs ${RECENT_FULL} games)` : ""}` : ""}.</p>
    ${g5.length ? `<p><strong>Last ${g5.length} games</strong>, oldest first: ${g5.map(x => fmt(x, 1)).join(", ")}. ${atAvg} of ${g5.length} at or above his ${fmt(v, 2)}.${(() => {
      const bn = bigNights(p, sc); return bn.games.length ? ` His ${bn.games.map(x => fmt(x, 1)).join(" and ")} night${bn.games.length > 1 ? "s count" : " counts"} as ${fmt(bn.cap, 1)} in recent form (one night is capped at ${BIG_NIGHT}x his usual), so a single big game can't carry the number.` : ""; })()}</p>` : ""}
    <p class="note">${grind >= 0.4 ? `${Math.round(grind * 100)}% of his value is shots, hits and blocks, which show up most nights, so his floor is steadier than a pure scorer's.`
      : scoring >= 0.75 ? `${Math.round(scoring * 100)}% of his value rides on goals and assists, so expect bigger swings night to night.` : "A mix of scoring and steady stats."}</p></div>`;
}
const whyRow = (p, f, cols) => `<tr class="detail" hidden><td colspan="${cols}">${why(p, f)}</td></tr>`;
const METHOD = `Per game: this season, steadied by his last season (or a typical regular at his position), plus up to 30% from the last 14 days. Bars are his last 5 games, lit when at or above his average. Tap Why for the numbers behind any player.`;
document.addEventListener("click", e => {
  const b = e.target.closest && e.target.closest(".why");
  if (!b) return;
  const row = b.closest("tr").nextElementSibling, open = b.getAttribute("aria-expanded") === "true";
  if (row && row.classList.contains("detail")) { row.hidden = open; b.setAttribute("aria-expanded", String(!open)); b.textContent = open ? "Why" : "Hide"; }
});

function leadersTable(fkey, limit = 12, waiverOnly = true) {
  const f = FORMATS[fkey];
  const all = DATA.skaters.filter(p => p.gp >= 5).map(p => ({ p, v: perGame(p, f, fkey) })).sort((a, b) => b.v - a.v);
  const list = (waiverOnly ? all.slice(150) : all).filter(x => x.p.rgp >= 3).slice(0, limit);
  const unit = f.type === "points" ? "Per game" : "Value per game";
  return `<div class="scroll"><table class="ev"><thead><tr><th>#</th><th>Player</th><th class="num">Games</th><th>Last 5</th><th class="num">${unit}</th></tr></thead><tbody>${
    list.map((x, i) => `<tr><td class="muted">${i + 1}</td><td>${who(x.p)} ${whyBtn}</td><td class="num">${played(x.p)}</td><td>${sparks(x.p, f)}</td><td class="num led">${fmt(x.v, 2)}</td></tr>${whyRow(x.p, f, 5)}`).join("")
  }</tbody></table></div><p class="note">${METHOD}</p>`;
}
function tabs(el, onPick) {
  const L = league(), keys = Object.keys(FORMATS), start = L.k;
  el.innerHTML = keys.map(k => `<button type="button" data-k="${k}" aria-pressed="${k === start}">${FORMATS[k].name.split(" (")[0]}</button>`).join("");
  el.addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return;
    el.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", x === b));
    store.set("league", { ...league(), k: b.dataset.k });   // the format you pick is remembered on every page
    onPick(b.dataset.k); });
  onPick(start);
}

/* ---------- this week, tonight, and the visitor's own team ---------- */
let CUT = {};
function waiverCut(k) {   // a skater below the 150th-best in this format is likely on waivers
  if (CUT[k] !== undefined) return CUT[k];
  const v = DATA.skaters.filter(p => p.gp >= 5).map(p => perGame(p, FORMATS[k], k)).sort((a, b) => b - a);
  return (CUT[k] = v[Math.min(149, v.length - 1)]);
}
/* ---------- ESPN league sync: paste a public league link, or one click on ESPN for a private league ---------- */
const ESPN_TEAM = { 1: "BOS", 2: "BUF", 3: "CGY", 4: "CHI", 5: "DET", 6: "EDM", 7: "CAR", 8: "LAK", 9: "DAL", 10: "MTL", 11: "NJD", 12: "NYI", 13: "NYR", 14: "OTT",
  15: "PHI", 16: "PIT", 17: "COL", 18: "SJS", 19: "STL", 20: "TBL", 21: "TOR", 22: "VAN", 23: "WSH", 25: "ANA", 26: "FLA", 27: "NSH", 28: "WPG", 29: "CBJ", 30: "MIN",
  37: "VGK", 124292: "SEA", 129764: "UTA" };
const ESPN_SLOT = { 0: "C", 1: "LW", 2: "RW", 3: "F", 4: "D", 5: "G", 6: "UTIL" };   // 7 bench, 8 IR
const ESPN_STAT = { 13: "G", 14: "A", 15: "PM", 38: "PPP", 39: "SHP", 29: "SOG", 31: "HIT", 32: "BLK", 1: "W", 4: "GA", 6: "SV", 7: "SO", 9: "OTL" };   // checked against an ESPN default league
const G_STAT = new Set(["W", "GA", "SV", "SO", "OTL"]);
const espnURL = (lid, season) => `https://lm-api-reads.fantasy.espn.com/apis/v3/games/fhl/seasons/${season}/segments/0/leagues/${lid}?view=mSettings&view=mTeam&view=mRoster&view=mMatchup&view=mStatus`;
let LEAGUE = null, TAKEN = new Set(), ELIG = {}, LINEUP = {}, INJ = {}, GSTART = {};
const FA_GOALIE_FILTER = JSON.stringify({ players: { filterSlotIds: { value: [5] }, filterStatus: { value: ["FREEAGENT", "WAIVERS"] }, limit: 40, sortPercOwned: { sortPriority: 1, sortAsc: false } } });
const startsOf = p => Object.entries(p.starterStatusByProGame || {}).sort((a, b) => a[0] - b[0]).slice(-4).map(([g, st]) => g + ":" + st[0]).join(",");
async function faGoalies(lid, season) {   // free-agent goalies in the league, with ESPN's expected and confirmed starts
  const j = await fetch(`https://lm-api-reads.fantasy.espn.com/apis/v3/games/fhl/seasons/${season}/segments/0/leagues/${lid}?view=kona_player_info`, { headers: { "x-fantasy-filter": FA_GOALIE_FILTER } }).then(r => r.json());
  return (j.players || []).map(x => [x.player.fullName, x.player.proTeamId, startsOf(x.player), x.player.injuryStatus && x.player.injuryStatus !== "ACTIVE" ? x.player.injuryStatus : ""]);
}
async function espnDates(season) {   // ESPN game id -> date, for the next two weeks; ESPN's schedule is big, so once a day per browser
  const day = todayISO(), c = store.get("espnDates", null);
  if (c && c.day === day && c.season === season) return c.map;
  const j = await fetch(`https://lm-api-reads.fantasy.espn.com/apis/v3/games/fhl/seasons/${season}?view=proTeamSchedules_wl`).then(r => r.json());
  const map = {}, lo = addDays(day, -1), hi = addDays(day, 14);
  (j.settings.proTeams || []).forEach(t => Object.values(t.proGamesByScoringPeriod || {}).flat().forEach(g => {
    const d = new Date(g.date).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    if (d >= lo && d <= hi) map[g.id] = d; }));
  store.set("espnDates", { day, season, map });
  return map;
}
const normName = s => s.normalize("NFKD").replace(/[^a-z0-9]/gi, "").toLowerCase();
let NAMEIDX = null;
function playerByName(name, pro, elig = "") {
  if (!NAMEIDX) { NAMEIDX = new Map(); everyone().forEach(p => { const k = normName(p.n); NAMEIDX.set(k, (NAMEIDX.get(k) || []).concat(p)); }); }
  // "Elias N. Pettersson": ESPN adds a middle initial to tell same-name players apart; the NHL doesn't
  let hits = NAMEIDX.get(normName(name)) || NAMEIDX.get(normName(name.replace(/\s[A-Z]\.?(?=\s)/g, ""))) || [];
  if (hits.length > 1) hits = hits.filter(p => p.t === ESPN_TEAM[pro]);
  if (hits.length > 1 && elig) {   // same name, same team: ESPN's slots say goalie, defenseman or forward
    const e = elig.split(".");
    hits = hits.filter(p => e.includes("5") ? p.p === "G" : e.includes("4") && !e.includes("3") ? p.p === "D" : "CLR".includes(p.p));
  }
  return hits.length === 1 ? hits[0] : null;
}
// The same trim runs inside the bookmarklet (bookmarklet.js), so both paths hand the page one small snapshot.
function espnTrim(j, lid, season, tid) {
  const S = j.settings, cur = j.status.currentMatchupPeriod;
  const m = j.schedule.find(x => x.matchupPeriodId === cur && x.home && x.away && (x.home.teamId === tid || x.away.teamId === tid));
  const me = m && m.home.teamId === tid ? m.home : m && m.away, them = m && m.home.teamId === tid ? m.away : m && m.home;
  return { v: 1, lid, season, tid, name: S.name, type: S.scoringSettings.scoringType, slots: S.rosterSettings.lineupSlotCounts,
    score: S.scoringSettings.scoringItems.filter(i => i.points).map(i => [i.statId, i.points]),
    acq: S.acquisitionSettings.matchupAcquisitionLimit, wday: (S.acquisitionSettings.waiverProcessDays || [])[0] || "",
    opp: them ? them.teamId : null, pts: me ? [me.totalPoints || 0, them.totalPoints || 0] : null,
    teams: j.teams.map(t => [t.id, t.name || t.abbrev, (t.roster ? t.roster.entries : []).map(e => { const p = e.playerPoolEntry.player;
      return [p.fullName, p.proTeamId, e.lineupSlotId, p.eligibleSlots.filter(s => s < 7).join("."), p.injuryStatus && p.injuryStatus !== "ACTIVE" ? p.injuryStatus : "",
        Object.entries(p.starterStatusByProGame || {}).sort((a, b) => a[0] - b[0]).slice(-4).map(([g, st]) => g + ":" + st[0]).join(",")]; })]),
    at: Date.now() };
}
function applyLeague(snap) {
  LEAGUE = snap; TAKEN = new Set(); ELIG = {}; LINEUP = {}; INJ = {}; GSTART = {};
  const dates = snap.dates || {};
  const addStarts = (p, starts) => (starts || "").split(",").filter(Boolean).forEach(x => { const [g, st] = x.split(":"), d = dates[g];
    if (d) (GSTART[d] = GSTART[d] || {})[p.t] = { id: p.id, s: st === "C" ? "Confirmed" : "Expected" }; });
  const rosterOf = tid => (snap.teams.find(t => t[0] === tid) || [0, "", []])[2];
  snap.teams.forEach(t => t[2].forEach(([n, pro, , el, inj, starts]) => { const p = playerByName(n, pro, el);
    if (!p) return; TAKEN.add(p.id); if (inj) INJ[p.id] = inj; addStarts(p, starts); }));
  (snap.fag || []).forEach(([n, pro, starts, inj]) => { const p = playerByName(n, pro, "5"); if (!p) return; if (inj) INJ[p.id] = inj; addStarts(p, starts); });
  const mine = [], missing = [];
  rosterOf(snap.tid).forEach(([n, pro, slot, el, inj]) => {
    const p = playerByName(n, pro, el);
    if (!p) { missing.push(n); return; }
    ELIG[p.id] = el.split(".").map(s => ESPN_SLOT[s]).filter(Boolean);
    LINEUP[p.id] = slot;
    if (slot !== 8) mine.push(p.id);   // injured reserve doesn't play
  });
  LEAGUE.missing = missing;
  LEAGUE.oppIds = snap.opp == null ? [] : rosterOf(snap.opp).filter(e => e[2] !== 8).map(([n, pro, , el]) => playerByName(n, pro, el)).filter(Boolean).map(p => p.id);
  LEAGUE.oppName = snap.opp == null ? "" : (snap.teams.find(t => t[0] === snap.opp) || [0, "your opponent"])[1];
  LEAGUE.myName = (snap.teams.find(t => t[0] === snap.tid) || [0, ""])[1];
  store.set("team", mine);
  const slots = {};
  Object.entries(snap.slots).forEach(([id, c]) => { if (ESPN_SLOT[id] && c) slots[ESPN_SLOT[id]] = c; });
  store.set("slotsLeague", slots); store.set("slots", "league");
  if (/POINTS/.test(snap.type) || snap.score.length) {
    const sk = {}, g = {}, unknown = [];
    snap.score.forEach(([id, w]) => { const k = ESPN_STAT[id]; if (!k) unknown.push(id); else (G_STAT.has(k) ? g : sk)[k] = w; });
    LEAGUE.unknown = unknown;
    if (/POINTS/.test(snap.type)) store.set("league", { k: "custom", custom: sk, customG: g, customName: "Your ESPN league" });
  }
}
async function fetchLeague(lid, season, tid) {
  const r = await fetch(espnURL(lid, season));
  if (r.status === 401 || r.status === 403) throw new Error("private");
  if (!r.ok) throw new Error("status " + r.status);
  const j = await r.json();
  return { j, snap: tid ? espnTrim(j, lid, season, tid) : null };
}
async function loadLeague() {   // every visit: public leagues refresh from ESPN; private ones use the last one-click sync
  const hash = location.hash;
  if (hash.startsWith("#espn=")) {
    try { const snap = JSON.parse(decodeURIComponent(hash.slice(6))); store.set("espn", { lid: snap.lid, season: snap.season, tid: snap.tid, private: true, snap }); }
    catch { store.set("espnError", "That sync link was cut off. Click the bookmark on ESPN again."); }
    history.replaceState(null, "", location.pathname + location.search);
  } else if (hash.startsWith("#espn-error")) {
    store.set("espnError", "Open your team page on ESPN Fantasy Hockey first, then click the bookmark.");
    history.replaceState(null, "", location.pathname + location.search);
  }
  const E = store.get("espn", null);
  if (!E) return null;
  const dates = await espnDates(E.season).catch(() => ({}));
  if (E.private && E.snap) { applyLeague({ ...E.snap, dates }); return LEAGUE; }
  try { const { snap } = await fetchLeague(E.lid, E.season, E.tid); snap.fag = await faGoalies(E.lid, E.season).catch(() => []); snap.dates = dates; applyLeague(snap); return LEAGUE; }
  catch (err) { store.set("espnError", err.message === "private" ? "ESPN says this league is private now. Use the one-click sync below." : "Couldn't reach ESPN just now. Showing your saved roster."); return null; }
}
const isFree = (p, k, cut) => LEAGUE ? !TAKEN.has(p.id) : perGame(p, FORMATS[k], k) < cut;
function bookmarkletHref() {
  const src = `(async()=>{const q=new URLSearchParams(location.search),lid=q.get("leagueId"),season=q.get("seasonId")||"${SEASON_ESPN}",home="${location.origin}${location.pathname.replace(/[^/]*$/, "")}team.html";`
    + `if(!/espn\\.com$/.test(location.hostname)||!lid){location.href=home+"#espn-error=open-league";return}`
    + `const j=await fetch("https://lm-api-reads.fantasy.espn.com/apis/v3/games/fhl/seasons/"+season+"/segments/0/leagues/"+lid+"?view=mSettings&view=mTeam&view=mRoster&view=mMatchup&view=mStatus",{credentials:"include"}).then(r=>r.json());`
    + `const sw=decodeURIComponent((document.cookie.match(/SWID=([^;]+)/)||[])[1]||"");const tid=+q.get("teamId")||(j.teams.find(t=>(t.owners||[]).includes(sw))||{}).id;`
    + `const espnTrim=${espnTrim.toString()};const snap=espnTrim(j,lid,season,tid);`
    + `try{const fj=await fetch("https://lm-api-reads.fantasy.espn.com/apis/v3/games/fhl/seasons/"+season+"/segments/0/leagues/"+lid+"?view=kona_player_info",{credentials:"include",headers:{"x-fantasy-filter":${JSON.stringify(FA_GOALIE_FILTER)}}}).then(r=>r.json());`
    + `snap.fag=(fj.players||[]).map(x=>[x.player.fullName,x.player.proTeamId,Object.entries(x.player.starterStatusByProGame||{}).sort((a,b)=>a[0]-b[0]).slice(-4).map(([g,s])=>g+":"+s[0]).join(","),x.player.injuryStatus&&x.player.injuryStatus!=="ACTIVE"?x.player.injuryStatus:""])}catch(e){}`
    + `location.href=home+"#espn="+encodeURIComponent(JSON.stringify(snap))})()`;
  return "javascript:" + encodeURIComponent(src);
}
const SEASON_ESPN = "2027";   // ESPN names a season by the year it ends
function parseLeagueLink(text) {
  try { const u = new URL(text.trim().startsWith("http") ? text.trim() : "https://" + text.trim()); const lid = u.searchParams.get("leagueId");
    return lid ? { lid, season: u.searchParams.get("seasonId") || SEASON_ESPN, tid: +u.searchParams.get("teamId") || null } : null; }
  catch { return null; }
}
function lineupFix(Z, d, mine, f, k) {   // ESPN's saved lineup against the best one, for players who play that night
  if (!LEAGUE) return null;
  const playing = mine.filter(p => Z.plays.has(p.t + d));
  const rows = playing.filter(p => !isOut(p) && startOn(p, d) > 0).map(p => ({ p, v: perGame(p, f, k) }));
  const { used } = nightLineup(rows, slotSet());
  const benchIn = rows.filter(r => used.has(r.p.id) && LINEUP[r.p.id] === 7).sort((a, b) => b.v - a.v);
  // starters to pull: the out ones first (they score nothing), then the weakest who lost their spot
  const dead = playing.filter(p => (isOut(p) || startOn(p, d) === 0) && LINEUP[p.id] !== 7 && LINEUP[p.id] !== 8).map(p => ({ p, v: 0, out: true }));
  const displaced = rows.filter(r => !used.has(r.p.id) && LINEUP[r.p.id] !== 7 && LINEUP[r.p.id] !== 8).sort((a, b) => a.v - b.v);
  if (!benchIn.length) return null;   // an out starter only matters if someone on the bench can take the spot
  const ins = benchIn, canFill = r => ins.some(x => isG(x.p) === isG(r.p));
  const outs = dead.filter(canFill).concat(displaced);
  return { ins, outs, gain: ins.reduce((a, r) => a + r.v * startOn(r.p, d), 0) - outs.reduce((a, r) => a + r.v * (r.out ? 0 : startOn(r.p, d)), 0) };
}
function fixText(fx) {   // who to start and who to bench; ESPN moves the slots around for you
  const nm = r => esc(r.p.n) + (r.out ? (isG(r.p) ? " (not starting)" : " (out)") : "");
  return "Lineup fix tonight: start " + fx.ins.map(nm).join(", ") + (fx.outs.length ? "; bench " + fx.outs.map(nm).join(", ") : "")
    + (fx.gain > 0.05 ? `. About +${fmt(fx.gain, 1)} points.` : ".");
}

/* ---------- shared: the header scoring picker and the night board ---------- */
const LEAGUE_CBS = [];
const onLeague = fn => LEAGUE_CBS.push(fn);
function initScoring() {   // one picker in the header; every tool on the page re-scores when it changes
  const sel = $("#fmt");
  if (!sel) return;
  league();   // registers your league's own scoring first, so it shows in the list
  sel.innerHTML = Object.keys(FORMATS).map(k => `<option value="${k}">${esc(FORMATS[k].name.split(" (")[0])}</option>`).join("");
  sel.value = league().k;
  sel.addEventListener("change", () => { store.set("league", { ...league(), k: sel.value }); LEAGUE_CBS.forEach(fn => fn()); });
}
function boardHTML(days, sel, tile) {
  const today = todayISO();
  return days.map(d => { const t = tile(d);
    return `<button type="button" class="tile ${t.kind}${d === today ? " today" : ""}" data-d="${d}" aria-pressed="${d === sel}" aria-label="${dayName(d)} ${dayDate(d)}, ${t.aria}">`
      + `<span class="dn">${dayName(d)}</span><span class="dd">${dayDate(d)}</span><b>${t.num}</b><span class="dl">${t.label}</span></button>`; }).join("");
}
function sweep(el) { el.classList.remove("sweep"); void el.offsetWidth; el.classList.add("sweep"); }
function segment(el, onPick) {
  el.addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return;
    el.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", x === b)); onPick(b); });
}
const longDate = d => new Date(d + "T12:00Z").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
const teamsOn = (Z, d) => Z.teams.filter(t => Z.plays.has(t + d));
const recentRate = (p, f) => f.type === "points" && p.r && p.rgp >= 3 ? Object.entries(f.sk).reduce((s, [k, w]) => s + w * (p.r[k] || 0), 0) / p.rgp : null;   // last 14 days only: who is hot
const who = p => `${esc(p.n)}<span class="meta">${esc(p.t)} ${POS[p.p]}</span>${badge(p)}`;
function myRoster() { const byId = new Map(everyone().map(p => [p.id, p])); return store.get("team", []).map(id => byId.get(id)).filter(Boolean); }
function nightStreamers(Z, d, k, n, fitsOpen) {
  const f = FORMATS[k], teams = new Set(teamsOn(Z, d)), cut = waiverCut(k), have = new Set(store.get("team", []));
  return DATA.skaters.filter(p => teams.has(p.t) && !have.has(p.id) && p.gp >= 5 && p.rgp >= 3 && !isOut(p) && (!fitsOpen || fitsOpen(p)) && isFree(p, k, cut))
    .map(p => ({ p, v: perGame(p, f, k), r: recentRate(p, f) }))
    .sort((a, b) => (b.r ?? b.v) + b.v - ((a.r ?? a.v) + a.v)).slice(0, n);   // rank by blended rate plus recent form, so hot players rise
}
function nightGoalies(Z, d, k, n) {
  const f = FORMATS[k], teams = new Set(teamsOn(Z, d));
  return DATA.goalies.filter(g => teams.has(g.t) && g.gs >= 3 && !isOut(g)).map(g => ({ p: g, share: startOn(g, d), call: ((GSTART[d] || {})[g.t] || {}).id === g.id ? GSTART[d][g.t].s : "", v: perGame(g, f, k) }))
    .filter(x => x.share >= 0.35).sort((a, b) => b.share * b.v - a.share * a.v).slice(0, n);
}
function standingsHTML(standings) {
  const byDiv = {};
  standings.rows.forEach(r => (byDiv[r.divisionName] = byDiv[r.divisionName] || []).push(r));
  return Object.entries(byDiv).map(([div, rows]) => `<div><h3>${esc(div)}</h3><table><thead><tr><th>Team</th><th class="num">GP</th><th class="num">PTS</th><th class="num">GD</th></tr></thead><tbody>${
    rows.sort((a, b) => b.points - a.points).map(r => `<tr><td>${esc(r.teamAbbrev)}</td><td class="num">${r.gamesPlayed}</td><td class="num led">${r.points}</td><td class="num">${r.goalDifferential > 0 ? "+" : ""}${r.goalDifferential}</td></tr>`).join("")}</tbody></table></div>`).join("");
}

/* ---------- lineup spots: presets plus your own ---------- */
const SLOTS = {
  espn: { name: "ESPN classic (2C 2LW 2RW 4D 1UTIL 2G)", s: { C: 2, LW: 2, RW: 2, D: 4, UTIL: 1, G: 2 } },
  espnf: { name: "ESPN forwards (9F 5D 1UTIL 2G)", s: { F: 9, D: 5, UTIL: 1, G: 2 } },
  yahoo: { name: "Yahoo default (2C 2LW 2RW 4D 2G)", s: { C: 2, LW: 2, RW: 2, D: 4, G: 2 } },
  fdg: { name: "Forwards / D / G (6F 4D 2G)", s: { F: 6, D: 4, G: 2 } },
  custom: { name: "Custom spots", s: null },
  league: { name: "Your ESPN league's spots", s: null },
};
const SLOT_KEYS = ["C", "LW", "RW", "F", "D", "UTIL", "G"];
function slotKey() { const k = store.get("slots", "espn"); return SLOTS[k] && (k !== "league" || store.get("slotsLeague", null)) ? k : "espn"; }
function slotSet() { const k = slotKey(); return k === "custom" ? store.get("slotsCustom", { F: 9, D: 5, UTIL: 1, G: 2 }) : k === "league" ? store.get("slotsLeague") : SLOTS[k].s; }
const POS = { C: "C", L: "LW", R: "RW", D: "D", G: "G" };
const fits = (p, slot) => ELIG[p.id] ? ELIG[p.id].includes(slot) : slot === POS[p.p] || (slot === "F" && "CLR".includes(p.p)) || (slot === "UTIL" && p.p !== "G");
const startShare = p => isG(p) ? Math.min(1, p.gs / Math.max(DATA.teams[p.t].played, 1)) : 1;   // a goalie only counts when he starts
// Out: his team played at least twice in the last 7 days and he didn't dress (injury, suspension, scratch, sent down), or ESPN lists him out
const OUT_INJ = new Set(["OUT", "INJURY_RESERVE", "SUSPENSION"]);
const missing = p => !isG(p) && p.gp >= 3 && (DATA.teams[p.t] || {}).g7 >= 2 && !p.l7;
// Status order: the daily injury list (p.inj), then ESPN's fantasy flag (INJ), then the missing-games check
const LIST_OUT = new Set(["Out", "Injured Reserve", "Suspension"]);
const isOut = p => (p.inj && LIST_OUT.has(p.inj.s)) || OUT_INJ.has(INJ[p.id]) || missing(p);
function outLabel(p) {
  const s = p.inj ? p.inj.s : "", f = INJ[p.id] || "";
  if (s === "Suspension" || f === "SUSPENSION") return "SUSP";
  if (s === "Injured Reserve" || f === "INJURY_RESERVE") return "IR";
  if (isOut(p)) return "OUT";
  return s === "Day-To-Day" || f === "DAY_TO_DAY" ? "DTD" : "";
}
const injNote = p => p.inj ? [p.inj.type, p.inj.ret ? "expected back about " + dayDate(p.inj.ret) : ""].filter(Boolean).join(", ")
  : missing(p) ? "hasn't dressed in his team's recent games" : "";
const badge = p => { const l = outLabel(p); return l ? ` <span class="pill ${l === "DTD" ? "amber" : "out"}" title="${esc(injNote(p) || l)}">${l}</span>` : ""; };
function startOn(p, d) {   // ESPN's expected or confirmed starter takes the night; his teammate gets none
  if (!isG(p)) return 1;
  const g = (GSTART[d] || {})[p.t];
  return g ? (g.id === p.id ? 1 : 0) : startShare(p);
}
function nightLineup(playing, slots) {
  // Positions come from the NHL (one each), so filling each position's own slots by value, then UTIL with the best leftover, is the best lineup.
  const left = { ...slots }, used = new Map(), order = [...playing].sort((a, b) => b.v - a.v);
  for (const pass of [s => s !== "UTIL", s => s === "UTIL"])
    for (const x of order) {
      if (used.has(x.p.id)) continue;
      const slot = Object.keys(left).find(s => pass(s) && left[s] > 0 && fits(x.p, s));
      if (slot) { left[slot]--; used.set(x.p.id, slot); }
    }
  return { used, left };
}
function usableWeek(Z, mine, from, to, slots, f, key) {
  const rows = mine.map(p => ({ p, v: perGame(p, f, key), games: 0, used: 0, light: 0 }));
  const nights = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const n = Z.perDay.get(d) || 0;
    const playing = rows.filter(r => Z.plays.has(r.p.t + d) && !isOut(r.p) && startOn(r.p, d) > 0);   // out players and goalies who won't start don't dress
    playing.forEach(r => { r.games++; if (n && n <= LIGHT) r.light++; });
    const { used, left } = nightLineup(playing, slots);
    used.forEach((_, id) => { const r = rows.find(x => x.p.id === id); r.used += startOn(r.p, d); });
    nights.push({ d, n, left, playing, used });
  }
  return { rows, nights };
}
const openSkaters = left => Object.entries(left).filter(([s]) => s !== "G").reduce((a, [, k]) => a + k, 0);
function bestAdds(Z, wk, mine, f, key) {
  const cut = waiverCut(key), have = new Set(mine.map(p => p.id));
  return DATA.skaters.filter(p => !have.has(p.id) && p.gp >= 5 && p.rgp >= 3 && !isOut(p) && isFree(p, key, cut)).map(p => ({ p, v: perGame(p, f, key) }))
    .map(x => ({ ...x, add: wk.nights.filter(nt => nt.n && Z.plays.has(x.p.t + nt.d) && Object.keys(nt.left).some(s => nt.left[s] > 0 && fits(x.p, s))).length }))
    .filter(x => x.add).map(x => ({ ...x, total: x.add * x.v })).sort((a, b) => b.total - a.total).slice(0, 8);
}
function weekTotals(W) {
  return W.rows.reduce((a, r) => ({ g: a.g + r.games * startShare(r.p), u: a.u + r.used }), { g: 0, u: 0 });
}

/* ---------- Home: the Arena. Four full-screen sections side by side under giant headline tabs; swipe, scroll or click ---------- */
const TEAM_COLORS = { ANA: ["#F47A38", "#B9975B"], BOS: ["#FFB81C", "#111111"], BUF: ["#003087", "#FFB81C"], CGY: ["#C8102E", "#F1BE48"],
  CAR: ["#CE1126", "#111111"], CHI: ["#CF0A2C", "#111111"], COL: ["#6F263D", "#236192"], CBJ: ["#002654", "#CE1126"], DAL: ["#006847", "#8F8F8C"],
  DET: ["#CE1126", "#FFFFFF"], EDM: ["#041E42", "#FF4C00"], FLA: ["#C8102E", "#041E42"], LAK: ["#111111", "#A2AAAD"], MIN: ["#154734", "#A6192E"],
  MTL: ["#AF1E2D", "#192168"], NSH: ["#FFB81C", "#041E42"], NJD: ["#CE1126", "#111111"], NYI: ["#00539B", "#F47D30"], NYR: ["#0038A8", "#CE1126"],
  OTT: ["#C52032", "#C2912C"], PHI: ["#F74902", "#111111"], PIT: ["#FCB514", "#111111"], SJS: ["#006D75", "#EA7200"], SEA: ["#001628", "#99D9D9"],
  STL: ["#002F87", "#FCB514"], TBL: ["#002868", "#FFFFFF"], TOR: ["#00205B", "#FFFFFF"], UTA: ["#71AFE5", "#090909"], VAN: ["#00205B", "#00843D"],
  VGK: ["#B4975A", "#333F42"], WSH: ["#041E42", "#C8102E"], WPG: ["#041E42", "#AC162C"] };
const lum = hex => { const n = parseInt(hex.slice(1), 16), c = [n >> 16, (n >> 8) & 255, n & 255].map(v => { v /= 255; return v <= .04 ? v / 12.9 : ((v + .055) / 1.055) ** 2.4; });
  return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]; };
const ARENA = { tab: 0, night: null, team: null, Z: null, teams: {}, names: {}, stand: {}, games: [] };
const ARENA_KEYS = ["tonight", "mine", "teams", "tools"];
function tbadge(t, cls = "") {   // team colors, not logos: recognition without using trademarks
  const [a, b] = TEAM_COLORS[t] || ["#33475e", "#8a9db2"];
  return `<span class="tb ${cls}" style="--c1:${a};--c2:${b};--fg:${lum(a) > .35 ? "#0b0f14" : "#fff"}" title="${esc(ARENA.names[t] || t)}">${esc(t)}</span>`;
}
const mmss = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const dateLong = d => new Date(d + "T12:00Z").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
const whyFold = (p, f) => isG(p) ? "" : `<details class="ar-why"><summary>Why</summary>${why(p, f)}</details>`;
document.addEventListener("pointermove", e => {   // cards catch a spotlight that follows the cursor
  const c = e.target.closest && e.target.closest(".spot, .panel"); if (!c) return;
  const r = c.getBoundingClientRect(); c.style.setProperty("--mx", `${e.clientX - r.left}px`); c.style.setProperty("--my", `${e.clientY - r.top}px`);
}, { passive: true });

function arenaTonight() {
  const Z = ARENA.Z, k = league().k, f = FORMATS[k], mon = mondayOf(todayISO()), d = ARENA.night || todayISO(), n = Z.perDay.get(d) || 0, kind = nightKind(n);
  const st = n ? nightStreamers(Z, d, k, 8) : [], gs = n ? nightGoalies(Z, d, k, 4) : [];
  const best = Z.teams.map(t => teamRange(Z, t, mon, addDays(mon, 6))).sort(bestFirst).slice(0, 6), mineT = myTeams();
  return `<div class="ar-nights">${Array.from({ length: 7 }, (_, i) => addDays(mon, i)).map(x => { const m = Z.perDay.get(x) || 0;
      return `<button type="button" data-night="${x}" class="${nightKind(m)}" aria-pressed="${x === d}"><span>${dayName(x)}</span><b>${m}</b><small>${dayDate(x)}</small></button>`; }).join("")}</div>
    <h2 class="ar-h">${d === todayISO() ? "Tonight" : dayName(d)}, ${dateLong(d).split(", ")[1]}<em class="${kind}">${n} ${n === 1 ? "game" : "games"}${kind === "light" ? ", a light night: benches have room" : kind === "packed" ? ", packed: set your lineup" : ""}</em></h2>
    <div class="ar-faceoffs">${ARENA.games.filter(g => g[0] === d).map(([, a, h]) => `<button type="button" class="ar-fo spot" data-team="${h}">${tbadge(a, "lg")}<span>at</span>${tbadge(h, "lg")}</button>`).join("") || `<p class="ar-quiet">No games. Pick another night.</p>`}</div>
    <h3 class="ar-h3">Streamers on this slate <small>${LEAGUE ? `free agents in ${esc(LEAGUE.name)}` : "likely on waivers"}</small></h3>
    <div class="ar-cards">${st.map(x => `<article class="ar-card spot">${tbadge(x.p.t)}<b>${esc(x.p.n)}${badge(x.p)}</b><strong>${vfmtA(x.v)}<i>per game</i></strong>
      <small>${POS[x.p.p]}, ${x.p.gp} games, ${x.p.rgp} in the last 14 days</small>${sparks(x.p, f)}${whyFold(x.p, f)}</article>`).join("") || `<p class="ar-quiet">Nobody to stream on a night with no games.</p>`}</div>
    ${gs.length ? `<h3 class="ar-h3">Likely in goal</h3><div class="ar-cards">${gs.map(x => `<article class="ar-card spot">${tbadge(x.p.t)}<b>${esc(x.p.n)}</b><strong>${vfmtA(x.v)}<i>per start</i></strong>
      <small>${x.call ? `<span class="pill${x.call === "Confirmed" ? "" : " amber"}">${x.call}</span>` : `${Math.round(x.share * 100)}% of his team's starts`}</small></article>`).join("")}</div>` : ""}
    <h3 class="ar-h3">Best schedules this week <small>most games, then most light-night games</small></h3>
    <div class="ar-best">${best.map(r => `<button type="button" class="ar-sched spot${mineT.has(r.t) ? " mine" : ""}" data-team="${r.t}">${tbadge(r.t)}<b>${r.games}</b><span>games, ${r.light} on light nights${r.b2b ? `, ${r.b2b} back-to-back` : ""}</span></button>`).join("")}</div>
    <h3 class="ar-h3">Waiver leaders <small>${esc(f.name)}</small></h3><div class="panel">${leadersTable(k, 10)}</div>
    <p class="ar-more"><a href="waiver-wire.html">Full waiver wire</a><a href="schedule.html">Schedule planner</a><a href="nhl-4-game-teams-this-week.html">4-game teams</a><a href="receipts.html">How our calls did</a></p>`;
}
const vfmtA = x => fmt(x, 2);
function teamVM(t) {
  const T = ARENA.teams[t], byId = new Map(everyone().map(p => [p.id, p])), k = league().k, f = FORMATS[k];
  const roster = T.roster.map(([id, n, pos, num]) => ({ id, n, pos, num, p: byId.get(id) }));
  const healthy = roster.filter(r => r.p && !isOut(r.p)), ice = r => r.p ? r.p.rt || r.p.toi : 0, LCR = (a, b) => "LCR".indexOf(a.pos) - "LCR".indexOf(b.pos);
  const F = healthy.filter(r => "CLR".includes(r.pos)).sort((a, b) => ice(b) - ice(a)), D = healthy.filter(r => r.pos === "D").sort((a, b) => ice(b) - ice(a));
  const L = T.lines, numOf = new Map(roster.map(r => [r.id, r.num]));
  const df = xs => xs.map(([id, n, pos, num]) => ({ id, n, pos: pos || (roster.find(r => r.id === id) || {}).pos || "", num: num ?? numOf.get(id), p: id ? byId.get(id) : null }));
  const lines = L ? L.f.map(df) : [0, 1, 2, 3].map(i => F.slice(i * 3, i * 3 + 3).sort(LCR)), pairs = L ? L.d.map(df) : [0, 1, 2].map(i => D.slice(i * 2, i * 2 + 2));
  const placed = new Set(lines.flat().concat(pairs.flat()).map(r => r.id));
  return { t, f, k, ice, name: ARENA.names[t] || t, record: ARENA.stand[t] || "", roster, src: L,
    lines, pairs, extra: L ? healthy.filter(r => r.pos !== "G" && !placed.has(r.id)) : F.slice(12).concat(D.slice(6)),
    G: L && L.g.length ? df(L.g).map(r => ({ ...r, pos: "G" })) : roster.filter(r => r.pos === "G" && r.p).sort((a, b) => b.p.gs - a.p.gs),
    pp1: L && L.pp1.length ? df(L.pp1) : healthy.filter(r => r.pos !== "G").sort((a, b) => b.p.pp - a.p.pp).slice(0, 5),
    out: roster.filter(r => r.p && isOut(r.p)), noGames: roster.filter(r => !r.p),
    sys: T.system.map(([id, n, pos, by]) => ({ id, n, pos, age: by ? new Date().getFullYear() - by : null })),
    next: ARENA.Z.byTeam[t].filter(g => g.d >= todayISO()).slice(0, 4) };
}
function arenaTeams() {
  const vm = teamVM(ARENA.team), nm = r => esc(r.p ? r.p.n : r.n);
  const jersey = (r, sub) => `<div class="ar-jersey spot"><b>${r.num ?? ""}</b><span>${nm(r)}${r.p ? badge(r.p) : ""}</span><small>${sub}</small></div>`;
  return `<div class="ar-rack" role="list">${Object.keys(ARENA.teams).sort().map(t => `<button type="button" role="listitem" data-team="${t}" aria-pressed="${t === vm.t}">${tbadge(t)}</button>`).join("")}</div>
    <div class="ar-teamhead">${tbadge(vm.t, "xl")}<div><h2>${esc(vm.name)}</h2><p>${vm.record ? vm.record + ". " : ""}Next: ${vm.next.map(g => `${dayName(g.d)} ${g.home ? "vs" : "@"} ${g.opp}`).join(", ")}</p></div></div>
    <p class="ar-note">${vm.src ? `Lines and power play from <a href="${esc(vm.src.url)}" rel="noopener">Daily Faceoff</a>${vm.src.at ? `, updated ${dayDate(vm.src.at)}` : ""}. Ice time is from the NHL's data over the last 14 days.`
      : "Lines by ice time over the last 14 days: who plays with whom by usage, not a confirmed lineup."}</p>
    <div class="ar-lines">${vm.lines.map((ln, i) => `<div class="ar-line"><span>Line ${i + 1}</span>${ln.map(r => jersey(r, `${POS[r.pos] || r.pos}${r.p ? `, ${mmss(vm.ice(r))} a game` : ""}`)).join("")}</div>`).join("")}
      ${vm.pairs.map((pr, i) => `<div class="ar-line d"><span>Pair ${i + 1}</span>${pr.map(r => jersey(r, `D${r.p ? `, ${mmss(vm.ice(r))} a game` : ""}`)).join("")}</div>`).join("")}
      <div class="ar-line g"><span>Goal</span>${vm.G.map(r => jersey(r, r.p ? `${r.p.gs} starts, ${Math.round(startShare(r.p) * 100)}%` : "no starts yet")).join("")}</div></div>
    <div class="ar-cols"><div><h3 class="ar-h3">Top power-play unit</h3>${vm.pp1.map(r => `<p class="ar-row">${nm(r)}<small>${r.p ? `${mmss(r.p.pp)} on the power play a game` : "no games yet"}</small></p>`).join("")}
      <h3 class="ar-h3">Out</h3>${vm.out.map(r => `<p class="ar-row">${nm(r)} ${badge(r.p)}<small>${esc(injNote(r.p) || "not dressing")}</small></p>`).join("") || `<p class="ar-quiet">Nobody.</p>`}
      ${vm.extra.length ? `<h3 class="ar-h3">Extras</h3>${vm.extra.map(r => `<p class="ar-row">${nm(r)}<small>${POS[r.pos] || r.pos}, ${mmss(vm.ice(r))}</small></p>`).join("")}` : ""}</div>
      <div><h3 class="ar-h3">In the system</h3><p class="ar-note">Signed or drafted, not on the NHL roster: AHL, junior, college or Europe.</p>${vm.sys.map(s => `<p class="ar-row">${esc(s.n)}<small>${POS[s.pos] || s.pos}${s.age ? `, age ${s.age}` : ""}</small></p>`).join("") || `<p class="ar-quiet">None listed.</p>`}
      ${vm.noGames.length ? `<h3 class="ar-h3">On the roster, no games yet</h3>${vm.noGames.map(r => `<p class="ar-row">${esc(r.n)}<small>${POS[r.pos] || r.pos}</small></p>`).join("")}` : ""}</div></div>
    <details class="panel fold"><summary>Standings</summary><div class="standings" id="standings"></div></details>`;
}
let STANDINGS = null;
function drawTeams() { $("#ar-teams").innerHTML = arenaTeams(); if (STANDINGS) $("#standings").innerHTML = standingsHTML(STANDINGS); }
function drawTonight() { $("#ar-tonight").innerHTML = arenaTonight(); }
function arenaGo(i, smooth = true) {
  const tr = $("#track"); if (!tr) return;
  tr.scrollTo({ left: i * tr.clientWidth, behavior: smooth && !matchMedia("(prefers-reduced-motion: reduce)").matches ? "smooth" : "auto" });
}
function arenaTrack() {
  const tr = $("#track"), words = [...document.querySelectorAll(".ar-words [data-go]")], puck = $(".ar-puck");
  const sync = () => {   // words and puck follow the swipe continuously, not just when it lands
    const p = tr.scrollLeft / Math.max(tr.clientWidth, 1), i = Math.round(p), nav = $(".ar-words").getBoundingClientRect();
    words.forEach((w, j) => { w.style.opacity = String(Math.max(.3, 1 - Math.abs(p - j) * .7)); w.toggleAttribute("aria-current", j === i); });
    const a = words[Math.floor(p)] || words[0], b = words[Math.ceil(p)] || a, t = p - Math.floor(p), ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    const x = (ra.left + ra.width / 2 - nav.left) * (1 - t) + (rb.left + rb.width / 2 - nav.left) * t + $(".ar-words").scrollLeft;
    puck.style.transform = `translateX(${x - 14}px) rotate(${p * 360}deg)`;
    if (i !== ARENA.tab) { ARENA.tab = i; history.replaceState(null, "", "#" + ARENA_KEYS[i] + (i === 2 ? "/" + ARENA.team : "")); a.scrollIntoView({ block: "nearest", inline: "nearest" }); }
  };
  tr.addEventListener("scroll", sync, { passive: true }); addEventListener("resize", () => { arenaGo(ARENA.tab, false); sync(); });
  $(".ar-words").addEventListener("click", e => { const w = e.target.closest("[data-go]"); if (!w) return; e.preventDefault(); arenaGo(+w.dataset.go); });
  $(".ar-words").addEventListener("keydown", e => { if (e.key === "ArrowRight") arenaGo(Math.min(3, ARENA.tab + 1)); if (e.key === "ArrowLeft") arenaGo(Math.max(0, ARENA.tab - 1)); });
  document.addEventListener("click", e => {
    const n = e.target.closest && e.target.closest("[data-night]"); if (n) { ARENA.night = n.dataset.night; drawTonight(); return; }
    const t = e.target.closest && e.target.closest("[data-team]"); if (t && ARENA.teams[t.dataset.team]) { ARENA.team = t.dataset.team; drawTeams(); if (ARENA.tab !== 2) arenaGo(2); history.replaceState(null, "", "#teams/" + ARENA.team); }
  });
  addEventListener("hashchange", () => {   // same-page links like index.html#tools (replaceState never fires this, so no loop)
    const [sec, arg] = location.hash.slice(1).split("/"), i = ARENA_KEYS.indexOf(sec); if (i < 0) return;
    if (i === 2 && arg && ARENA.teams[arg] && arg !== ARENA.team) { ARENA.team = arg; drawTeams(); }
    if (i !== ARENA.tab) arenaGo(i);
  });
  arenaGo(ARENA.tab, false); requestAnimationFrame(sync);
}
async function home() {
  const [players, S, teams, week, standings] = await Promise.all([load("players"), load("schedule"), load("teams"), load("week").catch(() => ({ names: {} })), load("standings").catch(() => null)]);
  DATA = players; ARENA.games = S.games; ARENA.Z = seasonIndex(S); ARENA.teams = teams.teams; ARENA.names = week.names || {}; STANDINGS = standings;
  ARENA.stand = Object.fromEntries(((standings || {}).rows || []).map(r => [r.teamAbbrev, `${r.wins}-${r.losses}-${r.otLosses}`]));
  await loadLeague();
  initScoring();
  const [sec, arg] = location.hash.slice(1).split("/");
  ARENA.tab = Math.max(0, ARENA_KEYS.indexOf(sec));
  ARENA.team = arg && ARENA.teams[arg] ? arg : (myRoster()[0] || {}).t || "COL";
  drawTonight(); drawTeams(); mountMyTeam(ARENA.Z);
  onLeague(() => { drawTonight(); drawTeams(); });
  arenaTrack();
  $("#updated").textContent = players.updated;
}

function renderConnect(Z) {
  const el = $("#connect"), E = store.get("espn", null), err = store.get("espnError", "");
  store.set("espnError", "");
  if (LEAGUE) {
    const ago = Math.round((Date.now() - LEAGUE.at) / 60000);
    el.innerHTML = `<h3>${esc(LEAGUE.name)}</h3><p class="note">Connected as <strong>${esc(LEAGUE.myName)}</strong>. ${E && E.private ? `Synced ${ago < 60 ? ago + " min" : Math.round(ago / 60) + " h"} ago; click the bookmark on ESPN to refresh.` : "Public league: refreshed from ESPN every visit."}
      Your roster, scoring, lineup spots and the league's free agents are loaded.${LEAGUE.missing.length ? ` Not matched: ${LEAGUE.missing.map(esc).join(", ")}.` : ""}${LEAGUE.unknown && LEAGUE.unknown.length ? " Your league scores a few stats we don't track yet (like faceoffs), so values leave those out." : ""}</p>
      <button class="btn" type="button" id="espn-off">Disconnect</button>`;
    $("#espn-off").addEventListener("click", () => { ["espn", "slotsLeague", "team"].forEach(k => store.set(k, k === "team" ? [] : null)); store.set("slots", "espn"); store.set("league", { k: "espn" }); location.reload(); });
    return;
  }
  el.innerHTML = `<h3>Connect your ESPN league</h3><p class="note">Paste the link to your team page on ESPN. We load your roster, your league's scoring and lineup spots, and who is actually free in your league.</p>
    ${err ? `<p class="alert">${esc(err)}</p>` : ""}
    <form class="inline" id="espn-form"><input id="espn-url" placeholder="fantasy.espn.com/hockey/team?leagueId=..." autocomplete="off" aria-label="ESPN league link"><button class="btn primary" type="submit">Connect</button></form>
    <div id="espn-pick"></div>
    <details class="private"><summary>Private league?</summary><p class="note">ESPN only shares a private league with its members, so it has to come from your browser. On a computer:</p>
    <ol class="note"><li>Drag this button to your bookmarks bar: <a class="btn bm" id="bm">Sync to Off-Night</a></li><li>Open your team page on ESPN Fantasy Hockey.</li><li>Click the bookmark. You'll land back here with everything loaded.</li></ol>
    <p class="note">Nothing goes to our server: the league data rides in the link to this page and stays in your browser. On a phone, the simplest route is making the league viewable to the public in ESPN's league settings.</p></details>`;
  $("#bm").setAttribute("href", bookmarkletHref());
  $("#bm").addEventListener("click", e => { e.preventDefault(); $("#bm").textContent = "Drag me to your bookmarks bar"; });
  $("#espn-form").addEventListener("submit", async e => {
    e.preventDefault();
    const L = parseLeagueLink($("#espn-url").value);
    if (!L) { $("#espn-pick").innerHTML = `<p class="alert">That link has no leagueId in it. Open your team page on ESPN and copy the address.</p>`; return; }
    $("#espn-pick").innerHTML = `<p class="note">Reading your league...</p>`;
    try {
      const { j } = await fetchLeague(L.lid, L.season, null);
      const done = tid => { store.set("espn", { lid: L.lid, season: L.season, tid }); location.reload(); };
      if (L.tid && j.teams.some(t => t.id === L.tid)) return done(L.tid);
      $("#espn-pick").innerHTML = `<label for="espn-team">Which team is yours?</label><select id="espn-team">${j.teams.map(t => `<option value="${t.id}">${esc(t.name || t.abbrev)}</option>`).join("")}</select>
        <button class="btn primary" type="button" id="espn-go">Use this team</button>`;
      $("#espn-go").addEventListener("click", () => done(+$("#espn-team").value));
    } catch (err) {
      $("#espn-pick").innerHTML = err.message === "private"
        ? `<p class="alert">This league is private. Use the one-click sync below.</p>` : `<p class="alert">Couldn't reach ESPN (${esc(err.message)}). Try again in a minute.</p>`;
      if (err.message === "private") el.querySelector("details.private").open = true;
    }
  });
}

/* ---------- My team: usable games, open spots by night, who fills them ---------- */
async function teamPage() {
  const [players, S] = await Promise.all([load("players"), load("schedule")]);
  DATA = players;
  const Z = seasonIndex(S);
  await loadLeague();
  initScoring();
  mountMyTeam(Z);
  $("#updated").textContent = players.updated;
}
function mountMyTeam(Z) {   // the full My team workspace; runs on team.html and inside the Arena home
  const today = todayISO(), players = DATA;
  renderConnect(Z);
  let span = store.get("myweek", "rest") === "next" ? "next" : "rest", sel = null;
  document.querySelectorAll(".pagehead .seg button").forEach(b => b.setAttribute("aria-pressed", b.dataset.wk === span));
  const slotSel = $("#slots");
  slotSel.innerHTML = Object.entries(SLOTS).filter(([k]) => k !== "league" || store.get("slotsLeague", null))
    .map(([k, x]) => `<option value="${k}">${k === "league" ? esc(x.name) + " (" + Object.entries(store.get("slotsLeague")).map(([s, c]) => c + s).join(" ") + ")" : x.name}</option>`).join("");
  slotSel.value = slotKey();
  const drawSlotEdit = () => {
    const on = slotSel.value === "custom", c = slotSet();
    $("#slot-edit").hidden = !on;
    if (on) $("#slot-edit").innerHTML = SLOT_KEYS.map(s => `<div><label for="sl-${s}">${s}</label><input id="sl-${s}" type="number" min="0" max="15" inputmode="numeric" value="${c[s] || 0}" data-slot="${s}"></div>`).join("");
  };
  const range = () => { const mon = mondayOf(today); return span === "next" ? [addDays(mon, 7), addDays(mon, 13)] : [today, addDays(mon, 6)]; };
  const draw = () => {
    const mine = myRoster(), k = league().k, f = FORMATS[k], [from, to] = range(), slots = slotSet();
    $("#roster-count").textContent = mine.length ? `${mine.length} players` : "";
    $("#roster").innerHTML = mine.map(p => `<li><span>${esc(p.n)}<span class="pos">${esc(p.t)} ${POS[p.p]}</span>${badge(p)}</span><button class="x" type="button" data-rm="${p.id}" aria-label="Remove ${esc(p.n)}">×</button></li>`).join("");
    const W = usableWeek(Z, mine, from, to, slots, f, k), withGames = W.nights.filter(nt => nt.n);
    if (!sel || !W.nights.some(nt => nt.d === sel)) sel = (withGames[0] || W.nights[0]).d;
    $("#board").innerHTML = boardHTML(W.nights.map(nt => nt.d), sel, d => { const nt = W.nights.find(x => x.d === d), o = openSkaters(nt.left);
      if (!nt.n) return { kind: "none", num: "-", label: "off", aria: "no games" };
      if (!mine.length) return { kind: nightKind(nt.n), num: nt.n, label: "games", aria: `${nt.n} games` };
      return { kind: o === 0 ? "packed" : o >= 3 ? "light" : "", num: o, label: o ? "open" : "full", aria: `${o} open skater spots` }; });
    if (!mine.length) {
      $("#summary").innerHTML = `<div class="empty"><p class="big-line">Start with your roster.</p><p class="note">Type each player's name in the box on the left. Then pick your league's lineup spots. Everything saves in this browser, and nothing is sent anywhere.</p></div>`;
      $("#night-detail").innerHTML = $("#adds").innerHTML = $("#mine").innerHTML = "";
      $("#night-detail").hidden = $("#adds").hidden = true;
      return;
    }
    $("#night-detail").hidden = $("#adds").hidden = false;
    const tot = weekTotals(W), empty = withGames.reduce((a, nt) => a + openSkaters(nt.left), 0);
    const worst = withGames.slice().sort((a, b) => openSkaters(b.left) - openSkaters(a.left))[0];
    let matchup = "", fixHTML = "";
    if (LEAGUE && span === "rest" && LEAGUE.pts) {
      const byId = new Map(everyone().map(p => [p.id, p])), opp = LEAGUE.oppIds.map(id => byId.get(id)).filter(Boolean);
      const proj = Wx => Wx.rows.reduce((a, r) => a + r.used * r.v, 0), OW = usableWeek(Z, opp, from, to, slots, f, k);
      const [a, b] = LEAGUE.pts, ma = a + proj(W), mb = b + proj(OW);
      matchup = `<p class="matchup"><span>This week vs ${esc(LEAGUE.oppName)}</span><b class="led">${fmt(a, 1)}</b> to <b class="led">${fmt(b, 1)}</b> now.
        Projected final <b>${fmt(ma, 0)}</b> to <b>${fmt(mb, 0)}</b>${Math.abs(ma - mb) < 8 ? ", close enough that one add or lineup call matters." : ma > mb ? ", you're ahead." : ", you're behind: use your open spots."}</p>`;
    }
    const fx = span === "rest" ? lineupFix(Z, today, mine, f, k) : null;
    if (fx) fixHTML = `<p class="alert">${fixText(fx)} <span class="note">(Your ESPN lineup as of the last sync.)</span></p>`;
    $("#summary").innerHTML = fixHTML + matchup + `<p class="big-line">You can use <span class="led">${fmt(tot.u, 0)}</span> of your players' ${fmt(tot.g, 0)} games</p>
      <p class="note">${dayDate(from)} to ${dayDate(to)}. ${tot.g - tot.u >= 0.5 ? `${fmt(tot.g - tot.u, 0)} sit on your bench on crowded nights. ` : ""}${empty ? `${empty} skater spot-nights stay empty${worst && openSkaters(worst.left) ? `, most on ${dayName(worst.d)} (${openSkaters(worst.left)})` : ""}. Empty spots score zero.` : "Every spot is filled every night."}</p>`;
    const nt = W.nights.find(x => x.d === sel), bySlot = {};
    nt.used.forEach((slot, id) => (bySlot[slot] = bySlot[slot] || []).push(nt.playing.find(r => r.p.id === id)));
    const benched = nt.playing.filter(r => !nt.used.has(r.p.id)), open = Object.entries(nt.left).filter(([, c]) => c > 0);
    const sitting = mine.filter(p => Z.plays.has(p.t + sel) && (isOut(p) || startOn(p, sel) === 0));
    const gcall = p => { const g = (GSTART[sel] || {})[p.t]; return isG(p) && g && g.id === p.id ? ` <span class="pill${g.s === "Confirmed" ? "" : " amber"}">${g.s}</span>` : ""; };
    const fill = open.length ? nightStreamers(Z, sel, k, 5, p => open.some(([s]) => s !== "G" && fits(p, s))) : [];
    $("#night-detail").innerHTML = `<div class="panel-head"><h2>${longDate(sel)}</h2><span class="note">${nt.n ? nt.n + " NHL games" : "No NHL games"}</span></div>
      ${!nt.n ? `<p class="note">Nobody plays. Pick another night on the board.</p>` : `<div class="lineup">
      <div><h3>Starting (${nt.used.size})</h3><ul>${Object.entries(bySlot).sort(([a], [b]) => SLOT_KEYS.indexOf(a) - SLOT_KEYS.indexOf(b)).map(([s, rs]) => rs.map(r => `<li>${who(r.p)}${gcall(r.p)} <span class="pill">${s}</span></li>`).join("")).join("") || "<li class='muted'>Nobody plays tonight</li>"}</ul>
      ${sitting.length ? `<h3 style="margin-top:14px">Not playing</h3><ul>${sitting.map(p => `<li>${who(p)}${isG(p) && !isOut(p) ? ' <span class="pill out">BACKUP</span>' : ""}${injNote(p) ? `<span class="meta">${esc(injNote(p))}</span>` : ""}</li>`).join("")}</ul>` : ""}</div>
      <div><h3>On the bench (${benched.length})</h3><ul>${benched.map(r => `<li>${who(r.p)}</li>`).join("") || "<li class='muted'>Nobody. Everyone who plays starts.</li>"}</ul>
      <h3 style="margin-top:14px">Open spots</h3><p>${open.length ? open.map(([s, c]) => `${c} ${s}`).join(", ") : "None"}</p></div>
      <div><h3>Fill an open spot</h3><ul>${fill.map(x => `<li>${who(x.p)} <span class="led">${fmt(x.v, 2)}</span></li>`).join("") || "<li class='muted'>No open skater spots</li>"}</ul></div></div>`}`;
    const adds = bestAdds(Z, W, mine, f, k);
    // add/drop pairs: each best add against the weakest players on the roster, kept when it gains this week without costing the season
    const ros = p => value(p, f, k, gamesLeft(p)), wk = new Map(W.rows.map(r => [r.p.id, r.used * r.v]));
    const dropC = mine.filter(p => LINEUP[p.id] !== 8).map(p => ({ p, week: wk.get(p.id) || 0, ros: ros(p), out: isOut(p) })).sort((x, y) => x.ros - y.ros || x.week - y.week).slice(0, 4);
    const pairs = [], usedP = new Set();
    adds.map(a => ({ ...a, ros: ros(a.p) })).flatMap(a => dropC.map(d => ({ a, d, week: a.total - d.week, rest: a.ros - d.ros })))
      .filter(x => x.week > 0.3 && x.rest > -6).sort((x, y) => (y.week + .15 * y.rest) - (x.week + .15 * x.rest))
      .forEach(x => { if (pairs.length < 3 && !usedP.has(x.a.p.id) && !usedP.has(x.d.p.id)) { usedP.add(x.a.p.id); usedP.add(x.d.p.id); pairs.push(x); } });
    const mv = $("#moves");
    if (mv) mv.innerHTML = `<h3 class="ar-h3">Make these moves <small>add and drop, side by side</small></h3>${pairs.map(pr => `<article class="ar-swap spot">
      <div><em>Add</em>${tbadge(pr.a.p.t, "lg")}<b>${esc(pr.a.p.n)}</b>${sparks(pr.a.p, f)}</div><strong>+${fmt(pr.week, 1)}<i>this week</i></strong>
      <div><em class="red">Drop</em>${tbadge(pr.d.p.t, "lg")}<b>${esc(pr.d.p.n)}</b>${badge(pr.d.p)}</div>
      <p>${esc(pr.a.p.n)} plays ${pr.a.add} of your open night${pr.a.add === 1 ? "" : "s"} (${fmt(pr.a.v, 2)} a game). ${esc(pr.d.p.n)} ${pr.d.out ? `is out (${esc(injNote(pr.d.p) || "not dressing")})` : `projects ${fmt(pr.d.week, 1)} this week`}. Rest of season: ${pr.rest >= 0 ? "+" : ""}${fmt(pr.rest, 1)} over a replacement player.</p></article>`).join("")
      || `<p class="ar-quiet">Nothing on the wire beats your roster this week. Hold your add.</p>`}`;
    const limit = LEAGUE ? (LEAGUE.acq > 0 ? ` Your league allows ${LEAGUE.acq} add${LEAGUE.acq > 1 ? "s" : ""} per matchup${LEAGUE.wday ? `, and waivers run ${LEAGUE.wday.charAt(0) + LEAGUE.wday.slice(1).toLowerCase()}` : ""}, so pick the one that covers the most open nights.` : "") : "";
    $("#adds").innerHTML = `<div class="panel-head"><h2>Best adds for your open spots</h2></div><p class="note">${LEAGUE ? `Free agents in ${esc(LEAGUE.name)}.` : `Likely on waivers in ${esc(f.name)}.`} Usable games = his team's games on nights you have an open spot he fits.${limit}</p>
      <div class="scroll"><table class="ev"><thead><tr><th>Player</th><th class="num">Games</th><th>Last 5</th><th class="num">Usable games</th><th class="num">Per game</th><th class="num">Adds you</th></tr></thead><tbody>${
      adds.map(x => `<tr><td>${who(x.p)} ${whyBtn}</td><td class="num">${played(x.p)}</td><td>${sparks(x.p, f)}</td><td class="num">${x.add}</td><td class="num">${fmt(x.v, 2)}</td><td class="num led">${fmt(x.total, 1)}</td></tr>${whyRow(x.p, f, 6)}`).join("") || `<tr><td colspan="6" class="muted">No open spots to fill this week.</td></tr>`}</tbody></table></div>
      <p class="note">Adds you = usable games times per game. ${METHOD}</p>`;
    $("#mine").innerHTML = `<div class="scroll"><table><thead><tr><th>Player</th><th class="num">Games</th><th class="num">Usable</th><th class="num">Benched</th><th class="num">Light nights</th><th class="num">Per game</th></tr></thead><tbody>${
      W.rows.map(r => { const g = r.games * startShare(r.p), bench = g - r.used, d = isG(r.p) ? 1 : 0;
        return `<tr><td>${who(r.p)}</td><td class="num">${fmt(g, d)}</td><td class="num led">${fmt(r.used, d)}</td><td class="num${bench >= 0.5 ? " warn" : ""}">${bench >= 0.5 ? fmt(bench, d) : ""}</td><td class="num">${r.light}</td><td class="num">${fmt(r.v, 2)}</td></tr>`; }).join("")}</tbody></table></div>
      <p class="note">Goalies count expected starts (ESPN's starter call when we have it, otherwise his share of his team's starts). IR, OUT and SUSP come from the daily NHL injury list; we also mark a player OUT when his team has played twice or more in the last 7 days without him. They don't count. DTD (day-to-day) players still count.</p>`;
  };
  playerPicker($("#add-mine"), p => { const t = store.get("team", []); if (!t.includes(p.id)) { store.set("team", t.concat(p.id)); draw(); } });
  $("#roster").addEventListener("click", e => { const x = e.target.closest("[data-rm]"); if (!x) return;
    store.set("team", store.get("team", []).filter(id => String(id) !== x.dataset.rm)); draw(); });
  $("#board").addEventListener("click", e => { const b = e.target.closest(".tile"); if (!b || b.dataset.d === sel) return; sel = b.dataset.d; draw(); sweep($("#night-detail")); });
  segment($(".pagehead .seg"), b => { span = b.dataset.wk; store.set("myweek", span); sel = null; draw(); sweep($("#night-detail")); });
  slotSel.addEventListener("change", () => { store.set("slots", slotSel.value); drawSlotEdit(); draw(); });
  $("#slot-edit").addEventListener("input", () => {
    const c = {}; document.querySelectorAll("#slot-edit input").forEach(i => { const v = Math.max(0, Math.min(15, parseInt(i.value, 10) || 0)); if (v) c[i.dataset.slot] = v; });
    store.set("slotsCustom", c); draw(); });
  onLeague(draw);
  drawSlotEdit();
  draw();
}

async function hub() {
  const [players, week] = await Promise.all([load("players"), load("week")]);
  DATA = players; window.WEEK = week;
  tabs($("#hub-tabs"), k => { $("#hub-leaders").innerHTML = leadersTable(k, 15, $("#pool").value === "waiver"); $("#hub-tabs").dataset.k = k; });
  $("#pool").addEventListener("change", () => $("#hub-leaders").innerHTML = leadersTable($("#hub-tabs").dataset.k, 15, $("#pool").value === "waiver"));
}

function playerPicker(input, onAdd) {
  const list = everyone().filter(p => (p.gp || 0) >= 1);
  const dl = document.createElement("datalist");
  dl.id = input.id + "-list";
  dl.innerHTML = list.map(p => `<option value="${esc(p.n)} (${p.t} ${p.p})">`).join("");
  document.body.append(dl);
  input.setAttribute("list", dl.id);
  const pick = () => {   // the exact dropdown text, or a plain typed name (most games played wins a same-name tie)
    const v = input.value.trim(), lo = v.toLowerCase(); if (!v) return;
    const p = list.find(x => `${x.n} (${x.t} ${x.p})` === v) || list.filter(x => x.n.toLowerCase() === lo).sort((a, b) => (b.gp || 0) - (a.gp || 0))[0];
    if (p) { onAdd(p); input.value = ""; }
  };
  input.addEventListener("change", pick);
  input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); pick(); } });
}

async function fantasyTrade() {
  DATA = await load("players");
  const sides = { a: [], b: [] }, games = {};
  const L = league(), q = new URLSearchParams(location.search);
  let fkey = L.k;
  const custom = { ...(L.custom || FORMATS.espn.sk) };
  if (q.get("w")) q.get("w").split(",").forEach(kv => { const [k, v] = kv.split(":"); if (SK_KEYS.includes(k)) custom[k] = parseFloat(v) || 0; });
  if (q.get("f") === "custom" || FORMATS[q.get("f")]) fkey = q.get("f");   // a shared link shows the sender's format
  const byId = new Map(everyone().map(p => [String(p.id), p]));
  ["a", "b"].forEach(s => (q.get(s) || "").split(",").map(id => byId.get(id)).filter(Boolean).forEach(p => { sides[s].push(p); games[p.id] = gamesLeft(p); }));
  const save = () => store.set("league", { k: fkey, custom: fkey === "custom" ? custom : L.custom });
  const fmtOf = () => fkey === "custom" ? { name: "Custom points", type: "points", sk: custom, g: FORMATS.espn.g } : FORMATS[fkey];
  const sel = $("#format");
  sel.innerHTML = Object.entries(FORMATS).filter(([k]) => k !== "custom").map(([k, f]) => `<option value="${k}">${f.name}</option>`).join("") + `<option value="custom">Custom points (your league)</option>`;
  $("#weights").innerHTML = SK_KEYS.map(k => `<div><label for="w-${k}">${LABEL[k]}</label><input id="w-${k}" type="number" step="0.1" value="${custom[k] ?? 0}"></div>`).join("");
  $("#weights").addEventListener("input", e => { const k = e.target.id.slice(2); custom[k] = parseFloat(e.target.value) || 0; RCACHE = {}; save(); render(); });
  sel.addEventListener("change", () => { fkey = sel.value; $("#custom").hidden = fkey !== "custom"; RCACHE = {}; ZCACHE = {}; save(); render(); });
  sel.value = fkey; $("#custom").hidden = fkey !== "custom";
  $("#share").addEventListener("click", async () => {
    const p = new URLSearchParams({ f: fkey, a: sides.a.map(x => x.id).join(","), b: sides.b.map(x => x.id).join(",") });
    if (fkey === "custom") p.set("w", Object.entries(custom).filter(([, v]) => v).map(([k, v]) => `${k}:${v}`).join(","));
    const url = `${location.origin}${location.pathname}?${p}`, status = $("#share-status");
    try {
      if (navigator.share) { await navigator.share({ title: "Who wins this trade?", text: $("#verdict").textContent, url }); status.textContent = "Shared."; }
      else { await navigator.clipboard.writeText(url); status.textContent = "Link copied. Paste it in your league chat."; }
    } catch { status.innerHTML = `Copy this link: <input readonly value="${esc(url)}" onfocus="this.select()">`; }
  });
  ["a", "b"].forEach(s => playerPicker($(`#add-${s}`), p => { if (!sides[s].includes(p)) { sides[s].push(p); games[p.id] = gamesLeft(p); render(); } }));
  document.addEventListener("click", e => { const x = e.target.closest("[data-rm]"); if (!x) return; const [s, id] = x.dataset.rm.split(":"); sides[s] = sides[s].filter(p => String(p.id) !== id); render(); });
  document.addEventListener("input", e => { if (e.target.matches("input.games")) { games[e.target.dataset.id] = Math.max(0, parseInt(e.target.value) || 0); render(false); } });
  function render(rebuild = true) {
    const f = fmtOf(), key = fkey === "custom" ? "custom" + JSON.stringify(custom) : fkey;
    const unit = f.type === "points" ? "pts" : "value";
    const tot = {};
    ["a", "b"].forEach(s => {
      tot[s] = sides[s].reduce((sum, p) => sum + value(p, f, key, games[p.id]), 0);
      if (!rebuild) { sides[s].forEach(p => { $(`#v-${p.id}`).textContent = fmt(value(p, f, key, games[p.id]), 1); }); }
      else $(`#list-${s}`).innerHTML = sides[s].map(p => `<tr><td>${esc(p.n)} <span class="muted small">${esc(p.t)} ${p.p}</span></td>
        <td class="num">${fmt(perGame(p, f, key), 2)}</td>
        <td class="num"><label class="small" style="display:none" for="g-${p.id}">Games left</label><input class="games" id="g-${p.id}" data-id="${p.id}" type="number" min="0" max="84" value="${games[p.id]}"></td>
        <td class="num led" id="v-${p.id}">${fmt(value(p, f, key, games[p.id]), 1)}</td><td><button class="x" data-rm="${s}:${p.id}" aria-label="Remove ${esc(p.n)}">×</button></td></tr>`).join("") || `<tr><td colspan="5" class="muted">Add players above.</td></tr>`;
      $(`#total-${s}`).textContent = fmt(tot[s], 1);
    });
    const v = $("#verdict");
    if (!sides.a.length || !sides.b.length) { v.className = "verdict"; v.textContent = "Add players to both sides"; return; }
    const diff = tot.a - tot.b, big = Math.max(tot.a, tot.b, 1), pct = Math.abs(diff) / big * 100;
    v.className = "verdict " + (pct < 5 ? "fair" : "win");
    v.textContent = pct < 5 ? "Fair trade" : `${diff > 0 ? "Side A" : "Side B"} wins by ${fmt(Math.abs(diff), 1)} ${unit} (${fmt(pct, 0)}%)`;
    $("#unit-note").textContent = f.type === "points" ? `Projected fantasy points above a replacement-level player at his position, rest of season (${f.name}).` : `Category value above replacement at his position (z-scores across ${f.sk.join(", ")} and goalie W, GAA, SV%, SO), rest of season. Goalie-for-skater trades in categories leagues are the hardest to value: treat that number as a guide.`;
  }
  render();
}

async function nhlTrade() {
  DATA = await load("players");
  const sides = { a: [], b: [] }, cap = {};
  ["a", "b"].forEach(s => playerPicker($(`#add-${s}`), p => { if (!sides[s].includes(p)) { sides[s].push(p); render(); } }));
  document.addEventListener("click", e => { const x = e.target.closest("[data-rm]"); if (!x) return; const [s, id] = x.dataset.rm.split(":"); sides[s] = sides[s].filter(p => String(p.id) !== id); render(); });
  document.addEventListener("input", e => { if (e.target.matches("input.cap")) { cap[e.target.dataset.id] = parseFloat(e.target.value) || 0; render(false); } });
  const mmss = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
  function line(p, s) {
    const capIn = `<input class="games cap" data-id="${p.id}" type="number" step="0.05" min="0" placeholder="$M" value="${cap[p.id] ?? ""}" aria-label="Cap hit for ${esc(p.n)} in millions">`;
    if (isG(p)) { const sv = p.s.SA ? (p.s.SV / p.s.SA).toFixed(3).replace(/^0/, "") : "-";
      return `<tr><td>${esc(p.n)} <span class="muted small">${p.t} G</span><span class="meta" style="display:block;margin:0">${p.s.W}-${p.s.L}-${p.s.OTL}, ${(p.s.GA / Math.max(p.gs, 1)).toFixed(2)} goals against a start</span></td><td class="num">${p.gs}</td><td class="num led">${sv}</td><td class="num">-</td><td class="num">${capIn}</td><td><button class="x" data-rm="${s}:${p.id}" aria-label="Remove ${esc(p.n)}">×</button></td></tr>`; }
    const pts = p.s.G + p.s.A, pace = Math.round(pts / p.gp * 84);
    return `<tr><td>${esc(p.n)} <span class="muted small">${p.t} ${p.p}</span><span class="meta" style="display:block;margin:0">${mmss(p.toi)} a night, ${mmss(p.pp)} on the PP</span></td><td class="num">${p.gp}</td><td class="num led">${p.s.G}-${p.s.A}-${pts}</td><td class="num">${pace}</td><td class="num">${capIn}</td><td><button class="x" data-rm="${s}:${p.id}" aria-label="Remove ${esc(p.n)}">×</button></td></tr>`;
  }
  function render(rebuild = true) {
    const sum = {};
    ["a", "b"].forEach(s => {
      if (rebuild) $(`#list-${s}`).innerHTML = sides[s].map(p => line(p, s)).join("") || `<tr><td colspan="7" class="muted">Add players above.</td></tr>`;
      const sk = sides[s].filter(p => !isG(p));
      sum[s] = { pace: sk.reduce((t, p) => t + (p.s.G + p.s.A) / p.gp * 84, 0), cap: sides[s].reduce((t, p) => t + (cap[p.id] || 0), 0), n: sides[s].length };
      $(`#total-${s}`).textContent = Math.round(sum[s].pace);
    });
    const v = $("#verdict");
    if (!sum.a.n || !sum.b.n) { v.className = "verdict"; v.textContent = "Add players to both sides"; $("#cap-swing").textContent = ""; return; }
    const d = sum.a.pace - sum.b.pace;
    v.className = "verdict " + (Math.abs(d) < 6 ? "fair" : "win");
    v.textContent = Math.abs(d) < 6 ? "Even on production" : `Production edge: ${d > 0 ? "Side A" : "Side B"} (+${Math.round(Math.abs(d))} points per 84)`;
    const c = sum.a.cap - sum.b.cap;
    $("#cap-swing").textContent = (sum.a.cap || sum.b.cap) ? `Cap: side A's players carry $${fmt(sum.a.cap, 2)}M, side B's $${fmt(sum.b.cap, 2)}M (difference $${fmt(Math.abs(c), 2)}M).` : "Add cap hits (in $M) to see the cap swing.";
  }
  render();
}

/* ---------- season schedule planner: any week, look-ahead, back-to-backs, fantasy playoffs, goalie starts ---------- */
const LIGHT = 7, PACKED = 13;   // light night: 7 or fewer games (open bench spots); packed: 13 or more
const addDays = (iso, n) => { const d = new Date(iso + "T12:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const mondayOf = iso => addDays(iso, -((new Date(iso + "T12:00Z").getUTCDay() + 6) % 7));
const dayName = iso => new Date(iso + "T12:00Z").toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
const dayDate = iso => new Date(iso + "T12:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const nightKind = n => n === 0 ? "none" : n <= LIGHT ? "light" : n >= PACKED ? "packed" : "";

function seasonIndex(S) {
  const perDay = new Map(), byTeam = {};
  for (const [d, a, h] of S.games) {
    perDay.set(d, (perDay.get(d) || 0) + 1);
    (byTeam[a] = byTeam[a] || []).push({ d, opp: h, home: false });
    (byTeam[h] = byTeam[h] || []).push({ d, opp: a, home: true });
  }
  const plays = new Set(S.games.flatMap(([d, a, h]) => [a + d, h + d]));
  for (const t in byTeam) byTeam[t].sort((x, y) => (x.d < y.d ? -1 : 1)).forEach((g, i, a) => { g.b2b = i > 0 && addDays(a[i - 1].d, 1) === g.d; });
  const weeks = [];
  for (let m = mondayOf(S.games[0][0]); m <= S.games[S.games.length - 1][0]; m = addDays(m, 7)) weeks.push(m);
  return { perDay, byTeam, plays, weeks, teams: Object.keys(byTeam).sort() };
}
function teamRange(Z, t, from, to) {
  const g = Z.byTeam[t].filter(x => x.d >= from && x.d <= to);
  return { t, g, games: g.length, light: g.filter(x => Z.perDay.get(x.d) <= LIGHT).length, b2b: g.filter(x => x.b2b).length, home: g.filter(x => x.home).length };
}
const bestFirst = (a, b) => b.games - a.games || b.light - a.light || a.b2b - b.b2b || (a.t < b.t ? -1 : 1);
const SORTS = { best: bestFirst, worst: (a, b) => -bestFirst(a, b), az: (a, b) => (a.t < b.t ? -1 : 1) };
const weekLabel = (Z, m) => `Week ${Z.weeks.indexOf(m) + 1} · ${dayDate(m)} to ${dayDate(addDays(m, 6))}`;
function myTeams() { const ids = store.get("team", []); return new Set(everyone().filter(p => ids.includes(p.id)).map(p => p.t)); }
const teamCell = (t, mine) => `<strong>${esc(t)}</strong>${mine.has(t) ? ' <span class="pill">YOURS</span>' : ""}`;

function weekGrid(Z, mon, span, sort) {
  const to = addDays(mon, 7 * span - 1), mine = myTeams();
  const rows = Z.teams.map(t => teamRange(Z, t, mon, to)).sort(SORTS[sort]);
  if (span > 1) {
    const wks = Array.from({ length: span }, (_, i) => addDays(mon, 7 * i));
    return `<div class="scroll"><table><thead><tr><th>Team</th><th class="num">Games</th><th class="num">Light-night games</th><th class="num">Back-to-backs</th><th class="num">Home</th><th class="num">By week</th></tr></thead><tbody>${
      rows.map(r => `<tr${mine.has(r.t) ? ' class="mine"' : ""}><td>${teamCell(r.t, mine)}</td><td class="num led">${r.games}</td><td class="num">${r.light}</td><td class="num">${r.b2b}</td><td class="num">${r.home}</td><td class="num muted">${
        wks.map(w => r.g.filter(x => x.d >= w && x.d <= addDays(w, 6)).length).join(" · ")}</td></tr>`).join("")}</tbody></table></div>`;
  }
  const days = Array.from({ length: 7 }, (_, i) => addDays(mon, i));
  const head = days.map(d => { const n = Z.perDay.get(d) || 0, k = nightKind(n);
    return `<th class="day ${k}" scope="col"><span class="dn">${dayName(d)}</span><span class="dd">${dayDate(d)}</span><span class="dc">${n ? n + (n === 1 ? " game" : " games") : "no games"}</span>${k === "light" ? '<span class="dk">light night</span>' : k === "packed" ? '<span class="dk">packed</span>' : ""}</th>`; }).join("");
  return `<div class="scroll"><table class="wk-grid"><thead><tr><th scope="col">Team</th>${head}<th class="num" scope="col">Games</th><th class="num" scope="col">On light nights</th><th class="num" scope="col">Back-to-backs</th></tr></thead><tbody>${
    rows.map(r => `<tr${mine.has(r.t) ? ' class="mine"' : ""}><th scope="row">${teamCell(r.t, mine)}</th>${days.map(d => { const g = r.g.find(x => x.d === d), k = nightKind(Z.perDay.get(d) || 0);
      return `<td class="g ${k}${g && g.b2b ? " b2b" : ""}">${g ? `${g.home ? "vs" : "@"} ${esc(g.opp)}` : ""}</td>`; }).join("")}<td class="num led">${r.games}</td><td class="num">${r.light}</td><td class="num">${r.b2b || ""}</td></tr>`).join("")}</tbody></table></div>`;
}
function nightStrip(Z, mon) {
  return `<div class="board">${Array.from({ length: 7 }, (_, i) => addDays(mon, i)).map(d => { const n = Z.perDay.get(d) || 0, k = nightKind(n);
    return `<div class="tile ${k}${d === todayISO() ? " today" : ""}"><span class="dn">${dayName(d)}</span><span class="dd">${dayDate(d)}</span><b>${n}</b><span class="dl">${k === "light" ? "light" : k === "packed" ? "packed" : n ? "games" : "off"}</span></div>`; }).join("")}</div>`;
}
function playoffTable(Z, from, to) {
  const end = addDays(to, 6), mine = myTeams(), wks = Z.weeks.filter(w => w >= from && w <= to);
  const rows = Z.teams.map(t => teamRange(Z, t, from, end)).sort(bestFirst);
  return `<p class="small muted">${wks.length} week${wks.length > 1 ? "s" : ""}, ${dayDate(from)} to ${dayDate(end)}. Ranked by games, then light-night games, then fewest back-to-backs.</p><div class="scroll"><table><thead><tr><th>#</th><th>Team</th><th class="num">Games</th><th class="num">Light-night games</th><th class="num">Back-to-backs</th><th class="num">By week</th></tr></thead><tbody>${
    rows.map((r, i) => `<tr${mine.has(r.t) ? ' class="mine"' : ""}><td class="muted">${i + 1}</td><td>${teamCell(r.t, mine)}</td><td class="num led">${r.games}</td><td class="num">${r.light}</td><td class="num">${r.b2b}</td><td class="num muted">${
      wks.map(w => r.g.filter(x => x.d >= w && x.d <= addDays(w, 6)).length).join(" · ")}</td></tr>`).join("")}</tbody></table></div>`;
}
function goalieTable(Z, mon) {
  const to = addDays(mon, 6), L = league(), f = FORMATS[L.k];
  const rows = DATA.goalies.filter(g => DATA.teams[g.t] && g.gs >= 1).map(g => {
    const share = Math.min(1, g.gs / Math.max(DATA.teams[g.t].played, 1)), r = teamRange(Z, g.t, mon, to);
    return { g, share, r, exp: share * r.games, v: perGame(g, f, L.k) };
  }).filter(x => x.share >= 0.15 && x.r.games).sort((a, b) => b.exp - a.exp || b.v - a.v).slice(0, 40);
  return `<div class="scroll"><table><thead><tr><th>Goalie</th><th>Team</th><th class="num">Share of starts</th><th class="num">Team games</th><th class="num">B2B</th><th class="num">Expected starts</th><th class="num">${f.type === "points" ? "Pts per start" : "Value per start"}</th></tr></thead><tbody>${
    rows.map(x => `<tr><td>${esc(x.g.n)}</td><td>${esc(x.g.t)}</td><td class="num">${Math.round(x.share * 100)}%</td><td class="num">${x.r.games}</td><td class="num">${x.r.b2b || ""}</td><td class="num led">${fmt(x.exp, 1)}</td><td class="num">${fmt(x.v, 2)}</td></tr>`).join("")}</tbody></table></div>`;
}

async function schedulePlanner() {
  const [S, players] = await Promise.all([load("schedule"), load("players")]);
  DATA = players;
  const Z = seasonIndex(S), q = new URLSearchParams(location.search);
  const now = mondayOf(todayISO()), wkSel = $("#wk"), spanSel = $("#span"), sortSel = $("#sort");
  const opts = Z.weeks.map(m => `<option value="${m}">${weekLabel(Z, m)}</option>`).join("");
  wkSel.innerHTML = opts;
  wkSel.value = Z.weeks.includes(q.get("week")) ? q.get("week") : Z.weeks.includes(now) ? now : Z.weeks[0];
  const draw = () => {
    const mon = wkSel.value;
    $("#nights").innerHTML = nightStrip(Z, mon);
    $("#grid").innerHTML = weekGrid(Z, mon, +spanSel.value, sortSel.value);
    $("#goalie-week").textContent = weekLabel(Z, mon);
    $("#goalies").innerHTML = goalieTable(Z, mon);
  };
  [wkSel, spanSel, sortSel].forEach(el => el.addEventListener("change", draw));
  const P = store.get("playoffs", { from: Z.weeks[Z.weeks.length - 3], to: Z.weeks[Z.weeks.length - 1] });
  const pf = $("#po-from"), pt = $("#po-to");
  pf.innerHTML = pt.innerHTML = opts;
  pf.value = Z.weeks.includes(P.from) ? P.from : Z.weeks[Z.weeks.length - 3];
  pt.value = Z.weeks.includes(P.to) ? P.to : Z.weeks[Z.weeks.length - 1];
  const drawPO = () => { if (pt.value < pf.value) pt.value = pf.value; store.set("playoffs", { from: pf.value, to: pt.value }); $("#playoffs").innerHTML = playoffTable(Z, pf.value, pt.value); };
  [pf, pt].forEach(el => el.addEventListener("change", drawPO));
  initScoring();
  onLeague(draw);   // the scoring format only changes the goalie value column
  const tabsEl = $(".tabs-row");
  tabsEl.addEventListener("click", e => { const b = e.target.closest("[role=tab]"); if (!b) return;
    tabsEl.querySelectorAll("[role=tab]").forEach(x => { x.setAttribute("aria-selected", x === b); $("#tab-" + x.dataset.tab).hidden = x !== b; }); });
  draw();
  drawPO();
  $("#updated").textContent = players.updated;
}

/* ---------- page transition: CSS view transitions do the swipe (style.css, "one pass"); here we only note where we came from,
   so a tab to the left mirrors it (the head script reads this on the next page). ---------- */
const NAV_ORDER = ["index.html", "team.html", "schedule.html", "waiver-wire.html", "trade.html"];
const NAV_HOME = { "nhl-trade.html": "trade.html", "fantasy.html": "waiver-wire.html", "nhl-4-game-teams-this-week.html": "schedule.html" };
const pageSlot = path => { const f = path.split("/").pop() || "index.html"; return NAV_ORDER.indexOf(NAV_HOME[f] || f); };
addEventListener("pageswap", () => { try { sessionStorage.setItem("onh.from", String(pageSlot(location.pathname))); } catch { /* no storage: the swipe just goes left to right */ } });

async function receiptsPage() {   // research 28: every public call, graded against the average skater over the same days
  const R = await load("receipts"), done = R.calls.filter(c => c.result).reverse(), open = R.calls.filter(c => !c.result);
  const V = { hit: ["Hit", ""], close: ["Close", "amber"], miss: ["Miss", "out"], dnp: ["Didn't play", "out"] };
  const day = iso => new Date(iso + "T12:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const when = c => c.from === c.to ? day(c.from) : `${day(c.from)} to ${day(c.to)}`;
  const who = c => `${esc(c.name)} <span class="muted small">${c.team} ${c.pos}</span>`;
  const said = c => `${c.kind === "drop" ? "Drop" : "Add"}, ${esc(c.source)}${c.said != null ? `<span class="meta" style="display:block;margin:0">${c.said.toFixed(2)} a game then, ${esc(c.basis)}</span>` : c.why ? `<span class="meta" style="display:block;margin:0">${esc(c.why)}</span>` : ""}`;
  const line = r => Object.entries(r.line).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(", ") || "no points";
  const hits = xs => xs.filter(c => c.result.verdict === "hit").length;
  $("#rc-rule").textContent = R.rule;
  if (done.length) {
    const by = [...new Set(done.map(c => c.source))].map(s => { const xs = done.filter(c => c.source === s); return `${esc(s)}: ${hits(xs)} of ${xs.length}`; }).join(". ");
    $("#rc-score").innerHTML = `<p class="big-line"><span class="led">${hits(done)}</span> hit${hits(done) === 1 ? "" : "s"} in <span class="led">${done.length}</span> graded call${done.length === 1 ? "" : "s"}</p><p class="note">${by}.</p>`;
  } else {
    const next = open.map(c => c.to).sort()[0];
    $("#rc-score").innerHTML = `<p class="big-line">No grades yet.</p><p class="note">We started logging on November 25, 2026. ${next ? `The first grades land the morning after ${day(next)}.` : ""} Open calls are below, so you can hold us to them.</p>`;
  }
  $("#rc-graded").innerHTML = done.length ? `<table class="ev rc"><thead><tr><th>When</th><th>Player</th><th>Our call</th><th class="num">What happened</th><th>Verdict</th></tr></thead><tbody>${done.map(c => { const r = c.result, v = V[r.verdict];
    return `<tr><td>${when(c)}</td><td>${who(c)}</td><td>${said(c)}</td><td class="num">${r.gp} GP, <span class="led">${r.fp}</span> pts<span class="meta">${r.gp ? `${r.per_game.toFixed(2)} a game vs ${r.bar.toFixed(2)} average. ` : ""}${line(r)}</span></td><td><span class="pill ${v[1]}">${v[0]}</span></td></tr>`; }).join("")}</tbody></table>`
    : `<p class="note">Nothing graded yet.</p>`;
  $("#rc-open").innerHTML = open.length ? `<table class="rc"><thead><tr><th>When</th><th>Player</th><th>Our call</th></tr></thead><tbody>${open.map(c => `<tr><td>${when(c)}</td><td>${who(c)}</td><td>${said(c)}</td></tr>`).join("")}</tbody></table>`
    : `<p class="note">No open calls right now.</p>`;
  $("#updated").textContent = R.updated;
}

const PAGES = { home, team: teamPage, hub, "fantasy-trade": fantasyTrade, "nhl-trade": nhlTrade, schedule: schedulePlanner, receipts: receiptsPage };
function parkPuck() {   // inner pages: the puck rests under the section the page belongs to
  const w = $(".ar-words [aria-current]"), puck = $(".ar-puck"); if (!puck) return;
  if (!w) { puck.hidden = true; return; }
  const nav = $(".ar-words"), r = w.getBoundingClientRect();
  puck.style.transform = `translateX(${r.left + r.width / 2 - nav.getBoundingClientRect().left + nav.scrollLeft - 14}px)`;
}
document.addEventListener("DOMContentLoaded", () => {
  if (document.body.dataset.page !== "home") { parkPuck(); addEventListener("resize", parkPuck); const w = $(".ar-words [aria-current]"); if (w && window.ResizeObserver) new ResizeObserver(parkPuck).observe(w); }   // re-park when the web font swaps in
  const fn = PAGES[document.body.dataset.page];
  if (fn) fn().catch(err => { const m = document.querySelector("main"); m.insertAdjacentHTML("afterbegin", `<p class="panel red">Couldn't load the data (${esc(err.message)}). Try reloading.</p>`); });
});
