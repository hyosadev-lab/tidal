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
  confirmStop: false,
  draft: null,
  section: "mode",
  msg: null,
  help: null, // id of the help tip opened by a tap or click; hover and focus open it without this
  older: new Map(), // runId → its activity events, for today's runs paged in past the ten /api/state carries
  olderMore: null, // whether older runs of today remain; null until the first page comes back
  loadingOlder: false,
  runPages: { all: new Map(), failed: new Map() }, // runId → row, for today's runs paged in past the state's page
  runsMore: { all: null, failed: null },
};
const page = () => (["overview", "trading", "settings"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "overview");

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
  $("#clock").textContent = `${dayLabel(now)} · ${hms(now)}`;
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
    paint($("#main"), p === "overview" ? overview(d) : p === "trading" ? trading(d) : settings(d));
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
};

function header(d) {
  const p = page();
  const nav = [["overview", "Overview"], ["trading", "Trading"], ["settings", "Settings"]]
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
      detail: `cycle every ${h.entry.cycleMs / 1000}s${h.entry.lastAt ? ` · last ${hms(h.entry.lastAt)} · next ${hms(h.entry.nextAt)}` : ""}${h.entry.note ? ` · ${h.entry.note}` : ""}`,
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
      status: h.exit.priceError ? "Prices down" : "Polling",
      detail: h.exit.priceError
        ? `Jupiter: ${h.exit.priceError} · only time stops run`
        : `Jupiter price every ${h.exit.pollMs / 1000}s · ${plural(h.exit.mints, "mint")}${h.exit.lastAt && d.now - h.exit.lastAt > 15_000 ? ` · last poll ${hms(h.exit.lastAt)}, stale` : ""}`,
      dot: h.exit.priceError ? WARN : OK,
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
  const pts = c.equity.length ? c.equity : [{ at: now, e: equityNow }];
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
  const active = Object.keys(tr.filters).length;
  const feedRows = tr.feed
    .map((t) => {
      const on = S.sel === t.address;
      const age = t.createdAt ? mins(Math.max(0, Math.floor((d.now - t.createdAt) / 60_000))) : "—";
      return `<li><button class="grid-feed" data-a="pick" data-v="${esc(t.address)}" aria-pressed="${on}" aria-label="${esc(`${t.symbol}, ${STATUS[t.status]}, ${statusNote(t)}`)}">
        <span class="tok"><span class="av sm" aria-hidden="true">${ini(t.symbol)}</span><span class="stack"><span class="inline" style="gap:6px"><span class="nm">${esc(t.symbol)}</span>${t.inRun ? `<span class="runbadge">#${t.inRun}</span>` : ""}</span><span class="mono dim" style="font-size:11px;line-height:14px">${esc(t.mint)}</span></span></span>
        <span class="stack" style="align-items:flex-start"><span class="pill ${t.status}">${STATUS[t.status]}</span><span class="muted nowrap" style="font-size:11px;line-height:14px;overflow:hidden;text-overflow:ellipsis;max-width:120px">${esc(statusNote(t))}</span></span>
        <span class="r">${k$(t.mcap)}</span><span class="r">${k$(t.liq)}</span>
        <span class="stack" style="align-items:flex-end"><span>${fin(t.buys) && fin(t.sells) ? (t.buys + t.sells).toLocaleString("en-US") : "—"}</span><span class="muted" style="font-size:11px;line-height:14px">${kn(t.buys)} / ${kn(t.sells)}</span></span>
        <span class="r ${sign(t.change1h)}">${pct(t.change1h)}</span><span class="r">${rate(t.top10)}</span><span class="r">${rate(t.bundler)}</span>
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
      <div class="head"><span class="ico">${I.eye}</span><div class="stack"><h2 id="feed-title" class="big">What the agent sees</h2><span class="s13 muted">${tr.fetchedAt ? `${plural(tr.feed.length, "token")} from the fetch at ${hms(tr.fetchedAt)}, plus waits now due` : "no fetch yet"}</span></div>
        <button class="btn sm light" style="margin-left:auto" data-a="openFilters" aria-label="Edit filters, ${active} active">${I.filter}<span>Filters</span>${active ? `<span class="cnt" aria-hidden="true">${active}</span>` : ""}</button></div>
      <div class="fill fade" data-scroll="feed"><div style="min-width:910px"><div class="grid-feed ghead" aria-hidden="true"><span>Token</span><span>Status</span><span class="r">MCap</span><span class="r">Liquidity</span><span class="r">TXs 1h</span><span class="r">1h</span><span class="r">Top 10</span><span class="r">Bundler</span><span class="r">Rug</span><span class="r">Age</span></div>
        <ul class="feed" aria-label="Tokens the agent reads">${feedRows || `<li class="empty">Nothing fetched yet.</li>`}</ul></div></div>
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
  <span>Every minute the entry loop hands the agent the tokens that are due: new on GMGN's 1h list or signals, or a wait that has ended. Up to 10 tokens per run.</span>
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

// GMGN trending's filters, in its order and units ($K = thousands of dollars).
const FILTERS = [
  ["age", "Age, minutes"], ["liquidity", "Liquidity, $K"], ["initialLiquidity", "Initial liquidity, $K"], ["marketCap", "Market cap, $K"],
  ["athMarketCap", "ATH market cap, $K"], ["volume", "1h volume, $K"], ["swaps", "1h transactions"], ["fee", "Total fees, SOL"],
  ["holders", "Holders"], ["botDegens", "Bot degens"], ["viewing", "Currently viewing"], ["smartMoney", "Smart-money wallets"], ["kol", "KOL wallets"],
  ["top10", "Top 10 holders, %"], ["devHolding", "Dev holding, %"], ["insider", "Insiders, %"], ["bundler", "Bundlers, %"], ["phishing", "Phishing, %"], ["sniper", "Snipers hold, %"],
];

function filtersDialog(d) {
  const f = d.config.filters;
  return `<div class="overlay"><div class="dialog wide" role="dialog" aria-modal="true" aria-labelledby="ff-title">
    <div class="head"><span class="ico">${I.filter}</span><div class="stack"><h2 id="ff-title" style="font-size:18px;line-height:24px">Fetch filters</h2><span class="s13 muted">sent to GMGN with every trending and signal request</span></div>
      <button class="btn line" style="margin-left:auto;width:44px;min-height:44px;padding:0;border-radius:50%" aria-label="Close" data-a="closeFilters">${I.x}</button></div>
    <p class="s13 muted" style="color:var(--muted)">Tokens outside these ranges are never snapshotted, so they cost no rate limit and never reach the agent. GMGN applies them to trending; initial liquidity and the signal feed are checked on each row. They only narrow the pool; the risk check still runs on every buy. Leave a side empty for no limit.</p>
    <form id="filters" class="filters">${FILTERS.map(([k, l]) => `<div><span class="s13 b">${l}</span><div class="inline" style="gap:8px"><input class="inp" type="number" min="0" step="any" name="${k}Min" aria-label="${l} minimum" placeholder="Min" value="${esc(f[k + "Min"] ?? "")}"><span class="s13 muted" aria-hidden="true">to</span><input class="inp" type="number" min="0" step="any" name="${k}Max" aria-label="${l} maximum" placeholder="Max" value="${esc(f[k + "Max"] ?? "")}"></div></div>`).join("")}</form>
    <div class="actions" style="justify-content:flex-start"><button class="btn ghost" data-a="clearFilters">Clear all</button><button class="btn inner" style="margin-left:auto" data-a="closeFilters">Cancel</button><button class="btn lime" data-a="applyFilters">Apply filters</button></div>
  </div></div>`;
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
    ["agent", "Agent", I.chat, `${String(c.model || "OPENROUTER_MODEL").split("/").pop()} · ${unset(c.toolCalls) ? "unlimited" : c.toolCalls} tools · ${unset(c.maxSteps) ? "unlimited" : c.maxSteps} steps`],
  ];
}

const fieldNum = (label, key, value, unit, opts = {}) =>
  `<div class="field"><label for="f-${key}">${label}</label><div class="inline"><input id="f-${key}" class="inp ${opts.cls ?? ""}" type="number" step="${opts.step ?? "any"}" data-f="${key}" value="${esc(value)}"${opts.placeholder ? ` placeholder="${opts.placeholder}"` : ""}>${unit ? `<span class="s13 muted">${unit}</span>` : ""}</div>${opts.help ? `<span class="small muted">${opts.help}</span>` : ""}</div>`;

const radio = (name, value, on, title, text, disabled) =>
  `<label class="choice ${on ? "on" : ""} ${disabled ? "off" : ""}"><input type="radio" name="${name}" value="${value}" data-f="${name}" ${on ? "checked" : ""} ${disabled ? "disabled" : ""}><span class="stack"><span class="b" style="font-size:15px">${title}</span><span class="s13 ${disabled ? "" : "muted"}">${text}</span></span></label>`;

function settings(d) {
  const c = S.draft;
  const ok = planOk(c.plan);
  const nav = sections(c, d)
    .map(([k, l, ic, sum]) => `<button data-a="section" data-v="${k}" aria-pressed="${S.section === k}"><span class="ico" ${k === "agent" ? 'style="background:var(--violet);color:#161618;border:0"' : ""}>${ic}</span><span class="stack"><span class="b" style="font-size:15px">${l}</span><span class="small muted" data-sum="${k}">${esc(sum)}</span></span></button>`)
    .join("");
  const sol = d.solUsd > 0 ? `SOL ≈ ${usd(Number(c.sizeSol) * d.solUsd)}` : "SOL";
  const body = {
    mode: `<fieldset class="choices"><legend class="sr">Trading mode</legend>${radio("mode", "paper", c.mode === "paper", "Paper", "Real prices, simulated fills. The wallet is never touched.")}${radio("mode", "live", c.mode === "live", "Live", "Jupiter swaps, signed inside this process with the wallet key.", !d.liveAvailable)}</fieldset>
      ${d.liveAvailable ? `<div class="banner amber" style="border-radius:16px;font-size:13px;line-height:18px">Live trades real funds from the wallet SOLANA_PRIVATE_KEY signs for. Every buy and sell is irreversible.</div>` : `<div class="banner amber" style="border-radius:16px;font-size:13px;line-height:18px">Live stays off while <code class="mono small">SOLANA_PRIVATE_KEY</code> is unset. It is read from the environment only, never from this page.</div>`}
      ${fieldNum("Paper starting equity", "paperStartUsd", c.paperStartUsd, "", { cls: "mid", help: "Paper cash = this + every sell − every buy." })}`,
    cycle: `<div class="note"><span class="small muted">Source</span><span class="big">GMGN 1h trending + signal, plus waits that are due</span></div>
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
  for (const [k, , , sum] of sections(c, S.data)) {
    const n = document.querySelector(`[data-sum="${k}"]`);
    if (n) n.textContent = sum;
  }
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
  openFilters: () => ((S.filtersOpen = true), render()),
  closeFilters: () => ((S.filtersOpen = false), render()),
  clearFilters: () => document.querySelectorAll("#filters input").forEach((i) => (i.value = "")),
  applyFilters: async () => {
    const filters = {};
    for (const i of document.querySelectorAll("#filters input")) if (i.value !== "") filters[i.name] = Number(i.value);
    S.filtersOpen = false;
    const r = await act("/api/settings", { config: { filters } }, "Filters saved for the next fetch. The run in progress is not affected.");
    if (r?.config && S.draft) S.draft.filters = r.config.filters;
  },
  section: (v) => ((S.section = v), render(true)),
  addRule: () => (S.draft.plan.push({ kind: "tp", at: 100, sell: 0 }), render(true)),
  rmRule: (i) => (S.draft.plan.splice(Number(i), 1), render(true)),
  discard: () => ((S.draft = structuredClone(S.data.config)), (S.msg = null), render(true)),
  save: async () => {
    const r = await act("/api/settings", { config: S.draft }, "Settings saved. They apply from the next cycle.");
    if (r?.config) S.draft = structuredClone(r.config);
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
window.addEventListener("hashchange", () => render(true));

poll();
setInterval(poll, 3000);
setInterval(tickClock, 250); // a 1s timer drifts against the second boundary and skips a second now and then
