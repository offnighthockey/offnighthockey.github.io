/* Off-Night lab: three design directions for the rebuild, on live data. Loads after app.js and reuses its engine
   (rates, usable games, ESPN league, injuries). Shared here: team badges, add/drop pairs, team pages, tab transitions.
   Each direction (A broadcast, B rink, C analyst) only changes how the same view-models are drawn. */
"use strict";

// Team colors (facts, not logos): badges give the at-a-glance recognition without using trademarks.
const TEAM_COLORS = { ANA: ["#F47A38", "#B9975B"], BOS: ["#FFB81C", "#111111"], BUF: ["#003087", "#FFB81C"], CGY: ["#C8102E", "#F1BE48"],
  CAR: ["#CE1126", "#111111"], CHI: ["#CF0A2C", "#111111"], COL: ["#6F263D", "#236192"], CBJ: ["#002654", "#CE1126"], DAL: ["#006847", "#8F8F8C"],
  DET: ["#CE1126", "#FFFFFF"], EDM: ["#041E42", "#FF4C00"], FLA: ["#C8102E", "#041E42"], LAK: ["#111111", "#A2AAAD"], MIN: ["#154734", "#A6192E"],
  MTL: ["#AF1E2D", "#192168"], NSH: ["#FFB81C", "#041E42"], NJD: ["#CE1126", "#111111"], NYI: ["#00539B", "#F47D30"], NYR: ["#0038A8", "#CE1126"],
  OTT: ["#C52032", "#C2912C"], PHI: ["#F74902", "#111111"], PIT: ["#FCB514", "#111111"], SJS: ["#006D75", "#EA7200"], SEA: ["#001628", "#99D9D9"],
  STL: ["#002F87", "#FCB514"], TBL: ["#002868", "#FFFFFF"], TOR: ["#00205B", "#FFFFFF"], UTA: ["#71AFE5", "#090909"], VAN: ["#00205B", "#00843D"],
  VGK: ["#B4975A", "#333F42"], WSH: ["#041E42", "#C8102E"], WPG: ["#041E42", "#AC162C"] };
const lum = hex => { const n = parseInt(hex.slice(1), 16), c = [n >> 16, (n >> 8) & 255, n & 255].map(v => { v /= 255; return v <= .04 ? v / 12.9 : ((v + .055) / 1.055) ** 2.4; });
  return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]; };
function tbadge(t, cls = "") {
  const [a, b] = TEAM_COLORS[t] || ["#33475e", "#8a9db2"];
  return `<span class="tb ${cls}" style="--c1:${a};--c2:${b};--fg:${lum(a) > .35 ? "#0b0f14" : "#fff"}" title="${esc(LAB.names[t] || t)}">${esc(t)}</span>`;
}
const LAB = { names: {}, teams: {}, Z: null, tab: "tonight", night: null, team: null };
const mmss = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

/* ---------- tabs: interactive, keyboard-friendly, with the stick-and-puck swipe between them ---------- */
const TABS = [["tonight", "Tonight"], ["mine", "My team"], ["team", "Teams"]];
function goTab(tab) {
  if (tab === LAB.tab) return;
  const dir = TABS.findIndex(t => t[0] === tab) < TABS.findIndex(t => t[0] === LAB.tab) ? -1 : 1;
  const update = () => { LAB.tab = tab; draw(); history.replaceState(null, "", "#" + tab); };
  if (!document.startViewTransition || matchMedia("(prefers-reduced-motion: reduce)").matches) return update();
  try { document.startViewTransition({ update, types: dir < 0 ? ["left"] : [] }); } catch { document.startViewTransition(update); }
}
function tabsHTML(cls = "") {
  return `<div class="labtabs ${cls}" role="tablist" aria-label="Sections">${TABS.map(([k, n], i) =>
    `<button type="button" role="tab" data-tab="${k}" aria-selected="${k === LAB.tab}" tabindex="${k === LAB.tab ? 0 : -1}" style="--i:${i}"><span>${n}</span></button>`).join("")}<i class="ind" aria-hidden="true"></i></div>`;
}
document.addEventListener("click", e => {
  const t = e.target.closest && e.target.closest("[data-tab]"); if (t) return goTab(t.dataset.tab);
  const n = e.target.closest && e.target.closest("[data-night]"); if (n) { LAB.night = n.dataset.night; return swapPart(); }
  const tm = e.target.closest && e.target.closest("[data-team]"); if (tm) { LAB.team = tm.dataset.team; if (LAB.tab !== "team") return goTab("team"); return swapPart(); }
});
document.addEventListener("keydown", e => {
  const t = e.target.closest && e.target.closest("[role=tab]"); if (!t || !["ArrowLeft", "ArrowRight"].includes(e.key)) return;
  const i = TABS.findIndex(x => x[0] === t.dataset.tab), j = (i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length;
  goTab(TABS[j][0]); setTimeout(() => { const b = document.querySelector(`[role=tab][data-tab="${TABS[j][0]}"]`); if (b) b.focus(); }, 30);
});
function swapPart() {   // same-tab changes (another night, another team) get the light sheen, not the full swipe
  draw(); const el = document.querySelector(".sweepable"); if (el) sweep(el);
}

/* ---------- view-models ---------- */
function tonightVM() {
  const Z = LAB.Z, k = league().k, f = FORMATS[k], mon = mondayOf(todayISO());
  const days = Array.from({ length: 7 }, (_, i) => addDays(mon, i)), d = LAB.night || todayISO();
  const games = S_GAMES.filter(g => g[0] === d).map(([, a, h]) => ({ a, h }));
  const n = Z.perDay.get(d) || 0;
  return { d, days, n, kind: nightKind(n), games, f, k,
    nights: days.map(x => ({ d: x, n: Z.perDay.get(x) || 0, kind: nightKind(Z.perDay.get(x) || 0) })),
    streamers: n ? nightStreamers(Z, d, k, 6) : [], goalies: n ? nightGoalies(Z, d, k, 4) : [] };
}
function addDropPairs(W, mine, f, k) {
  const ros = p => value(p, f, k, gamesLeft(p)), weekPts = new Map(W.rows.map(r => [r.p.id, r.used * r.v]));
  const adds = bestAdds(LAB.Z, W, mine, f, k).slice(0, 6).map(a => ({ ...a, ros: ros(a.p) }));
  const drops = mine.filter(p => LINEUP[p.id] !== 8).map(p => ({ p, week: weekPts.get(p.id) || 0, ros: ros(p), out: isOut(p) }))
    .sort((a, b) => a.ros - b.ros || a.week - b.week).slice(0, 4);
  const pairs = [];
  adds.forEach(a => drops.forEach(d => {
    const week = a.total - d.week, rest = a.ros - d.ros;
    if (week > 0.3 && rest > -6) pairs.push({ a, d, week, rest, score: week + 0.15 * rest });
  }));
  pairs.sort((x, y) => y.score - x.score);
  const used = new Set(), out = [];
  for (const pr of pairs) { if (used.has(pr.a.p.id) || used.has(pr.d.p.id)) continue; used.add(pr.a.p.id); used.add(pr.d.p.id); out.push(pr); if (out.length === 3) break; }
  return { pairs: out, drops };
}
function mineVM() {
  const mine = myRoster(), k = league().k, f = FORMATS[k], today = todayISO(), mon = mondayOf(today);
  if (!mine.length) return { none: true };
  const W = usableWeek(LAB.Z, mine, today, addDays(mon, 6), slotSet(), f, k), tot = weekTotals(W);
  const empty = W.nights.filter(nt => nt.n).reduce((a, nt) => a + openSkaters(nt.left), 0);
  return { mine, W, tot, empty, fix: lineupFix(LAB.Z, today, mine, f, k), ...addDropPairs(W, mine, f, k), f, k,
    league: LEAGUE ? { name: LEAGUE.name, me: LEAGUE.myName, opp: LEAGUE.oppName, pts: LEAGUE.pts, acq: LEAGUE.acq } : null };
}
function teamVM(t) {
  const T = LAB.teams[t], byId = new Map(everyone().map(p => [p.id, p])), k = league().k, f = FORMATS[k];
  const roster = T.roster.map(([id, n, pos, num]) => ({ id, n, pos, num, p: byId.get(id) }));
  const healthy = roster.filter(r => r.p && !isOut(r.p)), ice = r => r.p.rt || r.p.toi;
  const F = healthy.filter(r => "CLR".includes(r.pos)).sort((a, b) => ice(b) - ice(a));
  const D = healthy.filter(r => r.pos === "D").sort((a, b) => ice(b) - ice(a));
  const G = roster.filter(r => r.pos === "G" && r.p).sort((a, b) => b.p.gs - a.p.gs);
  const lines = [0, 1, 2, 3].map(i => F.slice(i * 3, i * 3 + 3)), pairs = [0, 1, 2].map(i => D.slice(i * 2, i * 2 + 2));
  const extra = F.slice(12).concat(D.slice(6));
  const pp1 = healthy.filter(r => r.pos !== "G").sort((a, b) => b.p.pp - a.p.pp).slice(0, 5);
  const out = roster.filter(r => r.p && isOut(r.p)), noGames = roster.filter(r => !r.p);
  const sys = T.system.map(([id, n, pos, by]) => ({ id, n, pos, age: by ? new Date().getFullYear() - by : null }));
  const st = (r) => ({ v: perGame(r.p, f, k), toi: ice(r), out: isOut(r.p) });
  const games = LAB.Z.byTeam[t].filter(g => g.d >= todayISO()).slice(0, 5);
  return { t, name: LAB.names[t] || t, lines, pairs, G, extra, pp1, out, noGames, sys, st, games, f, k, record: (LAB.stand || {})[t] };
}

/* ---------- shared bits the three directions draw with ---------- */
const pname = r => esc(r.p ? r.p.n : r.n);
const vfmt = x => fmt(x, 2);
function pairWhy(pr) {
  const a = pr.a, d = pr.d;
  return `${esc(a.p.n)} plays ${a.add} of your open nights (${vfmt(a.v)} a game). ${esc(d.p.n)} ${d.out ? `is out (${esc(injNote(d.p) || "not dressing")})` : `projects ${fmt(d.week, 1)} this week`}. Rest of season: ${pr.rest >= 0 ? "+" : ""}${fmt(pr.rest, 1)} value over a replacement player.`;
}

let S_GAMES = [];
async function lab() {
  const [players, S, teams, week, standings] = await Promise.all([load("players"), load("schedule"), load("teams"), load("week").catch(() => ({ names: {} })), load("standings").catch(() => ({ rows: [] }))]);
  DATA = players; S_GAMES = S.games; LAB.Z = seasonIndex(S); LAB.teams = teams.teams; LAB.names = week.names || {};
  LAB.stand = Object.fromEntries((standings.rows || []).map(r => [r.teamAbbrev, `${r.wins}-${r.losses}-${r.otLosses}`]));
  await loadLeague();
  const h = location.hash.slice(1); if (TABS.some(t => t[0] === h)) LAB.tab = h;
  LAB.team = LAB.team || (myRoster()[0] || {}).t || "COL";
  initScoring();
  onLeague(draw);
  draw();
}
function draw() {
  const V = VARIANTS[document.body.dataset.variant];
  document.querySelector("#app").innerHTML = V.shell(LAB.tab === "tonight" ? V.tonight(tonightVM()) : LAB.tab === "mine" ? V.mine(mineVM()) : V.team(teamVM(LAB.team)));
  const sel = document.querySelector("#fmt"); if (sel && !sel.options.length) { initScoring(); }
}
PAGES.lab = lab;

/* =====================================================================================================
   A. BROADCAST: a TV hockey package. Score-bug header, tabs as a scoreboard strip with a sliding puck,
   lower-third rows, the team page as a "starting lineups" graphic.
   ===================================================================================================== */
const VARIANTS = {};
const scoringSelect = `<label class="scoring"><span>Scoring</span><select id="fmt" aria-label="Your league's scoring"></select></label>`;
VARIANTS.a = {
  shell: body => `<header class="bug"><a class="bug-logo" href="index.html"><img src="logo.png" alt="Off-Night Hockey"></a>${tabsHTML("strip")}${scoringSelect}</header><main class="stage">${body}</main>`,
  tonight: vm => `<section class="a-hero sweepable"><div class="a-count"><b class="led">${vm.n}</b><span>${vm.n === 1 ? "game" : "games"}<br>${new Date(vm.d + "T12:00Z").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" })}</span>${vm.kind ? `<em class="k ${vm.kind}">${vm.kind === "light" ? "Light night" : "Packed night"}</em>` : ""}</div>
      <div class="a-ticker">${vm.games.map(g => `<span class="match">${tbadge(g.a)}<i>@</i>${tbadge(g.h)}</span>`).join("") || `<span class="muted">No games</span>`}</div></section>
    <nav class="a-nights">${vm.nights.map(x => `<button type="button" data-night="${x.d}" class="${x.kind}" aria-pressed="${x.d === vm.d}"><span>${dayName(x.d)}</span><b class="led">${x.n}</b></button>`).join("")}</nav>
    <section class="a-lower"><h2>Streamers on this slate</h2>${vm.streamers.map((x, i) => `<div class="lt" style="--d:${i}">${tbadge(x.p.t)}<div class="lt-n"><b>${esc(x.p.n)}</b><span>${POS[x.p.p]} · ${x.p.gp} GP · ${x.p.rgp} in 14 days</span></div>${sparks(x.p, vm.f)}<b class="led">${vfmt(x.v)}</b></div>`).join("") || `<p class="muted">No games on this night.</p>`}
      ${vm.goalies.length ? `<h2>Likely in goal</h2>${vm.goalies.map(x => `<div class="lt">${tbadge(x.p.t)}<div class="lt-n"><b>${esc(x.p.n)}</b><span>${x.call || Math.round(x.share * 100) + "% of starts"}</span></div><b class="led">${vfmt(x.v)}</b></div>`).join("")}` : ""}</section>`,
  mine: vm => vm.none ? `<section class="a-lower"><h2>Connect your team</h2><p>Open <a href="team.html">My team</a> and paste your ESPN league link, then come back.</p></section>` :
    `<section class="a-hero"><div class="a-count"><b class="led">${fmt(vm.tot.u, 0)}</b><span>of ${fmt(vm.tot.g, 0)} games<br>usable this week</span></div>
      ${vm.league ? `<div class="a-score"><span>${esc(vm.league.me)}</span><b class="led">${fmt(vm.league.pts ? vm.league.pts[0] : 0, 1)}</b><i>vs</i><b class="led">${fmt(vm.league.pts ? vm.league.pts[1] : 0, 1)}</b><span>${esc(vm.league.opp)}</span></div>` : ""}</section>
    ${vm.fix ? `<p class="a-alert">${fixText(vm.fix)}</p>` : ""}
    <section class="a-lower"><h2>Add / drop, side by side</h2>${vm.pairs.map((pr, i) => `<article class="a-pair" style="--d:${i}">
        <div class="side add"><em>Add</em>${tbadge(pr.a.p.t)}<b>${esc(pr.a.p.n)}</b>${sparks(pr.a.p, vm.f)}</div>
        <div class="delta"><b class="led">+${fmt(pr.week, 1)}</b><span>this week</span></div>
        <div class="side drop"><em>Drop</em>${tbadge(pr.d.p.t)}<b>${esc(pr.d.p.n)}</b>${badge(pr.d.p)}</div>
        <p class="why-line">${pairWhy(pr)}</p></article>`).join("") || `<p class="muted">No add beats anyone on your roster this week. Hold.</p>`}</section>`,
  team: vm => `<section class="a-teambar">${Object.keys(LAB.teams).sort().map(t => `<button type="button" data-team="${t}" aria-pressed="${t === vm.t}">${tbadge(t, "sm")}</button>`).join("")}</section>
    <section class="a-hero sweepable"><div class="a-count">${tbadge(vm.t, "xl")}<span><b>${esc(vm.name)}</b><br>${vm.record || ""} · next: ${vm.games.slice(0, 3).map(g => (g.home ? "vs " : "@ ") + g.opp).join(", ")}</span></div></section>
    <section class="a-lineup"><h2>Lines by ice time <small>last 14 days; the NHL doesn't publish line combinations</small></h2>
      ${vm.lines.map((ln, i) => `<div class="line"><em>L${i + 1}</em>${ln.map(r => `<div class="card"><b class="led">${r.num ?? ""}</b><span>${pname(r)}</span><small>${POS[r.pos] || r.pos} · ${mmss(vm.st(r).toi)}</small></div>`).join("")}</div>`).join("")}
      ${vm.pairs.map((pr, i) => `<div class="line d"><em>D${i + 1}</em>${pr.map(r => `<div class="card"><b class="led">${r.num ?? ""}</b><span>${pname(r)}</span><small>D · ${mmss(vm.st(r).toi)}</small></div>`).join("")}</div>`).join("")}
      <div class="line g"><em>G</em>${vm.G.map(r => `<div class="card"><b class="led">${r.num ?? ""}</b><span>${pname(r)}</span><small>${r.p.gs} starts</small></div>`).join("")}</div></section>
    <section class="a-lower two"><div><h2>Power play, top unit</h2>${vm.pp1.map(r => `<div class="lt"><div class="lt-n"><b>${pname(r)}</b><span>${mmss(r.p.pp)} PP a game</span></div></div>`).join("")}
      <h2>Out</h2>${vm.out.map(r => `<div class="lt"><div class="lt-n"><b>${pname(r)}</b><span>${esc(injNote(r.p) || "not dressing")}</span></div>${badge(r.p)}</div>`).join("") || `<p class="muted">Nobody.</p>`}</div>
      <div><h2>In the system <small>signed or drafted, not on the NHL roster</small></h2>${vm.sys.map(s => `<div class="lt"><div class="lt-n"><b>${esc(s.n)}</b><span>${POS[s.pos] || s.pos}${s.age ? ` · age ${s.age}` : ""}</span></div></div>`).join("") || `<p class="muted">None listed.</p>`}
      ${vm.noGames.length ? `<h2>On the roster, no games yet</h2>${vm.noGames.map(r => `<div class="lt"><div class="lt-n"><b>${esc(r.n)}</b><span>${POS[r.pos] || r.pos}</span></div></div>`).join("")}` : ""}</div></section>`,
};

/* =====================================================================================================
   B. RINK: the page is a sheet of ice. Tabs are faceoff dots, the team page is a depth chart drawn on a half rink,
   add/drop is a line change from the bench.
   ===================================================================================================== */
VARIANTS.b = {
  shell: body => `<header class="b-top"><a href="index.html"><img src="logo.png" alt="Off-Night Hockey"></a>${scoringSelect}</header>${tabsHTML("dots")}<main class="b-ice">${body}</main>`,
  tonight: vm => `<section class="b-board">${vm.nights.map(x => `<button type="button" data-night="${x.d}" class="${x.kind}" aria-pressed="${x.d === vm.d}"><span>${dayName(x.d)} ${dayDate(x.d)}</span><b class="led">${x.n}</b></button>`).join("")}</section>
    <section class="b-center sweepable"><h1>${vm.d === todayISO() ? "Tonight" : dayName(vm.d)}: ${vm.n} ${vm.n === 1 ? "game" : "games"}</h1>
      <div class="b-faceoffs">${vm.games.map(g => `<div class="fo">${tbadge(g.a, "lg")}<span class="dot"></span>${tbadge(g.h, "lg")}</div>`).join("") || `<p class="muted">No games.</p>`}</div></section>
    <section class="b-cards">${vm.streamers.map(x => `<article class="puck-card">${tbadge(x.p.t)}<b>${esc(x.p.n)}</b><span>${POS[x.p.p]} · ${x.p.gp} GP</span>${sparks(x.p, vm.f)}<b class="led">${vfmt(x.v)}</b></article>`).join("")}</section>`,
  mine: vm => vm.none ? `<section class="b-center"><h1>Connect your team on My team first.</h1></section>` :
    `<section class="b-center"><h1>Line changes worth making</h1><p class="sub">You can use ${fmt(vm.tot.u, 0)} of ${fmt(vm.tot.g, 0)} games this week, with ${vm.empty} empty skater spot-nights.</p>${vm.fix ? `<p class="alert">${fixText(vm.fix)}</p>` : ""}</section>
    <section class="b-changes">${vm.pairs.map(pr => `<article class="change"><div class="bench">${tbadge(pr.d.p.t)}<b>${esc(pr.d.p.n)}</b><span>off</span></div>
        <svg class="arrow" viewBox="0 0 120 30" aria-hidden="true"><path d="M2 15 H110 M98 5 L112 15 L98 25"/></svg>
        <div class="onice">${tbadge(pr.a.p.t)}<b>${esc(pr.a.p.n)}</b><span>on</span></div><b class="led gain">+${fmt(pr.week, 1)}</b><p>${pairWhy(pr)}</p></article>`).join("") || `<p class="muted">No change beats your current roster this week.</p>`}</section>`,
  team: vm => `<section class="b-teams">${Object.keys(LAB.teams).sort().map(t => `<button type="button" data-team="${t}" aria-pressed="${t === vm.t}">${tbadge(t, "sm")}</button>`).join("")}</section>
    <section class="b-rink sweepable"><h1>${tbadge(vm.t, "lg")} ${esc(vm.name)} <small>${vm.record || ""}</small></h1>
      <div class="half"><div class="fwd">${vm.lines.map((ln, i) => `<div class="row"><em>${i + 1}</em>${ln.map(r => `<span class="pl"><b class="led">${r.num ?? ""}</b>${pname(r)}</span>`).join("")}</div>`).join("")}</div>
      <div class="blue"></div><div class="def">${vm.pairs.map((pr, i) => `<div class="row"><em>${i + 1}</em>${pr.map(r => `<span class="pl"><b class="led">${r.num ?? ""}</b>${pname(r)}</span>`).join("")}</div>`).join("")}</div>
      <div class="crease">${vm.G.slice(0, 2).map((r, i) => `<span class="pl ${i ? "backup" : ""}"><b class="led">${r.num ?? ""}</b>${pname(r)}</span>`).join("")}</div></div>
      <p class="note">Lines by ice time over the last 14 days. The NHL doesn't publish line combinations.</p></section>
    <section class="b-cards">${vm.out.map(r => `<article class="puck-card out"><b>${pname(r)}</b>${badge(r.p)}<span>${esc(injNote(r.p) || "not dressing")}</span></article>`).join("")}
      ${vm.sys.map(s => `<article class="puck-card sys"><b>${esc(s.n)}</b><span>In the system · ${POS[s.pos] || s.pos}${s.age ? `, ${s.age}` : ""}</span></article>`).join("")}</section>`,
};

/* =====================================================================================================
   C. ANALYST: built for the GM who wants every number. Left rail, find-anything search, dense ledgers with
   heat cells for the last 5 games, the team page as a depth matrix.
   ===================================================================================================== */
const heat = (p, f) => isG(p) || !p.g5 ? "" : `<span class="heat">${p.g5.slice().reverse().map(g => { const x = gamePts(g, f); return `<i style="--h:${Math.min(1, x / 4)}" title="${fmt(x, 1)}"></i>`; }).join("")}</span>`;
VARIANTS.c = {
  shell: body => `<aside class="rail"><a href="index.html" class="rail-logo"><img src="logo.png" alt="Off-Night Hockey"></a>${tabsHTML("vertical")}
      <label class="find"><span>Find a player or team</span><input id="find" list="find-list" placeholder="Name or team" autocomplete="off"></label><datalist id="find-list">${
      Object.keys(LAB.teams).map(t => `<option value="${t}">`).join("")}</datalist>${scoringSelect}</aside><main class="desk">${body}</main>`,
  tonight: vm => `<section class="c-strip">${vm.nights.map(x => `<button type="button" data-night="${x.d}" class="${x.kind}" aria-pressed="${x.d === vm.d}"><span>${dayName(x.d)}</span><small>${dayDate(x.d)}</small><b class="led">${x.n}</b></button>`).join("")}</section>
    <section class="c-grid sweepable"><div class="c-panel"><h2>Slate <small>${longDate(vm.d)}</small></h2><table class="ledger"><tbody>${vm.games.map(g => `<tr><td>${tbadge(g.a, "sm")}</td><td class="muted">at</td><td>${tbadge(g.h, "sm")}</td><td class="num muted">${LAB.stand[g.a] || ""}</td><td class="num muted">${LAB.stand[g.h] || ""}</td></tr>`).join("")}</tbody></table></div>
      <div class="c-panel wide"><h2>Streamers <small>free in your scoring, ranked</small></h2><table class="ledger"><thead><tr><th>Player</th><th class="num">GP</th><th class="num">14d</th><th>Last 5</th><th class="num">TOI</th><th class="num">PP</th><th class="num">Per game</th></tr></thead><tbody>${
        vm.streamers.map(x => `<tr><td>${tbadge(x.p.t, "sm")} ${esc(x.p.n)} <span class="meta">${POS[x.p.p]}</span></td><td class="num">${x.p.gp}</td><td class="num">${x.p.rgp}</td><td>${heat(x.p, vm.f)}</td><td class="num">${mmss(x.p.rt || x.p.toi)}</td><td class="num">${mmss(x.p.pp)}</td><td class="num led">${vfmt(x.v)}</td></tr>`).join("")}</tbody></table></div></section>`,
  mine: vm => vm.none ? `<section class="c-panel"><h2>No team loaded</h2><p>Connect your ESPN league on My team.</p></section>` :
    `<section class="c-kpis">${[["Usable games", `${fmt(vm.tot.u, 0)} / ${fmt(vm.tot.g, 0)}`], ["Empty spot-nights", vm.empty], ["Matchup now", vm.league && vm.league.pts ? `${fmt(vm.league.pts[0], 1)} to ${fmt(vm.league.pts[1], 1)}` : "-"], ["Adds left", vm.league && vm.league.acq > 0 ? vm.league.acq + " a matchup" : "-"]].map(([k2, v]) => `<div><span>${k2}</span><b class="led">${v}</b></div>`).join("")}</section>
    ${vm.fix ? `<p class="alert">${fixText(vm.fix)}</p>` : ""}
    <section class="c-panel"><h2>Add / drop ledger <small>this week and rest of season, for each move</small></h2><table class="ledger"><thead><tr><th>Add</th><th>Drop</th><th class="num">This week</th><th class="num">Rest of season</th><th>Why</th></tr></thead><tbody>${
      vm.pairs.map(pr => `<tr><td>${tbadge(pr.a.p.t, "sm")} ${esc(pr.a.p.n)} ${heat(pr.a.p, vm.f)}</td><td>${tbadge(pr.d.p.t, "sm")} ${esc(pr.d.p.n)} ${badge(pr.d.p)}</td><td class="num led">+${fmt(pr.week, 1)}</td><td class="num">${pr.rest >= 0 ? "+" : ""}${fmt(pr.rest, 1)}</td><td class="why-cell">${pairWhy(pr)}</td></tr>`).join("") || `<tr><td colspan="5" class="muted">No move beats your roster this week.</td></tr>`}</tbody></table>
      <h2>Drop candidates <small>lowest rest-of-season value on your roster</small></h2><table class="ledger"><tbody>${vm.drops.map(d => `<tr><td>${tbadge(d.p.t, "sm")} ${esc(d.p.n)} ${badge(d.p)}</td><td class="num">${fmt(d.week, 1)} this week</td><td class="num">${fmt(d.ros, 1)} value left</td><td>${heat(d.p, vm.f)}</td></tr>`).join("")}</tbody></table></section>`,
  team: vm => `<section class="c-panel sweepable"><h2>${tbadge(vm.t)} ${esc(vm.name)} <small>${vm.record || ""} · depth by ice time, last 14 days</small></h2>
      <table class="ledger"><thead><tr><th>Unit</th><th>Player</th><th class="num">#</th><th class="num">TOI</th><th class="num">PP</th><th>Last 5</th><th class="num">Per game</th></tr></thead><tbody>${
        vm.lines.flatMap((ln, i) => ln.map((r, j) => `<tr class="${j === 0 ? "grp" : ""}"><td class="muted">${j === 0 ? "Line " + (i + 1) : ""}</td><td>${pname(r)} <span class="meta">${POS[r.pos] || r.pos}</span></td><td class="num">${r.num ?? ""}</td><td class="num">${mmss(vm.st(r).toi)}</td><td class="num">${mmss(r.p.pp)}</td><td>${heat(r.p, vm.f)}</td><td class="num led">${vfmt(vm.st(r).v)}</td></tr>`)).join("")}${
        vm.pairs.flatMap((pr, i) => pr.map((r, j) => `<tr class="${j === 0 ? "grp" : ""}"><td class="muted">${j === 0 ? "Pair " + (i + 1) : ""}</td><td>${pname(r)} <span class="meta">D</span></td><td class="num">${r.num ?? ""}</td><td class="num">${mmss(vm.st(r).toi)}</td><td class="num">${mmss(r.p.pp)}</td><td>${heat(r.p, vm.f)}</td><td class="num led">${vfmt(vm.st(r).v)}</td></tr>`)).join("")}${
        vm.G.map((r, i) => `<tr class="${i === 0 ? "grp" : ""}"><td class="muted">${i === 0 ? "Goalies" : ""}</td><td>${pname(r)}</td><td class="num">${r.num ?? ""}</td><td class="num" colspan="2">${r.p.gs} starts</td><td></td><td class="num led">${vfmt(vm.st(r).v)}</td></tr>`).join("")}</tbody></table></section>
    <section class="c-grid"><div class="c-panel"><h2>Out</h2><table class="ledger"><tbody>${vm.out.map(r => `<tr><td>${pname(r)}</td><td>${badge(r.p)}</td><td class="muted">${esc(injNote(r.p) || "")}</td></tr>`).join("") || `<tr><td class="muted">Nobody.</td></tr>`}</tbody></table></div>
      <div class="c-panel"><h2>In the system <small>signed or drafted, not on the NHL roster</small></h2><table class="ledger"><tbody>${vm.sys.map(s => `<tr><td>${esc(s.n)}</td><td class="muted">${POS[s.pos] || s.pos}</td><td class="num muted">${s.age ? "age " + s.age : ""}</td></tr>`).join("") || `<tr><td class="muted">None listed.</td></tr>`}</tbody></table></div></section>`,
};
document.addEventListener("change", e => { if (e.target.id === "find") { const v = e.target.value.trim().toUpperCase(); if (LAB.teams[v]) { LAB.team = v; goTab("team"); } } });
