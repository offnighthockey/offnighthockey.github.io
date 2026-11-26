/* Off-Night lab, round 2: three directions that differ in type, surface, motion and function, on live data.
   Loads after app.js and reuses its engine (rates, usable games, ESPN league, injuries). Shared here: team badges,
   view-models (tonight, my team with add/drop, team pages), and the plumbing each direction hooks into.
   1 Arena: swipe between full-screen sections under giant headline tabs.  2 Fresh Ice: light rink, zone tabs,
   flip cards, drag a free agent onto a roster player.  3 Scoreboard: LED board, split-flap titles, keys 1-3, player search. */
"use strict";

const TEAM_COLORS = { ANA: ["#F47A38", "#B9975B"], BOS: ["#FFB81C", "#111111"], BUF: ["#003087", "#FFB81C"], CGY: ["#C8102E", "#F1BE48"],
  CAR: ["#CE1126", "#111111"], CHI: ["#CF0A2C", "#111111"], COL: ["#6F263D", "#236192"], CBJ: ["#002654", "#CE1126"], DAL: ["#006847", "#8F8F8C"],
  DET: ["#CE1126", "#FFFFFF"], EDM: ["#041E42", "#FF4C00"], FLA: ["#C8102E", "#041E42"], LAK: ["#111111", "#A2AAAD"], MIN: ["#154734", "#A6192E"],
  MTL: ["#AF1E2D", "#192168"], NSH: ["#FFB81C", "#041E42"], NJD: ["#CE1126", "#111111"], NYI: ["#00539B", "#F47D30"], NYR: ["#0038A8", "#CE1126"],
  OTT: ["#C52032", "#C2912C"], PHI: ["#F74902", "#111111"], PIT: ["#FCB514", "#111111"], SJS: ["#006D75", "#EA7200"], SEA: ["#001628", "#99D9D9"],
  STL: ["#002F87", "#FCB514"], TBL: ["#002868", "#FFFFFF"], TOR: ["#00205B", "#FFFFFF"], UTA: ["#71AFE5", "#090909"], VAN: ["#00205B", "#00843D"],
  VGK: ["#B4975A", "#333F42"], WSH: ["#041E42", "#C8102E"], WPG: ["#041E42", "#AC162C"] };
const lum = hex => { const n = parseInt(hex.slice(1), 16), c = [n >> 16, (n >> 8) & 255, n & 255].map(v => { v /= 255; return v <= .04 ? v / 12.9 : ((v + .055) / 1.055) ** 2.4; });
  return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]; };
function tbadge(t, cls = "") {   // team colors, not logos: recognition without trademarks
  const [a, b] = TEAM_COLORS[t] || ["#33475e", "#8a9db2"];
  return `<span class="tb ${cls}" style="--c1:${a};--c2:${b};--fg:${lum(a) > .35 ? "#0b0f14" : "#fff"}" title="${esc(LAB.names[t] || t)}">${esc(t)}</span>`;
}
const LAB = { names: {}, teams: {}, Z: null, tab: 0, night: null, team: null, stand: {} };
const SECTIONS = ["Tonight", "My team", "Teams"], KEYS = ["tonight", "mine", "team"];
const mmss = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const pname = r => esc(r.p ? r.p.n : r.n);
const vfmt = x => fmt(x, 2);
const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const scoringSelect = `<label class="scoring"><span>Scoring</span><select id="fmt" aria-label="Your league's scoring"></select></label>`;
let S_GAMES = [];

/* ---------- view-models: the same numbers for every direction ---------- */
function tonightVM() {
  const Z = LAB.Z, k = league().k, f = FORMATS[k], mon = mondayOf(todayISO()), d = LAB.night || todayISO(), n = Z.perDay.get(d) || 0;
  return { d, n, kind: nightKind(n), f, k, games: S_GAMES.filter(g => g[0] === d).map(([, a, h]) => ({ a, h })),
    nights: Array.from({ length: 7 }, (_, i) => addDays(mon, i)).map(x => ({ d: x, n: Z.perDay.get(x) || 0, kind: nightKind(Z.perDay.get(x) || 0) })),
    streamers: n ? nightStreamers(Z, d, k, 6) : [], goalies: n ? nightGoalies(Z, d, k, 4) : [] };
}
function mineVM() {
  const mine = myRoster(), k = league().k, f = FORMATS[k], today = todayISO(), mon = mondayOf(today);
  if (!mine.length) return { none: true, f, k };
  const W = usableWeek(LAB.Z, mine, today, addDays(mon, 6), slotSet(), f, k), tot = weekTotals(W);
  const ros = p => value(p, f, k, gamesLeft(p)), weekPts = new Map(W.rows.map(r => [r.p.id, r.used * r.v]));
  const adds = bestAdds(LAB.Z, W, mine, f, k).slice(0, 8).map(a => ({ ...a, ros: ros(a.p) }));
  const roster = mine.filter(p => LINEUP[p.id] !== 8).map(p => ({ p, week: weekPts.get(p.id) || 0, ros: ros(p), out: isOut(p) }));
  const evalPair = (a, d) => ({ a, d, week: a.total - d.week, rest: a.ros - d.ros });
  const drops = roster.slice().sort((x, y) => x.ros - y.ros || x.week - y.week).slice(0, 4), pairs = [], used = new Set();
  adds.flatMap(a => drops.map(d => evalPair(a, d))).filter(x => x.week > 0.3 && x.rest > -6).sort((x, y) => (y.week + .15 * y.rest) - (x.week + .15 * x.rest))
    .forEach(x => { if (pairs.length < 3 && !used.has(x.a.p.id) && !used.has(x.d.p.id)) { used.add(x.a.p.id); used.add(x.d.p.id); pairs.push(x); } });
  return { mine, W, tot, f, k, adds, roster, drops, pairs, evalPair, empty: W.nights.filter(nt => nt.n).reduce((a, nt) => a + openSkaters(nt.left), 0),
    fix: lineupFix(LAB.Z, today, mine, f, k), league: LEAGUE ? { name: LEAGUE.name, me: LEAGUE.myName, opp: LEAGUE.oppName, pts: LEAGUE.pts, acq: LEAGUE.acq } : null };
}
function teamVM(t) {
  const T = LAB.teams[t], byId = new Map(everyone().map(p => [p.id, p])), k = league().k, f = FORMATS[k];
  const roster = T.roster.map(([id, n, pos, num]) => ({ id, n, pos, num, p: byId.get(id) }));
  const healthy = roster.filter(r => r.p && !isOut(r.p)), ice = r => r.p.rt || r.p.toi;
  const F = healthy.filter(r => "CLR".includes(r.pos)).sort((a, b) => ice(b) - ice(a)), D = healthy.filter(r => r.pos === "D").sort((a, b) => ice(b) - ice(a));
  return { t, f, k, name: LAB.names[t] || t, record: LAB.stand[t] || "", ice,
    lines: [0, 1, 2, 3].map(i => F.slice(i * 3, i * 3 + 3)), pairs: [0, 1, 2].map(i => D.slice(i * 2, i * 2 + 2)),
    G: roster.filter(r => r.pos === "G" && r.p).sort((a, b) => b.p.gs - a.p.gs), pp1: healthy.filter(r => r.pos !== "G").sort((a, b) => b.p.pp - a.p.pp).slice(0, 5),
    out: roster.filter(r => r.p && isOut(r.p)), noGames: roster.filter(r => !r.p),
    sys: T.system.map(([id, n, pos, by]) => ({ id, n, pos, age: by ? new Date().getFullYear() - by : null })),
    next: LAB.Z.byTeam[t].filter(g => g.d >= todayISO()).slice(0, 4), v: r => perGame(r.p, f, k) };
}
const pairWhy = pr => `${esc(pr.a.p.n)} plays ${pr.a.add} of your open nights (${vfmt(pr.a.v)} a game). ${esc(pr.d.p.n)} ${pr.d.out ? `is out (${esc(injNote(pr.d.p) || "not dressing")})` : `projects ${fmt(pr.d.week, 1)} this week`}. Rest of season: ${pr.rest >= 0 ? "+" : ""}${fmt(pr.rest, 1)} over a replacement player.`;
const nextGames = vm => vm.next.map(g => `${dayName(g.d)} ${g.home ? "vs" : "@"} ${g.opp}`).join(", ");
const dateLong = d => new Date(d + "T12:00Z").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });

/* ---------- plumbing: draw, go to a section, react to picks ---------- */
const VARIANTS = {};
const V = () => VARIANTS[document.body.dataset.variant];
function draw() { document.querySelector("#app").innerHTML = V().render(); wireScoring(); V().after && V().after(); }
function wireScoring() { const sel = document.querySelector("#fmt"); if (sel && !sel.options.length) initScoring(); }
function redraw(i) { V().redraw ? V().redraw(i) : draw(); }
function go(i) { i = (i + 3) % 3; if (i === LAB.tab && V().keep) return; V().go(i); }
document.addEventListener("click", e => {
  const t = e.target.closest && e.target.closest("[data-go]"); if (t) return go(+t.dataset.go);
  const n = e.target.closest && e.target.closest("[data-night]"); if (n) { LAB.night = n.dataset.night; return redraw(0); }
  const tm = e.target.closest && e.target.closest("[data-team]"); if (tm) { LAB.team = tm.dataset.team; redraw(2); if (LAB.tab !== 2) go(2); }
});
async function lab() {
  const [players, S, teams, week, standings] = await Promise.all([load("players"), load("schedule"), load("teams"), load("week").catch(() => ({ names: {} })), load("standings").catch(() => ({ rows: [] }))]);
  DATA = players; S_GAMES = S.games; LAB.Z = seasonIndex(S); LAB.teams = teams.teams; LAB.names = week.names || {};
  LAB.stand = Object.fromEntries((standings.rows || []).map(r => [r.teamAbbrev, `${r.wins}-${r.losses}-${r.otLosses}`]));
  await loadLeague();
  const h = KEYS.indexOf(location.hash.slice(1)); if (h >= 0) LAB.tab = h;
  LAB.team = (myRoster()[0] || {}).t || "COL";
  onLeague(() => draw());
  draw();
}
PAGES.lab = lab;
const setHash = i => history.replaceState(null, "", "#" + KEYS[i]);

/* ======================================================================================================
   1. ARENA. Full-screen sections side by side; the giant words at the top are the tabs. Swipe, scroll or click:
   the words brighten with scroll progress and a puck glides under them. Cards catch a spotlight under the cursor.
   ====================================================================================================== */
const A = {};
A.tonight = vm => `<div class="ar-nights">${vm.nights.map(x => `<button type="button" data-night="${x.d}" class="${x.kind}" aria-pressed="${x.d === vm.d}"><span>${dayName(x.d)}</span><b>${x.n}</b></button>`).join("")}</div>
  <h2 class="ar-h">${dateLong(vm.d)}<em class="${vm.kind}">${vm.n} ${vm.n === 1 ? "game" : "games"}${vm.kind === "light" ? ", light night" : vm.kind === "packed" ? ", packed" : ""}</em></h2>
  <div class="ar-faceoffs">${vm.games.map(g => `<div class="ar-fo spot">${tbadge(g.a, "lg")}<span>at</span>${tbadge(g.h, "lg")}</div>`).join("") || `<p class="ar-quiet">No games. Pick another night.</p>`}</div>
  <h3 class="ar-h3">Streamers on this slate</h3><div class="ar-cards">${vm.streamers.map(x => `<article class="ar-card spot">${tbadge(x.p.t)}<b>${esc(x.p.n)}</b><small>${POS[x.p.p]}, ${x.p.gp} games, ${x.p.rgp} in the last 14 days</small>${sparks(x.p, vm.f)}<strong>${vfmt(x.v)}<i>per game</i></strong></article>`).join("")}</div>`;
A.mine = vm => vm.none ? `<p class="ar-quiet">Connect your ESPN league on <a href="team.html">My team</a>, then come back.</p>` :
  `${vm.league ? `<div class="ar-score"><span>${esc(vm.league.me)}</span><b>${fmt(vm.league.pts ? vm.league.pts[0] : 0, 1)}</b><i>to</i><b>${fmt(vm.league.pts ? vm.league.pts[1] : 0, 1)}</b><span>${esc(vm.league.opp)}</span></div>` : ""}
  <p class="ar-big"><b>${fmt(vm.tot.u, 0)}</b> of your ${fmt(vm.tot.g, 0)} games count this week. ${vm.empty} empty spot-nights.</p>${vm.fix ? `<p class="ar-alert">${fixText(vm.fix)}</p>` : ""}
  <h3 class="ar-h3">Make these moves</h3>${vm.pairs.map(pr => `<article class="ar-swap spot"><div><em>Add</em>${tbadge(pr.a.p.t, "lg")}<b>${esc(pr.a.p.n)}</b>${sparks(pr.a.p, vm.f)}</div>
    <strong>+${fmt(pr.week, 1)}<i>this week</i></strong><div><em class="red">Drop</em>${tbadge(pr.d.p.t, "lg")}<b>${esc(pr.d.p.n)}</b>${badge(pr.d.p)}</div><p>${pairWhy(pr)}</p></article>`).join("") || `<p class="ar-quiet">Nothing on the wire beats your roster this week. Hold.</p>`}`;
A.team = vm => `<div class="ar-rack">${Object.keys(LAB.teams).sort().map(t => `<button type="button" data-team="${t}" aria-pressed="${t === vm.t}">${tbadge(t)}</button>`).join("")}</div>
  <div class="ar-teamhead">${tbadge(vm.t, "xl")}<div><h2>${esc(vm.name)}</h2><p>${vm.record}. Next: ${nextGames(vm)}</p></div></div>
  <p class="ar-note">Lines by ice time over the last 14 days. The NHL doesn't publish line combinations.</p>
  <div class="ar-lines">${vm.lines.map((ln, i) => `<div class="ar-line"><span>Line ${i + 1}</span>${ln.map(r => `<div class="ar-jersey spot"><b>${r.num ?? ""}</b><span>${pname(r)}</span><small>${POS[r.pos] || r.pos}, ${mmss(vm.ice(r))}</small></div>`).join("")}</div>`).join("")}
  ${vm.pairs.map((pr, i) => `<div class="ar-line d"><span>Pair ${i + 1}</span>${pr.map(r => `<div class="ar-jersey spot"><b>${r.num ?? ""}</b><span>${pname(r)}</span><small>D, ${mmss(vm.ice(r))}</small></div>`).join("")}</div>`).join("")}
  <div class="ar-line g"><span>Goal</span>${vm.G.map(r => `<div class="ar-jersey spot"><b>${r.num ?? ""}</b><span>${pname(r)}</span><small>${r.p.gs} starts</small></div>`).join("")}</div></div>
  <div class="ar-cols"><div><h3 class="ar-h3">Out</h3>${vm.out.map(r => `<p class="ar-row">${pname(r)} ${badge(r.p)}<small>${esc(injNote(r.p) || "")}</small></p>`).join("") || `<p class="ar-quiet">Nobody.</p>`}</div>
  <div><h3 class="ar-h3">In the system</h3><p class="ar-note">Signed or drafted, not on the NHL roster.</p>${vm.sys.map(s => `<p class="ar-row">${esc(s.n)}<small>${POS[s.pos] || s.pos}${s.age ? `, ${s.age}` : ""}</small></p>`).join("") || `<p class="ar-quiet">None listed.</p>`}</div></div>`;
VARIANTS.arena = {
  render: () => `<header class="ar-top"><a href="index.html"><img src="logo.png" alt="Off-Night Hockey"></a>${scoringSelect}</header>
    <nav class="ar-words" role="tablist" aria-label="Sections">${SECTIONS.map((s, i) => `<button type="button" role="tab" data-go="${i}" aria-selected="${i === LAB.tab}">${s}</button>`).join("")}<i class="ar-puck" aria-hidden="true"></i></nav>
    <div class="ar-track" id="track">${[A.tonight(tonightVM()), A.mine(mineVM()), A.team(teamVM(LAB.team))].map((h, i) => `<section class="ar-slide" id="slide-${i}" role="tabpanel">${h}</section>`).join("")}</div>`,
  redraw: i => { const el = document.querySelector("#slide-" + i); if (el) el.innerHTML = [A.tonight, A.mine, A.team][i](i === 0 ? tonightVM() : i === 1 ? mineVM() : teamVM(LAB.team)); },
  go: i => { const tr = document.querySelector("#track"); tr.scrollTo({ left: i * tr.clientWidth, behavior: calm() ? "auto" : "smooth" }); },
  after: () => {
    const tr = document.querySelector("#track"), words = [...document.querySelectorAll(".ar-words button")], puck = document.querySelector(".ar-puck");
    tr.scrollLeft = LAB.tab * tr.clientWidth;
    const sync = () => {   // words and puck follow the swipe continuously, not just at the end
      const p = tr.scrollLeft / Math.max(tr.clientWidth, 1), i = Math.round(p);
      words.forEach((w, j) => { w.style.opacity = String(Math.max(.28, 1 - Math.abs(p - j) * .72)); w.setAttribute("aria-selected", String(j === i)); });
      const a = words[Math.floor(p)] || words[0], b = words[Math.ceil(p)] || a, t = p - Math.floor(p);
      const x = (a.offsetLeft + a.offsetWidth / 2) * (1 - t) + (b.offsetLeft + b.offsetWidth / 2) * t;
      puck.style.transform = `translateX(${x - 14}px) rotate(${p * 360}deg)`;
      if (i !== LAB.tab) { LAB.tab = i; setHash(i); }
    };
    tr.addEventListener("scroll", sync, { passive: true }); addEventListener("resize", sync); sync();
    document.querySelector(".ar-words").addEventListener("keydown", e => { if (e.key === "ArrowRight") go(LAB.tab + 1); if (e.key === "ArrowLeft") go(LAB.tab - 1); });
    document.querySelector("#app").addEventListener("pointermove", e => { const c = e.target.closest && e.target.closest(".spot"); if (!c) return;
      const r = c.getBoundingClientRect(); c.style.setProperty("--mx", `${e.clientX - r.left}px`); c.style.setProperty("--my", `${e.clientY - r.top}px`); });
  },
};

/* ======================================================================================================
   2. FRESH ICE. Light rink surface. The section switcher is a rink diagram: tap a zone and the page pans over
   while a Zamboni sheen resurfaces it. Cards flip to show their evidence. Drag a free agent onto a roster player
   (or tap one, then the other) to see what that swap does.
   ====================================================================================================== */
const B = {};
const flip = (front, back) => `<article class="ic-card"><div class="ic-inner"><div class="ic-face">${front}<button type="button" class="ic-turn">Why</button></div><div class="ic-face ic-back">${back}<button type="button" class="ic-turn">Back</button></div></div></article>`;
B.tonight = vm => `<div class="ic-nights">${vm.nights.map(x => `<button type="button" data-night="${x.d}" class="${x.kind}" aria-pressed="${x.d === vm.d}"><b>${x.n}</b><span>${dayName(x.d)} ${dayDate(x.d)}</span></button>`).join("")}</div>
  <h2 class="ic-h">${dateLong(vm.d)}: ${vm.n} ${vm.n === 1 ? "game" : "games"}</h2><div class="ic-games">${vm.games.map(g => `<span>${tbadge(g.a)} at ${tbadge(g.h)}</span>`).join("") || "No games."}</div>
  <h3 class="ic-h3">Streamers <small>tap Why to flip a card</small></h3><div class="ic-grid">${vm.streamers.map(x => flip(
    `${tbadge(x.p.t)}<b>${esc(x.p.n)}</b><small>${POS[x.p.p]}, ${x.p.gp} games</small>${sparks(x.p, vm.f)}<strong>${vfmt(x.v)}</strong>`, why(x.p, vm.f))).join("")}</div>`;
B.mine = vm => vm.none ? `<p>Connect your ESPN league on <a href="team.html">My team</a> first.</p>` :
  `<h2 class="ic-h">Try a swap</h2><p class="ic-sub">Drag a free agent onto someone on your roster, or tap one and then the other. ${vm.fix ? fixText(vm.fix) : ""}</p>
  <div class="ic-swap"><div><h3 class="ic-h3">On the wire</h3>${vm.adds.map((a, i) => `<button type="button" class="ic-chip fa" draggable="true" data-fa="${i}">${tbadge(a.p.t)} <b>${esc(a.p.n)}</b><small>+${fmt(a.total, 1)} this week</small></button>`).join("")}</div>
    <div class="ic-result" id="swap-result"><p>${vm.pairs[0] ? `Best swap right now: <b>add ${esc(vm.pairs[0].a.p.n)}, drop ${esc(vm.pairs[0].d.p.n)}</b>, +${fmt(vm.pairs[0].week, 1)} this week.` : "Pick a free agent and a roster player."}</p></div>
    <div><h3 class="ic-h3">Your roster</h3>${vm.roster.slice().sort((x, y) => x.ros - y.ros).map((d, i) => `<button type="button" class="ic-chip ro" data-ro="${vm.roster.indexOf(d)}">${tbadge(d.p.t)} <b>${esc(d.p.n)}</b>${badge(d.p)}<small>${fmt(d.week, 1)} this week</small></button>`).join("")}</div></div>`;
B.team = vm => `<div class="ic-teams">${Object.keys(LAB.teams).sort().map(t => `<button type="button" data-team="${t}" aria-pressed="${t === vm.t}">${tbadge(t)}</button>`).join("")}</div>
  <h2 class="ic-h">${tbadge(vm.t, "lg")} ${esc(vm.name)} <small>${vm.record}</small></h2><p class="ic-sub">Next: ${nextGames(vm)}. Lines by ice time, last 14 days.</p>
  <div class="ic-depth"><div class="ic-col"><h3 class="ic-h3">Forwards</h3>${vm.lines.map((ln, i) => `<div class="ic-line"><em>${i + 1}</em>${ln.map(r => `<span>${pname(r)}<small>${mmss(vm.ice(r))}</small></span>`).join("")}</div>`).join("")}</div>
  <div class="ic-col"><h3 class="ic-h3">Defense</h3>${vm.pairs.map((pr, i) => `<div class="ic-line"><em>${i + 1}</em>${pr.map(r => `<span>${pname(r)}<small>${mmss(vm.ice(r))}</small></span>`).join("")}</div>`).join("")}
  <h3 class="ic-h3">Goal</h3>${vm.G.map(r => `<div class="ic-line"><span>${pname(r)}<small>${r.p.gs} starts</small></span></div>`).join("")}</div>
  <div class="ic-col"><h3 class="ic-h3">Out</h3>${vm.out.map(r => `<p>${pname(r)} ${badge(r.p)}</p>`).join("") || "<p>Nobody.</p>"}<h3 class="ic-h3">In the system</h3>${vm.sys.map(s => `<p>${esc(s.n)} <small>${POS[s.pos] || s.pos}${s.age ? `, ${s.age}` : ""}</small></p>`).join("") || "<p>None listed.</p>"}</div></div>`;
let ICE_VM = null, ICE_PICK = null;
function iceSwap(ai, ri) {
  const vm = ICE_VM, a = vm.adds[ai], d = vm.roster[ri]; if (!a || !d) return;
  const x = vm.evalPair(a, d), good = x.week >= 0.5 && x.rest > -3 || x.rest >= 3 && x.week >= 0;
  const verdict = x.week < 0 ? "You'd lose points this week." : x.rest <= -3 ? "Costs you over the rest of the season." : !good ? "Barely moves the needle. Save the add." : "Worth it.";
  document.querySelector("#swap-result").innerHTML = `<p class="${good ? "good" : "bad"}"><b>Add ${esc(a.p.n)}, drop ${esc(d.p.n)}</b></p><p class="ic-delta"><span>${x.week >= 0 ? "+" : ""}${fmt(x.week, 1)}</span> this week <span>${x.rest >= 0 ? "+" : ""}${fmt(x.rest, 1)}</span> rest of season</p><p>${pairWhy(x)}</p><p>${verdict}</p>`;
  document.querySelectorAll(".ic-chip").forEach(c => c.classList.remove("picked"));
}
VARIANTS.ice = {
  render: () => { ICE_VM = mineVM(); return `<header class="ic-top"><a href="index.html"><img src="logo.png" alt="Off-Night Hockey"></a>${scoringSelect}</header>
    <nav class="ic-rink" role="tablist" aria-label="Sections" style="--z:${LAB.tab}">${SECTIONS.map((s, i) => `<button type="button" role="tab" data-go="${i}" aria-selected="${i === LAB.tab}">${s}</button>`).join("")}<i class="ic-puck" aria-hidden="true"></i></nav>
    <div class="ic-view"><div class="ic-track" id="track" style="--z:${LAB.tab}">${[B.tonight(tonightVM()), B.mine(ICE_VM), B.team(teamVM(LAB.team))].map((h, i) => `<section class="ic-zone" id="slide-${i}" role="tabpanel" ${i === LAB.tab ? "" : "inert"}>${h}</section>`).join("")}</div><div class="ic-zamboni" aria-hidden="true"></div></div>`; },
  redraw: i => { const el = document.querySelector("#slide-" + i); if (el) { if (i === 1) ICE_VM = mineVM(); el.innerHTML = [B.tonight, B.mine, B.team][i](i === 0 ? tonightVM() : i === 1 ? ICE_VM : teamVM(LAB.team)); } },
  go: i => {
    LAB.tab = i; setHash(i);
    document.querySelectorAll(".ic-rink, .ic-track").forEach(el => el.style.setProperty("--z", i));
    document.querySelectorAll(".ic-rink [role=tab]").forEach((b, j) => b.setAttribute("aria-selected", String(j === i)));
    document.querySelectorAll(".ic-zone").forEach((z, j) => z.toggleAttribute("inert", j !== i));
    const zam = document.querySelector(".ic-zamboni"); zam.classList.remove("run"); void zam.offsetWidth; if (!calm()) zam.classList.add("run");
  },
  after: () => {
    const app = document.querySelector("#app");
    app.addEventListener("click", e => {
      const turn = e.target.closest(".ic-turn"); if (turn) return turn.closest(".ic-card").classList.toggle("flipped");
      const fa = e.target.closest(".fa"), ro = e.target.closest(".ro");
      if (fa) { ICE_PICK = { fa: +fa.dataset.fa }; document.querySelectorAll(".fa").forEach(c => c.classList.toggle("picked", c === fa)); }
      if (ro && ICE_PICK) iceSwap(ICE_PICK.fa, +ro.dataset.ro);
    });
    app.addEventListener("dragstart", e => { const fa = e.target.closest(".fa"); if (fa) e.dataTransfer.setData("text/plain", fa.dataset.fa); });
    app.addEventListener("dragover", e => { const ro = e.target.closest(".ro"); if (ro) { e.preventDefault(); ro.classList.add("over"); } });
    app.addEventListener("dragleave", e => { const ro = e.target.closest(".ro"); if (ro) ro.classList.remove("over"); });
    app.addEventListener("drop", e => { const ro = e.target.closest(".ro"); if (!ro) return; e.preventDefault(); ro.classList.remove("over"); iceSwap(+e.dataTransfer.getData("text/plain"), +ro.dataset.ro); });
  },
};

/* ======================================================================================================
   3. SCOREBOARD. An LED board. Sections are lit panels (keys 1, 2, 3); titles flip like a split-flap board
   and rows light up line by line. Press / to search any player and pin two side by side to compare.
   ====================================================================================================== */
const C = {};
const flap = s => [...s].map((ch, i) => `<span class="fl" style="--i:${i}">${ch === " " ? "&nbsp;" : esc(ch)}</span>`).join("");
const row = (cells, i) => `<div class="sb-row" style="--r:${i}">${cells}</div>`;
C.tonight = vm => `<div class="sb-nights">${vm.nights.map(x => `<button type="button" data-night="${x.d}" class="${x.kind}" aria-pressed="${x.d === vm.d}"><span>${dayName(x.d)}</span><b>${x.n}</b></button>`).join("")}</div>
  <h2 class="sb-title">${flap(`${dayName(vm.d)} ${dayDate(vm.d)}: ${vm.n} games`)}</h2>
  <div class="sb-table">${vm.games.map((g, i) => row(`${tbadge(g.a, "sm")}<span class="sb-at">at</span>${tbadge(g.h, "sm")}<span class="sb-dim">${LAB.stand[g.a] || ""} vs ${LAB.stand[g.h] || ""}</span>`, i)).join("")}</div>
  <h3 class="sb-sub">Streamers</h3><div class="sb-table">${vm.streamers.map((x, i) => row(`${tbadge(x.p.t, "sm")}<button type="button" class="sb-name" data-pin="${x.p.id}">${esc(x.p.n)}</button><span class="sb-dim">${POS[x.p.p]} ${x.p.gp}gp</span>${sparks(x.p, vm.f)}<b class="sb-val">${vfmt(x.v)}</b>`, i)).join("")}</div>`;
C.mine = vm => vm.none ? `<h2 class="sb-title">${flap("No team loaded")}</h2><p class="sb-dim">Connect your ESPN league on My team.</p>` :
  `<h2 class="sb-title">${flap(vm.league ? `${vm.league.me} ${fmt(vm.league.pts ? vm.league.pts[0] : 0, 1)} - ${fmt(vm.league.pts ? vm.league.pts[1] : 0, 1)}` : "Your week")}</h2>
  <div class="sb-stats"><div><b>${fmt(vm.tot.u, 0)}/${fmt(vm.tot.g, 0)}</b><span>games count</span></div><div><b>${vm.empty}</b><span>empty spots</span></div><div><b>${vm.league && vm.league.acq > 0 ? vm.league.acq : "-"}</b><span>adds a matchup</span></div></div>
  ${vm.fix ? `<p class="sb-alert">${fixText(vm.fix)}</p>` : ""}<h3 class="sb-sub">Moves</h3><div class="sb-table">${vm.pairs.map((pr, i) => row(`<span class="sb-g">ADD</span><button type="button" class="sb-name" data-pin="${pr.a.p.id}">${esc(pr.a.p.n)}</button><span class="sb-r">DROP</span><button type="button" class="sb-name" data-pin="${pr.d.p.id}">${esc(pr.d.p.n)}</button><b class="sb-val">+${fmt(pr.week, 1)}</b>`, i)).join("") || row(`<span class="sb-dim">No move beats your roster this week.</span>`, 0)}</div>`;
C.team = vm => `<div class="sb-teams">${Object.keys(LAB.teams).sort().map(t => `<button type="button" data-team="${t}" aria-pressed="${t === vm.t}">${t}</button>`).join("")}</div>
  <h2 class="sb-title">${flap(`${vm.t} ${vm.record}`)}</h2><p class="sb-dim">${esc(vm.name)}. Next: ${nextGames(vm)}. Lines by ice time, last 14 days.</p>
  <div class="sb-table">${vm.lines.map((ln, i) => row(`<span class="sb-g">L${i + 1}</span>${ln.map(r => `<button type="button" class="sb-name" data-pin="${r.id}">${pname(r)}</button>`).join("")}`, i)).join("")}
  ${vm.pairs.map((pr, i) => row(`<span class="sb-g">D${i + 1}</span>${pr.map(r => `<button type="button" class="sb-name" data-pin="${r.id}">${pname(r)}</button>`).join("")}`, i + 4)).join("")}
  ${row(`<span class="sb-g">G</span>${vm.G.map(r => `<button type="button" class="sb-name" data-pin="${r.id}">${pname(r)}</button><span class="sb-dim">${r.p.gs}gs</span>`).join("")}`, 7)}</div>
  <h3 class="sb-sub">Out</h3><div class="sb-table">${vm.out.map((r, i) => row(`${pname(r)} ${badge(r.p)}<span class="sb-dim">${esc(injNote(r.p) || "")}</span>`, i)).join("") || row(`<span class="sb-dim">Nobody</span>`, 0)}</div>
  <h3 class="sb-sub">In the system</h3><div class="sb-table">${vm.sys.map((s, i) => row(`${esc(s.n)}<span class="sb-dim">${POS[s.pos] || s.pos}${s.age ? " " + s.age : ""}</span>`, i)).join("") || row(`<span class="sb-dim">None listed</span>`, 0)}</div>`;
const PINS = [];
function pinCard(p) {
  const f = FORMATS[league().k];
  return `<article class="sb-card">${tbadge(p.t)}<h4>${esc(p.n)}${badge(p)}</h4>${isG(p) ? `<p class="sb-dim">${p.gs} starts this season</p>` : sparks(p, f)}<div class="whybox">${isG(p) ? "" : why(p, f)}</div><button type="button" class="sb-unpin" data-unpin="${p.id}">Remove</button></article>`;
}
function drawPins() { const byId = new Map(everyone().map(p => [p.id, p])); document.querySelector("#pins").innerHTML = PINS.map(id => byId.get(id)).filter(Boolean).map(pinCard).join(""); }
VARIANTS.board = {
  render: () => `<header class="sb-board"><a href="index.html" class="sb-logo"><img src="logo.png" alt="Off-Night Hockey"></a>
      <nav class="sb-tabs" role="tablist" aria-label="Sections">${SECTIONS.map((s, i) => `<button type="button" role="tab" data-go="${i}" aria-selected="${i === LAB.tab}"><b>${i + 1}</b>${s}</button>`).join("")}</nav>
      <label class="sb-find"><span>Search</span><input id="q" placeholder="Press / to find a player" autocomplete="off"></label>${scoringSelect}</header>
    <div id="results" class="sb-results" hidden></div><div id="pins" class="sb-pins"></div>
    <main class="sb-panel" id="panel" role="tabpanel">${[C.tonight, C.mine, C.team][LAB.tab](LAB.tab === 0 ? tonightVM() : LAB.tab === 1 ? mineVM() : teamVM(LAB.team))}</main>`,
  redraw: i => { if (i === LAB.tab) VARIANTS.board.go(i, true); },
  go: (i, same) => {
    LAB.tab = i; setHash(i);
    document.querySelectorAll(".sb-tabs [role=tab]").forEach((b, j) => b.setAttribute("aria-selected", String(j === i)));
    const panel = document.querySelector("#panel");
    panel.innerHTML = [C.tonight, C.mine, C.team][i](i === 0 ? tonightVM() : i === 1 ? mineVM() : teamVM(LAB.team));
    panel.classList.remove("play"); void panel.offsetWidth; if (!calm()) panel.classList.add("play");
  },
  after: () => {
    const q = document.querySelector("#q"), res = document.querySelector("#results");
    document.querySelector("#panel").classList.add("play");
    document.addEventListener("keydown", e => {
      if (e.target === q) { if (e.key === "Escape") { q.value = ""; res.hidden = true; q.blur(); } return; }
      if (e.key === "/") { e.preventDefault(); q.focus(); }
      if (["1", "2", "3"].includes(e.key)) go(+e.key - 1);
    });
    q.addEventListener("input", () => {
      const s = normName(q.value); if (s.length < 2) { res.hidden = true; return; }
      const hits = everyone().filter(p => normName(p.n).includes(s)).slice(0, 8);
      res.innerHTML = hits.map(p => `<button type="button" data-pin="${p.id}">${tbadge(p.t, "sm")} ${esc(p.n)} <span class="sb-dim">${POS[p.p]}</span></button>`).join("") || `<p class="sb-dim">No match.</p>`;
      res.hidden = false;
    });
    document.querySelector("#app").addEventListener("click", e => {
      const pin = e.target.closest("[data-pin]"), un = e.target.closest("[data-unpin]");
      if (pin) { const id = +pin.dataset.pin; if (!PINS.includes(id)) { PINS.push(id); if (PINS.length > 2) PINS.shift(); } res.hidden = true; q.value = ""; drawPins(); }
      if (un) { PINS.splice(PINS.indexOf(+un.dataset.unpin), 1); drawPins(); }
    });
  },
};
