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
async function load(name) { const r = await fetch(`data/${name}.json`); if (!r.ok) throw new Error(name); return r.json(); }

/* ---------- saved in this browser only (league and team); private windows may block storage, so every call is guarded ---------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem("onh." + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("onh." + k, JSON.stringify(v)); } catch { /* storage blocked: the page still works, it just won't remember */ } },
};
function league() {
  const L = store.get("league", { k: "espn" });
  if (L.k === "custom" && L.custom) FORMATS.custom = { name: "Your league (custom points)", type: "points", sk: L.custom, g: FORMATS.espn.g };
  if (!FORMATS[L.k]) L.k = "espn";
  return L;
}
const todayISO = () => new Date().toLocaleDateString("en-CA");   // YYYY-MM-DD in the visitor's own time zone

/* ---------- rates and values ---------- */
function blend(p, k, denomKey) {
  const s = p.s[k] / Math.max(p[denomKey], 1);
  const rd = denomKey === "gs" ? p.rgs : p.rgp;
  if (!p.r || rd < 3) return s;
  return 0.7 * s + 0.3 * (p.r[k] / rd);
}
const isG = p => p.p === "G";
function gamesLeft(p) {
  const t = DATA.teams[p.t];
  if (!isG(p)) return t.left;
  return Math.round(t.left * Math.min(1, p.gs / Math.max(t.played, 1)));   // projected starts from his share so far
}
function perGamePoints(p, f) {
  if (isG(p)) return Object.entries(f.g).reduce((s, [k, w]) => s + w * blend(p, k, "gs"), 0);
  return Object.entries(f.sk).reduce((s, [k, w]) => s + w * blend(p, k, "gp"), 0);
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
function leadersTable(fkey, limit = 12, waiverOnly = true) {
  const f = FORMATS[fkey];
  const all = DATA.skaters.filter(p => p.gp >= 5).map(p => ({ p, v: perGame(p, f, fkey) })).sort((a, b) => b.v - a.v);
  const list = (waiverOnly ? all.slice(150) : all).filter(x => x.p.rgp >= 3).slice(0, limit);
  const unit = f.type === "points" ? "Pts/GP" : "Cat value/GP";
  return `<div class="scroll"><table><thead><tr><th>#</th><th>Player</th><th>Team</th><th class="num">GP</th><th class="num">${unit}</th></tr></thead><tbody>${
    list.map((x, i) => `<tr><td class="muted">${i + 1}</td><td>${esc(x.p.n)} <span class="muted small">${x.p.p}</span></td><td>${esc(x.p.t)}${gamesPill(x.p.t, window.WEEK)}</td><td class="num">${x.p.gp}</td><td class="num led">${fmt(x.v, 2)}</td></tr>`).join("")
  }</tbody></table></div>`;
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
/* ---------- shared: the header scoring picker and the night board ---------- */
const LEAGUE_CBS = [];
const onLeague = fn => LEAGUE_CBS.push(fn);
function initScoring() {   // one picker in the header; every tool on the page re-scores when it changes
  const sel = $("#fmt");
  if (!sel) return;
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
const who = p => `${esc(p.n)}<span class="meta">${esc(p.t)} ${POS[p.p]}</span>`;
function myRoster() { const byId = new Map(everyone().map(p => [p.id, p])); return store.get("team", []).map(id => byId.get(id)).filter(Boolean); }
function nightStreamers(Z, d, k, n, fitsOpen) {
  const f = FORMATS[k], teams = new Set(teamsOn(Z, d)), cut = waiverCut(k), have = new Set(store.get("team", []));
  return DATA.skaters.filter(p => teams.has(p.t) && !have.has(p.id) && p.gp >= 5 && p.rgp >= 3 && (!fitsOpen || fitsOpen(p)))
    .map(p => ({ p, v: perGame(p, f, k), r: recentRate(p, f) })).filter(x => x.v < cut)
    .sort((a, b) => (b.r ?? b.v) + b.v - ((a.r ?? a.v) + a.v)).slice(0, n);   // rank by blended rate plus recent form, so hot players rise
}
function nightGoalies(Z, d, k, n) {
  const f = FORMATS[k], teams = new Set(teamsOn(Z, d));
  return DATA.goalies.filter(g => teams.has(g.t) && g.gs >= 3).map(g => ({ p: g, share: startShare(g), v: perGame(g, f, k) }))
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
};
const SLOT_KEYS = ["C", "LW", "RW", "F", "D", "UTIL", "G"];
function slotKey() { const k = store.get("slots", "espn"); return SLOTS[k] ? k : "espn"; }
function slotSet() { const k = slotKey(); return k === "custom" ? store.get("slotsCustom", { F: 9, D: 5, UTIL: 1, G: 2 }) : SLOTS[k].s; }
const POS = { C: "C", L: "LW", R: "RW", D: "D", G: "G" };
const fits = (p, slot) => slot === POS[p.p] || (slot === "F" && "CLR".includes(p.p)) || (slot === "UTIL" && p.p !== "G");
const startShare = p => isG(p) ? Math.min(1, p.gs / Math.max(DATA.teams[p.t].played, 1)) : 1;   // a goalie only counts when he starts
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
    const playing = rows.filter(r => Z.plays.has(r.p.t + d));
    playing.forEach(r => { r.games++; if (n && n <= LIGHT) r.light++; });
    const { used, left } = nightLineup(playing, slots);
    used.forEach((_, id) => { const r = rows.find(x => x.p.id === id); r.used += startShare(r.p); });
    nights.push({ d, n, left, playing, used });
  }
  return { rows, nights };
}
const openSkaters = left => Object.entries(left).filter(([s]) => s !== "G").reduce((a, [, k]) => a + k, 0);
function bestAdds(Z, wk, mine, f, key) {
  const cut = waiverCut(key), have = new Set(mine.map(p => p.id));
  return DATA.skaters.filter(p => !have.has(p.id) && p.gp >= 5 && p.rgp >= 3).map(p => ({ p, v: perGame(p, f, key) })).filter(x => x.v < cut)
    .map(x => ({ ...x, add: wk.nights.filter(nt => nt.n && Z.plays.has(x.p.t + nt.d) && Object.keys(nt.left).some(s => nt.left[s] > 0 && fits(x.p, s))).length }))
    .filter(x => x.add).map(x => ({ ...x, total: x.add * x.v })).sort((a, b) => b.total - a.total).slice(0, 8);
}
function weekTotals(W) {
  return W.rows.reduce((a, r) => ({ g: a.g + r.games * startShare(r.p), u: a.u + r.used }), { g: 0, u: 0 });
}

/* ---------- Tonight (home): pick a night on the board, see who plays and who to stream ---------- */
async function home() {
  const [players, standings, S] = await Promise.all([load("players"), load("standings"), load("schedule")]);
  DATA = players;
  const Z = seasonIndex(S), today = todayISO();
  initScoring();
  let wk = 0, show = "sk", lim = 8, sel = today;
  const days = () => { const m = addDays(mondayOf(today), 7 * wk); return Array.from({ length: 7 }, (_, i) => addDays(m, i)); };
  if (!days().includes(sel)) sel = days()[0];
  const weekGamesOf = t => days().filter(d => Z.plays.has(t + d)).length;
  const drawBoard = () => { $("#board").innerHTML = boardHTML(days(), sel, d => { const n = Z.perDay.get(d) || 0, k = nightKind(n);
    return { kind: k, num: n, label: k === "light" ? "light" : k === "packed" ? "packed" : n ? "games" : "off", aria: `${n} games${k ? ", " + k + " night" : ""}` }; }); };
  const drawNight = () => {
    const k = league().k, f = FORMATS[k], n = Z.perDay.get(sel) || 0, kind = nightKind(n);
    $("#night-title").textContent = sel === today ? "Tonight" : new Date(sel + "T12:00Z").toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
    $("#night-sub").textContent = `${longDate(sel)}: ` + (!n ? "no NHL games." : `${n} games` + (kind === "light" ? ", a light night. Most benches have open spots, so a pickup counts." : kind === "packed" ? ", a packed night. Benches fill up; set your lineup." : "."));
    const mineT = myTeams();
    $("#np-teams").innerHTML = n ? `<span class="chips">${teamsOn(Z, sel).map(t => `<span class="chip${mineT.has(t) ? " mine" : ""}">${esc(t)}</span>`).join("")}</span>` : "";
    $("#np-title").textContent = show === "g" ? "Likely goalie starts" : "Streamers";
    if (!n) { $("#np-list").innerHTML = `<p class="note">No games this night. Pick another night on the board.</p>`; return; }
    if (show === "g") {
      const gs = nightGoalies(Z, sel, k, 10);
      $("#np-list").innerHTML = `<div class="scroll"><table><thead><tr><th>Goalie</th><th class="num">Share of starts</th><th class="num">${f.type === "points" ? "Pts per start" : "Value per start"}</th></tr></thead><tbody>${
        gs.map(x => `<tr><td>${who(x.p)}</td><td class="num">${Math.round(x.share * 100)}%</td><td class="num led">${fmt(x.v, 2)}</td></tr>`).join("")}</tbody></table></div>
        <p class="note">Teams don't announce starters a day ahead, so this is each goalie's share of his team's starts this season.</p>`;
      return;
    }
    const st = nightStreamers(Z, sel, k, 8);
    const pts = f.type === "points";
    $("#np-list").innerHTML = `<div class="scroll"><table><thead><tr><th>Player</th><th class="num">Games</th>${pts ? '<th class="num">Last 14 days</th>' : ""}<th class="num">Per game</th></tr></thead><tbody>${
      st.map(x => { const g = weekGamesOf(x.p.t), r = recentRate(x.p, f); return `<tr><td>${who(x.p)}</td><td class="num">${g}${g >= 4 ? ' <span class="pill">4G</span>' : ""}</td>${pts ? `<td class="num">${r === null ? "" : fmt(r, 2)}</td>` : ""}<td class="num led">${fmt(x.v, 2)}</td></tr>`; }).join("")}</tbody></table></div>
      <p class="note">Likely on waivers in ${esc(f.name)} (outside the top 150 in this scoring). Last 14 days blended with the season.</p>`;
  };
  const drawSnap = () => {
    const mine = myRoster();
    if (!mine.length) { $("#snap-body").innerHTML = `<div class="empty"><p class="big-line">How many of your players' games can you use?</p><p class="note">Add your roster once. You'll see your open lineup spots every night and the best adds to fill them.</p><a class="btn primary" href="team.html">Set up My team</a></div>`; return; }
    const k = league().k, f = FORMATS[k], ds = days(), from = ds.includes(today) ? today : ds[0];
    const W = usableWeek(Z, mine, from, ds[6], slotSet(), f, k), tot = weekTotals(W);
    const empty = W.nights.filter(nt => nt.n).reduce((a, nt) => a + openSkaters(nt.left), 0), top = bestAdds(Z, W, mine, f, k)[0];
    const on = mine.filter(p => Z.plays.has(p.t + sel)).length;
    $("#snap-body").innerHTML = `<p class="big-line"><span class="led">${fmt(tot.u, 0)}</span> of ${fmt(tot.g, 0)} games usable</p>
      <p class="note">${wk ? "Next week" : from === today ? "Rest of this week" : "This week"}, with ${empty} empty skater spot-nights.</p>
      <p>${sel === today ? "Tonight" : dayName(sel)}: ${on} of your ${mine.length} players play.</p>
      ${top ? `<p>Best add: <strong>${esc(top.p.n)}</strong><span class="meta">${esc(top.p.t)} ${POS[top.p.p]}</span>, ${top.add} usable game${top.add > 1 ? "s" : ""}, about ${fmt(top.total, 1)} points.</p>` : ""}`;
  };
  const drawBest = () => {
    const ds = days(), mineT = myTeams(), rows = Z.teams.map(t => teamRange(Z, t, ds[0], ds[6])).sort(bestFirst).slice(0, 8);
    $("#best-note").textContent = `Week of ${dayDate(ds[0])}: most games, then most games on light nights.`;
    $("#best").innerHTML = `<div class="scroll"><table><thead><tr><th>Team</th><th class="num">Games</th><th class="num">On light nights</th><th class="num">Back-to-backs</th></tr></thead><tbody>${
      rows.map(r => `<tr${mineT.has(r.t) ? ' class="mine"' : ""}><td><strong>${esc(r.t)}</strong></td><td class="num led">${r.games}</td><td class="num">${r.light}</td><td class="num">${r.b2b || ""}</td></tr>`).join("")}</tbody></table></div>`;
  };
  const drawLeaders = () => { const k = league().k; $("#leaders").innerHTML = leadersTable(k, lim);
    $("#leader-note").textContent = `${FORMATS[k].name}, likely on waivers, last 14 days blended with the season.`; };
  const all = () => { drawBoard(); drawNight(); drawSnap(); drawBest(); drawLeaders(); };
  $("#board").addEventListener("click", e => { const b = e.target.closest(".tile"); if (!b || b.dataset.d === sel) return;
    sel = b.dataset.d; drawBoard(); drawNight(); drawSnap(); sweep($("#night-panel")); });
  segment($(".pagehead .seg"), b => { wk = +b.dataset.wk; sel = days().includes(today) ? today : days()[0]; all(); sweep($("#night-panel")); });
  segment($("#night-panel .seg"), b => { show = b.dataset.show; drawNight(); });
  $("#leaders-more").addEventListener("click", e => { lim = lim === 8 ? 25 : 8; e.target.textContent = lim === 8 ? "Show 25" : "Show 8"; drawLeaders(); });
  onLeague(() => { drawNight(); drawSnap(); drawLeaders(); });
  all();
  $("#standings").innerHTML = standingsHTML(standings);
  $("#updated").textContent = players.updated;
}

/* ---------- My team: usable games, open spots by night, who fills them ---------- */
async function teamPage() {
  const [players, S] = await Promise.all([load("players"), load("schedule")]);
  DATA = players;
  const Z = seasonIndex(S), today = todayISO();
  initScoring();
  let span = store.get("myweek", "rest") === "next" ? "next" : "rest", sel = null;
  document.querySelectorAll(".pagehead .seg button").forEach(b => b.setAttribute("aria-pressed", b.dataset.wk === span));
  const slotSel = $("#slots");
  slotSel.innerHTML = Object.entries(SLOTS).map(([k, x]) => `<option value="${k}">${x.name}</option>`).join("");
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
    $("#roster").innerHTML = mine.map(p => `<li><span>${esc(p.n)}<span class="pos">${esc(p.t)} ${POS[p.p]}</span></span><button class="x" type="button" data-rm="${p.id}" aria-label="Remove ${esc(p.n)}">×</button></li>`).join("");
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
    $("#summary").innerHTML = `<p class="big-line">You can use <span class="led">${fmt(tot.u, 0)}</span> of your players' ${fmt(tot.g, 0)} games</p>
      <p class="note">${dayDate(from)} to ${dayDate(to)}. ${tot.g - tot.u >= 0.5 ? `${fmt(tot.g - tot.u, 0)} sit on your bench on crowded nights. ` : ""}${empty ? `${empty} skater spot-nights stay empty${worst && openSkaters(worst.left) ? `, most on ${dayName(worst.d)} (${openSkaters(worst.left)})` : ""}. Empty spots score zero.` : "Every spot is filled every night."}</p>`;
    const nt = W.nights.find(x => x.d === sel), bySlot = {};
    nt.used.forEach((slot, id) => (bySlot[slot] = bySlot[slot] || []).push(nt.playing.find(r => r.p.id === id)));
    const benched = nt.playing.filter(r => !nt.used.has(r.p.id)), open = Object.entries(nt.left).filter(([, c]) => c > 0);
    const fill = open.length ? nightStreamers(Z, sel, k, 5, p => open.some(([s]) => s !== "G" && fits(p, s))) : [];
    $("#night-detail").innerHTML = `<div class="panel-head"><h2>${longDate(sel)}</h2><span class="note">${nt.n ? nt.n + " NHL games" : "No NHL games"}</span></div>
      ${!nt.n ? `<p class="note">Nobody plays. Pick another night on the board.</p>` : `<div class="lineup">
      <div><h3>Starting (${nt.used.size})</h3><ul>${Object.entries(bySlot).sort(([a], [b]) => SLOT_KEYS.indexOf(a) - SLOT_KEYS.indexOf(b)).map(([s, rs]) => rs.map(r => `<li>${who(r.p)} <span class="pill">${s}</span></li>`).join("")).join("") || "<li class='muted'>Nobody plays tonight</li>"}</ul></div>
      <div><h3>On the bench (${benched.length})</h3><ul>${benched.map(r => `<li>${who(r.p)}</li>`).join("") || "<li class='muted'>Nobody. Everyone who plays starts.</li>"}</ul>
      <h3 style="margin-top:14px">Open spots</h3><p>${open.length ? open.map(([s, c]) => `${c} ${s}`).join(", ") : "None"}</p></div>
      <div><h3>Fill an open spot</h3><ul>${fill.map(x => `<li>${who(x.p)} <span class="led">${fmt(x.v, 2)}</span></li>`).join("") || "<li class='muted'>No open skater spots</li>"}</ul></div></div>`}`;
    const adds = bestAdds(Z, W, mine, f, k);
    $("#adds").innerHTML = `<div class="panel-head"><h2>Best adds for your open spots</h2></div><p class="note">Likely on waivers in ${esc(f.name)}. Usable games = his team's games on nights you have an open spot he fits.</p>
      <div class="scroll"><table><thead><tr><th>Player</th><th class="num">Usable games</th><th class="num">Per game</th><th class="num">Adds you</th></tr></thead><tbody>${
      adds.map(x => `<tr><td>${who(x.p)}</td><td class="num">${x.add}</td><td class="num">${fmt(x.v, 2)}</td><td class="num led">${fmt(x.total, 1)}</td></tr>`).join("") || `<tr><td colspan="4" class="muted">No open spots to fill this week.</td></tr>`}</tbody></table></div>`;
    $("#mine").innerHTML = `<div class="scroll"><table><thead><tr><th>Player</th><th class="num">Games</th><th class="num">Usable</th><th class="num">Benched</th><th class="num">Light nights</th><th class="num">Per game</th></tr></thead><tbody>${
      W.rows.map(r => { const g = r.games * startShare(r.p), bench = g - r.used, d = isG(r.p) ? 1 : 0;
        return `<tr><td>${who(r.p)}</td><td class="num">${fmt(g, d)}</td><td class="num led">${fmt(r.used, d)}</td><td class="num${bench >= 0.5 ? " warn" : ""}">${bench >= 0.5 ? fmt(bench, d) : ""}</td><td class="num">${r.light}</td><td class="num">${fmt(r.v, 2)}</td></tr>`; }).join("")}</tbody></table></div>
      <p class="note">Goalies count expected starts (his share of his team's starts). Positions come from the NHL, one per player.</p>`;
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
  $("#updated").textContent = players.updated;
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
  input.addEventListener("change", () => {
    const p = list.find(x => `${x.n} (${x.t} ${x.p})` === input.value);
    if (p) { onAdd(p); input.value = ""; }
  });
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
      return `<tr><td>${esc(p.n)} <span class="muted small">${p.t} G</span></td><td class="num">${p.gs} GS</td><td class="num led">${sv}</td><td class="num">${(p.s.GA / Math.max(p.gs, 1)).toFixed(2)} GA/GS</td><td class="num">${p.s.W}-${p.s.L}-${p.s.OTL}</td><td class="num">${capIn}</td><td><button class="x" data-rm="${s}:${p.id}" aria-label="Remove ${esc(p.n)}">×</button></td></tr>`; }
    const pts = p.s.G + p.s.A, pace = Math.round(pts / p.gp * 84);
    return `<tr><td>${esc(p.n)} <span class="muted small">${p.t} ${p.p}</span></td><td class="num">${p.gp} GP</td><td class="num led">${p.s.G}-${p.s.A}-${pts}</td><td class="num">${pace} pace</td><td class="num">${mmss(p.toi)} TOI, ${mmss(p.pp)} PP</td><td class="num">${capIn}</td><td><button class="x" data-rm="${s}:${p.id}" aria-label="Remove ${esc(p.n)}">×</button></td></tr>`;
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
    return `<th class="num ${k === "light" ? "light" : ""}">${dayName(d)}<br><span class="small ${k === "light" ? "" : "muted"}">${n ? (k === "light" ? "LIGHT " : k === "packed" ? "PACKED " : "") + n : "NO GAMES"}</span></th>`; }).join("");
  return `<div class="scroll"><table class="sched"><thead><tr><th>Team</th>${head}<th class="num">GP</th><th class="num">Light</th><th class="num">B2B</th></tr></thead><tbody>${
    rows.map(r => `<tr${mine.has(r.t) ? ' class="mine"' : ""}><td>${teamCell(r.t, mine)}</td>${days.map(d => { const g = r.g.find(x => x.d === d), k = nightKind(Z.perDay.get(d) || 0);
      return `<td class="opp ${k === "light" ? "light" : ""}">${g ? `${g.home ? "vs" : "@"} ${esc(g.opp)}${g.b2b ? "*" : ""}` : ""}</td>`; }).join("")}<td class="num led">${r.games}</td><td class="num">${r.light}</td><td class="num">${r.b2b}</td></tr>`).join("")}</tbody></table></div>`;
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

const PAGES = { home, team: teamPage, hub, "fantasy-trade": fantasyTrade, "nhl-trade": nhlTrade, schedule: schedulePlanner };
document.addEventListener("DOMContentLoaded", () => {
  const fn = PAGES[document.body.dataset.page];
  if (fn) fn().catch(err => { const m = document.querySelector("main"); m.insertAdjacentHTML("afterbegin", `<p class="panel red">Couldn't load the data (${esc(err.message)}). Try reloading.</p>`); });
});
