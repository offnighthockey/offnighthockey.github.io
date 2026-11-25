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
function scheduleTable(week) {
  const days = week.per_day;
  const has = new Set(week.plays.map(([t, d]) => t + d));
  const head = days.map(([d, n]) => { const lt = n <= 7; const day = new Date(d + "T12:00").toLocaleDateString("en-US", { weekday: "short" });
    return `<th class="${lt ? "light" : ""} num">${day}<br><span class="small ${lt ? "" : "muted"}">${lt ? "LIGHT" : n + " GM"}</span></th>`; }).join("");
  const rows = week.four.map(t => `<tr><td><strong>${esc(t)}</strong></td>${days.map(([d, n]) =>
    `<td class="dot ${n <= 7 ? "light" : ""}">${has.has(t + d) ? "<i></i>" : ""}</td>`).join("")}<td class="num led">4</td></tr>`).join("");
  return `<div class="scroll"><table class="sched"><thead><tr><th>Team</th>${head}<th class="num">GP</th></tr></thead><tbody>${rows}</tbody></table></div>`;
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
function weekGames(team, week) {
  const n = new Map(week.per_day);
  return week.plays.filter(([t]) => t === team).map(([, d]) => ({ d, light: n.get(d) <= 7 }));
}
let CUT = {};
function waiverCut(k) {   // a skater below the 150th-best in this format is likely on waivers
  if (CUT[k] !== undefined) return CUT[k];
  const v = DATA.skaters.filter(p => p.gp >= 5).map(p => perGame(p, FORMATS[k], k)).sort((a, b) => b - a);
  return (CUT[k] = v[Math.min(149, v.length - 1)]);
}
function tonightPanel(T) {
  const today = todayISO(), L = league(), f = FORMATS[L.k];
  if (T.date !== today || !T.games) { $("#tonight-title").textContent = "Tonight"; $("#tonight").innerHTML = `<p class="muted">${T.date === today ? "No NHL games tonight." : "Tonight's slate updates every morning in season."}</p>`; return; }
  const teams = T.teams, entry = [today, T.games];
  $("#tonight-date").textContent = new Date(today + "T12:00").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
  $("#tonight-title").textContent = entry[1] <= 7 ? `Light night: only ${entry[1]} games` : `${entry[1]} games tonight`;
  const cut = waiverCut(L.k);
  const streams = DATA.skaters.filter(p => teams.includes(p.t) && p.gp >= 5 && p.rgp >= 3).map(p => ({ p, v: perGame(p, f, L.k) }))
    .filter(x => x.v < cut).sort((a, b) => b.v - a.v).slice(0, 6);
  const mine = store.get("team", []), mineTonight = everyone().filter(p => mine.includes(p.id) && teams.includes(p.t));
  $("#tonight").innerHTML = `<p class="small muted">Playing: ${teams.map(esc).join(", ")}</p>`
    + (mine.length ? `<p><strong>Your players tonight:</strong> ${mineTonight.map(p => esc(p.n)).join(", ") || "none"}</p>` : "")
    + `<h3>Streamers playing tonight</h3><p class="small muted">${esc(f.name)}, likely on waivers, recent form blended with season.</p><div class="scroll"><table><thead><tr><th>Player</th><th>Team</th><th class="num">Per game</th></tr></thead><tbody>${
      streams.map(x => `<tr><td>${esc(x.p.n)} <span class="muted small">${x.p.p}</span></td><td>${esc(x.p.t)}</td><td class="num led">${fmt(x.v, 2)}</td></tr>`).join("")}</tbody></table></div>`;
}
/* ---------- usable games: a game counts only if the player makes your best legal lineup that night ---------- */
const SLOTS = {
  espn: { name: "ESPN default (2C 2LW 2RW 4D 1UTIL 2G)", s: { C: 2, LW: 2, RW: 2, D: 4, UTIL: 1, G: 2 } },
  yahoo: { name: "Yahoo default (2C 2LW 2RW 4D 2G)", s: { C: 2, LW: 2, RW: 2, D: 4, G: 2 } },
  fdg: { name: "Forwards / D / G (6F 4D 2G)", s: { F: 6, D: 4, G: 2 } },
};
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
    nights.push({ d, n, left });
  }
  return { rows, nights };
}
function bestAdds(Z, wk, mine, f, key) {
  const cut = waiverCut(key), have = new Set(mine.map(p => p.id));
  return DATA.skaters.filter(p => !have.has(p.id) && p.gp >= 5 && p.rgp >= 3).map(p => ({ p, v: perGame(p, f, key) })).filter(x => x.v < cut)
    .map(x => ({ ...x, add: wk.nights.filter(nt => nt.n && Z.plays.has(x.p.t + nt.d) && Object.keys(nt.left).some(s => nt.left[s] > 0 && fits(x.p, s))).length }))
    .filter(x => x.add).map(x => ({ ...x, total: x.add * x.v })).sort((a, b) => b.total - a.total).slice(0, 8);
}
function myTeamPanel(Z, T) {
  const ids = store.get("team", []), L = league(), f = FORMATS[L.k], span0 = store.get("myweek", "rest");
  const tonight = T.date === todayISO() && span0 !== "next" ? T.teams : [];   // the TONIGHT tag only makes sense in this week's view
  const byId = new Map(everyone().map(p => [p.id, p])), mine = ids.map(id => byId.get(id)).filter(Boolean);
  const slotKey = SLOTS[store.get("slots", "espn")] ? store.get("slots", "espn") : "espn", span = store.get("myweek", "rest");
  const today = todayISO(), mon = mondayOf(today);
  const from = span === "next" ? addDays(mon, 7) : today, to = span === "next" ? addDays(mon, 13) : addDays(mon, 6);
  $("#open").innerHTML = $("#adds").innerHTML = "";
  if (!mine.length) { $("#mine").innerHTML = `<p class="muted">No players yet. Add your roster and this panel shows how many of their games you can use, your open spots and the best adds.</p>`; return; }
  const wk = usableWeek(Z, mine, from, to, SLOTS[slotKey].s, f, L.k);
  const tot = wk.rows.reduce((a, r) => ({ g: a.g + r.games * startShare(r.p), u: a.u + r.used }), { g: 0, u: 0 });
  const label = `${dayDate(from)} to ${dayDate(to)}`;
  $("#mine").innerHTML = `<p><strong>You can use ${fmt(tot.u, 0)} of your players' ${fmt(tot.g, 0)} games</strong> (${label}). ${tot.g - tot.u >= 0.5 ? `${fmt(tot.g - tot.u, 0)} sit on your bench on crowded nights.` : "Nobody gets stuck on your bench."}</p>
    <div class="scroll"><table><thead><tr><th>Player</th><th class="num">Games</th><th class="num">Usable</th><th class="num">Benched</th><th class="num">Light nights</th><th class="num">Per game</th><th><span class="muted small">Remove</span></th></tr></thead><tbody>${
      wk.rows.map(r => { const on = tonight.includes(r.p.t), g = r.games * startShare(r.p), bench = g - r.used;
        return `<tr><td>${esc(r.p.n)} <span class="muted small">${esc(r.p.t)} ${POS[r.p.p]}</span>${on ? ' <span class="pill">TONIGHT</span>' : ""}</td><td class="num">${isG(r.p) ? fmt(g, 1) : r.games}</td><td class="num led">${isG(r.p) ? fmt(r.used, 1) : fmt(r.used, 0)}</td><td class="num${bench >= 0.5 ? " warn" : ""}">${bench >= 0.5 ? fmt(bench, isG(r.p) ? 1 : 0) : ""}</td><td class="num">${r.light}</td><td class="num">${fmt(r.v, 2)}</td><td><button class="x" data-rm-mine="${r.p.id}" aria-label="Remove ${esc(r.p.n)}">×</button></td></tr>`; }).join("")}</tbody></table></div>
    <p class="small muted">Goalies count expected starts (his share of his team's starts). Positions come from the NHL; if your platform lists a player at two positions, the Forwards / D / G lineup is the closer fit.</p>`;
  $("#open").innerHTML = `<h3>Open skater spots by night</h3><div class="nights">${wk.nights.map(nt => {
    const open = Object.entries(nt.left).filter(([s]) => s !== "G").reduce((a, [, k]) => a + k, 0), k = !nt.n ? "none" : open >= 3 ? "light" : open === 0 ? "packed" : "";
    return `<div class="night ${k}"><span class="small">${dayName(nt.d)} ${dayDate(nt.d)}</span><b class="led">${nt.n ? open : "-"}</b><span class="small">${nt.n ? (open ? "open" : "full") : "no games"}</span></div>`; }).join("")}</div>`;
  const adds = bestAdds(Z, wk, mine, f, L.k);
  $("#adds").innerHTML = !adds.length ? "" : `<h3>Best adds for your open spots</h3><p class="small muted">Likely on waivers in ${esc(f.name)}. Usable games = his team's games on nights you have an open spot he fits.</p><div class="scroll"><table><thead><tr><th>Player</th><th class="num">Usable games</th><th class="num">Per game</th><th class="num">Adds you</th></tr></thead><tbody>${
    adds.map(x => `<tr><td>${esc(x.p.n)} <span class="muted small">${esc(x.p.t)} ${POS[x.p.p]}</span></td><td class="num">${x.add}</td><td class="num">${fmt(x.v, 2)}</td><td class="num led">${fmt(x.total, 1)}</td></tr>`).join("")}</tbody></table></div>`;
}

/* ---------- pages ---------- */
async function home() {
  const [players, week, standings, T, S] = await Promise.all([load("players"), load("week"), load("standings"), load("today").catch(() => ({})), load("schedule")]);
  DATA = players; window.WEEK = week;
  const Z = seasonIndex(S);
  $("#slots").innerHTML = Object.entries(SLOTS).map(([k, x]) => `<option value="${k}">${x.name}</option>`).join("");
  $("#slots").value = SLOTS[store.get("slots", "espn")] ? store.get("slots", "espn") : "espn";
  $("#myweek").value = store.get("myweek", "rest") === "next" ? "next" : "rest";
  $("#slots").addEventListener("change", () => { store.set("slots", $("#slots").value); refresh(); });
  $("#myweek").addEventListener("change", () => { store.set("myweek", $("#myweek").value); refresh(); });
  $("#week-title").textContent = `${week.four.length} teams play 4 games`;
  $("#week-span").textContent = `${week.week[0]} to ${week.week[1]}`;
  $("#schedule").innerHTML = scheduleTable(week);
  const refresh = () => { tonightPanel(T); myTeamPanel(Z, T); };
  playerPicker($("#add-mine"), p => { const t = store.get("team", []); if (!t.includes(p.id)) { store.set("team", t.concat(p.id)); refresh(); } });
  document.addEventListener("click", e => { const x = e.target.closest("[data-rm-mine]"); if (!x) return;
    store.set("team", store.get("team", []).filter(id => String(id) !== x.dataset.rmMine)); refresh(); });
  tabs($("#leader-tabs"), k => { $("#leaders").innerHTML = leadersTable(k); refresh();
    $("#leader-note").textContent = FORMATS[k].name + ". Outside the top 150 in this format, so likely on waivers. Last 14 days blended with season."; });
  const byDiv = {};
  standings.rows.forEach(r => (byDiv[r.divisionName] = byDiv[r.divisionName] || []).push(r));
  $("#standings").innerHTML = Object.entries(byDiv).map(([div, rows]) => `<div><h3>${esc(div)}</h3><table><thead><tr><th>Team</th><th class="num">GP</th><th class="num">PTS</th><th class="num">GD</th></tr></thead><tbody>${
    rows.sort((a, b) => b.points - a.points).map(r => `<tr><td>${esc(r.teamAbbrev)}</td><td class="num">${r.gamesPlayed}</td><td class="num led">${r.points}</td><td class="num">${r.goalDifferential > 0 ? "+" : ""}${r.goalDifferential}</td></tr>`).join("")}</tbody></table></div>`).join("");
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
  return `<div class="nights">${Array.from({ length: 7 }, (_, i) => addDays(mon, i)).map(d => { const n = Z.perDay.get(d) || 0, k = nightKind(n);
    return `<div class="night ${k}"><span class="small">${dayName(d)} ${dayDate(d)}</span><b class="led">${n}</b><span class="small">${k === "light" ? "light night" : k === "packed" ? "packed" : k === "none" ? "no games" : "games"}</span></div>`; }).join("")}</div>`;
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
  tabs($("#sched-tabs"), () => draw());   // the scoring format only changes the goalie value column
  drawPO();
}

const PAGES = { home, hub, "fantasy-trade": fantasyTrade, "nhl-trade": nhlTrade, schedule: schedulePlanner };
document.addEventListener("DOMContentLoaded", () => {
  const fn = PAGES[document.body.dataset.page];
  if (fn) fn().catch(err => { const m = document.querySelector("main"); m.insertAdjacentHTML("afterbegin", `<p class="panel red">Couldn't load the data (${esc(err.message)}). Try reloading.</p>`); });
});
