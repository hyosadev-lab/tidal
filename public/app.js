const $ = (id) => document.getElementById(id);
const tokenUrl = (chain, address) => `https://gmgn.ai/${chain || "sol"}/token/${address}`;

const PRESETS = {
  smart:
    "Only enter when at least 3 distinct smart-money wallets have bought in the last hour and none of them have started selling. Check the top holders before committing. If the smart money is already distributing, skip it no matter how good the chart looks.",
  patient:
    "Be selective. At most one new position per cycle, and only when conviction is genuinely above 70. Prefer tokens that have been trading for a few hours with steady volume over anything that just launched. A cycle with no entry is a good cycle.",
  momentum:
    "Look for early momentum: volume rising against a market cap that has not caught up yet, buys clearly outnumbering sells over the last hour, holder count still climbing. Avoid anything already up more than 120% in an hour — that move is not yours to catch.",
  defensive:
    "Capital preservation first. Require deep liquidity relative to market cap, a dev who has fully exited, and top-10 concentration under 20%. Size down to a 0.6 multiplier on everything. Ask to exit early at the first sign of smart money distributing.",
};

const FLOORS = { sol: 3, bsc: 5, base: 5, eth: 25 };
// Fee is denominated in whatever the chain pays gas in — mirrors NATIVE in src/trading/config.ts.
const NATIVE_SYMBOL = { sol: "SOL", bsc: "BNB", base: "ETH", eth: "ETH" };

// Refine rows — must match REFINE_FIELDS in src/trading/config.ts. Blank = no filter.
const REFINE = ["age", "liquidity", "marketCap", "fee", "kol", "smartMoney", "top10", "devHolding", "insider"];
// Typed and shown in thousands; the config stores plain USD, so convert at the edge.
const REFINE_K = new Set(["liquidity", "marketCap"]);

let state = null;
let dirty = false; // don't stomp on fields the operator is mid-edit
let pendingMode = null;

// ── formatting ────────────────────────────────────────────────────────
const usd = (n, dp = 2) => {
  const v = Number(n) || 0;
  const sign = v < 0 ? "-" : "";
  const a = Math.abs(v);
  if (a >= 1_000_000) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 10_000) return `${sign}$${(a / 1e3).toFixed(1)}K`;
  return `${sign}$${a.toFixed(dp)}`;
};

const pct = (n, dp = 1) => `${Number(n) >= 0 ? "+" : ""}${(Number(n) || 0).toFixed(dp)}%`;

const price = (n) => {
  const v = Number(n) || 0;
  if (v === 0) return "$0";
  if (v < 0.000001) return `$${v.toExponential(2)}`;
  return `$${v.toPrecision(v < 1 ? 4 : 6)}`;
};

const dur = (ms) => {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
};

// dur() rounds to the minute — fine for ages, useless for a countdown ticking every second.
const countdown = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : dur(ms);
};

const clock = (ts) =>
  new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

const tone = (n) => (Number(n) > 0 ? "up" : Number(n) < 0 ? "down" : "flat");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// ── the tide gauge ────────────────────────────────────────────────────
function drawTide(points, stats) {
  const svg = $("tide");
  const W = 1000;
  const H = 200;
  const pad = 14;

  if (!points.length) {
    svg.innerHTML = `<line x1="0" y1="${H - 30}" x2="${W}" y2="${H - 30}" stroke="var(--rule)" stroke-dasharray="3 5"/>`;
    $("mk-span").textContent = "no soundings yet";
    return;
  }

  // The stored series is throttled to one point a minute and stops entirely while nothing
  // is open, so the curve ends at a live reading — otherwise the dot lags the big number.
  const series = [...points, { at: Date.now(), equity: stats.equity }];
  const vals = series.map((p) => p.equity);
  // Only what is plotted: peak/trough are all-time and survive the history trim, so drawing
  // the water lines from them floats them above a curve that never reached there.
  const hi = Math.max(...vals);
  const lo = Math.min(...vals);
  const range = hi - lo || Math.max(1, hi * 0.02);
  const top = hi + range * 0.18;
  const bottom = lo - range * 0.12;
  const y = (v) => pad + (1 - (v - bottom) / (top - bottom)) * (H - pad * 2);
  const t0 = series[0].at;
  const span = series[series.length - 1].at - t0 || 1;
  const x = (p) => ((p.at - t0) / span) * W;

  const line = series.map((p, i) => `${i ? "L" : "M"}${x(p).toFixed(1)},${y(p.equity).toFixed(1)}`).join("");
  const area = `${line}L${W},${H}L0,${H}Z`;
  const rising = vals[vals.length - 1] >= vals[0];
  const stroke = rising ? "var(--flood)" : "var(--ebb)";

  svg.innerHTML = `
    <defs>
      <linearGradient id="water" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${rising ? "#56E0B8" : "#FF7B6E"}" stop-opacity=".26"/>
        <stop offset="100%" stop-color="${rising ? "#56E0B8" : "#FF7B6E"}" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <line x1="0" y1="${y(hi).toFixed(1)}" x2="${W}" y2="${y(hi).toFixed(1)}" stroke="var(--flood)" stroke-width="1" stroke-dasharray="4 6" opacity=".5"/>
    <line x1="0" y1="${y(lo).toFixed(1)}" x2="${W}" y2="${y(lo).toFixed(1)}" stroke="var(--ebb)" stroke-width="1" stroke-dasharray="4 6" opacity=".45"/>
    <path d="${area}" fill="url(#water)"/>
    <path d="${line}" fill="none" stroke="${stroke}" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
    <circle cx="${W}" cy="${y(vals[vals.length - 1]).toFixed(1)}" r="3.5" fill="${stroke}"/>
  `;

  $("mk-high").textContent = usd(hi);
  $("mk-low").textContent = usd(lo);
  $("mk-span").textContent = `${points.length} soundings over ${dur(Date.now() - t0)}`;
}

// ── render ────────────────────────────────────────────────────────────
function render(s) {
  state = s;
  const { config: c, stats: st } = s;

  // header
  $("chip-chain").textContent = c.chain.toUpperCase();
  $("chip-mode").textContent = c.mode.toUpperCase();
  $("chip-mode").dataset.live = c.mode === "live" ? "1" : "0";
  $("chip-cycle").textContent = `cycle ${s.cycle.count}`;
  $("beacon").dataset.state = s.runState;
  $("run-label").textContent = s.cycle.busy ? s.cycle.phase : s.runState;
  const runBtn = $("btn-run");
  runBtn.textContent = s.runState === "running" ? "Stop agent" : "Start agent";
  runBtn.dataset.stop = s.runState === "running" ? "1" : "0";

  const banner = $("banner");
  if (s.haltReason) {
    banner.hidden = false;
    banner.dataset.kind = "error";
    banner.textContent = s.haltReason;
  } else if (c.mode === "live") {
    banner.hidden = false;
    banner.dataset.kind = "warn";
    banner.textContent = s.liveReady
      ? "Live mode — swaps are real and irreversible."
      : "Live mode is selected but not armed. Set GMGN_ALLOW_AUTOMATED_TRADES=1 in the shell running this server and add a wallet address.";
  } else {
    banner.hidden = true;
  }

  // gauge + readout
  $("eq-value").textContent = usd(st.equity);
  $("eq-day").textContent = pct(st.dayPnlPct, 2);
  $("eq-day").className = tone(st.dayPnlPct);
  drawTide(s.equity, st);

  $("s-cash").textContent = usd(st.cash);
  $("s-exposure").textContent = usd(st.exposure);
  $("s-realised").textContent = usd(st.realisedUsd);
  $("s-realised").className = `cell-v ${tone(st.realisedUsd)}`;
  $("s-unrealised").textContent = usd(st.unrealisedUsd);
  $("s-unrealised").className = `cell-v ${tone(st.unrealisedUsd)}`;
  $("s-winrate").textContent = st.wins + st.losses ? `${st.winRatePct.toFixed(0)}% · ${st.wins}/${st.wins + st.losses}` : "—";
  $("s-dd").textContent = `${st.maxDrawdownPct.toFixed(1)}%`;
  $("s-next").textContent =
    s.runState === "running" && s.cycle.nextRunAt ? countdown(s.cycle.nextRunAt - Date.now()) : "—";

  if (!dirty) fillForm(c, s);
  renderPositions(s);
  renderCandidates(s);
  renderTrades(s);
  renderLogs(s.logs);
}

function fillForm(c, s) {
  for (const b of document.querySelectorAll("#seg-chain button"))
    b.setAttribute("aria-pressed", String(b.dataset.v === c.chain));
  for (const b of document.querySelectorAll("#seg-mode button"))
    b.setAttribute("aria-pressed", String(b.dataset.v === c.mode));

  $("in-interval").value = c.intervalMinutes;
  $("lbl-interval").textContent = `${c.intervalMinutes} min`;
  $("lbl-monitor").textContent = c.monitorSeconds;
  $("in-prompt").value = c.prompt;
  $("mode-hint").textContent =
    c.mode === "live"
      ? "Live mode places real swaps through gmgn-cli from the wallet below."
      : "Paper trades against live prices. Nothing leaves your wallet.";

  const set = (id, v) => {
    const el = $(id);
    if (el && document.activeElement !== el) el.value = v;
  };
  $("in-fixed").checked = c.fixedStrategy !== false;
  applyFixed();
  // Don't rebuild the rule rows under the operator's cursor — only when they actually changed.
  const incoming = JSON.stringify(c.strategy ?? []);
  if (incoming !== JSON.stringify(rules)) {
    rules = JSON.parse(incoming);
    renderRules();
  }
  set("in-risk", c.riskPerTradePct);
  set("in-maxpos", c.maxOpenPositions);
  set("in-daily", c.maxDailyLossPct);
  set("in-timestop", c.timeStopMinutes);
  set("in-cooldown", c.cooldownMinutes);
  // 0 means "per-chain default" — show that as an empty box with an `auto` placeholder
  // rather than a 0 the operator has to decode.
  set("in-minpos", c.minPositionUsd || "");
  set("in-gasres", c.gasReserveNative || "");
  for (const k of REFINE)
    for (const side of ["Min", "Max"]) {
      const v = c.refine?.[k + side];
      set(`in-${k}${side}`, v === undefined ? "" : REFINE_K.has(k) ? v / 1000 : v);
    }
  set("in-slip", c.slippagePct || "");
  set("in-bankroll", c.paperStartEquityUsd);
  set("in-wallet", c.walletAddress);

  // Make the floor visible before it silently eats every candidate.
  $("lbl-fee-unit").textContent = NATIVE_SYMBOL[c.chain] ?? "";

  const floor = c.minPositionUsd || FLOORS[c.chain] || 5;
  const ceiling = (s.stats?.equity ?? 0) * (c.riskPerTradePct / 100);
  $("lbl-floor").textContent = usd(floor);
  const ceilEl = $("lbl-ceiling");
  ceilEl.textContent = usd(ceiling);
  ceilEl.className = ceiling < floor ? "down" : "";
  $("live-status").textContent = s.liveReady
    ? "Armed. Live swaps will execute without further confirmation."
    : "Not armed. Live entries will be refused until GMGN_ALLOW_AUTOMATED_TRADES=1 is set and a wallet is saved.";
}

function renderPositions(s) {
  const tb = $("tbl-positions").querySelector("tbody");
  $("c-pos").textContent = s.positions.length;
  $("e-pos").hidden = s.positions.length > 0;
  tb.innerHTML = s.positions
    .map((p) => {
      const pl = p.entryPrice > 0 ? ((p.lastPrice - p.entryPrice) / p.entryPrice) * 100 : 0;
      const value = p.qty * p.lastPrice;
      const peak = p.entryPrice > 0 ? ((p.peakPrice - p.entryPrice) / p.entryPrice) * 100 : 0;
      // A position carries the exit plan it was opened with, so show that plan rather than a
      // rung count: with the analyst writing one per token, no two rows need be alike.
      const plan = (p.strategy ?? [])
        .map((r, i) => {
          const done = p.filledRungs.includes(i);
          return `<span class="pill${done ? " pill-done" : ""}" title="${esc(ruleTitle(r))}">${esc(ruleLabel(r))}</span>`;
        })
        .join("");
      const rungs = p.filledRungs.length ? `<span class="pill">${p.filledRungs.length} rung${p.filledRungs.length > 1 ? "s" : ""}</span>` : "";
      const trail = p.trailArmed ? `<span class="pill pill-armed">trailing</span>` : "";
      const state = plan || `${trail}${rungs || (trail ? "" : `<span class="pill">holding</span>`)}`;
      return `<tr>
        <td class="sym"><a class="linkish" href="${esc(tokenUrl(p.chain, p.address))}" target="_blank" rel="noopener">${esc(p.symbol)}</a>
          <small title="${esc(p.thesis)}">${esc(p.thesis).slice(0, 46)}${p.thesis.length > 46 ? "…" : ""}</small></td>
        <td class="r">${usd(value)}</td>
        <td class="r">${price(p.entryPrice)}</td>
        <td class="r">${price(p.lastPrice)}</td>
        <td class="r ${tone(pl)}">${pct(pl)}</td>
        <td class="r muted">${pct(peak)}</td>
        <td class="r muted">${dur(Date.now() - p.openedAt)}</td>
        <td class="plan">${state}</td>
        <td class="r"><button class="btn btn-quiet" data-close="${p.id}">Close</button></td>
      </tr>`;
    })
    .join("");
}

const ruleLabel = (r) =>
  ({
    tp: `TP +${r.at}% · ${r.sell}%`,
    sl: `SL ${r.at}% · ${r.sell}%`,
    ttp: `TTP +${r.at}% ↘${r.dd}% · ${r.sell}%`,
    tsl: `TSL ↘${r.dd}% · ${r.sell}%`,
  })[r.kind] ?? r.kind;

const ruleTitle = (r) =>
  ({
    tp: `take profit — sell ${r.sell}% of the original size at +${r.at}%`,
    sl: `stop loss — sell ${r.sell}% at ${r.at}%`,
    ttp: `trailing take profit — arms at +${r.at}%, sells ${r.sell}% on a ${r.dd}% giveback from peak`,
    tsl: `trailing stop loss — once in profit, sells ${r.sell}% on a ${r.dd}% giveback from peak. Below break-even the stop loss owns the position`,
  })[r.kind] ?? "";

function renderCandidates(s) {
  const rows = s.cycle.lastCandidates || [];
  const tb = $("tbl-candidates").querySelector("tbody");
  $("c-cand").textContent = rows.length;
  $("e-cand").hidden = rows.length > 0;
  tb.innerHTML = rows
    .slice(0, 25)
    .map((c) => {
      const pass = !c.gateFailures.length;
      return `<tr>
        <td class="sym"><a class="linkish" href="${esc(tokenUrl(s.config.chain, c.address))}" target="_blank" rel="noopener">${esc(c.symbol)}</a>
          <small>${esc(c.source)}</small></td>
        <td class="r">${pass ? c.score : "—"}</td>
        <td class="r">${usd(c.liquidityUsd, 0)}</td>
        <td class="r">${usd(c.volume1hUsd, 0)}</td>
        <td class="r ${tone(c.change1hPct)}">${pct(c.change1hPct, 0)}</td>
        <td class="r">${c.smartDegenCount}</td>
        <td class="r">${c.rugRatio.toFixed(2)}</td>
        <td class="why">${pass ? '<span class="pill pill-pass">eligible</span>' : `<span class="pill pill-fail">blocked</span> ${esc(c.gateFailures.slice(0, 2).join(", "))}`}</td>
      </tr>`;
    })
    .join("");
}

function renderTrades(s) {
  const tb = $("tbl-trades").querySelector("tbody");
  $("e-trades").hidden = s.trades.length > 0;
  tb.innerHTML = s.trades
    .slice(0, 60)
    .map(
      (t) => `<tr>
        <td class="muted">${clock(t.at)}</td>
        <td class="${t.side === "buy" ? "flat" : tone(t.pnlUsd ?? 0)}">${t.side.toUpperCase()}</td>
        <td class="sym">${esc(t.symbol)}${t.mode === "live" ? "" : ' <span class="pill">paper</span>'}</td>
        <td class="r">${price(t.price)}</td>
        <td class="r">${usd(t.usd)}</td>
        <td class="r ${t.side === "sell" ? tone(t.pnlUsd) : "flat"}">${t.side === "sell" ? `${usd(t.pnlUsd)} · ${pct(t.pnlPct)}` : "—"}</td>
        <td class="why">${esc(t.reason)}</td>
      </tr>`,
    )
    .join("");
}

const logRow = (l) =>
  `<div class="log-row log-${l.level}"><span class="log-t">${clock(l.at)}</span><span class="log-m">${esc(l.msg)}${l.detail ? `<em>${esc(l.detail)}</em>` : ""}</span></div>`;

function renderLogs(logs) {
  const box = $("log");
  const atTop = box.scrollTop < 40; // newest sits at the top
  box.innerHTML = logs.slice().reverse().map(logRow).join("");
  if (atTop) box.scrollTop = 0;
}

// ── api ───────────────────────────────────────────────────────────────
async function post(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const banner = $("banner");
    banner.hidden = false;
    banner.dataset.kind = "error";
    banner.textContent = data.error || `Request failed (${res.status}).`;
  }
  return data;
}

function collectConfig() {
  const n = (id, fallback) => {
    const v = Number($(id).value);
    return Number.isFinite(v) ? v : fallback;
  };
  // Refine boxes are plain text, so tolerate how people actually type numbers ("50,000",
  // "1 500"). Blank stays blank — that is the "no filter" signal — and anything still
  // unreadable is dropped rather than sent as NaN.
  const refine = {};
  for (const k of REFINE)
    for (const side of ["Min", "Max"]) {
      const raw = $(`in-${k}${side}`).value.replace(/[\s,_]/g, "");
      const v = Number(raw);
      if (raw !== "" && Number.isFinite(v)) refine[k + side] = REFINE_K.has(k) ? v * 1000 : v;
    }
  return {
    chain: document.querySelector('#seg-chain button[aria-pressed="true"]')?.dataset.v ?? "sol",
    mode: document.querySelector('#seg-mode button[aria-pressed="true"]')?.dataset.v ?? "paper",
    intervalMinutes: n("in-interval", 15),
    prompt: $("in-prompt").value,
    riskPerTradePct: n("in-risk", 4),
    maxOpenPositions: n("in-maxpos", 5),
    fixedStrategy: $("in-fixed").checked,
    strategy: rules,
    maxDailyLossPct: n("in-daily", 15),
    timeStopMinutes: n("in-timestop", 180),
    cooldownMinutes: n("in-cooldown", 120),
    minPositionUsd: n("in-minpos", 0),
    gasReserveNative: n("in-gasres", 0),
    refine,
    slippagePct: n("in-slip", 20),
    paperStartEquityUsd: n("in-bankroll", 1000),
    walletAddress: $("in-wallet").value,
  };
}

// Every input saves itself on `change`, so there is no Save button — this line is the
// only thing telling the operator that happened. A failed save keeps `dirty` set, so the
// next tick of state cannot quietly overwrite the edit that did not land.
function saveState(text, failed = false) {
  const el = $("save-state");
  el.textContent = text;
  el.classList.toggle("err", failed);
}

async function save() {
  saveState("saving…");
  let r;
  try {
    r = await post("/api/config", collectConfig());
  } catch {
    saveState("not saved — server unreachable", true);
    return;
  }
  if (!r.config) {
    saveState("not saved", true);
    return;
  }
  dirty = false;
  fillForm(r.config, state ?? { liveReady: false });
  saveState(`saved ${clock(Date.now())}`);
}

// ── wiring ────────────────────────────────────────────────────────────
$("seg-chain").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  for (const x of e.currentTarget.children) x.setAttribute("aria-pressed", String(x === b));
  save();
});

$("seg-mode").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.v === "live" && state?.config.mode !== "live") {
    pendingMode = "live";
    $("in-confirm").value = "";
    $("btn-confirm-live").disabled = true;
    $("veil").hidden = false;
    $("in-confirm").focus();
    return;
  }
  for (const x of e.currentTarget.children) x.setAttribute("aria-pressed", String(x === b));
  save();
});

$("in-confirm").addEventListener("input", (e) => {
  $("btn-confirm-live").disabled = e.target.value.trim().toUpperCase() !== "LIVE";
});

function closeVeil() {
  pendingMode = null;
  $("veil").hidden = true;
  $("in-confirm").value = "";
  $("btn-confirm-live").disabled = true;
}

$("btn-cancel-live").addEventListener("click", closeVeil);

// Clicking the backdrop or pressing Escape are the two things people try first.
$("veil").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) closeVeil();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("veil").hidden) closeVeil();
});

$("btn-confirm-live").addEventListener("click", async () => {
  const wanted = pendingMode;
  closeVeil();
  if (wanted !== "live") return;
  for (const x of $("seg-mode").children) x.setAttribute("aria-pressed", String(x.dataset.v === "live"));
  await save();
});

$("in-interval").addEventListener("input", (e) => {
  $("lbl-interval").textContent = `${e.target.value} min`;
  dirty = true;
});
$("in-interval").addEventListener("change", save);

// ── exit builder ──────────────────────────────────────────────────────
// These rows are the exit plan every new position is opened with. Leave the list
// empty and the engine falls back to the stop / trail / ladder in data/config.json.
const RULE_FIELDS = {
  tp: [["at", "TP"], ["sell", "Sell"]],
  sl: [["at", "SL"], ["sell", "Sell"]],
  ttp: [["at", "TP"], ["dd", "DD"], ["sell", "Sell"]],
  tsl: [["dd", "SL DD"], ["sell", "Sell"]],
};
const RULE_DEFAULTS = {
  tp: { kind: "tp", at: 100, sell: 50 },
  sl: { kind: "sl", at: -50, sell: 100 },
  ttp: { kind: "ttp", at: 100, dd: 10, sell: 50 },
  tsl: { kind: "tsl", dd: 20, sell: 100 },
};
let rules = [];

function renderRules() {
  const box = $("rules");
  box.textContent = "";
  rules.forEach((r, i) => {
    const row = document.createElement("div");
    row.className = "rule";
    for (const [key, label] of RULE_FIELDS[r.kind] ?? []) {
      const cell = document.createElement("label");
      cell.className = "rule-cell";
      cell.innerHTML = `<span></span><input type="number" step="1" /><i>%</i>`;
      cell.firstChild.textContent = label;
      const input = cell.querySelector("input");
      input.value = r[key];
      input.addEventListener("input", () => (dirty = true));
      input.addEventListener("change", () => {
        r[key] = Number(input.value);
        save();
      });
      row.append(cell);
    }
    const del = document.createElement("button");
    del.type = "button";
    del.className = "rule-del";
    del.title = "remove rule";
    del.textContent = "✕";
    del.addEventListener("click", () => {
      rules.splice(i, 1);
      renderRules();
      save();
    });
    row.append(del);
    box.append(row);
  });

  // A ladder that never adds up to 100% leaves a stub of every position running forever.
  const sum = (kinds) => rules.filter((r) => kinds.includes(r.kind)).reduce((t, r) => t + (r.sell || 0), 0);
  const tp = sum(["tp", "ttp"]);
  const sl = sum(["sl", "tsl"]);
  $("rules-total").textContent = rules.length
    ? `Sells ${tp}% on the way up, ${sl}% on the way down. 100% each side exits fully.`
    : "No rules yet — every position opens on the stop, trail and ladder in data/config.json.";
  $("rules-total").classList.toggle("warn", rules.length > 0 && (tp < 100 || sl < 100));
}

function applyFixed() {
  const on = $("in-fixed").checked;
  $("strategy").hidden = !on;
  $("hint-dynamic").hidden = on;
}
$("in-fixed").addEventListener("change", () => {
  applyFixed();
  save();
});

$("btn-add-rule").addEventListener("click", () => {
  $("rule-menu").hidden = !$("rule-menu").hidden;
});

$("rule-menu").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  rules.push({ ...RULE_DEFAULTS[b.dataset.kind] });
  $("rule-menu").hidden = true;
  renderRules();
  save();
});

document.addEventListener("click", (e) => {
  if (!e.target.closest(".addwrap")) $("rule-menu").hidden = true;
});

$("in-prompt").addEventListener("input", () => (dirty = true));
$("in-prompt").addEventListener("blur", save);

for (const el of document.querySelectorAll('.fold input[type="number"], .fold input[type="text"]')) {
  el.addEventListener("input", () => (dirty = true));
  el.addEventListener("change", save);
}

$("presets").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  const text = PRESETS[b.dataset.preset];
  const box = $("in-prompt");
  box.value = box.value.trim() ? `${box.value.trim()}\n\n${text}` : text;
  save();
});

$("btn-run").addEventListener("click", async () => {
  if (state?.runState === "running") await post("/api/stop");
  else await post("/api/start", { config: collectConfig() });
});

$("btn-scan").addEventListener("click", () => post("/api/scan"));

/**
 * In-page confirmation. window.confirm() is auto-dismissed — it returns false without ever
 * painting — inside embedded browsers, which made every guarded action silently do nothing.
 */
function ask(text, okLabel) {
  const d = $("ask");
  $("ask-text").textContent = text;
  $("ask-ok").textContent = okLabel;
  d.returnValue = "";
  d.showModal();
  return new Promise((resolve) => d.addEventListener("close", () => resolve(d.returnValue === "ok"), { once: true }));
}

$("btn-reset").addEventListener("click", async () => {
  if (await ask("Clear all positions, trades and the equity history? This cannot be undone.", "Clear ledger"))
    post("/api/reset");
});

// No confirmation on the way out: getting out fast is the point, and the sell is one click.
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-close]");
  if (!b) return;
  // A live sell is a swap plus a price read — several seconds. Say so, and don't let it be
  // clicked twice; the row disappears on the snapshot that follows.
  b.disabled = true;
  b.textContent = "Closing…";
  await post("/api/close", { id: b.dataset.close, percent: 100 });
  if (b.isConnected) {
    b.disabled = false;
    b.textContent = "Close";
  }
});

// ── stream ────────────────────────────────────────────────────────────
function connect() {
  const es = new EventSource("/api/stream");
  es.addEventListener("snapshot", (e) => render(JSON.parse(e.data)));
  // Snapshots only land on scan/monitor ticks, so paint log lines the moment they arrive.
  es.addEventListener("log", (e) => {
    const box = $("log");
    const atTop = box.scrollTop < 40;
    box.insertAdjacentHTML("afterbegin", logRow(JSON.parse(e.data)));
    while (box.children.length > 200) box.lastElementChild?.remove();
    if (atTop) box.scrollTop = 0;
  });
  es.onerror = () => {
    es.close();
    setTimeout(connect, 3000);
  };
}

connect();
setInterval(() => {
  if (!state) return;
  $("s-next").textContent =
    state.runState === "running" && state.cycle.nextRunAt
      ? countdown(state.cycle.nextRunAt - Date.now())
      : "—";
}, 1000);
