// Tidal dashboard: polls /api/state, renders the page the URL hash names. No framework, no build.
// Every value that came from the ledger goes through esc() — token names and theses are written by
// strangers and by a model.

const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const MINUS = "−";
const fin = (v) => typeof v === "number" && Number.isFinite(v);
const usd = (v, d = 2) => (fin(v) ? (v < 0 ? MINUS : "") + "$" + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }) : "—");
const susd = (v) => (fin(v) ? (v < 0 ? MINUS : "+") + "$" + Math.abs(v).toFixed(2) : "—");
const pct = (v, d = 1) => (fin(v) ? (v < 0 ? MINUS : "+") + (Math.abs(v) >= 1000 ? Math.round(Math.abs(v)).toLocaleString("en-US") : Math.abs(v).toFixed(d)) + "%" : "—");
const num = (v) => (v >= 1e6 ? (v / 1e6).toFixed(1) + "M" : v >= 1e3 ? (v / 1e3).toFixed(1) + "k" : String(Math.round(v)));
const k$ = (v) => (fin(v) ? "$" + num(v) : "—");
const kn = (v) => (fin(v) ? num(v) : "—");
const px = (v) => (fin(v) ? (v >= 1 ? v.toFixed(4) : Number(v.toPrecision(3)).toString()) : "—");
const rate = (v) => (fin(v) ? (v * 100).toFixed(1) + "%" : "—");
const hms = (t) => new Date(t).toLocaleTimeString("en-GB", { hour12: false });
const hm = (t) => hms(t).slice(0, 5);
const dayLabel = (t) => new Date(t).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }).replace(",", "");
const mins = (m) => (m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`);
const ini = (s) => esc(String(s ?? "?").slice(0, 2).toUpperCase());
const sign = (v) => (fin(v) && v < 0 ? "neg" : "pos");
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

const SVG = (d, cls = "ic") => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
const I = {
  logo: `<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" style="fill:none;stroke:#A891FF;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round"><path d="M3 14c2.2 0 2.8-4 5-4s2.8 4 5 4 2.8-4 5-4 2.4 2.4 3 4"/></svg>`,
  stop: `<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" style="fill:currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`,
  play: `<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" style="fill:currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>`,
  clock: SVG("M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z M12 8v4l3 2"),
  wallet: SVG("M4 7h14v12H4z M4 7l11-3v3 M14 13h4"),
  target: SVG("M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"),
  bars: SVG("M6 18v-7 M12 18V6 M18 18v-4"),
  case: SVG("M4 8h16v11H4z M9 8V5h6v3 M4 13h16"),
  pulse: SVG("M3 12h4l3-7 4 14 3-7h4"),
  swap: SVG("M7 4v16 M4 7l3-3 3 3 M17 20V4 M14 17l3 3 3-3"),
  eye: SVG("M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"),
  chat: SVG("M5 5h14v10H10l-5 4z"),
  trading: SVG("M4 18l5-6 4 3 7-8 M15 7h5v5"), // the header's Trading icon
  flask: SVG("M9 3h6 M10 3v6.5L5.2 17.6A2 2 0 0 0 7 20.5h10a2 2 0 0 0 1.8-2.9L14 9.5V3 M7.5 14h9"), // the header's Research icon
  filter: SVG("M4 5h16l-6 7v6l-4 2v-8z"),
  x: `<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" style="fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round"><path d="M4 4l8 8M12 4l-8 8"/></svg>`,
  help: `<svg width="10" height="10" viewBox="0 0 24 24" aria-hidden="true" style="fill:none;stroke:currentColor;stroke-width:2.6;stroke-linecap:round;stroke-linejoin:round"><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.5-3 4.5"/><path d="M12 18h.01"/></svg>`,
  check: `<svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true" style="fill:none;stroke:currentColor;stroke-width:3;stroke-linecap:round;stroke-linejoin:round"><path d="M5 12l4 4 10-10"/></svg>`,
  arrow: `<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" style="fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round"><path d="M5 12h14 M13 6l6 6-6 6"/></svg>`,
  mode: SVG("M7 7h10a5 5 0 0 1 0 10H7A5 5 0 0 1 7 7z M8 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z"),
  cycle: SVG("M20 12a8 8 0 1 1-2.3-5.7 M20 4v4h-4"),
  shield: SVG("M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z"),
  exit: SVG("M14 4h6v6 M20 4l-9 9 M10 6H5v13h13v-5"),
  pause: SVG("M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M10 9v6 M14 9v6"),
  square: SVG("M5 5h14v14H5z"),
};

const S = {
  data: null,
  error: "",
  range: "7d",
  view: "pnl",
  sel: null,
  token: null,
  tab: "activity",
  runFilter: "all",
  dock: "positions",
  run: null,
  runPicked: false,
  filtersOpen: false,
  list: "trending", // the token list's open tab; its Filters edit that list's set
  confirmStop: false,
  draft: null,
  rmodel: null, // the research agent's model as typed on Settings, saved apart from the config; null = as saved
  section: "mode",
  msg: null,
  help: null, // id of the help tip opened by a tap or click; hover and focus open it without this
  older: new Map(), // runId → its activity events, for today's runs paged in past the ten /api/state carries
  olderMore: null, // whether older runs of today remain; null until the first page comes back
  loadingOlder: false,
  runPages: { all: new Map(), failed: new Map() }, // runId → row, for today's runs paged in past the state's page
  runsMore: { all: null, failed: null },
  research: null, // /api/research, read every RESEARCH_MS while the Research page is open
  researchAt: 0,
  researchError: "",
  idea: null, // id of the hypothesis whose detail is open
  reportOpen: false, // the research agent's last report, shown or folded
  hypFilter: "all", // the hypotheses list's status filter
  verOpen: false, // Settings versions, folded as the canvas draws them
  copied: null, // id of the idea whose prompt was just copied
};
const PAGES = ["overview", "trading", "research", "settings"];
const page = () => (PAGES.includes(location.hash.slice(1)) ? location.hash.slice(1) : "overview");
const RESEARCH_MS = 15_000;

// ── network ───────────────────────────────────────────────────────────

async function call(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (res.status === 401) location.reload(); // signed out: the server answers the page with the sign-in
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

// "Today" and the chart's days are this browser's; the daily loss limit runs on 00:00 UTC.
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

async function poll() {
  try {
    const next = await call(`/api/state?range=${S.range}&tz=${encodeURIComponent(TZ)}`);
    // Once older runs are paged in, a run that rolls out of the state's ten stays in the list.
    if (S.older.size && S.data && S.data.trading.runsSince === next.trading.runsSince) {
      const live = new Set(next.trading.activity.map((e) => e.runId));
      for (const e of S.data.trading.activity)
        if (!live.has(e.runId)) S.older.has(e.runId) ? S.older.get(e.runId).push(e) : S.older.set(e.runId, [e]);
    }
    const prev = S.data?.trading;
    if (prev && prev.runsSince !== next.trading.runsSince) { // a new day: today's lists start over
      S.runPages = { all: new Map(), failed: new Map() };
      S.runsMore = { all: null, failed: null };
      S.older = new Map();
      S.olderMore = null;
    } else if (prev)
      for (const k of ["all", "failed"]) { // as with activity, a run that rolls out of the state's page stays listed
        if (!S.runPages[k].size) continue;
        const live = new Set(next.trading.runs[k].runs.map((r) => r.id));
        for (const r of prev.runs[k].runs) if (!live.has(r.id)) S.runPages[k].set(r.id, r);
      }
    S.data = next;
    S.skew = next.now - Date.now();
    S.seenAt = Date.now();
    S.error = "";
    if (!S.draft) S.draft = structuredClone(S.data.config);
    followLatestRun();
  } catch (e) {
    S.error = e.message;
  }
  render();
  if (page() === "research" && Date.now() - S.researchAt >= RESEARCH_MS) (await loadResearch(), render());
}

/** The research scorecard: heavier than the state, so read only on its page and every RESEARCH_MS. */
async function loadResearch() {
  S.researchAt = Date.now();
  try {
    S.research = await call(`/api/research?tz=${encodeURIComponent(TZ)}`);
    S.researchError = "";
  } catch (e) {
    S.researchError = e.message;
  }
}

async function act(path, body, okMsg) {
  try {
    const r = await call(path, body ?? {});
    if (okMsg) S.msg = { ok: true, text: okMsg };
    await poll();
    return r;
  } catch (e) {
    S.msg = { ok: false, text: e.message };
    render(true);
    return null;
  }
}

// ── painting ──────────────────────────────────────────────────────────

const painted = new Map();
// A repaint between a press and its release would swallow the click: paints wait for the release.
let pressed = false;
const held = new Map();
document.addEventListener("pointerdown", () => (pressed = true), true);
const release = () => {
  pressed = false;
  setTimeout(() => { // after the click this release belongs to has been dispatched
    for (const [el, html] of held) paint(el, html);
    held.clear();
  });
};
document.addEventListener("pointerup", release, true);
document.addEventListener("pointercancel", release, true);

/** Sets innerHTML only when it changed, keeping scroll (both axes) of [data-scroll] boxes and keyboard focus. */
function paint(el, html) {
  if (!el || painted.get(el) === html) return;
  if (pressed) return void held.set(el, html);
  const kept = [...el.querySelectorAll("[data-scroll]")].map((n) => [n.dataset.scroll, n.scrollTop, n.scrollLeft]);
  const f = document.activeElement;
  const focus = f && el.contains(f) && f.dataset.a ? `[data-a="${f.dataset.a}"]${f.dataset.v ? `[data-v="${CSS.escape(f.dataset.v)}"]` : ""}` : null;
  el.innerHTML = html;
  painted.set(el, html);
  for (const [k, top, left] of kept) {
    const n = el.querySelector(`[data-scroll="${k}"]`);
    if (n) (n.scrollTop = top), (n.scrollLeft = left);
  }
  if (focus) el.querySelector(focus)?.focus({ preventScroll: true }); // a repaint must never move the page
}

/** Ticks on the server's clock, but freezes once polls stop landing, so a stuck clock still means a dead feed. */
function tickClock() {
  const d = S.data;
  const now = !d ? Date.now() : Date.now() - S.seenAt < 10_000 ? Date.now() + S.skew : d.now;
  const clock = $("#clock");
  if (clock) clock.textContent = `${dayLabel(now)} · ${hms(now)}`;
}

/** `force` repaints the settings form, which polls otherwise leave alone so typing is never lost. */
function render(force = false) {
  const d = S.data;
  paint($("#hdr"), header(d));
  tickClock();
  if (!d) return paint($("#main"), `<p class="${S.error ? "neg" : "muted"}">${esc(S.error || "Loading…")}</p>`);
  paint($("#banner"), banners(d));
  const p = page();
  if (p !== "settings" || force || !painted.has($("#main")) || $("#main").dataset.page !== "settings") {
    $("#main").dataset.page = p;
    paint($("#main"), p === "overview" ? overview(d) : p === "trading" ? trading(d) : p === "research" ? research() : settings(d));
  }
  paint($("#modal"), S.confirmStop ? stopDialog(d) : S.filtersOpen ? filtersDialog(d) : "");
  nearEnd($('[data-scroll="agent"]')); // a list too short to scroll still pages in until it fills the box
}

// ── header, banners, stop dialog ──────────────────────────────────────

const RUN = {
  running: { label: "Running", dot: "var(--lime)", btn: `<button class="btn stop" data-a="runBtn">${I.stop}Stop</button>` },
  paused: { label: "Paused · daily loss", dot: "var(--amber)", btn: `<button class="btn lime" data-a="resume">${I.play}Resume</button>` },
  stopped: { label: "Stopped", dot: "var(--dim)", btn: `<button class="btn lime" data-a="start">${I.play}Start</button>` },
};

// The current page's tab carries its icon; the others are text only, as designed.
const NAV_ICON = {
  overview: `<path d="M4 5h16v10H4z M12 15v4 M8 19h8 M8 11l3-3 2 2 3-3"/>`,
  trading: `<path d="M4 18l5-6 4 3 7-8 M15 7h5v5"/>`,
  settings: `<path d="M4 7h10 M18 7h2 M4 17h2 M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>`,
  research: `<path d="M9 3h6 M10 3v6.5L5.2 17.6A2 2 0 0 0 7 20.5h10a2 2 0 0 0 1.8-2.9L14 9.5V3 M7.5 14h9"/>`,
};

function header(d) {
  const p = page();
  const nav = [["overview", "Overview"], ["trading", "Trading"], ["research", "Research"], ["settings", "Settings"]]
    .map(([k, l]) =>
      p === k
        ? `<a href="#${k}" aria-current="page"><svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" style="fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round">${NAV_ICON[k]}</svg>${l}</a>`
        : `<a href="#${k}">${l}</a>`,
    )
    .join("");
  const run = RUN[d?.health.run ?? "running"];
  return `<span class="logo" aria-hidden="true">${I.logo}</span><nav class="nav" aria-label="Main">${nav}</nav>
    <span class="clock" id="clock"></span>
    ${d ? `<span class="runpill"><span class="dot" style="background:${run.dot}"></span>${run.label}</span>${run.btn}` : ""}`;
}

function banners(d) {
  const h = d.health;
  const names = d.overview.positions.map((p) => esc(p.symbol)).join(" and ");
  const msg = S.msg ? `<div class="banner ${S.msg.ok ? "grey" : "red"}" role="status"><div class="stack"><span class="b">${esc(S.msg.text)}</span></div><button class="btn sm ghost" data-a="dismiss">Dismiss</button></div>` : "";
  if (h.run === "paused")
    return msg + `<div class="banner amber" role="status">${I.pause}<div class="stack"><span class="b">Buying paused: max daily loss reached</span>
      <span class="s13">The loss since 00:00 UTC passed ${esc(d.config.maxDailyLossPct)}% of that day's starting equity. Exits keep running. ${
        h.lossResume === "auto" ? "Buying resumes automatically at the next day start (00:00 UTC), or press Resume." : "Buying stays paused until you press Resume."
      }</span></div></div>`;
  // The header already says Stopped; the banner only earns its place when positions sit unwatched.
  if (h.run === "stopped" && names)
    return msg + `<div class="banner grey" role="status">${I.square}<div class="stack"><span class="b">Everything is stopped</span>
      <span class="s13">No buys and no exits: stop loss, take profit and time stop are not watching ${names} until you press Start.</span></div></div>`;
  return msg;
}

function stopDialog(d) {
  const pos = d.overview.positions;
  return `<div class="overlay"><div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="stop-title" aria-describedby="stop-desc">
    <div class="head"><span class="ico" style="background:rgba(255,129,112,.15);color:var(--red);border:0">${I.stop}</span><h2 id="stop-title">Stop everything?</h2></div>
    <p id="stop-desc">${plural(pos.length, "position")} ${pos.length === 1 ? "is" : "are"} still open: ${pos.map((p) => esc(p.symbol)).join(" and ")}. Stopping also halts the exit loop, so stop loss, take profit, time stop and health checks will not run until you start again.</p>
    <div class="actions"><button class="btn ghost" data-a="cancelStop">Cancel</button><button class="btn inner" data-a="closeAllStop">Close all &amp; stop</button><button class="btn danger" data-a="stopAnyway">Stop anyway</button></div>
  </div></div>`;
}

// ── overview ──────────────────────────────────────────────────────────

function overview(d) {
  const o = d.overview;
  const t = o.today;
  const used = t.limitUsd > 0 ? Math.min(100, (t.usedUsd / t.limitUsd) * 100) : 0;
  const slots = Array.from({ length: o.slots.max }, (_, i) => `<i class="${i < o.slots.used ? "on" : ""}"></i>`).join("");
  const won = o.winRate.closed ? Math.round((o.winRate.won / o.winRate.closed) * 100) + "%" : "—";
  return `<div class="kpis">
    <div class="equity"><span class="muted" style="font-size:15px">Equity, ${esc(o.mode)} mode</span>
      <div class="inline" style="flex-wrap:wrap;gap:8px 20px"><span class="big">${usd(o.equity)}</span><span class="badge ${o.mode === "live" ? "live" : ""}">${o.mode === "live" ? "Live" : "Paper"}</span></div>
      <span style="font-size:15px"><span class="${sign(o.sinceStart.usd)} b">${susd(o.sinceStart.usd)} (${pct(o.sinceStart.pct, 2)})</span> <span class="muted">since start, ${esc(dayLabel(o.sinceStart.at))}</span></span></div>
    <div class="tiles">
      <div class="tile"><div class="inline"><span class="ico">${I.clock}</span><span style="font-size:15px;font-weight:500">Today</span></div>
        <div class="in"><span class="inline" style="align-items:baseline"><span class="num">${susd(t.usd)}</span><span class="s13 muted">${pct(t.pct, 2)}</span></span>
        <span class="s13 muted"><span class="${sign(t.realised)} b">${susd(t.realised)}</span> realised, ${plural(t.sells, "sell")} · <span class="${sign(t.open)} b">${susd(t.open)}</span> open</span></div>
        <div class="in" style="gap:8px"><div class="inline small muted" style="justify-content:space-between"><span>Daily loss limit</span><span><span class="b" style="color:var(--ink)">${usd(t.usedUsd)}</span> of ${usd(t.limitUsd)}</span></div>
          <div class="meter" role="meter" aria-label="Daily loss used" aria-valuemin="0" aria-valuemax="${t.limitUsd.toFixed(2)}" aria-valuenow="${t.usedUsd.toFixed(2)}"><i style="width:${used.toFixed(1)}%"></i></div>
          <span class="small muted">Buying pauses at ${MINUS}${esc(d.config.maxDailyLossPct)}% of the ${usd(t.dayStart)} day start, 00:00 UTC</span></div></div>
      <div class="tile lime"><div class="inline"><span class="ico">${I.wallet}</span><span style="font-size:15px;font-weight:600">Cash &amp; slots</span></div>
        <div class="in"><span class="num">${usd(o.cash)}</span><span class="s13 muted">cash on hand · <b style="color:#161618">${usd(o.held)}</b> held in positions</span></div>
        <div class="in" style="gap:8px"><div class="slots" aria-hidden="true">${slots}</div>
          <span class="small muted"><b style="color:#161618">${o.slots.used} of ${o.slots.max} slots</b> used${o.slots.used >= o.slots.max ? " · the next buy waits for a close" : ""}</span></div></div>
      <div class="tile"><div class="inline"><span class="ico">${I.target}</span><span style="font-size:15px;font-weight:500">Since start</span></div>
        <div class="split"><div class="stack" style="gap:4px"><span class="s13 muted">Win rate</span><span class="num2">${won}</span><span class="small muted"><b style="color:var(--ink)">${o.winRate.won} of ${o.winRate.closed}</b> closed in profit</span></div>
        <div class="stack" style="gap:4px"><span class="s13 muted">Max drawdown</span><span class="num2">${o.drawdown.pct < 0 ? pct(o.drawdown.pct, 2) : "0.00%"}</span><span class="small muted">${o.drawdown.at ? `<b style="color:var(--ink)">${susd(o.drawdown.usd)}</b> on ${esc(dayLabel(o.drawdown.at))}` : "no drawdown yet"}</span></div></div></div>
    </div></div>
  <div class="row">
    <section class="card" style="flex:3 1 560px;gap:8px" aria-labelledby="chart-title">
      <div class="head"><span class="ico">${I.bars}</span><h2 id="chart-title">${S.view === "pnl" ? "Realised PnL" : "Equity"}</h2>
        <div class="tail"><div class="seg" role="group" aria-label="Chart view">${[["pnl", "Daily PnL"], ["eq", "Equity"]].map(([k, l]) => `<button data-a="view" data-v="${k}" aria-pressed="${S.view === k}">${l}</button>`).join("")}</div>
        <div class="seg light" role="group" aria-label="Time range">${[["7d", "7 days"], ["30d", "30 days"], ["all", "All time"]].map(([k, l]) => `<button data-a="range" data-v="${k}" aria-pressed="${S.range === k}">${l}</button>`).join("")}</div></div></div>
      ${S.view === "pnl" ? pnlChart(o.chart, d.now) : equityChart(o.chart, o.equity, d.now)}
    </section>
    <section class="card" style="flex:2 1 380px;padding-bottom:0" aria-labelledby="pos-title">
      <div class="head"><span class="ico">${I.case}</span><div class="stack"><h2 id="pos-title">Open positions</h2><span class="sub">exits run by code on every price poll</span></div>
        <a class="btn sm line" href="#trading" style="margin-left:auto">Manage in Trading${I.arrow}</a></div>
      ${o.positions.length ? `<div class="fill fade" data-scroll="pos" tabindex="0" role="region" aria-label="Open positions list" style="max-height:384px;display:flex;flex-direction:column;gap:12px">${o.positions.map(posCard).join("")}</div>` : `<p class="empty">No open positions.</p>`}
    </section>
  </div>
  <div class="row">
    <section class="card flush" style="flex:2 1 340px;padding-bottom:0" aria-labelledby="health-title">
      <div class="head"><span class="ico">${I.pulse}</span><h2 id="health-title">System health</h2><span class="s13 muted">loops and services</span></div>
      <div class="hbody fade" data-scroll="health" tabindex="0" role="region" aria-label="System health and alerts"><ul class="health">${healthRows(d).map((h) => `<li><span class="dot" style="background:${h.dot}"></span><div class="stack" style="flex:1 1 auto"><div class="inline" style="flex-wrap:wrap;align-items:baseline;gap:4px 10px"><span class="b">${h.name}</span><span class="s13 b" style="margin-left:auto;color:${h.ink ?? h.dot}">${esc(h.status)}</span></div><span class="s13 muted">${esc(h.detail)}</span></div></li>`).join("")}</ul>
      <h3>Alerts today</h3>
      <ol class="alerts">${d.health.alerts.length ? d.health.alerts.map((a) => `<li><span class="mono small muted">${hms(a.at)}</span><span class="tag ${esc(a.level)}">${esc(a.level)}</span><span>${esc(a.msg)}</span></li>`).join("") : `<li class="muted">None.</li>`}</ol></div>
    </section>
    <section class="card flush" style="flex:3 1 560px;padding-bottom:0" aria-labelledby="fills-title">
      <div class="head"><span class="ico">${I.swap}</span><h2 id="fills-title">Fills</h2><span class="s13 muted">every swap today, newest first</span></div>
      ${o.fills.length ? `<div class="vscroll fade" data-scroll="fills" tabindex="0" role="region" aria-label="Fills list"><table style="min-width:620px"><thead><tr><th>Time</th><th>Side</th><th>Token</th><th class="r">Sold</th><th class="r">USD</th><th class="r">PnL</th><th>Reason</th></tr></thead><tbody>${o.fills.map(fillRow).join("")}</tbody></table></div>` : `<p class="empty">No fills today.</p>`}
    </section>
  </div>`;
}

const reasonText = (f) => (f.reason === "tp" || f.reason === "sl") && fin(f.ruleAt) ? `${f.reason} ${pct(f.ruleAt, 0)}` : f.reason;

function fillRow(f) {
  return `<tr><td class="mono small muted">${hms(f.at)}</td><td><span class="side ${esc(f.side)}">${esc(f.side)}</span></td><td class="b">${esc(f.symbol)}</td>
    <td class="r ${f.soldPct === null ? "dim" : ""}">${f.soldPct === null ? "—" : Math.round(f.soldPct) + "%"}</td><td class="r">${usd(f.usd)}</td>
    <td class="r ${f.pnl === null ? "dim" : sign(f.pnl) + " b"}">${f.pnl === null ? "—" : susd(f.pnl)}</td><td class="soft">${esc(reasonText(f))}</td></tr>`;
}

function ruleChips(p, compact) {
  const rules = p.rules;
  const nextTp = rules.find((r) => r.kind === "tp" && !r.filled);
  const chips = [];
  for (const r of rules) {
    if (r.kind === "sl") chips.push(`<span class="chip">SL ${pct(r.at, 0)}</span>`);
    else if (r.filled) chips.push(`<span class="chip done">${I.check}TP ${pct(r.at, 0)} · ${Math.round(r.sell)}% sold</span>`);
    else if (!compact) chips.push(`<span class="chip">TP ${pct(r.at, 0)} · ${Math.round(r.sell)}%</span>`);
  }
  if (compact && nextTp) chips.splice(rules.filter((r) => r.filled).length, 0, `<span class="chip">next TP ${pct(nextTp.at, 0)}</span>`);
  return chips.join("");
}

function posCard(p, i) {
  return `<article class="poscard" aria-label="${esc(p.symbol)}"><div class="top2"><span class="av ${i % 2 ? "alt" : ""}" aria-hidden="true">${ini(p.symbol)}</span>
    <div class="stack" style="flex:1 1 auto"><span class="b">${esc(p.symbol)}</span><span class="mono small muted">${esc(p.mint)} · held ${mins(p.heldMin)}</span></div>
    <div class="stack" style="align-items:flex-end"><span class="${sign(p.pnlPct)}" style="font-size:18px;line-height:24px;font-weight:600">${pct(p.pnlPct)}</span><span class="small muted">${susd(p.pnlUsd)} · peak ${pct(p.peakPct)}</span></div></div>
    <div class="chips">${ruleChips(p, true)}<span class="chip">time stop in ${mins(p.timeLeftMin)}</span></div></article>`;
}

function healthRows(d) {
  const h = d.health;
  const OK = "var(--lime)", WARN = "var(--amber)", OFF = "var(--dim)", BAD = "var(--red)";
  const stopped = h.run === "stopped";
  const a = h.agent;
  const today = a ? `${plural(a.today.n, "run")} today, ${a.today.failed} failed · ${kn(a.today.tin)} / ${kn(a.today.tout)} tokens` : "no runs yet";
  const rows = [];
  if (stopped) rows.push({ name: "Entry loop", status: "Stopped", detail: "no fetches, no buys", dot: OFF, ink: "var(--muted)" });
  else if (h.run === "paused") rows.push({ name: "Entry loop", status: "Paused", detail: `max daily loss hit · resumes ${h.lossResume === "auto" ? "at 00:00 UTC or " : ""}on Resume`, dot: WARN });
  else
    rows.push({
      name: "Entry loop",
      status: "Running",
      detail: `cycle after cycle${h.entry.lastAt ? ` · last ${hms(h.entry.lastAt)}` : ""}${h.entry.note ? ` · ${h.entry.note}` : ""}`,
      dot: OK,
    });
  if (!a) rows.push({ name: "Agent", status: "Idle", detail: today, dot: OFF, ink: "var(--muted)" });
  else
    rows.push({
      name: "Agent",
      status: a.status === "running" ? `Run #${a.id} running` : `Run #${a.id} ${a.status === "ok" ? "ok" : "failed"}`,
      detail: `${a.secs !== null ? a.secs.toFixed(1) + "s · " : ""}${today}`,
      dot: a.status === "error" ? BAD : stopped ? OFF : OK,
    });
  if (stopped) rows.push({ name: "Exit loop", status: "Stopped", detail: h.openPositions ? `${plural(h.openPositions, "position")} unwatched` : "nothing open", dot: h.openPositions ? BAD : OFF });
  else
    rows.push({
      name: "Exit loop",
      status: h.exit.priceError ? "Prices down" : "Watching",
      detail: `${h.exit.priceError ? `${h.exit.priceError}, only time stops run for it · ` : ""}${h.exit.onChain} on-chain${h.exit.onJupiter ? ` · ${h.exit.onJupiter} on Jupiter` : ""}${h.exit.onChain ? ` · socket ${h.exit.socket ? "up" : "down, pools read every 1s"}` : ""}${h.exit.lastAt && d.now - h.exit.lastAt > 15_000 ? ` · last tick ${hms(h.exit.lastAt)}, stale` : ""}`,
      dot: h.exit.priceError || (h.exit.onChain && !h.exit.socket) ? WARN : OK,
    });
  rows.push(h.gmgn ? { name: "GMGN", status: "Errors", detail: `last ${hms(h.gmgn.errorAt)} · ${h.gmgn.error}`, dot: WARN } : { name: "GMGN", status: "OK", detail: "free plan · no errors today", dot: OK });
  rows.push(
    h.swaps.mode === "paper"
      ? { name: "Swaps", status: "Paper", detail: `simulated fills on live Jupiter quotes${d.liveAvailable ? "" : " · live needs SOLANA_PRIVATE_KEY"}`, dot: "var(--violet)" }
      : { name: "Swaps", status: "Live", detail: `Jupiter · wallet ${h.swaps.wallet ?? "missing"}`, dot: h.swaps.wallet ? OK : BAD },
  );
  return rows;
}

/** Round steps for an axis: 1, 2 or 5 times a power of ten. */
function niceStep(span, parts = 4) {
  const raw = span / parts || 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw);
}

function xLabels(points, now, at) {
  const n = points.length;
  const every = n <= 10 ? 1 : Math.ceil(n / 7);
  const today = new Date(now).toDateString();
  return points
    .map((p, i) => {
      const show = i % every === 0 || i === n - 1;
      const d = new Date(at(p));
      const txt = n <= 7 ? d.toLocaleDateString("en-GB", { weekday: "short" }) : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
      return `<span class="${d.toDateString() === today ? "today" : ""}">${show ? esc(txt) : ""}</span>`;
    })
    .join("");
}

function pnlChart(c, now) {
  const vals = c.pnl.map((p) => p.pnl);
  const step = niceStep(Math.max(1, Math.max(0, ...vals) - Math.min(0, ...vals)));
  const hi = Math.max(step, Math.ceil(Math.max(0, ...vals) / step) * step);
  const lo = Math.min(0, Math.floor(Math.min(0, ...vals) / step) * step);
  const span = hi - lo;
  const y = (v) => ((hi - v) / span) * 100;
  const ticks = [];
  for (let v = hi; v >= lo - 1e-9; v -= step) ticks.push(v);
  // Each bar carries its own tooltip and CSS :hover shows it and turns the bar solid (app.css .bars):
  // no state, no repaint, so a fast mouse can never leave one behind. Unhovered bars stay hatched.
  const today = new Date(now).toDateString();
  const last = c.pnl.length - 1;
  const bars = c.pnl
    .map((p, i) => {
      const top = y(Math.max(0, p.pnl)), h = Math.abs(y(0) - y(p.pnl));
      const r = p.pnl >= 0 ? "15px 15px 4px 4px" : "4px 4px 15px 15px";
      const tipTop = Math.min(70, Math.max(18, (y(Math.max(0, p.pnl)) + y(Math.min(0, p.pnl))) / 2));
      const edge = i === 0 && c.pnl.length > 2 ? "left:0;transform:translate(0,-50%)" : i === last && c.pnl.length > 2 ? "left:100%;transform:translate(-100%,-50%)" : "left:50%";
      return `<div><i style="top:${top.toFixed(2)}%;height:${Math.max(h, p.pnl ? 0.8 : 0).toFixed(2)}%;border-radius:${r}"></i>
        <div class="tip" style="top:${tipTop.toFixed(2)}%;${edge}"><span class="small soft">${esc(dayLabel(p.at))}${new Date(p.at).toDateString() === today ? " · today" : ""}</span><span class="v">${susd(p.pnl)}</span><span class="small soft">${plural(p.sells, "sell")}</span></div></div>`;
    })
    .join("");
  const label = c.pnl.map((p) => `${dayLabel(p.at)} ${susd(p.pnl)}`).join(", ");
  return `<figure aria-label="Realised PnL per day: ${esc(label)}" style="margin:0">
    <div class="plot">${ticks.map((v) => `<span class="yl" style="top:${y(v).toFixed(2)}%">${v === 0 ? "$0" : susd(v).replace(".00", "")}</span><div class="gl ${v === 0 ? "zero" : ""}" style="top:${y(v).toFixed(2)}%"></div>`).join("")}
      <div class="bars">${bars}</div>
    </div><div class="xl" aria-hidden="true">${xLabels(c.pnl, now, (p) => p.at)}</div></figure>`;
}

function equityChart(c, equityNow, now) {
  const pts = [...c.equity, { at: now, e: equityNow }]; // ends on the headline, not the last minute sample
  const vals = pts.map((p) => p.e);
  const step = niceStep(Math.max(1, Math.max(...vals) - Math.min(...vals)));
  const hi = Math.ceil(Math.max(...vals) / step) * step + (Math.max(...vals) === Math.min(...vals) ? step : 0);
  const lo = Math.floor(Math.min(...vals) / step) * step;
  const y = (v) => ((hi - v) / (hi - lo)) * 200;
  const t0 = c.from, t1 = Math.max(now, t0 + 1);
  const x = (t) => ((t - t0) / (t1 - t0)) * 1000;
  const path = pts.map((p, i) => `${i ? "L" : "M"}${x(p.at).toFixed(1)} ${y(p.e).toFixed(1)}`).join(" ");
  const ticks = [];
  for (let v = hi; v >= lo - 1e-9; v -= step) ticks.push(v);
  const last = pts[pts.length - 1];
  const days = c.pnl;
  return `<figure aria-label="Equity from ${usd(vals[0])} to ${usd(last.e)}" style="margin:0">
    <div class="plot eq">${ticks.map((v) => `<span class="yl" style="top:${((y(v) / 200) * 100).toFixed(2)}%">${usd(v, 0)}</span>`).join("")}
      <svg viewBox="0 0 1000 200" preserveAspectRatio="none" aria-hidden="true" style="position:absolute;inset:0;width:100%;height:100%;overflow:visible">
        <path d="${ticks.map((v) => `M0 ${y(v).toFixed(1)}H1000`).join("")}" style="fill:none;stroke:var(--line);stroke-width:1;vector-effect:non-scaling-stroke"/>
        <path d="${path}" style="fill:none;stroke:var(--violet);stroke-width:2;stroke-linecap:round;stroke-linejoin:round;vector-effect:non-scaling-stroke"/></svg>
      <span aria-hidden="true" style="position:absolute;left:${(x(last.at) / 10).toFixed(2)}%;top:${((y(last.e) / 200) * 100).toFixed(2)}%;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;background:var(--lime);box-shadow:0 0 0 2px var(--card)"></span>
      <span class="b s13" style="position:absolute;left:calc(100% + 12px);top:${((y(last.e) / 200) * 100).toFixed(2)}%;transform:translateY(-50%);white-space:nowrap">${usd(last.e)}</span>
    </div><div class="xl eq" aria-hidden="true">${xLabels(days, now, (p) => p.at)}</div></figure>`;
}

// ── trading desk ──────────────────────────────────────────────────────

const STATUS = { due: "Due", waiting: "Waiting", holding: "Holding", cooldown: "Cooldown", skipped: "Skipped" };
const statusNote = (t) => (t.until ? `${t.note} ${hm(t.until)}` : t.note);

function trading(d) {
  const tr = d.trading;
  const L = LISTS[S.list];
  const cur = tr.lists[S.list];
  const sig = S.list === "signals";
  const active = Object.keys(d.config[L.key]).length;
  const feedRows = cur.rows
    .map((t) => {
      const on = S.sel === t.address;
      const age = t.createdAt ? mins(Math.max(0, Math.floor((d.now - t.createdAt) / 60_000))) : "—";
      return `<li><button class="grid-feed" data-a="pick" data-v="${esc(t.address)}" aria-pressed="${on}" aria-label="${esc(`${t.symbol}, ${STATUS[t.status]}, ${statusNote(t)}`)}">
        <span class="tok"><span class="av sm" aria-hidden="true">${ini(t.symbol)}</span><span class="stack"><span class="inline" style="gap:6px"><span class="nm">${esc(t.symbol)}</span>${t.inRun ? `<span class="runbadge">#${t.inRun}</span>` : ""}</span><span class="mono dim" style="font-size:11px;line-height:14px">${esc(t.mint)}</span></span></span>
        <span class="stack" style="align-items:flex-start"><span class="pill ${t.status}">${STATUS[t.status]}</span><span class="muted nowrap" style="font-size:11px;line-height:14px;overflow:hidden;text-overflow:ellipsis;max-width:120px">${esc(statusNote(t))}</span></span>
        <span class="r">${k$(t.mcap)}</span><span class="r">${k$(t.liq)}</span>
        <span class="stack" style="align-items:flex-end"><span>${fin(t.buys) && fin(t.sells) ? (t.buys + t.sells).toLocaleString("en-US") : "—"}</span><span class="muted" style="font-size:11px;line-height:14px">${kn(t.buys)} / ${kn(t.sells)}</span></span>
        ${sig ? `<span class="stack" style="align-items:flex-end"><span class="soft nowrap">${t.signal ? esc(t.signal.replace(/_/g, " ")) : "—"}</span><span class="muted" style="font-size:11px;line-height:14px">${t.signalAt ? `${mins(Math.max(0, Math.floor((d.now - t.signalAt) / 60_000)))} ago` : ""}</span></span>` : `<span class="r ${sign(t.change1h)}">${pct(t.change1h)}</span>`}<span class="r">${rate(t.top10)}</span><span class="r">${rate(t.bundler)}</span>
        <span class="r" style="color:${fin(t.rug) && t.rug >= 0.7 ? "var(--red)" : "var(--ink)"}">${fin(t.rug) ? t.rug.toFixed(2) : "—"}</span><span class="r soft">${age}</span></button></li>`;
    })
    .join("");
  // Three tabs always, as designed; the run two stay off until there is a run to show.
  const r = S.run;
  const dock = r ? S.dock : "positions";
  const tabs = [
    ["positions", "Open positions", String(d.overview.positions.length)],
    ["run", r ? `Run #${r.id}` : "Run", r ? (r.status === "error" ? "failed" : plural(r.brief.length, "due token")) : "none yet"],
    ["transcript", "Transcript", r ? plural(r.transcript.length, "message") : "none yet"],
  ];
  return `<div class="title"><div class="stack"><span class="muted" style="font-size:15px">Entry loop · agent</span><h1>Trading</h1><p>The tokens the agent reads, what it decided and why, and the positions it holds.</p></div></div>
  <div class="row" style="align-items:flex-start">
    <section class="card flush tall" style="flex:999 1 760px;gap:14px;padding-top:16px;padding-bottom:0" aria-labelledby="feed-title">
      <div class="head"><span class="ico">${I.eye}</span><div class="stack"><h2 id="feed-title" class="big">What the agent sees</h2><span class="s13 muted">${tr.fetchedAt ? `${plural(cur.fetched, "Pump.fun token")} from the fetch at ${hms(tr.fetchedAt)}, plus waits now due` : "no fetch yet"}</span></div></div>
      <div class="head"><div class="seg sm" role="group" aria-label="Token list">${Object.entries(LISTS).map(([k, l]) => `<button data-a="feedList" data-v="${k}" aria-pressed="${S.list === k}">${l.label}<span class="n">${tr.lists[k].rows.length}</span></button>`).join("")}</div>
        <button class="btn sm light" style="margin-left:auto" data-a="openFilters" aria-label="Edit ${L.label} filters, ${active} active">${I.filter}<span>Filters</span>${active ? `<span class="cnt" aria-hidden="true">${active}</span>` : ""}</button></div>
      <div class="fill fade" data-scroll="feed"><div style="min-width:910px"><div class="grid-feed ghead" aria-hidden="true"><span>Token</span><span>Status</span><span class="r">MCap</span><span class="r">Liquidity</span><span class="r">${L.tx}</span><span class="r">${L.c1}</span><span class="r">Top 10</span><span class="r">Bundler</span><span class="r">Rug</span><span class="r">Age</span></div>
        <ul class="feed" aria-label="${L.label} tokens the agent reads">${feedRows || `<li class="empty">Nothing on this list yet.</li>`}</ul></div></div>
    </section>
    <section class="card flush tall" style="flex:1 1 440px;padding-top:16px;padding-bottom:0;position:relative" aria-labelledby="agent-title">
      <div class="head"><span class="ico vio">${I.chat}</span><div class="stack"><div class="inline" style="gap:2px"><h2 id="agent-title" class="big">Agent activity</h2>${helpTip("agent-help", "About agent activity", AGENT_HELP)}</div><span class="s13 muted inline" style="gap:6px"><span class="dot" style="background:${d.health.run === "running" ? "var(--lime)" : "var(--dim)"}"></span>${d.health.run === "running" ? "cycle running" : d.health.run}${tr.lastRun ? ` · last run #${tr.lastRun}` : ""}</span></div></div>
      <div class="seg sm" role="group" aria-label="Agent panel view" style="align-self:flex-start;margin:0 16px">${[["activity", "Activity"], ["runs", "Runs"]].map(([k, l]) => `<button data-a="tab" data-v="${k}" aria-pressed="${S.tab === k}">${l}</button>`).join("")}</div>
      <div class="fill fade" data-scroll="agent" style="display:flex;flex-direction:column;gap:12px">${S.tab === "activity" ? activityPanel(tr) : runsPanel(tr)}</div>
    </section>
  </div>
  <div style="display:flex;flex-direction:column;gap:12px">
    <div class="seg" role="group" aria-label="Details" style="align-self:flex-start;background:var(--deep);border-color:var(--line)">${tabs.map(([k, l, m]) => `<button data-a="dock" data-v="${k}" aria-pressed="${dock === k}" ${k !== "positions" && !r ? "disabled" : ""}>${esc(l)}<span class="n">${esc(m)}</span></button>`).join("")}</div>
    ${dock === "positions" ? positionsTable(d) : dock === "run" ? runDock(S.run, tr) : transcriptDock(S.run)}
  </div>`;
}

/** A "?" beside a card title; its tip shows on hover or focus, and stays open after a tap until tapped again or Escape. */
const helpTip = (id, label, html) =>
  `<button class="helpbtn" data-a="help" data-v="${id}" aria-label="${label}" aria-describedby="${id}" aria-expanded="${S.help === id}"><span aria-hidden="true">${I.help}</span></button><div class="helptip" id="${id}" role="tooltip">${html}</div>`;

const AGENT_HELP = `<b style="color:var(--ink)">What the agent does</b>
  <span>Cycle after cycle, the entry loop hands the agent the tokens that are due: new on GMGN's 1h trending or signal list (smart money buy, pump claim; Pump.fun launches only), or a wait that has ended. Up to 10 tokens per run.</span>
  <span>In a run it may look up holders, top traders, candles or the dev's earlier tokens, then gives each token a verdict:</span>
  <span class="stack" style="gap:2px;padding-left:2px"><span><b class="pos">buy</b> · conviction 0–100; bought only if a slot, the security check and cash allow</span><span><b class="vio">wait</b> · looked at again at the time it sets</span><span><b class="soft">skip</b> · a hard refusal, final</span></span>
  <span>No run starts while every slot is taken or buying is paused.</span>
  <span class="muted" style="padding-top:6px;border-top:1px solid var(--line3)">Shows today, since 00:00 your time. Activity lists every step, newest first; scroll down for earlier runs. Runs shows one row per run. Pick a token on the left to see only what the agent did with it.</span>`;

function activityPanel(tr) {
  if (S.sel && S.token && S.token.address === S.sel) {
    const t = S.token;
    const v = t.verdict;
    return `<div style="display:flex;flex-direction:column;gap:12px;padding:0 16px 8px">
      <div class="inline" style="gap:12px;padding:12px 14px;border-radius:18px;background:var(--inner)"><span class="av dark" aria-hidden="true">${ini(t.symbol)}</span>
        <div class="stack" style="flex:1 1 auto"><span style="font-size:16px;line-height:22px;font-weight:600">${esc(t.symbol)}</span><span class="mono small muted">${esc(t.mint)}${t.source ? ` · ${esc(t.source)}` : ""}</span></div>
        <button class="btn line" style="width:40px;min-height:40px;padding:0;border-radius:50%" aria-label="Back to all activity" data-a="clearSel">${I.x}</button></div>
      ${v ? `<div class="boxed"><div class="inline" style="flex-wrap:wrap;gap:6px 10px"><span class="small muted">Latest verdict</span><span class="tag ${esc(v.action)}">${esc(v.action)}</span><span class="mono small muted">conviction ${v.conviction ?? "—"}</span><span class="small muted" style="margin-left:auto">run #${v.run} · ${v.action === "wait" && v.until ? `until ${hm(v.until)}` : hm(v.at)}</span></div>
        <span class="convbar" aria-hidden="true"><i style="width:${v.conviction ?? 0}%"></i></span><p style="margin:0;line-height:21px;color:var(--body)">${esc(v.thesis ?? "No thesis given.")}</p>
        <button class="link s13" style="align-self:flex-start;min-height:40px" data-a="openRun" data-v="${v.run}">Open run #${v.run} below</button></div>`
        : `<p class="boxed s13 soft" style="margin:0">${t.status === "holding" ? "Held, with no verdict on record." : "No agent activity on this token yet."} Status: ${esc(STATUS[t.status])}, ${esc(statusNote(t))}.</p>`}
      ${t.lookups.length ? `<div class="stack" style="gap:4px"><span class="small muted" style="padding:4px 2px">Lookups the agent made</span>${t.lookups.map((l) => `<div class="lookup"><span class="mono dim" style="font-size:11px">${hms(l.at)}</span><span class="mono small">${esc(l.name)}</span><span class="small muted" style="margin-left:auto">${esc(l.text)}</span></div>`).join("")}</div>` : ""}
    </div>`;
  }
  const live = new Set(tr.activity.map((e) => e.runId));
  const older = [...S.older].filter(([id]) => !live.has(id)).flatMap(([, ev]) => ev);
  const more = S.olderMore ?? tr.activityMore;
  const items = [...tr.activity, ...older]
    .sort((a, b) => b.at - a.at)
    .map((e) => {
      const who = e.kind === "run" || e.kind === "error"
        ? `<button class="link" data-a="openRun" data-v="${e.runId}" style="text-decoration:underline;text-underline-offset:3px">Run #${e.runId}</button>`
        : `<span class="b">${esc(e.token)}</span>`;
      const text = e.kind === "verdict" ? (e.veto ? esc(e.veto) : `${esc(e.action)} · conviction ${e.conviction ?? "—"}${e.action === "wait" && e.until ? ` · until ${hm(e.until)}` : ""}`) : esc(e.text);
      const kind = e.kind === "verdict" ? "verdict" : e.kind;
      return `<li><span class="t">${hms(e.at)}</span><span class="tag ${kind}">${kind}</span><span class="s13" style="flex:1 1 auto;min-width:0">${who} <span class="soft">${text}</span></span></li>`;
    })
    .join("");
  return `<ol class="events" aria-label="Agent activity today">${items || `<li class="muted s13">No runs today yet.</li>`}
    <li class="s13 muted" style="display:block;padding:12px 16px">${more ? "Loading earlier runs…" : items ? "That is every run today." : ""} Pick a token to see everything the agent did with it.</li></ol>`;
}

/** Today's runs of one filter: the state's page plus pages loaded since, newest first. */
function runList(tr, k) {
  const live = new Set(tr.runs[k].runs.map((r) => r.id));
  return [...tr.runs[k].runs, ...[...S.runPages[k].values()].filter((r) => !live.has(r.id))].sort((a, b) => b.id - a.id);
}

function runsPanel(tr) {
  const t = tr.runsToday;
  const list = runList(tr, S.runFilter);
  const more = S.runsMore[S.runFilter] ?? tr.runs[S.runFilter].more;
  return `<div style="display:flex;flex-direction:column;gap:10px;padding:0 12px 8px">
    <div class="inline s13 muted" style="gap:10px;padding:0 4px"><span style="flex:1 1 auto;min-width:0"><b style="color:var(--ink)">${plural(t.n, "run")}</b> · <b class="neg">${t.failed} failed</b> · <span style="white-space:nowrap">${kn(t.tin)} / ${kn(t.tout)} tokens</span></span>
      <div class="seg sm" role="group" aria-label="Filter runs" style="flex:none;flex-wrap:nowrap;margin-left:auto;border:0;padding:0">${[["all", "All", t.n], ["failed", "Failed", t.failed]].map(([k, l, n]) => `<button data-a="runFilter" data-v="${k}" aria-pressed="${S.runFilter === k}" style="${S.runFilter === k ? "" : "background:var(--inner);color:var(--ink)"}">${l}<span class="n">${n}</span></button>`).join("")}</div></div>
    <div class="runs">${list
      .map((r) => {
        const counts = ["buy", "wait", "skip"].filter((a) => r.counts[a]).map((a) => `${r.counts[a]} ${a}`).join(" · ");
        return `<button data-a="openRun" data-v="${r.id}" aria-pressed="${S.run?.id === r.id}"><span class="inline" style="width:100%;gap:8px"><span style="font-size:15px;line-height:20px;font-weight:600">#${r.id}</span>${r.status === "error" ? `<span class="tag failed">failed</span>` : r.status === "running" ? `<span class="tag">running</span>` : ""}<span class="mono small muted" style="margin-left:auto">${hms(r.at)}</span></span>
          <span class="s13">${r.due !== null ? plural(r.due, "due token") : "…"} · ${r.status === "error" ? "no verdicts" : counts || "—"}</span>
          <span class="mono small muted">${r.toolsUsed}${tr.toolBudget === null ? "" : `/${tr.toolBudget}`} tools · ${kn(r.tin ?? 0)} / ${kn(r.tout ?? 0)} · ${r.secs !== null ? r.secs.toFixed(1) + "s" : "—"}</span></button>`;
      })
      .join("") || `<p class="empty">${S.runFilter === "failed" ? "No failed runs today." : "No runs today."}</p>`}</div>
    ${list.length ? `<p class="s13 muted" style="margin:0;padding:4px">${more ? "Loading earlier runs…" : "That is every run today."}</p>` : ""}</div>`;
}

function positionsTable(d) {
  const pos = d.overview.positions;
  return `<section class="card flush" aria-labelledby="pos-title2"><div class="head"><span class="ico">${I.case}</span><h2 id="pos-title2">Open positions</h2><span class="s13 muted">exits run by code on every price poll · click a token to see why the agent bought it</span></div>
    ${pos.length ? `<div class="scroll-x" data-scroll="positions"><table style="min-width:920px"><thead><tr><th>Token</th><th class="r">PnL</th><th class="r">Now / entry, USD</th><th class="r">Held</th><th>Exit plan</th><th class="r">Time stop</th><th><span class="sr">Actions</span></th></tr></thead><tbody>${pos
      .map(
        (p, i) => `<tr><td class="nowrap"><div class="inline" style="gap:12px"><span class="av ${i % 2 ? "alt" : ""}" aria-hidden="true">${ini(p.symbol)}</span><span class="stack"><button class="namebtn" data-a="pick" data-v="${esc(p.token)}" aria-label="Show the agent's view of ${esc(p.symbol)}">${esc(p.symbol)}</button><span class="mono small muted">${esc(p.mint)} · held ${mins(p.heldMin)}${p.mode === "live" ? " · live" : ""}</span></span></div></td>
        <td class="r nowrap"><div class="${sign(p.pnlPct)}" style="font-size:18px;line-height:24px;font-weight:600">${pct(p.pnlPct)}</div><div class="small muted">${susd(p.pnlUsd)} · peak ${pct(p.peakPct)}</div></td>
        <td class="r nowrap mono small" style="line-height:18px"><div>${px(p.price)}</div><div class="muted">${px(p.entry)}</div></td>
        <td class="r nowrap"><div>${Math.round(p.heldPct)}%</div><div class="small muted">${kn(p.qtyLeft)} left</div></td>
        <td><div class="chips">${ruleChips(p, false)}</div></td><td class="r nowrap">${mins(p.timeLeftMin)} left</td>
        <td class="r"><button class="btn sm line" data-a="close" data-v="${p.id}" aria-label="Close ${esc(p.symbol)} position">Close</button></td></tr>`,
      )
      .join("")}</tbody></table></div>` : `<p class="empty">No open positions.</p>`}</section>`;
}

const ROLE_TAG = { system: "system", user: "user", assistant: "assistant", tool: "tool" };

function runDock(r, tr) {
  const failed = r.status === "error";
  const used = r.tools.filter((t) => t.ok).length;
  return `<div class="row" style="align-items:flex-start"><div style="flex:1 1 600px;min-width:0;display:flex;flex-direction:column;gap:12px">
    <section class="card" style="gap:16px;padding:18px 20px 20px" aria-labelledby="run-title"><div class="head"><span class="ico vio">${I.chat}</span><h2 id="run-title" style="font-size:24px;line-height:30px;font-weight:600">Run #${r.id}</h2>${failed ? `<span class="tag failed">failed</span>` : ""}<span class="mono small muted" style="margin-left:auto">${esc(r.model)}</span></div>
      <div class="stats"><div><span class="small muted">Started</span><b>${hms(r.at)}</b></div><div><span class="small muted">Duration</span><b>${r.secs !== null ? r.secs.toFixed(1) + "s" : "—"}</b></div><div><span class="small muted">Steps</span><b>${r.steps}${tr.maxSteps === null ? "" : ` of ${tr.maxSteps}`}</b></div><div><span class="small muted">Tool calls</span><b>${used}${tr.toolBudget === null ? "" : ` of ${tr.toolBudget}`}</b></div><div><span class="small muted">Tokens in / out</span><b>${kn(r.tin ?? 0)} / ${kn(r.tout ?? 0)}</b></div></div>
      ${failed ? `<div class="banner red" role="status" style="border-radius:16px;font-size:13px;line-height:19px"><span><code class="mono small">agent_runs.error</code> ${esc(r.error)}</span></div>` : ""}</section>
    <section class="card flush" aria-labelledby="brief-title"><div class="head" style="padding:0 20px;align-items:baseline"><h2 id="brief-title">Brief</h2><span class="s13 muted">${plural(r.brief.length, "due token")} · the numbers the model saw, from token_snapshots</span></div>
      <div class="scroll-x" data-scroll="brief"><div style="min-width:820px"><div class="grid-brief ghead" style="padding:6px 20px 8px"><span>Token</span><span>Why due</span><span class="r">MCap</span><span class="r">Liquidity</span><span class="r">Vol 1h</span><span class="r">TXs 1h</span><span class="r">1h</span><span class="r">Top 10</span></div>
      ${r.brief.map((b) => `<div class="grid-brief" style="padding:10px 20px;border-bottom:1px solid var(--line);white-space:nowrap;font-variant-numeric:tabular-nums"><span class="stack"><span class="b" style="overflow:hidden;text-overflow:ellipsis">${esc(b.symbol)}</span><span class="mono small muted">${esc(b.mint)}</span></span><span class="s13 soft">${esc(b.why)}</span><span class="r">${k$(b.mcap)}</span><span class="r">${k$(b.liq)}</span><span class="r">${k$(b.vol)}</span><span class="r">${kn(b.txs)}</span><span class="r ${sign(b.change1h)}">${pct(b.change1h)}</span><span class="r">${rate(b.top10)}</span></div>`).join("") || `<p class="empty">No brief on record.</p>`}</div></div></section>
  </div><div style="flex:1 1 460px;min-width:0;display:flex;flex-direction:column;gap:12px">
    <section class="card flush" aria-labelledby="verdicts-title"><div class="head" style="padding:0 20px;align-items:baseline"><h2 id="verdicts-title">Verdicts</h2><span class="s13 muted">saved to decisions · model-written, read as data</span></div>
      ${r.verdicts.length ? `<ul class="lst">${r.verdicts.map((v) => `<li><span class="av ${v.action === "buy" ? "alt" : v.action === "skip" ? "grey" : ""}" aria-hidden="true">${ini(v.symbol)}</span><div class="stack" style="flex:1 1 auto;gap:4px"><div class="inline" style="flex-wrap:wrap;gap:4px 10px"><span class="b" style="font-size:15px">${esc(v.symbol)}</span><span class="small b ${v.action === "buy" ? "pos" : v.action === "wait" ? "vio" : "muted"}">${esc(v.action)}</span><span class="mono small muted">conviction ${v.conviction ?? "—"}</span><span class="small muted nowrap" style="margin-left:auto">${v.action === "wait" && v.recheck_at ? `until ${hm(v.recheck_at)}` : ""}</span></div><p class="s13 soft" style="margin:0;line-height:19px">${esc(v.thesis ?? "")}</p></div></li>`).join("")}</ul>`
        : `<p class="empty">None saved. A failed run writes no decisions; its tokens are asked again next cycle.</p>`}</section>
    <section class="card flush" aria-labelledby="tools-title"><div class="head" style="padding:0 20px;align-items:baseline"><h2 id="tools-title">Tool calls</h2><span class="s13 muted">read-only GMGN routes, one per tool · from tool_calls</span></div>
      ${r.tools.length ? `<ol class="lst tools">${r.tools.map((t) => `<li><span class="mono small dim" style="width:48px">+${t.offset.toFixed(1)}s</span><span class="toolname">${esc(t.name)}</span><span class="mono small muted" style="flex:1 1 220px;min-width:0;overflow-wrap:anywhere">${esc(t.args)}</span><span class="s13 inline" style="gap:6px;color:${t.ok ? "var(--lime)" : "var(--red)"}"><span class="dot" style="background:currentColor"></span>${esc(t.text)}</span></li>`).join("")}</ol>`
        : `<p class="empty">No lookups this run: the model decided from the brief alone.</p>`}</section>
  </div></div>`;
}

function transcriptDock(r) {
  return `<section class="card" aria-label="Transcript" style="padding:14px 20px"><details open><summary class="inline" style="flex-wrap:wrap;gap:6px 12px;min-height:44px;cursor:pointer"><span style="font-size:15px;font-weight:500">Transcript</span><span class="s13 muted">${plural(r.transcript.length, "message")} · agent_runs.messages</span></summary>
    <ol class="transcript">${r.transcript.map((m) => `<li><span class="tag ${ROLE_TAG[m.role] ?? "tool"}">${esc(m.role)}</span><pre>${esc(m.text)}</pre></li>`).join("")}</ol></details></section>`;
}

// GMGN's filters, in trending's order and units ($K = thousands of dollars). The signal route
// takes market cap and total fees only, so those are all its list offers.
const FILTERS = [
  ["age", "Age, minutes"], ["liquidity", "Liquidity, $K"], ["initialLiquidity", "Initial liquidity, $K"], ["marketCap", "Market cap, $K"],
  ["athMarketCap", "ATH market cap, $K"], ["volume", "1h volume, $K"], ["swaps", "1h transactions"], ["fee", "Total fees, SOL"],
  ["holders", "Holders"], ["botDegens", "Bot degens"], ["viewing", "Currently viewing"], ["smartMoney", "Smart-money wallets"], ["kol", "KOL wallets"],
  ["top10", "Top 10 holders, %"], ["devHolding", "Dev holding, %"], ["insider", "Insiders, %"], ["bundler", "Bundlers, %"], ["phishing", "Phishing, %"], ["sniper", "Snipers hold, %"],
];
const SIGNAL_KEYS = new Set(["marketCap", "fee"]);
// GMGN's signal types the token signal route takes, grouped as the modal shows them. It refuses
// 14–16 (large buy, multi buy, multi large buy). Each checked type is one group of up to 50 rows.
const SIGNAL_TYPES = [
  ["Buying", [[12, "Smart money buy"], [20, "KOL buy"]]],
  ["Price", [[1, "K-line spike"], [6, "Price spike"], [7, "All-time high"], [8, "Market cap key level"]]],
  ["Promotion", [[2, "Dex ad"], [3, "Dex link update"], [4, "Dex trending bar"], [5, "Dex boost"], [13, "Platform call"], [19, "Platform call v2"]]],
  ["Other", [[9, "Live stream"], [11, "Community takeover"]]],
  ["Claims and warnings", [[10, "Bundler sell"], [17, "Bags claim"], [18, "Pump claim"]]],
];
/** The token list's tabs; each list keeps its own fetch filters under `key` in the config. */
const LISTS = {
  trending: {
    label: "1h trending", key: "filters", tx: "TXs 1h", c1: "1h", sub: "sent to GMGN with the 1h trending request",
    note: "Pump.fun launchpads only (Pump.fun, mayhem, agent), by GMGN's platforms param. GMGN applies these to the 1h trending request; initial liquidity is checked on each row.",
  },
  signals: {
    label: "Signals", key: "signalFilters", tx: "TXs 1h", c1: "Last signal", sub: "sent to GMGN with the token signal request",
    note: "Tokens GMGN fires one of the checked signal types on, Pump.fun launches on a pump curve or PumpSwap only (checked on each row). The signal route takes market cap and total fees only, so those are the bounds offered. Its rows carry no transactions; the column shows the last snapshot's 1h count.",
  },
};

function filtersDialog(d) {
  const L = LISTS[S.list];
  const f = d.config[L.key];
  const list = FILTERS.filter(([k]) => S.list !== "signals" || SIGNAL_KEYS.has(k));
  return `<div class="overlay"><div class="dialog wide" role="dialog" aria-modal="true" aria-labelledby="ff-title">
    <div class="head"><span class="ico">${I.filter}</span><div class="stack"><h2 id="ff-title" style="font-size:18px;line-height:24px">Fetch filters · ${L.label}</h2><span class="s13 muted">${L.sub}</span></div>
      <button class="btn line" style="margin-left:auto;width:44px;min-height:44px;padding:0;border-radius:50%" aria-label="Close" data-a="closeFilters">${I.x}</button></div>
    <p class="s13 muted" style="color:var(--muted)">Tokens outside these ranges are never snapshotted, so they cost no rate limit and never reach the agent. ${L.note} They only narrow the pool; the risk check still runs on every buy. Leave a side empty for no limit.</p>
    ${S.list === "signals" ? sigTypes(d.config.signalTypes) : ""}
    <form id="filters" class="filters">${list.map(([k, l]) => `<div><span class="s13 b">${l}</span><div class="inline" style="gap:8px"><input class="inp" type="number" min="0" step="any" name="${k}Min" aria-label="${l} minimum" placeholder="Min" value="${esc(f[k + "Min"] ?? "")}"><span class="s13 muted" aria-hidden="true">to</span><input class="inp" type="number" min="0" step="any" name="${k}Max" aria-label="${l} maximum" placeholder="Max" value="${esc(f[k + "Max"] ?? "")}"></div></div>`).join("")}</form>
    <div class="actions" style="justify-content:flex-start"><button class="btn ghost" data-a="clearFilters">Clear this list</button><button class="btn inner" style="margin-left:auto" data-a="closeFilters">Cancel</button><button class="btn lime" data-a="applyFilters">Apply filters</button></div>
  </div></div>`;
}

function sigTypes(on) {
  const box = ([t, l]) => `<label><input type="checkbox" value="${t}" ${on.includes(t) ? "checked" : ""}>${l}</label>`;
  return `<form id="sigtypes" class="sigtypes"><fieldset><legend class="s13 b">Signal types</legend>
    <p class="s13 muted">One group of up to 50 rows per checked type, all in one request. Price types fill their 50 at once; the agent sees 10 tokens a run. None checked turns this list off.</p>
    ${SIGNAL_TYPES.map(([g, ts]) => `<div class="grp"><span class="s13 muted">${g}</span><div class="chips">${ts.map(box).join("")}</div></div>`).join("")}</fieldset></form>`;
}

// ── research ──────────────────────────────────────────────────────────
// Laid out as the design canvas's "Proposal · Dashboard · Research" board: six tiles, the tries
// beside the open one, Settings versions folded at the bottom.

const SOURCE = { decision: "decided", rank: "rank 11+", migration: "migrations" };
const HYP_FILTERS = [["all", "All"], ["testing", "Testing"], ["passed", "Passed"], ["paper", "Paper"], ["live", "Live, small"], ["kept", "Kept"], ["closed", "Closed"]];
const R_ICON = {
  settings: "M7 4h7l4 4v12H7z M14 4v4h4 M10 13h5 M10 17h5",
  bought: "M4 18l5-6 4 3 7-9 M15 6h5v5",
  conviction: "M5 20V10 M12 20V4 M19 20v-7",
  drift: "M4 6l6 6 4-3 6 7 M15 16h5v-5",
  shadow: "M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  calibration: "M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14z M12 2v5 M12 17v5 M2 12h5 M17 12h5",
  list: "M9 6h11 M9 12h11 M9 18h11 M4.5 6h.01 M4.5 12h.01 M4.5 18h.01",
  find: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z M20 20l-4-4",
  versions: "M12 4l8 4-8 4-8-4z M4 12l8 4 8-4 M4 16l8 4 8-4",
  copy: "M9 9h11v11H9z M5 15V4h11",
  flask: "M9 3h6 M10 3v6.5L5.2 17.6A2 2 0 0 0 7 20.5h10a2 2 0 0 0 1.8-2.9L14 9.5V3",
};
const groupOf = (s) => (s === "failed" || s === "dropped" ? "closed" : s);
const OPS = { ">=": "≥", "<=": "≤", "!=": "≠" };
const condText = (c) =>
  `${c.path} ${OPS[c.op] ?? c.op} ${typeof c.value === "object" && c.value ? `${c.value.times === 1 ? "" : `${c.value.times} × `}${c.value.path}` : String(c.value)}`;
const exitChips = (e) => [`SL ${pct(e.sl, 0)}`, ...e.tp.map((t) => `TP ${pct(t.at, 0)} · sell ${t.sell}%`), `time stop ${e.time_min}m`];
const exitLine = (e) => [`SL ${pct(e.sl, 0).slice(0, -1)}`, ...e.tp.map((t) => `TP ${pct(t.at, 0).slice(0, -1)}`), `time ${e.time_min}m`].join(" · ");
const byOf = (h) => (h.author === "seed" ? "seed" : h.author === "claude-code" ? "claude-code" : "own agent");
const st = (s) => `<span class="st ${esc(s)}">${esc(s)}</span>`;
const when = (t) => (t ? `${dayLabel(t)} ${hm(t)}` : "");
const ink = (v) => `<b style="color:var(--ink)">${v}</b>`; // code-made numbers and words only
const meter = (n, of, cls, label) =>
  `<div class="meter ${cls}" role="meter" aria-label="${label}" aria-valuemin="0" aria-valuemax="${of}" aria-valuenow="${n}"><i style="width:${Math.min(100, (n / of) * 100).toFixed(1)}%"></i></div>`;
const mv = (h, to, label, cls) => `<button class="btn sm ${cls}" data-a="move" data-v="${h.id}:${to}">${label}</button>`;

/** Rows of label · a bar from the left (|avg| × 10%, lime above 0, red below) · avg · n. */
function rbars(rows, label, first) {
  return `<div class="rrows" style="grid-template-columns:${first} minmax(0, 1fr) 52px 60px">${rows
    .map((r) => {
      const w = fin(r.avg) ? Math.min(100, Math.abs(r.avg) * 10).toFixed(0) : 0;
      return `<span class="muted">${esc(label(r))}</span><div class="rbar" aria-hidden="true"><i class="${fin(r.avg) && r.avg < 0 ? "neg" : "pos"}" style="width:${w}%"></i></div><span class="r b ${fin(r.avg) ? sign(r.avg) : "muted"}">${pct(r.avg)}</span><span class="r muted">n ${kn(r.n)}</span>`;
    })
    .join("")}</div>`;
}

function researchTiles(r) {
  const cur = r.versions.find((v) => v.current);
  const c = r.candidates;
  const gap = fin(c.bought.avg) && fin(c.decided.avg) ? c.bought.avg - c.decided.avg : null;
  const cal = r.calibration;
  const t = r.today;
  const o = r.tracking;
  const fr = fin(r.friction) ? `${r.friction.toFixed(1)}%` : "the measured friction";
  const tile = (icon, title, body, foot) =>
    `<div class="tile"><div class="inline"><span class="ico">${SVG(icon)}</span><span style="font-size:15px;font-weight:500">${title}</span></div>${body}<span class="small muted" style="padding:0 6px">${foot}</span></div>`;
  const readable = (x) => (x === null ? "—" : Math.round(x * 100) + "%");
  const judged = cur ? Math.min(cur.trades, r.judgeN) : 0;
  return `<div class="rgrid">
    <div class="tile lime">
      <div class="inline"><span class="ico">${SVG(R_ICON.settings)}</span><span style="font-size:15px;font-weight:600">Current settings${cur ? ` · ${esc(cur.label)}` : ""}</span><span class="pill">${esc(r.mode)}</span></div>
      ${cur
        ? `<div class="in"><span class="num">${plural(cur.trades, "trade")}</span><span class="s13 muted">since ${esc(when(cur.at))}${cur.trades ? ` · <b style="color:#161618">${plural(cur.won, "win")}, ${pct(cur.avgPct)}</b> a trade` : ""}</span></div>
      <div class="in" style="gap:8px">${meter(judged, r.judgeN, "dark", "Trades before a verdict")}
        <span class="small muted"><b style="color:#161618">${judged} of ${r.judgeN}</b> trades before it can be judged</span>
        <span class="small muted">Once an idea is live, the decay watch: over a rolling ${r.judgeN} trades, avg ≤ 0 or a fill gap over ${fr} tells you.</span></div>`
        : `<div class="in"><span class="s13 muted">No settings saved yet.</span></div>`}
    </div>
    ${tile(R_ICON.bought, "Bought vs. all candidates",
      `<div class="in"><span class="num">${gap === null ? "—" : `${gap < 0 ? MINUS : "+"}${Math.abs(gap).toFixed(1)} pts`}</span><span class="s13 muted">bought <b class="${sign(c.bought.avg)}">${pct(c.bought.avg)}</b> (n ${kn(c.bought.n)}) · all decided <b class="${sign(c.decided.avg)}">${pct(c.decided.avg)}</b> (n ${kn(c.decided.n)}), 30 min after the decision</span></div>`,
      `last 7 days · 1 track per token, readable pools only · above 0 = the agent picks better than chance · judged at n ${r.judgeN} bought`)}
    ${tile(R_ICON.conviction, "Conviction vs. result",
      c.decided.n ? rbars(r.conviction, (b) => b.label, "44px") : `<p class="empty" style="padding:0 6px">No decided token has finished 30 minutes yet.</p>`,
      "30-min return of every decided token, by conviction")}
    ${tile(R_ICON.drift, "Drift by source",
      r.sources.some((s) => s.n) ? rbars(r.sources, (s) => SOURCE[s.source], "84px") : `<p class="empty" style="padding:0 6px">No track has finished 30 minutes yet.</p>`,
      "30-min return before costs, last 7 days, 1 track per token · a source is worth researching only above 0 after size impact and friction")}
    ${tile(R_ICON.shadow, "Shadow tracking",
      `<div class="in"><span class="inline" style="align-items:baseline"><span class="num">${o.decision + o.rank + o.migration}</span><span class="s13 muted">tracking now · one RPC read every 2s</span></span>
      <span class="s13 muted">${ink(o.decision)} decided · ${ink(o.rank + o.migration)} sampled from rank 11+ and fresh migrations</span>
      <span class="s13 muted">${ink(t.started)} tracks today · ${ink(readable(t.readable))} readable on-chain (${t.bySource.map((x) => `${SOURCE[x.source]} ${readable(x.readable)}`).join(", ")})</span>
      <span class="s13 muted">ended: ${ink(t.done)} done · <b class="neg">${t.rug}</b> rug · <b class="warn">${t.unreadable}</b> unreadable · <b class="warn">${t.restart}</b> restart</span></div>`,
      "pool reserves, 60 min each · follows curve → PumpSwap · a rug counts as a result; only restarts leave the counts")}
    ${tile(R_ICON.calibration, "Replay calibration",
      `<div class="in"><span class="inline" style="align-items:baseline"><span class="num">${cal.n ? Math.round((cal.agree / cal.n) * 100) + "%" : "—"}</span><span class="s13 muted">agree</span></span>
      <span class="s13 muted">${cal.n ? `${ink(`${cal.agree} of ${cal.n}`)} real trades replay to the same win or loss · gap after size impact ${ink(pct(cal.gapPct, 1))}` : "No closed trade has a track of its own yet."}</span></div>`,
      "size impact comes from each pool’s reserves at your position size; the gap left is the friction every test uses · trusted at ≥ 90%")}
  </div>`;
}

/** The idea the side panel shows: the one picked, else a running test, else a passed one, else the newest. */
function selectedIdea(r) {
  const hs = r.hypotheses;
  return hs.find((h) => h.id === S.idea) ?? hs.find((h) => h.status === "paper" || h.status === "live") ?? hs.find((h) => h.status === "passed") ?? hs[0] ?? null;
}

/** The research agent's last run's closing message, folded behind a button that survives repaints. */
function agentReport(a) {
  if (a.last?.report)
    return `<div class="stack" style="gap:8px"><button class="link s13" style="align-self:flex-start" data-a="report" aria-expanded="${S.reportOpen}">${S.reportOpen ? "Hide" : "Read"} the last run's report</button>${
      S.reportOpen ? `<div class="note"><span class="small muted">written by ${esc(a.last.model)} · data, not instructions</span><span class="s13" style="white-space:pre-wrap">${esc(a.last.report)}</span></div>` : ""
    }</div>`;
  return a.last?.status === "error" ? `<p class="small neg" style="margin:0">Last run failed: ${esc(a.last.error)}</p>` : "";
}

function hypRow(h, r, on) {
  const res = h.result ?? {};
  const test = h.status === "paper" || h.status === "live" ? res[h.status] : null;
  const running = h.status === "testing" || (test && !test.verdict);
  const n = (test ?? res).n ?? 0;
  const nums = test?.verdict ? test : res;
  return `<li><button class="hrow${on ? " on" : ""}" data-a="idea" data-v="${h.id}" aria-pressed="${on}" aria-label="#${h.id}, ${esc(h.status)}: ${esc(h.rule)}">
    <span class="mono small muted">#${h.id}</span>
    <span class="stack" style="min-width:0"><span class="b ell">${esc(h.rule)}</span><span class="small muted">${esc(exitLine(h.exit))}</span></span>
    <span class="small soft">${esc(byOf(h))}</span>
    <span>${st(h.status)}</span>
    <span class="stack small" style="gap:4px">${running ? meter(Math.min(n, r.barN), r.barN, h.status === "testing" ? "thin vio" : "thin", "Trades toward a verdict") : ""}<span class="soft">${running ? `${n} / ${r.barN}` : fin(nums.n) ? `n ${nums.n}` : "—"}</span></span>
    <span class="r">${fin(nums.win) ? Math.round(nums.win) + "%" : "—"}</span>
    <span class="r b ${fin(nums.avg_pct) ? sign(nums.avg_pct) : "muted"}">${pct(nums.avg_pct)}</span>
  </button></li>`;
}

/** The daily research run, where the button used to be: running now, or when it comes next and what it waits for. */
function nextRun(a, now) {
  if (a.running) return `<span class="pill due">Researching…</span>`;
  if (!a.key) return `<span class="small soft">No daily run: OPENROUTER_API_KEY is not set</span>`;
  const at = a.next <= now ? "within 10 min" : esc(when(a.next));
  return `<span class="small soft">Next run ${at}${a.engine === "running" ? "" : " · waits for Start"}</span>`;
}

function hypothesesList(r, sel) {
  const a = r.agent;
  const all = r.hypotheses;
  const rows = all.filter((h) => S.hypFilter === "all" || groupOf(h.status) === S.hypFilter);
  const last = a.last ? `Last run ${esc(when(a.last.started_at))}${a.last.status === "error" ? ` · <span class="neg">failed</span>` : a.last.status === "running" ? " · running" : ""}` : "No run yet";
  return `<section class="card" style="flex:3 1 640px" aria-labelledby="hyp-title">
    <div class="head"><span class="ico">${SVG(R_ICON.list)}</span><div class="stack" style="flex:1 1 0"><h2 id="hyp-title">Hypotheses</h2>
      <span class="sub">${all.length} ${all.length === 1 ? "try" : "tries"} · each row is one try, kept forever · every rule and SL/TP variant counts, and each try raises the bar · judged only on tracks after it was registered</span></div></div>
    <div class="box" style="gap:8px">
      <div class="inline" style="flex-wrap:wrap;justify-content:space-between;gap:4px 12px"><span class="s13 b">Own research agent · ${a.model ? `${esc(String(a.model).split("/").pop())} · ` : ""}daily while running</span>${nextRun(a, r.now)}</div>
      <span class="small muted">${last} · ${ink(a.week.n)} runs in 7 days · ${ink(a.registered)} ${a.registered === 1 ? "try" : "tries"} registered · ${ink(a.week.failed)} errors · ${kn(a.week.tin + a.week.tout)} tokens</span>
      ${agentReport(a)}
    </div>
    <div class="seg light" role="group" aria-label="Filter by status" style="align-self:flex-start">${HYP_FILTERS.map(([k, l]) =>
      `<button data-a="hypFilter" data-v="${k}" aria-pressed="${S.hypFilter === k}">${l} ${all.filter((h) => k === "all" || groupOf(h.status) === k).length}</button>`).join("")}</div>
    ${rows.length
      ? `<div class="scroll-x" data-scroll="hyp" tabindex="0" role="region" aria-label="Hypotheses list"><div class="hyps">
      <div class="hrow hhead" aria-hidden="true"><span>#</span><span>Rule</span><span>By</span><span>Status</span><span>Sample</span><span class="r">Win</span><span class="r">Avg</span></div>
      <ul>${rows.map((h) => hypRow(h, r, h.id === sel?.id)).join("")}</ul></div></div>`
      : `<p class="empty" style="padding:0">${all.length ? "None with this status." : "No try yet."}</p>`}
  </section>`;
}

/** Time left to the 30th trade at the pace so far, as the canvas says it ("~18 h left"). */
function eta(h, n, r) {
  if (!n || n >= r.barN) return "";
  const ms = ((r.barN - n) * (r.now - h.created_at)) / n;
  return ms < 3_600_000 ? `~${Math.max(1, Math.round(ms / 60_000))} min left` : ms < 48 * 3_600_000 ? `~${Math.round(ms / 3_600_000)} h left` : `~${Math.round(ms / 86_400_000)} days left`;
}

/** Why a closed idea closed, in words: a seed's own note, the operator's drop, a fade on fills, or the bar it missed. */
function whyClosed(h, need) {
  const res = h.result ?? {};
  if (h.author === "seed" || (h.status === "failed" && !fin(res.rnd_pct))) return res.note ?? "";
  if (h.status === "dropped") {
    if (res.dropped_by === "operator") return `Dropped by you while ${res.dropped_from}.`;
    const t = res[res.dropped_from] ?? {};
    return `Faded on ${res.dropped_from} fills: ${t.n} trades, ${Math.round(t.win)}% won, ${pct(t.avg_pct)} a trade.${t.agreement ? ` The agent matched the rule on ${t.agreement.bothBuy} of ${t.agreement.agentBuys} buys.` : ""}`;
  }
  const halves = res.halves ?? [];
  const missed = [
    !(res.avg_pct > 0) && `the mean was ${pct(res.avg_pct)} a trade after friction`,
    halves.length && !halves.every((v) => v > 0) && `${halves.filter((v) => v <= 0).length} of ${halves.length} half-days were at or below 0`,
    fin(res.rnd_pct) && res.rnd_pct < need && `it beat ${res.rnd_pct.toFixed(1)}% of random picks, under the ${need.toFixed(1)}% needed`,
  ].filter(Boolean);
  return `Failed the bar at ${res.n} trades: ${missed.join("; ")}.`;
}

/** What comes after the numbers: progress while testing, the paper or live test, the decay watch, why it closed, or the proposed change. */
function ideaStage(h, r) {
  const res = h.result ?? {};
  const s = h.status;
  if (s === "testing") {
    const n = res.n ?? 0;
    const note = res.note && !/^\d+ of \d+ trades$/.test(res.note) ? res.note : "Not judged yet. Code decides at 30; nobody can move the bar.";
    return `<div class="box inner"><div class="inline small muted" style="justify-content:space-between;gap:8px"><span>${ink(`${n} of ${r.barN} trades`)} after registering</span><span>${eta(h, n, r)}</span></div>
      ${meter(n, r.barN, "vio", "Trades toward a verdict")}<span class="small muted">${esc(note)}</span></div>`;
  }
  if (s === "paper" || s === "live") {
    const t = res[s] ?? {};
    const n = t.n ?? 0;
    const held = t.verdict === "holds";
    const ver = r.versions.find((v) => v.at === h[`${s}_config_at`])?.label;
    const a = t.agreement;
    const line = r.line.length ? ` In line: ${r.line.map((id) => `#${id}`).join(", ")}.` : "";
    const waits = s === "paper" ? `One paper test at a time: an idea that passes meanwhile waits its turn, in the order they passed.${line}`
      : !held ? `Ideas that pass meanwhile wait until this stake has its verdict, in the order they passed.${line}` : "";
    return `<div class="stagebox ${s}">
      <span class="b">#${h.id} ${s === "paper" ? "testing on paper" : "live, small stake"}${ver ? ` · Settings ${esc(ver)}` : ""}</span>
      ${meter(Math.min(n, r.barN), r.barN, "", s === "paper" ? "Paper trades toward a verdict" : "Live trades toward a verdict")}
      <span class="s13">${held
        ? `Held on ${s} fills: ${t.n} trades, ${Math.round(t.win)}% won, ${pct(t.avg_pct)} a trade, beat ${t.rnd_pct.toFixed(1)}% of random picks.`
        : `${n} of ${r.barN} ${s} trades. At ${r.barN}, code judges them on the forward test’s bar, with ${s} fills, and keeps or drops it.`}${
        t.paused_at ? ` Paused: Settings were saved again ${esc(when(t.paused_at))}, so later trades are another version.` : ""}${fin(t.fill_gap_pct) ? ` Fill gap ${pct(t.fill_gap_pct, 2)} against the quote.` : ""}</span>
      ${a ? `<div class="inline small" style="flex-wrap:wrap;gap:4px 16px"><span>Agent vs. rule: <b>${a.bothBuy} of ${a.agentBuys}</b> buys match the rule</span><span><b>${a.ruleOnly}</b> rule ${a.ruleOnly === 1 ? "match" : "matches"} the agent skipped</span></div>` : ""}
      <span class="s13">${s === "paper"
        ? held ? "A small live stake is your call: switch Settings to live at a small size, save, then press Go live." : "If it holds, a small live stake comes next: 30 trades, with the fill gap against the paper quote measured. Switching it on, and full size, stay your call in Settings."
        : held ? "Held live. Keep it to leave it as the prompt; full size stays your call in Settings, and the decay watch then follows it." : "Full size, and keeping it, stay your call in Settings."}</span>
      ${waits ? `<span class="small">${waits}</span>` : ""}
      <div class="inline" style="flex-wrap:wrap;gap:8px">${held ? mv(h, s === "paper" ? "live" : "keep", s === "paper" ? "Go live" : "Keep", "lime") : mv(h, "cancel", "Cancel test", "amberline")}${mv(h, "drop", "Drop", "stop")}</div>
    </div>`;
  }
  if (s === "kept") {
    const d = res.decay;
    return `<div class="stagebox kept"><span class="b">Kept · it stays as the prompt</span><span class="s13">${d
      ? `Decay watch: the last ${d.n} live trades ${pct(d.avg_pct)} a trade${fin(d.fill_gap_pct) ? ` · fill gap ${pct(d.fill_gap_pct, 2)}` : ""}${d.decayed ? ` · <span class="warn">flagged ${esc(when(h.decay_at))}: Settings are unchanged, your call</span>` : " · holding"}`
      : `Decay watch: it scores the last ${r.barN} live trades once there are that many.`}</span><div class="inline">${mv(h, "drop", "Drop", "stop")}</div></div>`;
  }
  if (s === "failed" || s === "dropped")
    return `<div class="box inner"><span class="small dim">Why it closed</span><span class="s13 soft">${esc(whyClosed(h, h.need_pct))}</span>${
      s === "dropped" && res.dropped_by === "operator" ? `<button class="btn sm line" style="align-self:flex-start;margin-top:8px" data-a="move" data-v="${h.id}:undrop">Undo drop</button>` : ""}</div>`;
  // passed: the proposed change, and whether Settings already hold it
  const p = h.proposal;
  const cur = r.versions.find((v) => v.current);
  const fieldsOk = p.fields.every((f) => f.from === f.to);
  const pos = r.line.indexOf(h.id);
  const place = `#${h.id} is ${pos + 1} of ${r.line.length} in line, in the order they passed.`;
  const ready = p.decision && !r.inTest && pos === 0 && r.mode === "paper" && p.savedAfter && !p.usedBy && fieldsOk;
  const [dot, guard] = !p.decision
    ? ["amber", `This idea's tokens come from ${SOURCE[h.source]}, which the engine does not brief to the agent: it cannot be tested on paper yet.`]
    : r.inTest ? ["amber", `#${r.inTest.id} is ${r.inTest.status === "paper" ? "on paper" : "on its live stake"}: one test at a time. ${place}`]
    : pos > 0 ? ["amber", `#${r.line[0]} passed first and goes on paper first. ${place} Drop #${r.line[0]} to let this one go ahead.`]
    : r.mode !== "paper" ? ["amber", "Settings are in live mode. Switch them to paper, paste the prompt, set the exit fields above and save them together first."]
    : !p.savedAfter ? ["amber", `Settings still hold ${cur?.label ?? "an older version"}${cur ? ` from ${when(cur.at)}` : ""}, older than this result. Paste the prompt, set the exit fields above and save them together first.`]
    : p.usedBy ? ["amber", `Settings ${cur?.label ?? ""} are the version #${p.usedBy} was tested on. Paste this prompt, set the exit fields above and save them together first.`]
    : !fieldsOk ? ["amber", `Settings ${cur.label} were saved after #${h.id} passed, but the exit fields above still differ: set them and save again.`]
    : ["lime", `Saved in Settings as ${cur.label}, ${when(cur.at)}, after #${h.id} passed: the prompt and the exit fields together.`];
  return `<div class="stack" style="gap:12px"><span class="small dim">Proposed change · never applied by itself · you make it in Settings and save both parts together</span>
    <div class="stack" style="gap:8px"><div class="inline"><span class="s13 b">1 · Operator prompt</span><button class="btn sm line" style="margin-left:auto" data-a="copyPrompt" data-v="${h.id}">${SVG(R_ICON.copy, "ic s16")}${S.copied === h.id ? "Copied" : "Copy"}</button></div>
      <pre class="prompt">${esc(p.prompt)}</pre></div>
    <div class="stack" style="gap:4px"><span class="s13 b">2 · Exit fields</span><ul class="checks" aria-label="Exit fields to set in Settings">${p.fields
      .map((f) => {
        const done = f.from === f.to;
        return `<li class="two"><span class="mk ${done ? "pos" : "warn"}" aria-hidden="true">${done ? "✓" : "→"}</span><span class="stack" style="gap:2px"><span>${esc(f.label)}</span><span class="small soft">${esc(done ? `${p.savedAfter ? "set to" : "stays"} ${f.to}` : `${f.from} → ${f.to}`)}</span></span></li>`;
      })
      .join("")}</ul></div>
    <div class="inline s13 soft" style="align-items:flex-start;gap:10px"><span class="dot" style="margin-top:5px;background:var(--${dot})"></span><span>${esc(guard)}</span></div>
    <div class="inline" style="flex-wrap:wrap;gap:8px"><button class="btn lime" data-a="move" data-v="${h.id}:paper" ${ready ? "" : "disabled"}>${SVG(R_ICON.flask, "ic s16")}Test on paper</button><a class="btn line" href="#settings">Open Settings</a><button class="btn stop" style="margin-left:auto" data-a="move" data-v="${h.id}:drop">Drop</button></div>
  </div>`;
}

function ideaPanel(h, r) {
  if (!h) return "";
  const res = h.result ?? {};
  const s = h.status;
  const seed = h.author === "seed";
  const bt = h.backtest ?? {};
  const halves = res.halves ?? [];
  const fr = fin(res.friction_pct) ? res.friction_pct : r.friction;
  const pending = s === "testing";
  const at = [
    `${seed ? "seeded · " : ""}registered ${when(h.created_at)}`,
    s === "passed" ? `passed ${when(h.decided_at)}` : s === "failed" && !seed ? `failed ${when(h.decided_at)}` : s === "dropped" ? `dropped ${when(h.decided_at)}`
      : s === "paper" ? `on paper since ${when(h.paper_config_at)}` : s === "live" ? `live since ${when(h.live_config_at)}` : s === "kept" ? `kept ${when(h.decided_at)}` : "",
  ].filter(Boolean).join(" · ");
  const mark = (ok) => (ok === null ? `<span class="mk muted" aria-hidden="true">…</span>` : `<span class="mk ${ok ? "pos" : "neg"}" aria-hidden="true">${ok ? "✓" : "✗"}</span>`);
  const checks = [
    ["n ≥ 30 tokens, 1 track each", fin(res.n) ? String(res.n) : "—", pending ? null : (res.n ?? 0) >= r.barN],
    [`avg > 0 after size impact + ${fin(fr) ? `${fr.toFixed(1)}%` : "the measured"} friction`, pct(res.avg_pct), pending || !fin(res.avg_pct) ? null : res.avg_pct > 0],
    ["every half-day > 0", halves.length ? `${halves.filter((v) => v > 0).length} of ${halves.length}` : "not checked", pending || !halves.length ? null : halves.every((v) => v > 0)],
    [`beats random picks from its own source: ≥ ${h.need_pct.toFixed(1)}% needed at try ${h.id}`, fin(res.rnd_pct) ? `${res.rnd_pct.toFixed(1)}%` : "not checked", pending || !fin(res.rnd_pct) ? null : res.rnd_pct >= h.need_pct],
    ...["paper", "live"].filter((m) => res[m]?.verdict).map((m) => [`${m}: the same bar, on ${m} fills`, `${res[m].n} trades · ${Math.round(res[m].win)}% · ${pct(res[m].avg_pct)}`, res[m].verdict === "holds"]),
  ];
  return `<section class="card" style="flex:2 1 400px;gap:16px" aria-labelledby="hd-title">
    <div class="head"><span class="ico">${SVG(R_ICON.find)}</span><div class="stack" style="flex:1 1 0;gap:2px"><div class="inline" style="flex-wrap:wrap"><h2 id="hd-title" class="big2">#${h.id}</h2>${st(s)}</div>
      <span class="sub">by ${esc(byOf(h))}${byOf(h) === "own agent" ? ` (${esc(h.author)})` : ""} · ${esc(at)}</span></div></div>
    <p class="hrule">${esc(h.rule)}</p>
    <div class="stack" style="gap:8px"><span class="small dim">Conditions · brief fields only, checked by code on shadow_tracks.features</span>
      <div class="chips">${h.source !== "decision" ? `<span class="cond">source = ${esc(h.source)}</span>` : ""}${h.conditions.length ? h.conditions.map((c) => `<span class="cond">${esc(condText(c))}</span>`).join("") : `<span class="cond">not expressible as conditions</span>`}</div></div>
    <div class="stack" style="gap:8px"><span class="small dim">Exit plan</span><div class="chips">${exitChips(h.exit).map((t) => `<span class="chip">${esc(t)}</span>`).join("")}</div></div>
    <div class="split2">
      <div class="box"><span class="small dim">Before registering · context only</span><span class="bnum muted">${pct(bt.avg_pct)}</span><span class="small dim">${fin(bt.n) ? `n ${bt.n}${fin(bt.win) ? ` · ${Math.round(bt.win)}% win` : ""}` : "no backtest"}</span></div>
      <div class="box on"><span class="small soft">${seed ? "Verdict data · replay and live" : pending ? "After registering · so far" : "After registering · the verdict"}</span><span class="bnum b ${fin(res.avg_pct) ? sign(res.avg_pct) : ""}">${pct(res.avg_pct)}</span><span class="small soft">n ${fin(res.n) ? res.n : "—"}${fin(res.win) ? ` · ${Math.round(res.win)}% win` : ""}</span></div>
    </div>
    ${halves.length ? `<div class="stack" style="gap:8px"><span class="small dim">After registering, per half-day</span><div class="chips">${halves.map((v) => `<span class="half ${sign(v)}">${pct(v)}</span>`).join("")}</div></div>` : ""}
    <div class="stack" style="gap:4px"><span class="small dim">The bar · set when registered · 2s paths, ${plural(h.exit.slots, "slot")}, ${h.exit.size_sol} SOL a buy and a ${h.exit.drain}% drain exit, as in Settings then</span>
      <ul class="checks" aria-label="The bar">${checks.map(([label, val, ok]) => `<li>${mark(ok)}<span>${esc(label)}</span><span class="soft">${esc(val)}</span></li>`).join("")}</ul></div>
    ${ideaStage(h, r)}
  </section>`;
}

function versionsSection(r) {
  const vs = r.versions;
  const rows = vs.map((v) => `<tr><td><span class="inline" style="gap:8px"><span class="b">${esc(v.label)}</span>${v.current ? `<span class="tag buy">current</span>` : ""}</span></td>
    <td class="mono small muted">${v.at ? esc(when(v.at)) : "before history"}</td><td class="r">${v.trades}</td><td class="r">${v.trades ? Math.round((v.won / v.trades) * 100) + "%" : "—"}</td>
    <td class="r b ${v.trades ? sign(v.avgPct) : "muted"}">${pct(v.avgPct)}</td><td class="r b ${v.trades ? sign(v.totalUsd) : "muted"}">${v.trades ? susd(v.totalUsd) : "—"}</td>
    <td class="soft">${v.from ? `${esc(v.from)} · ${v.trades >= r.judgeN ? "judged" : "too few trades to judge"}` : ""}</td></tr>`);
  return `<section class="card flush" aria-labelledby="ver-title"><div class="head"><span class="ico">${SVG(R_ICON.versions)}</span><h2 id="ver-title">Settings versions</h2>
      <span class="s13 muted">one row per save in Settings, prompt and exits together · judged after ${r.judgeN} trades</span>
      <button class="btn sm line" style="margin-left:auto" data-a="verOpen" aria-expanded="${S.verOpen}">${S.verOpen ? "Hide" : `Show ${plural(vs.length, "version")}`}${SVG(S.verOpen ? "M6 15l6-6 6 6" : "M6 9l6 6 6-6", "ic s16")}</button></div>
    ${S.verOpen ? (vs.length ? `<div class="scroll-x" data-scroll="versions" tabindex="0" role="region" aria-label="Settings versions table"><table style="min-width:680px"><thead><tr><th>Version</th><th>Saved</th><th class="r">Trades</th><th class="r">Win</th><th class="r">Avg / trade</th><th class="r">Total</th><th>From</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>` : `<p class="empty">No settings saved yet.</p>`) : ""}
  </section>`;
}

function research() {
  const r = S.research;
  const head = `<div class="title"><div class="stack"><span class="muted" style="font-size:15px">Edge research</span><h1>Research</h1><p>Code records every candidate and judges every idea; a model only proposes. Nothing on this page changes trading: trading changes only when you save Settings.</p></div></div>`;
  if (!r) return head + `<p class="${S.researchError ? "neg" : "muted"}" style="padding:0 4px">${esc(S.researchError || "Loading research…")}</p>`;
  const sel = selectedIdea(r);
  // The list and the open idea side by side, stretched to one height: no hole under the shorter one.
  return `${head}${researchTiles(r)}<div class="row">${hypothesesList(r, sel)}${ideaPanel(sel, r)}</div>${versionsSection(r)}`;
}

// ── settings ──────────────────────────────────────────────────────────

const sums = (rules) => ["tp", "sl"].map((k) => rules.reduce((t, r) => t + (r.kind === k ? Number(r.sell) || 0 : 0), 0));
const unset = (v) => v === null || v === "";
const planOk = (rules) => sums(rules).every((s) => Math.abs(s - 100) < 0.01);

function planSummary(c) {
  if (c.exitMode === "agent") return `Agent decides · SL ${c.agent.slTightest}% to ${c.agent.slWidest}% · up to ${c.agent.maxTps} TPs`;
  if (!planOk(c.plan)) return "Fixed plan must sell 100% on TP and SL";
  const sl = c.plan.find((r) => r.kind === "sl");
  return `${sl ? `SL ${pct(Number(sl.at), 0)} · ` : ""}${plural(c.plan.filter((r) => r.kind === "tp").length, "take profit")} · ${c.timeStopMinutes}m time stop`;
}

function sections(c, d) {
  return [
    ["mode", "Mode", I.mode, `${c.mode === "live" ? "Live" : "Paper"} · start ${usd(Number(c.paperStartUsd), 0)}`],
    ["cycle", "Buy cycle", I.cycle, `Wait ≤ ${c.maxWaitMinutes}m · cooldown ${c.cooldownMinutes}m`],
    ["risk", "Risk check", I.shield, `${c.sizeSol} SOL · ${c.maxOpenPositions} slots · ${MINUS}${c.maxDailyLossPct}% daily · ${Number(c.slippagePct) > 0 ? `${c.slippagePct}% slippage` : "auto slippage"}`],
    ["exit", "Exit plan", I.exit, planSummary(c)],
    ["agent", "Trading agent", I.trading, `${String(c.model || "OPENROUTER_MODEL").split("/").pop()} · ${unset(c.toolCalls) ? "unlimited" : c.toolCalls} tools · ${unset(c.maxSteps) ? "unlimited" : c.maxSteps} steps`],
    // An engine not restarted since the page changed sends no research block: the section waits for it.
    ...(d.research ? [["research", "Research agent", I.flask, `${typedModel(d).split("/").pop() || "OPENROUTER_MODEL"} · daily · ${d.research.steps} steps`]] : []),
  ];
}

/** The research model as typed (or as saved), and what a run would use with it: never the trading agent's model. */
const typedModel = (d) => (S.rmodel ?? d.research.model).trim();
const runsWith = (d) => typedModel(d) || (d.research.env ? `${d.research.env} (OPENROUTER_MODEL)` : `${d.research.fallback} (built-in default)`);

function researchBody(d) {
  const r = d.research;
  return `<div class="note"><span class="small muted">How it runs · set in code</span><span class="big">Once a day while the engine runs · up to ${r.steps} steps · at most one idea registered a run</span><span class="small muted">Its tools: <code class="mono">ledger_query</code> (read-only), <code class="mono">test_rule</code>, <code class="mono">register_hypothesis</code>. It never trades and never edits Settings.</span></div>
    <div class="row" style="gap:18px 24px">
      <div class="field" style="flex:1 1 360px;min-width:0"><label for="f-rmodel">Model</label><input id="f-rmodel" class="inp wide" type="text" value="${esc(S.rmodel ?? r.model)}" placeholder="OPENROUTER_MODEL"><span class="small muted">Any OpenRouter model id. Empty = <code class="mono">OPENROUTER_MODEL</code> from <code class="mono">.env</code>, ${r.env ? `now <code class="mono">${esc(r.env)}</code>` : `which is not set: <code class="mono">${esc(r.fallback)}</code>`}.</span></div>
      <div class="field" style="flex:1 1 260px;min-width:0"><span class="lbl">Runs with, from the next run</span><span class="mono" id="r-uses" style="min-height:48px;display:flex;align-items:center;overflow-wrap:anywhere">${esc(runsWith(d))}</span><span class="small muted">Next run ${r.next <= d.now ? "within 10 min" : esc(when(r.next))} · last 7 days: ${plural(r.week.n, "run")}, ${kn(r.week.tin + r.week.tout)} tokens</span></div>
    </div>
    <div class="banner lime" style="border-radius:16px;font-size:13px;line-height:18px;align-items:flex-start;flex-wrap:nowrap"><span class="dot" style="margin-top:5px;background:var(--lime)"></span><span><b>No new Settings version.</b> This model is stored apart from the trading config, in its own <code class="mono">settings</code> row. Save writes it on its own when nothing else changed: <code class="mono">config_history</code> gains no row, a paper or live test keeps running, and the Research page's Settings versions stay as they are.</span></div>`;
}

const fieldNum = (label, key, value, unit, opts = {}) =>
  `<div class="field"><label for="f-${key}">${label}</label><div class="inline"><input id="f-${key}" class="inp ${opts.cls ?? ""}" type="number" step="${opts.step ?? "any"}" data-f="${key}" value="${esc(value)}"${opts.placeholder ? ` placeholder="${opts.placeholder}"` : ""}>${unit ? `<span class="s13 muted">${unit}</span>` : ""}</div>${opts.help ? `<span class="small muted">${opts.help}</span>` : ""}</div>`;

const radio = (name, value, on, title, text, disabled) =>
  `<label class="choice ${on ? "on" : ""} ${disabled ? "off" : ""}"><input type="radio" name="${name}" value="${value}" data-f="${name}" ${on ? "checked" : ""} ${disabled ? "disabled" : ""}><span class="stack"><span class="b" style="font-size:15px">${title}</span><span class="s13 ${disabled ? "" : "muted"}">${text}</span></span></label>`;

function settings(d) {
  const c = S.draft;
  const ok = planOk(c.plan);
  const nav = sections(c, d)
    .map(([k, l, ic, sum]) => `<button data-a="section" data-v="${k}" aria-pressed="${S.section === k}"><span class="ico" ${k === "agent" ? 'style="background:var(--violet);color:#161618;border:0"' : k === "research" ? 'style="background:var(--lime);color:#161618;border:0"' : ""}>${ic}</span><span class="stack"><span class="b" style="font-size:15px">${l}</span><span class="small muted" data-sum="${k}">${esc(sum)}</span></span></button>`)
    .join("");
  const sol = d.solUsd > 0 ? `SOL ≈ ${usd(Number(c.sizeSol) * d.solUsd)}` : "SOL";
  const body = {
    mode: `<fieldset class="choices"><legend class="sr">Trading mode</legend>${radio("mode", "paper", c.mode === "paper", "Paper", "Real prices, simulated fills. The wallet is never touched.")}${radio("mode", "live", c.mode === "live", "Live", "Jupiter swaps, signed inside this process with the wallet key.", !d.liveAvailable)}</fieldset>
      ${d.liveAvailable ? `<div class="banner amber" style="border-radius:16px;font-size:13px;line-height:18px">Live trades real funds from the wallet SOLANA_PRIVATE_KEY signs for. Every buy and sell is irreversible.</div>` : `<div class="banner amber" style="border-radius:16px;font-size:13px;line-height:18px">Live stays off while <code class="mono small">SOLANA_PRIVATE_KEY</code> is unset. It is read from the environment only, never from this page.</div>`}
      ${fieldNum("Paper starting equity", "paperStartUsd", c.paperStartUsd, "", { cls: "mid", help: "Paper cash = this + every sell − every buy." })}`,
    cycle: `<div class="note"><span class="small muted">Source</span><span class="big">GMGN 1h trending + signals (smart money buy, pump claim), Pump.fun launches only, plus waits that are due</span></div>
      <div class="fgrid three">${fieldNum("Longest wait", "maxWaitMinutes", c.maxWaitMinutes, "minutes", { step: 1, help: "A wait's recheck time is clamped to this." })}${fieldNum("Cooldown after close", "cooldownMinutes", c.cooldownMinutes, "minutes", { step: 1, help: "A sold token can come back after this." })}</div>`,
    risk: `<div class="note"><span class="small muted">Checked before every buy</span><span class="big">Token security, a free slot, a size above the floor and cash on hand. Any fail = no buy.</span></div>
      <div class="fgrid">${fieldNum("Position size", "sizeSol", c.sizeSol, `<span data-sol>${sol}</span>`, { step: 0.01 })}${fieldNum("Max open positions", "maxOpenPositions", c.maxOpenPositions, "", { step: 1 })}${fieldNum("Max daily loss", "maxDailyLossPct", c.maxDailyLossPct, "% of day start", { help: "Past this, buying pauses. Exits keep running." })}${fieldNum("Slippage", "slippagePct", Number(c.slippagePct) > 0 ? c.slippagePct : "", "%", { step: 0.1, placeholder: "Auto", help: "Empty = auto: Jupiter picks the tolerance per route." })}</div>
      <fieldset style="display:flex;flex-direction:column;gap:8px"><legend style="padding:0 0 8px">After the daily loss limit</legend>${["auto", "manual"].map((v) => `<label class="choice thin ${c.lossResume === v ? "on" : ""}"><input type="radio" name="lossResume" value="${v}" data-f="lossResume" ${c.lossResume === v ? "checked" : ""}><span>${v === "auto" ? "Resume buying automatically at the next day start (00:00 UTC)" : "Stay paused until I press Resume"}</span></label>`).join("")}</fieldset>`,
    exit: `<p class="s13 muted" style="margin:0">Copied onto each position when it is booked. Editing it here never changes an open position.</p>
      <fieldset class="choices"><legend class="sr">Who sets take profit and stop loss</legend>${radio("exitMode", "fixed", c.exitMode === "fixed", "Fixed plan", "Every position gets the rules below.")}${radio("exitMode", "agent", c.exitMode === "agent", "Agent decides", "The agent sets TP/SL with each buy, inside your limits. Code still runs every exit.")}</fieldset>
      ${c.exitMode === "fixed" ? planEditor(c) : agentLimits(c)}
      <div class="fgrid three" style="padding-top:18px;border-top:1px solid var(--line)">${fieldNum("Time stop", "timeStopMinutes", c.timeStopMinutes, "minutes", { help: "Sells what is left once a position is this old." })}${fieldNum("Health: liquidity drain", "liquidityDrainPct", c.liquidityDrainPct, "% below entry", { help: "Sells everything if the pool drains this far." })}</div>`,
    agent: `<div class="row" style="gap:24px"><div style="flex:1 1 280px;min-width:0;display:flex;flex-direction:column;gap:18px">
        <div class="field"><label for="f-model">Model</label><input id="f-model" class="inp wide" type="text" data-f="model" value="${esc(c.model)}" placeholder="OPENROUTER_MODEL"><span class="small muted">Any OpenRouter model id. Empty = <code class="mono">OPENROUTER_MODEL</code>.</span></div>
        <div class="fgrid pair">${fieldNum("Tool calls per run", "toolCalls", c.toolCalls ?? "", "", { step: 1, placeholder: "No limit" })}${fieldNum("Max steps", "maxSteps", c.maxSteps ?? "", "", { step: 1, placeholder: "No limit" })}</div>
        <span class="small muted">Read-only GMGN lookups, one route per tool. Past the budget every call is refused; past max steps the run fails and its tokens retry next cycle. Empty = no limit.</span></div>
      <div class="field" style="flex:999 1 480px;min-width:0"><label for="f-prompt">Operator prompt</label><textarea id="f-prompt" class="inp" rows="14" data-f="prompt" placeholder="Your selection policy. Empty = the agent judges from the numbers alone.">${esc(c.prompt)}</textarea><span class="small muted">Token names and every scanned field reach the model fenced as untrusted data, never as instructions.</span></div></div>`,
    research: d.research ? researchBody(d) : "",
  }[S.section];
  return `<div class="title"><div class="stack"><span class="muted" style="font-size:15px">Operator config</span><h1>Settings</h1><p>Every loop reads this. Saved whole to <code class="mono" style="color:var(--ink)">settings</code>; applies from the next cycle.</p></div>
    <div class="inline" style="gap:8px"><button class="btn" data-a="discard">Discard</button><button class="btn lime" id="save" data-a="save" ${ok ? "" : "disabled"}>Save</button></div></div>
    <div class="row" style="align-items:flex-start"><nav class="secnav" aria-label="Settings sections">${nav}</nav>
    <section class="card" style="flex:999 1 640px;gap:18px;padding:14px 16px 20px" aria-labelledby="s-title"><div class="head"><span class="ico">${sections(c, d).find((s) => s[0] === S.section)[2]}</span><h2 id="s-title">${sections(c, d).find((s) => s[0] === S.section)[1]}</h2></div>${body}</section></div>`;
}

function planStatus(c) {
  const [tp, sl] = sums(c.plan);
  if (planOk(c.plan)) return `<p class="s13 muted" style="margin:0"><b style="color:var(--ink)">Exits fully.</b> Stop loss and take profits each sell 100% of the position.</p>`;
  const off = [tp !== 100 ? `take profits sell ${tp}%` : "", sl !== 100 ? `stop loss sells ${sl}%` : ""].filter(Boolean).join(" and ");
  return `<div class="banner amber" role="alert" style="border-radius:16px"><div class="stack"><span class="b">${esc(off.charAt(0).toUpperCase() + off.slice(1))}, not 100%</span><span class="s13">100% TP and 100% SL are required to exit fully. Save stays off until both add up to 100%.</span></div></div>`;
}

function planEditor(c) {
  return `<div style="display:flex;flex-direction:column;gap:18px"><div class="scroll-x" data-scroll="plan"><table style="min-width:420px"><thead><tr><th style="padding-left:0">Rule</th><th>Fires at PnL</th><th>Sells, of original qty</th><th><span class="sr">Remove</span></th></tr></thead><tbody>${c.plan
    .map(
      (r, i) => `<tr><td style="padding-left:0"><select class="inp" aria-label="Rule ${i + 1} kind" data-rule="${i}" data-k="kind"><option value="sl" ${r.kind === "sl" ? "selected" : ""}>Stop loss</option><option value="tp" ${r.kind === "tp" ? "selected" : ""}>Take profit</option></select></td>
      <td><div class="inline" style="gap:8px"><input class="inp narrow" type="number" step="any" aria-label="Rule ${i + 1} fires at" data-rule="${i}" data-k="at" value="${esc(r.at)}"><span class="muted">%</span></div></td>
      <td><div class="inline" style="gap:8px"><input class="inp narrow" type="number" step="any" aria-label="Rule ${i + 1} sells" data-rule="${i}" data-k="sell" value="${esc(r.sell)}"><span class="muted">%</span></div></td>
      <td class="r" style="padding-right:0"><button class="btn line" style="width:44px;min-height:44px;padding:0;border-radius:50%;color:var(--muted)" aria-label="Remove rule ${i + 1}" data-a="rmRule" data-v="${i}">${I.x}</button></td></tr>`,
    )
    .join("")}</tbody></table></div><div id="plan-status">${planStatus(c)}</div>
    <div><button class="btn inner" data-a="addRule" ${c.plan.length >= 8 ? "disabled" : ""}>Add rule</button></div></div>`;
}

function agentLimits(c) {
  const a = c.agent;
  return `<div style="display:flex;flex-direction:column;gap:18px"><div class="note"><span class="small muted">Agent decides, code enforces</span><span class="big">The agent writes a stop loss and a take-profit ladder with every buy verdict. Code clamps it to these limits, copies it onto the position and runs it, just like a fixed plan.</span></div>
    <div class="fgrid"><div class="field"><span class="lbl">Stop loss between</span><div class="inline"><input class="inp narrow" type="number" aria-label="Stop loss, tightest" data-f="agent.slTightest" value="${esc(a.slTightest)}"><span class="s13 muted">and</span><input class="inp narrow" type="number" aria-label="Stop loss, widest" data-f="agent.slWidest" value="${esc(a.slWidest)}"><span class="s13 muted">%</span></div><span class="small muted">A wider stop from the agent is clamped to ${esc(a.slWidest)}%.</span></div>
    ${fieldNum("Take-profit rules", "agent.maxTps", a.maxTps, "", { step: 1, cls: "narrow", help: "Up to this many. Sells add up to 100% of the position, same as the fixed plan." })}
    ${fieldNum("First take profit at least", "agent.firstTpMin", a.firstTpMin, "%", { cls: "narrow", help: "Keeps the agent from selling into noise." })}
    <div class="field"><label for="f-noplan">If the agent gives no plan</label><select id="f-noplan" class="inp" data-f="agent.noPlan" style="align-self:flex-start"><option value="fixed" ${a.noPlan === "fixed" ? "selected" : ""}>Use the fixed plan</option><option value="skip" ${a.noPlan === "skip" ? "selected" : ""}>Skip the buy</option></select><span class="small muted">A plan whose TP or SL does not sell 100% counts as no plan. The fixed plan always exits fully, so no position opens without a full exit.</span></div></div></div>`;
}

/** A form edit: into the draft, then only the bits that depend on it — never the input being typed in. */
/** Each Settings section's one-line summary, kept up with what is typed. */
function refreshSums() {
  for (const [k, , , sum] of sections(S.draft, S.data)) {
    const n = document.querySelector(`[data-sum="${k}"]`);
    if (n) n.textContent = sum;
  }
}

/** The research model as typed: not part of the config draft, it is saved on its own. */
function researchTyped(v) {
  S.rmodel = v;
  refreshSums();
  const u = $("#r-uses");
  if (u) u.textContent = runsWith(S.data);
}

function setField(el) {
  const c = S.draft;
  if (el.dataset.rule !== undefined) {
    const r = c.plan[Number(el.dataset.rule)];
    r[el.dataset.k] = el.dataset.k === "kind" ? el.value : el.value === "" ? "" : Number(el.value);
  } else {
    const path = el.dataset.f.split(".");
    const isNum = el.type === "number";
    const v = isNum ? (el.value === "" ? "" : Number(el.value)) : el.value;
    if (path.length === 2) c[path[0]][path[1]] = v;
    else c[path[0]] = v;
  }
  const structural = el.type === "radio" || el.tagName === "SELECT";
  if (structural) return render(true);
  const ok = planOk(c.plan);
  const save = $("#save");
  if (save) save.disabled = !ok;
  const ps = $("#plan-status");
  if (ps) ps.innerHTML = planStatus(c);
  refreshSums();
  const sol = document.querySelector("[data-sol]");
  if (sol && S.data.solUsd > 0) sol.textContent = `SOL ≈ ${usd(Number(c.sizeSol) * S.data.solUsd)}`;
}

/** Lazy load: once the box nears its end, pages in today's older activity (ten runs) or, on the Runs tab, older runs. */
async function nearEnd(box) {
  const tr = S.data?.trading;
  if (!box || !tr || S.loadingOlder) return;
  if (box.scrollTop + box.clientHeight < box.scrollHeight - 200) return;
  if (S.tab === "runs") return moreRuns(tr);
  if (S.sel || !(S.olderMore ?? tr.activityMore)) return;
  const before = Math.min(...tr.activity.map((e) => e.runId), ...S.older.keys());
  if (!Number.isFinite(before)) return;
  S.loadingOlder = true;
  try {
    const page = await call(`/api/activity?before=${before}&since=${tr.runsSince}`);
    if (S.data.trading.runsSince === tr.runsSince) { // a page from yesterday's list is dropped
      for (const e of page.activity) S.older.has(e.runId) ? S.older.get(e.runId).push(e) : S.older.set(e.runId, [e]);
      S.olderMore = page.more;
    }
  } catch (e) {
    S.msg = { ok: false, text: e.message };
    S.olderMore = false; // no retry loop on a failing endpoint; the next page load tries again
  } finally {
    S.loadingOlder = false;
  }
  render();
}
/** The Runs tab's lazy load: the next page of today's runs under the current filter. */
async function moreRuns(tr) {
  const k = S.runFilter;
  const last = runList(tr, k).at(-1);
  if (!last || !(S.runsMore[k] ?? tr.runs[k].more)) return;
  S.loadingOlder = true;
  try {
    const page = await call(`/api/runs?before=${last.id}&since=${tr.runsSince}${k === "failed" ? "&failed=1" : ""}`);
    if (S.data.trading.runsSince === tr.runsSince) { // a page from yesterday's list is dropped
      for (const r of page.runs) S.runPages[k].set(r.id, r);
      S.runsMore[k] = page.more;
    }
  } catch (e) {
    S.msg = { ok: false, text: e.message };
    S.runsMore[k] = false; // no retry loop on a failing endpoint; the next page load tries again
  } finally {
    S.loadingOlder = false;
  }
  render();
}
document.addEventListener("scroll", (e) => e.target.dataset?.scroll === "agent" && nearEnd(e.target), true);

// ── actions ───────────────────────────────────────────────────────────

async function openRun(id) {
  try {
    S.run = await call(`/api/run?id=${Number(id)}`);
    S.dock = "run";
    // Picking the latest run (or the one still running) keeps following new runs; an older one stays put.
    S.runPicked = Number(id) < (S.data?.trading.lastDone ?? 0);
  } catch (e) {
    S.msg = { ok: false, text: e.message };
  }
  render();
}

/** As the design does: the dock carries the latest finished run until one is picked by hand. */
let following = false;
function followLatestRun() {
  const latest = S.data?.trading.lastDone;
  if (!latest || S.runPicked || following) return;
  // Already on it, or on a newer run still in progress: wait until that one is done.
  if (S.run && (S.run.id > latest || (S.run.id === latest && S.run.status !== "running"))) return;
  following = true;
  call(`/api/run?id=${latest}`)
    .then((r) => {
      if (S.runPicked || S.run?.id > latest) return; // picked by hand while this was loading
      S.run = r;
      render();
    })
    .catch(() => {})
    .finally(() => (following = false));
}

const A = {
  idea: (v) => ((S.idea = Number(v)), render()),
  hypFilter: (v) => ((S.hypFilter = v), render()),
  verOpen: () => ((S.verOpen = !S.verOpen), render()),
  report: () => ((S.reportOpen = !S.reportOpen), render()),
  move: async (v) => {
    const [id, to] = v.split(":");
    const said = { paper: "on paper", live: "live", keep: "kept", cancel: "test cancelled", drop: "dropped", undrop: "drop undone" }[to];
    if (await act("/api/research/move", { id: Number(id), to }, `Idea #${id}: ${said}.`)) (S.researchAt = 0), await loadResearch(), render();
  },
  copyPrompt: (v) => {
    const h = S.research?.hypotheses.find((x) => x.id === Number(v));
    if (h?.proposal) navigator.clipboard?.writeText(h.proposal.prompt).then(() => ((S.copied = h.id), render()), () => {});
  },
  runBtn: () => (S.data.overview.positions.length ? ((S.confirmStop = true), render()) : act("/api/stop", { closeAll: false })),
  cancelStop: () => ((S.confirmStop = false), render()),
  stopAnyway: () => ((S.confirmStop = false), act("/api/stop", { closeAll: false })),
  closeAllStop: async () => {
    S.confirmStop = false;
    const names = S.data.overview.positions.map((p) => p.symbol);
    const r = await act("/api/stop", { closeAll: true });
    if (r)
      S.msg = r.errors?.length
        ? { ok: false, text: `Stopped, but some sells failed: ${r.errors.join(" · ")}` }
        : { ok: true, text: `Closed ${names.join(" and ")} at market and stopped everything.` };
    render();
  },
  start: () => act("/api/start"),
  resume: () => act("/api/resume"),
  dismiss: () => ((S.msg = null), render()),
  view: (v) => ((S.view = v), render()),
  range: (v) => ((S.range = v), poll()),
  tab: (v) => ((S.tab = v), render()),
  runFilter: (v) => ((S.runFilter = v), render()),
  dock: (v) => ((S.dock = v), render()),
  openRun,
  pick: async (address) => {
    if (S.sel === address) return A.clearSel();
    S.sel = address;
    S.tab = "activity";
    try {
      S.token = await call(`/api/token?address=${encodeURIComponent(address)}`);
    } catch (e) {
      S.msg = { ok: false, text: e.message };
    }
    render();
  },
  clearSel: () => ((S.sel = null), (S.token = null), render()),
  help: (id) => ((S.help = S.help === id ? null : id), render()),
  close: (id) => {
    const p = S.data.overview.positions.find((x) => String(x.id) === String(id));
    if (p && confirm(`Close ${p.symbol} at market${p.mode === "live" ? " — a real, irreversible sell" : ""}?`)) act("/api/close", { id: Number(id) });
  },
  feedList: (v) => ((S.list = v), render()),
  openFilters: () => ((S.filtersOpen = true), render()),
  closeFilters: () => ((S.filtersOpen = false), render()),
  clearFilters: () => document.querySelectorAll("#filters input").forEach((i) => (i.value = "")),
  applyFilters: async () => {
    const L = LISTS[S.list];
    const filters = {};
    for (const i of document.querySelectorAll("#filters input")) if (i.value !== "") filters[i.name] = Number(i.value);
    const config = { [L.key]: filters };
    if (S.list === "signals") config.signalTypes = [...document.querySelectorAll("#sigtypes input:checked")].map((i) => Number(i.value));
    S.filtersOpen = false;
    const r = await act("/api/settings", { config }, `${L.label} filters saved for the next fetch. The run in progress is not affected.`);
    if (r?.config && S.draft) for (const k of Object.keys(config)) S.draft[k] = r.config[k];
  },
  section: (v) => ((S.section = v), render(true)),
  addRule: () => (S.draft.plan.push({ kind: "tp", at: 100, sell: 0 }), render(true)),
  rmRule: (i) => (S.draft.plan.splice(Number(i), 1), render(true)),
  discard: () => ((S.draft = structuredClone(S.data.config)), (S.rmodel = null), (S.msg = null), render(true)),
  save: async () => {
    const d = S.data;
    const model = S.rmodel === null ? null : S.rmodel.trim();
    const research = model !== null && !!d.research && model !== d.research.model;
    const config = JSON.stringify(S.draft) !== JSON.stringify(d.config);
    // The research model is saved apart: a change to it alone makes no Settings version, so no test pauses.
    if (research && !(await act("/api/research/settings", { model }, config ? null : "Research agent model saved. It applies from its next run."))) return;
    if (config || !research) {
      const r = await act("/api/settings", { config: S.draft }, "Settings saved. They apply from the next cycle.");
      if (r?.config) S.draft = structuredClone(r.config);
    }
    S.rmodel = null;
    render(true);
  },
};

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-a]");
  if (!el || el.disabled) return;
  A[el.dataset.a]?.(el.dataset.v, el);
});
document.addEventListener("input", (e) => {
  const el = e.target;
  if (el.id === "f-rmodel") return researchTyped(el.value);
  if ((el.dataset.f !== undefined || el.dataset.rule !== undefined) && el.type !== "radio" && el.tagName !== "SELECT") setField(el);
});
document.addEventListener("change", (e) => {
  const el = e.target;
  if ((el.dataset.f !== undefined || el.dataset.rule !== undefined) && (el.type === "radio" || el.tagName === "SELECT")) setField(el);
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (S.confirmStop) A.cancelStop();
  else if (S.filtersOpen) A.closeFilters();
  else if (S.help) A.help(S.help);
});
window.addEventListener("hashchange", async () => {
  render(true);
  if (page() === "research" && Date.now() - S.researchAt >= RESEARCH_MS) (await loadResearch(), render());
});

poll();
setInterval(poll, 3000);
setInterval(tickClock, 250); // a 1s timer drifts against the second boundary and skips a second now and then
