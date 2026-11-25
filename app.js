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
function tabs(el, onPick, keys = Object.keys(FORMATS), start = "espn") {
  el.innerHTML = keys.map(k => `<button type="button" data-k="${k}" aria-pressed="${k === start}">${FORMATS[k].name.split(" (")[0]}</button>`).join("");
  el.addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return;
    el.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", x === b)); onPick(b.dataset.k); });
  onPick(start);
}

/* ---------- pages ---------- */
async function home() {
  const [players, week, standings] = await Promise.all([load("players"), load("week"), load("standings")]);
  DATA = players; window.WEEK = week;
  $("#week-title").textContent = `${week.four.length} teams play 4 games`;
  $("#week-span").textContent = `${week.week[0]} to ${week.week[1]}`;
  $("#schedule").innerHTML = scheduleTable(week);
  tabs($("#leader-tabs"), k => { $("#leaders").innerHTML = leadersTable(k); $("#leader-note").textContent = FORMATS[k].name + ". Outside the top 150 in this format, so likely on waivers. Last 14 days blended with season."; });
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
  let fkey = "espn";
  const custom = { ...FORMATS.espn.sk };
  const fmtOf = () => fkey === "custom" ? { name: "Custom points", type: "points", sk: custom, g: FORMATS.espn.g } : FORMATS[fkey];
  const sel = $("#format");
  sel.innerHTML = Object.entries(FORMATS).map(([k, f]) => `<option value="${k}">${f.name}</option>`).join("") + `<option value="custom">Custom points (your league)</option>`;
  $("#weights").innerHTML = SK_KEYS.map(k => `<div><label for="w-${k}">${LABEL[k]}</label><input id="w-${k}" type="number" step="0.1" value="${custom[k] ?? 0}"></div>`).join("");
  $("#weights").addEventListener("input", e => { const k = e.target.id.slice(2); custom[k] = parseFloat(e.target.value) || 0; RCACHE = {}; render(); });
  sel.addEventListener("change", () => { fkey = sel.value; $("#custom").hidden = fkey !== "custom"; RCACHE = {}; ZCACHE = {}; render(); });
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

const PAGES = { home, hub, "fantasy-trade": fantasyTrade, "nhl-trade": nhlTrade };
document.addEventListener("DOMContentLoaded", () => {
  const fn = PAGES[document.body.dataset.page];
  if (fn) fn().catch(err => { const m = document.querySelector("main"); m.insertAdjacentHTML("afterbegin", `<p class="panel red">Couldn't load the data (${esc(err.message)}). Try reloading.</p>`); });
});
