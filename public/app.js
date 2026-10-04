const $ = (id) => document.getElementById(id);
const tokenUrl = (chain, address) => `https://gmgn.ai/${chain || "sol"}/token/${address}`;

const PRESETS = {
  // What the system prompt used to assert on its own. It is a preset now, not a default:
  // the analyst's prompt states facts and limits, this box states policy.
  house:
    "Favour several independent smart-money wallets accumulating, volume rising against a market cap that has not caught up, liquidity deep enough to exit at size, a dev who has closed out, and a holder count still growing. Avoid a move already extended past roughly +150% in an hour, volume carried by one wallet, and a single holder cluster that could end the trade on its own. Prefer no trade to a marginal one — an empty cycle is a good outcome.",
  smart:
    "Only enter when at least 3 distinct smart-money wallets have bought in the last hour and none of them have started selling. Check the top holders before committing. If the smart money is already distributing, skip it no matter how good the chart looks.",
  patient:
    "Be selective. At most one new position per cycle, and only when conviction is genuinely above 70. Prefer tokens that have been trading for a few hours with steady volume over anything that just launched. A cycle with no entry is a good cycle.",
  momentum:
    "Look for early momentum: volume rising against a market cap that has not caught up yet, buys clearly outnumbering sells over the last hour, holder count still climbing. Avoid anything already up more than 120% in an hour — that move is not yours to catch.",
  defensive:
    "Capital preservation first. Require deep liquidity relative to market cap, a dev who has fully exited, and top-10 concentration under 20%. Size down to a 0.6 multiplier on everything. Ask to exit early at the first sign of smart money distributing.",
};

const FLOORS = { sol: 3, bsc: 5, base: 5, eth: 25, robinhood: 5 };
// Fee is denominated in whatever the chain pays gas in — mirrors NATIVE in src/trading/core/config.ts.
const NATIVE_SYMBOL = { sol: "SOL", bsc: "BNB", base: "ETH", eth: "ETH", robinhood: "ETH" };

// Refine rows — must match REFINE_FIELDS in src/trading/core/config.ts. Blank = no filter.
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

/** Largest unit only — 45m, 3h, 2d. For places where the order of magnitude is the point. */
const dur1 = (ms) => {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
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
    // Back to the marks' initial state, not left as they were: this branch is what a cleared
    // ledger renders, and a high-water mark from the ledger before it reads as a live figure.
    $("mk-high").textContent = "—";
    $("mk-low").textContent = "—";
    return;
  }

  // The stored series is throttled to one point a minute and stops entirely while nothing
  // is open, so the curve ends at a live reading — otherwise the dot lags the big number.
  // Not while stopped: nothing reprices then, and a live point at Date.now() only stretches
  // the time axis until the real history is a sliver on the left.
  const live = state?.runState === "running" || points.length < 2;
  const series = live ? [...points, { at: Date.now(), equity: stats.equity }] : points;
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
  // Ends short of W: the end dot sits on the last x, and the viewBox clips anything past W.
  const R = W - 6;
  const x = (p) => ((p.at - t0) / span) * R;

  const line = series.map((p, i) => `${i ? "L" : "M"}${x(p).toFixed(1)},${y(p.equity).toFixed(1)}`).join("");
  const area = `${line}L${R},${H}L0,${H}Z`;
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
    <path d="M${R},${y(vals[vals.length - 1]).toFixed(1)}h0" stroke="${stroke}" stroke-width="7" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
  `;

  $("mk-high").textContent = usd(hi);
  $("mk-low").textContent = usd(lo);
  $("mk-span").textContent = `${points.length} soundings over ${dur(span)}`;
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
  runBtn.textContent = { running: "Stop agent", halted: "Resume agent" }[s.runState] ?? "Start agent";
  runBtn.dataset.state = s.runState;

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
      : `Live mode is selected but not armed — ${s.liveReason}.`;
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
  renderWatchlist(s);
  renderCandidates(s);
  renderTrades(s);
  renderLogs(s.logs);
}

function fillForm(c, s) {
  for (const b of document.querySelectorAll("#seg-mode button"))
    b.setAttribute("aria-pressed", String(b.dataset.v === c.mode));

  $("in-interval").value = c.intervalMinutes;
  $("lbl-interval").textContent = `${c.intervalMinutes} min`;
  $("lbl-monitor").textContent = c.monitorSeconds;
  $("in-prompt").value = c.prompt;
  $("mode-hint").textContent =
    c.mode === "live"
      ? "Live mode places real swaps from the wallet above, on its chain."
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
  // Per-chain, and the box only ever shows the chain in play. `sizeChain` is what the box is
  // currently holding a value *for* — on a chain switch it still names the old one, so the
  // number the operator typed lands back on the chain they typed it for.
  sizes = { ...c.positionSizeNative };
  sizeChain = c.chain;
  set("in-size", sizes[c.chain] ?? "");
  set("in-maxpos", c.maxOpenPositions);
  set("in-daily", c.maxDailyLossPct);
  set("in-timestop", c.timeStopMinutes);
  set("in-cooldown", c.cooldownMinutes);
  // 0 means "per-chain default" — show that as an empty box with an `auto` placeholder
  // rather than a 0 the operator has to decode.
  set("in-gasres", c.gasReserveNative || "");
  for (const k of REFINE)
    for (const side of ["Min", "Max"]) {
      const v = c.refine?.[k + side];
      set(`in-${k}${side}`, v === undefined ? "" : REFINE_K.has(k) ? v / 1000 : v);
    }
  set("in-slip", c.slippagePct || "");
  set("in-bankroll", c.paperStartEquityUsd);
  fillWallets(c);

  // Make the floor visible before it silently eats every candidate.
  const sym = NATIVE_SYMBOL[c.chain] ?? "";
  $("lbl-fee-unit").textContent = sym;
  $("lbl-size-unit").textContent = sym;

  // Whether the fixed size clears the floor needs the native price, which the browser does
  // not have — `start()` refuses with the exact numbers if it doesn't.
  $("lbl-floor").textContent = usd(FLOORS[c.chain] || 5);
  $("lbl-ceiling").textContent = sizes[c.chain] ? `${sizes[c.chain]} ${sym}` : `— (no size set for ${sym})`;
  $("live-status").textContent = s.liveReady
    ? "Armed. Live swaps will execute without further confirmation."
    : `Not armed. Live entries will be refused — ${s.liveReason}.`;
}

/**
 * A position's market cap at some price of its own. Supply is fixed on a graduated token, so
 * scaling the entry market cap by price/entryPrice is exact; positions opened before that was
 * recorded fall back to the price itself, which is what this column used to show.
 */
const mcapAt = (p, atPrice) =>
  p.entryMarketCapUsd && p.entryPrice > 0
    ? usd((p.entryMarketCapUsd / p.entryPrice) * atPrice, 0)
    : price(atPrice);

function renderPositions(s) {
  const tb = $("tbl-positions").querySelector("tbody");
  $("c-pos").textContent = s.positions.length;
  $("e-pos").hidden = s.positions.length > 0;
  tb.innerHTML = s.positions
    .map((p) => {
      const pl = p.entryPrice > 0 ? ((p.lastPrice - p.entryPrice) / p.entryPrice) * 100 : 0;
      // Green means "worth selling", not "above the entry price": the round trip's fees are
      // already spent and the number that clears them is the position's own, since the flat
      // chain fee is a bigger share of a small one. The printed % is still the price move.
      const be = p.breakevenPct ?? 0;
      const value = p.qty * p.lastPrice;
      const peak = p.entryPrice > 0 ? ((p.peakPrice - p.entryPrice) / p.entryPrice) * 100 : 0;
      // A position carries the exit plan it was opened with, so show that plan rather than a
      // rung count: with the analyst writing one per token, no two rows need be alike.
      const pill = (r, done, cls = "") =>
        `<span class="pill${done ? " pill-done" : ""}${cls}" title="${esc(ruleTitle(r))}">${esc(ruleLabel(r))}</span>`;
      const plan = (p.strategy ?? []).map((r, i) => pill(r, p.filledRungs.includes(i))).join("");
      // A position opened with no rule set still has exits — it runs the config's stop, ladder
      // and trail (`evaluateExit`'s legacy branch). Show those too, dimmed, rather than the
      // bare "holding" that made a live plan look like no plan at all. That happens whenever
      // Fixed strategy is on with an empty rule list, or the analyst omitted `strategy`.
      const fallback = [
        pill({ kind: "sl", at: -(p.stopLossPct || s.config.stopLossPct), sell: 100 }, false, " pill-default"),
        ...(s.config.takeProfit ?? []).map((r, i) => pill({ kind: "tp", ...r }, p.filledRungs.includes(i), " pill-default")),
        s.config.trailArmPct
          ? pill(
              { kind: "ttp", at: s.config.trailArmPct, dd: s.config.trailGivebackPct, sell: 100 },
              false,
              p.trailArmed ? " pill-armed" : " pill-default",
            )
          : "",
      ].join("");
      const state = plan || fallback || `<span class="pill">holding</span>`;
      return `<tr>
        <td class="sym"><a class="linkish" href="${esc(tokenUrl(p.chain, p.address))}" target="_blank" rel="noopener">${esc(p.symbol)}</a>
          <small title="${esc(p.thesis)}">${esc(p.thesis).slice(0, 46)}${p.thesis.length > 46 ? "…" : ""}</small></td>
        <td class="r" title="${esc(`${price(p.entryPrice)} → ${price(p.lastPrice)}`)}">${usd(value)}</td>
        <td class="r">${mcapAt(p, p.entryPrice)}</td>
        <td class="r">${mcapAt(p, p.lastPrice)}</td>
        <td class="r ${tone(pl - be)}" title="${esc(be ? `break-even at +${be.toFixed(1)}% — fees on both legs` : "")}">${pct(pl)}</td>
        <td class="r muted">${pct(peak)}</td>
        <td class="r muted">${dur(Date.now() - p.openedAt)}</td>
        <td class="plan">${state}</td>
        <td class="r"><button class="btn btn-quiet" data-close="${p.id}">Close</button></td>
      </tr>`;
    })
    .join("");
}

/** What the analyst is watching before it buys: its note, and the price since it was added. */
function renderWatchlist(s) {
  const rows = s.watchlist || [];
  const r = s.watchRules;
  const now = Date.now();
  $("c-watch").textContent = `${rows.length}/${r.max}`;
  $("watch-rules").textContent = `checked every ${r.everyMinutes}m · buyable after ${r.minMinutes}m · dropped after ${r.ttlMinutes}m`;
  $("e-watch").hidden = rows.length > 0;
  $("tbl-watch").querySelector("tbody").innerHTML = rows
    .map((w) => {
      const c = w.c;
      const first = w.prices[0]?.price || 0;
      const chg = first > 0 ? (c.priceUsd / first - 1) * 100 : 0;
      // Supply is fixed, so the market cap at the add is the current one scaled back by price.
      const mcThen = first > 0 && c.priceUsd > 0 ? usd((c.marketCapUsd / c.priceUsd) * first, 0) : "—";
      const ripe = now - w.addedAt >= r.minMinutes * 60000;
      const trail = w.prices.map((p) => `${clock(p.at)}  ${price(p.price)}`).join("\n");
      return `<tr>
        <td class="sym"><a class="linkish" href="${esc(tokenUrl(w.chain, c.address))}" target="_blank" rel="noopener">${esc(c.symbol)}</a>
          <small title="${esc(w.note)}">${esc(w.note)}</small></td>
        <td class="r muted">${mcThen}</td>
        <td class="r">${usd(c.marketCapUsd, 0)}</td>
        <td class="r ${tone(chg)}" title="${esc(trail)}">${pct(chg)}</td>
        <td class="r muted">${dur(now - w.addedAt)}</td>
        <td class="r muted">${dur(w.addedAt + r.ttlMinutes * 60000 - now)}</td>
        <td><span class="pill${ripe ? " pill-pass" : ""}" title="${ripe ? "watched long enough — the analyst may buy it at the next check" : `not buyable until it has been watched ${r.minMinutes}m`}">${ripe ? "buyable" : "watching"}</span></td>
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

/** One labelled figure inside a sounding card. `title` is the long form, on hover. */
const kv = (k, v, title, cls = "") =>
  `<div class="kv" title="${esc(title)}"><span class="kv-k">${k}</span><span class="kv-v ${cls}">${v}</span></div>`;

/**
 * `dev_team_hold_rate` is a ratio, and null when the row's feed does not carry it. A blank is
 * printed for that: 0% would claim the deployer has sold out, which is the opposite reading.
 */
const devHolds = (c) =>
  c.devHoldRate === null || c.devHoldRate === undefined
    ? '<span class="kv-na">—</span>'
    : `${(c.devHoldRate * 100).toFixed(c.devHoldRate > 0 && c.devHoldRate < 0.1 ? 1 : 0)}%`;

/** Buys/sells over the last five minutes. Blank when the 5m feed did not carry the row. */
const flow5m = (c) =>
  c.buys5m === null || c.buys5m === undefined
    ? '<span class="kv-na">—</span>'
    : `<span class="up">${c.buys5m}</span><span class="kv-sep">/</span><span class="down">${c.sells5m ?? "—"}</span>`;

/** Which GMGN list surfaced the token, in words a non-trader can read; the detail is on hover. */
const FEED_TAG = {
  "trending-1h": ["trending 1h", "on GMGN's top-traded list for the last hour"],
  "trending-5m": ["trending 5m", "on GMGN's top-traded list for the last five minutes — activity right now"],
  graduated: ["graduated", "finished its launchpad bonding curve and moved to a real DEX pool"],
};
const feedTags = (source) => {
  const tags = (source || "")
    .split("+")
    .filter(Boolean)
    .map((f) => {
      const [label, title] = FEED_TAG[f] ?? [f, f];
      return `<span class="feed-tag" title="${esc(title)}">${esc(label)}</span>`;
    });
  return tags.length ? `<span class="sounding-k">found in</span>${tags.join("")}` : "";
};

// The card shows the five figures the old table did. The scan collects more — buys/sells,
// net buy, dev hold rate, insider and bundler rates, fees, 1m change — and the analyst gets
// all of it in the brief; it is only kept off the dashboard to keep a row scannable.

function renderCandidates(s) {
  const rows = s.cycle.lastCandidates || [];
  const box = $("list-candidates");
  $("c-cand").textContent = rows.length;
  $("e-cand").hidden = rows.length > 0;
  box.innerHTML = rows
    .map((c) => {
      const pass = !c.gateFailures.length;
      const verdict = !pass
        ? '<span class="status is-fail" title="failed a safety check (reason below) — never shown to the AI, cannot be bought">blocked</span>'
        : c.analystNote === "sent"
          ? '<span class="status is-pass" title="passed the safety checks and was shown to the AI analyst this cycle. Reviewed is not bought — the analyst first has to put it on the watchlist">reviewed</span>'
          : c.analystNote === "on the watchlist"
            ? '<span class="status is-pass" title="already on the watchlist — the analyst follows it there instead of re-reading it here">watched</span>'
            : '<span class="status" title="passed the safety checks but was not shown to the AI this cycle — reason below">skipped</span>';
      // "sent" already says it went to the analyst; the note only carries what the pill can't.
      const note = pass ? (c.analystNote === "sent" ? "" : (c.analystNote ?? "")) : c.gateFailures.join(", ");
      // Age reads on its own rather than buried in the meta line: on a memecoin it is half the trade.
      return `<article class="sounding${pass ? "" : " is-blocked"}">
        <header class="sounding-head">
          <div class="sounding-id">
            <div class="sounding-title">
              <a class="sounding-sym" href="${esc(tokenUrl(s.config.chain, c.address))}" target="_blank" rel="noopener">${esc(c.symbol)}</a>
              <span class="sounding-age" title="time since the token was created">${dur1(c.ageMinutes * 60000)}</span>
              ${c.launchpad ? `<span class="sounding-pad" title="launchpad the token was created on">${esc(c.launchpad)}</span>` : ""}
              ${verdict}
            </div>
            <div class="sounding-sub">${feedTags(c.source)}</div>
          </div>
          <span class="sounding-score" title="quality score, 0-100: smart-money buyers, momentum, liquidity, turnover, rug risk, age. Higher ranks first — it only orders the list, it blocks nothing"><span class="sounding-k">score</span>${
            pass ? `<b>${c.score}</b><i style="--w:${c.score}%"></i>` : "<b>—</b>"
          }</span>
        </header>
        ${note ? `<p class="sounding-note${pass ? "" : " is-fail"}">${esc(note)}</p>` : ""}
        <div class="sounding-grid">
          ${kv("mcap", usd(c.marketCapUsd, 0), "market cap")}
          ${kv("liq", usd(c.liquidityUsd, 0), "pool liquidity — what you can actually exit into")}
          ${kv("volume", usd(c.volume1hUsd, 0), "trading volume over the row's own window: 1h on the rank feeds, 24h on graduated")}
          ${kv("tx 5m", flow5m(c), "buy/sell transactions in the last five minutes (counts, not dollars), from the 5m feed. A token trading at a steady rate prints about a twelfth of its hourly count here — more is accelerating, less is a move already past. Blank means the 5m feed did not carry this row")}
          ${kv("1h", pct(c.change1hPct, 0), "price change over the last hour", tone(c.change1hPct))}
          ${kv("top 10", `${(c.top10HolderRate * 100).toFixed(0)}%`, "share of supply held by the ten largest wallets")}
          ${kv("dev holds", devHolds(c), "share of supply the deployer still holds. A blank means this row's feed does not report it — not that the dev is out")}
          ${kv("rug", c.rugRatio.toFixed(2), "GMGN rug-pull risk score, 0-1. Amber from 0.3, GMGN's published Skip line", c.rugRatio >= 0.3 ? "warn" : "")}
        </div>
      </article>`;
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
        <td class="sym"><a class="linkish" href="${esc(tokenUrl(t.chain, t.address))}" target="_blank" rel="noopener">${esc(t.symbol)}</a>${t.mode === "live" ? "" : ' <span class="pill">paper</span>'}</td>
        <td class="r">${price(t.price)}</td>
        <td class="r">${usd(t.usd)}</td>
        <td class="r ${t.side === "sell" ? tone(t.pnlUsd) : "flat"}" title="${esc(peakNote(t))}">${t.side === "sell" ? `${usd(t.pnlUsd)} · ${pct(t.pnlPct)}` : "—"}</td>
        <td class="why">${esc(t.reason)}</td>
      </tr>`,
    )
    .join("");
}

/**
 * Hover text on a sell's PnL: how far the position ever got, against what it booked. The peak is
 * gross of fees and the PnL is net, so they are not the same scale — the point is only whether a
 * higher exit was ever on the table. Blank on trades booked before the field existed.
 */
const peakNote = (t) =>
  t.side !== "sell" || t.peakPct === undefined
    ? ""
    : `peaked at ${pct(t.peakPct)} from entry before this exit (gross of fees; the PnL beside it is net)`;

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

let sizes = {};
let sizeChain = "sol";

// [{chain, address, native, tokens}] bound to the API key; null until /api/wallets answers
let wallets = null;
let walletNote = "";
let walletAt = 0;
let gasDefaults = {}; // GAS_RESERVE per chain, from the server rather than mirrored here
let walletHtml = "";

async function loadWallets(fresh = false) {
  const r = await fetch(`/api/wallets${fresh ? "?fresh=1" : ""}`)
    .then((x) => x.json())
    .catch(() => ({ error: "server unreachable" }));
  wallets = r.wallets ?? [];
  walletNote = r.error ? `could not read wallets — ${r.error}` : "";
  walletAt = r.at ?? 0;
  gasDefaults = r.gasReserve ?? gasDefaults;
  if (state) fillWallets(state.config);
}

const shortAddr = (a) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
const amt = (n) => (n === 0 ? "0" : n < 0.001 ? n.toPrecision(2) : String(+n.toFixed(4)));
// The picker's order, and the chains that still get a row when no wallet is bound on them.
const CHAIN_LABEL = { sol: "SOL", bsc: "BSC", base: "BASE", eth: "ETH", robinhood: "HOOD" };
const chainLabel = (ch) => CHAIN_LABEL[ch] ?? String(ch).toUpperCase();

/**
 * What this wallet could do on its own chain with the settings as they stand — the same
 * arithmetic `syncLiveBalance` sizes with: balance less the gas reserve, in whole buys.
 */
function walletStatus(w, c) {
  if (wallets === null && w.native === undefined) return ["haze", "reading wallets…"];
  if (!w.address) return ["haze", "no wallet on this chain — paper only"];
  if (w.native === undefined) return ["ebb", "not bound to this API key"];
  if (w.native === null) return ["haze", "GMGN reports no balance on this chain"];
  const sym = NATIVE_SYMBOL[w.chain] ?? "";
  if (!(w.native > 0)) return ["ebb", `empty — no ${sym} to trade or pay gas`];
  const size = c.positionSizeNative?.[w.chain];
  if (!size) return ["haze", `no size per trade set for ${sym}`];
  const buys = Math.floor((w.native - (c.gasReserveNative || gasDefaults[w.chain] || 0)) / size);
  return buys > 0
    ? ["flood", `${buys} buy${buys > 1 ? "s" : ""} at ${size} ${sym}, gas held back`]
    : ["lamp", `short of one ${size} ${sym} buy plus gas`];
}

function walletRow(w, c) {
  const [tone, note] = walletStatus(w, c);
  const others = (w.tokens ?? []).map((t) => `${t.symbol} ${amt(t.balance)}`).join(" · ");
  const bal = typeof w.native === "number" ? `<b>${esc(amt(w.native))}</b> ${esc(NATIVE_SYMBOL[w.chain] ?? "")}` : "—";
  return (
    `<span class="w-chain">${esc(chainLabel(w.chain))}</span>` +
    `<span class="w-main"><span class="w-addr">${esc(w.address ? shortAddr(w.address) : "no wallet")}</span><span class="w-note" data-tone="${tone}">${esc(note)}</span></span>` +
    `<span class="w-bal">${bal}${others ? `<small>${esc(others)}</small>` : ""}</span>`
  );
}

/**
 * The chain picker: one row per (chain, address), value `chain|address`. A chain with no bound
 * wallet still gets a wallet-less row so paper can trade it; live cannot, so that row is disabled
 * there. The saved wallet stays listed even when GMGN does not return it, so a failed read never
 * blanks it.
 */
function fillWallets(c) {
  const order = Object.keys(CHAIN_LABEL);
  const list =
    wallets === null
      ? []
      : order.flatMap((ch) => {
          const bound = wallets.filter((w) => w.chain === ch);
          return bound.length ? bound : [{ chain: ch, address: "" }];
        });
  const same = (w) => w.address.toLowerCase() === c.walletAddress.toLowerCase();
  let pick = list.find((w) => w.chain === c.chain && same(w));
  if (!pick) {
    pick = { chain: c.chain, address: c.walletAddress };
    if (c.walletAddress && wallets !== null) list.unshift(pick);
  }
  const value = `${pick.chain}|${pick.address}`;
  // Always, even when nothing below changed: a refused save has to put the old pick back.
  $("in-wallet").value = value;

  const trigger = walletRow(pick, c) + `<span class="wallet-caret" aria-hidden="true"></span>`;
  const options = list
    .map((w) => {
      const v = `${w.chain}|${w.address}`;
      const off = c.mode === "live" && !w.address ? " disabled" : "";
      return `<button type="button" role="option" aria-selected="${v === value}" data-v="${esc(v)}" title="${esc(w.address)}"${off}>${walletRow(w, c)}</button>`;
    })
    .join("");
  const asof = walletNote || (walletAt ? `balances as of ${clock(walletAt)}` : "—");

  // Rebuilt only when something shows differently, or every state push would steal focus from an open list.
  const html = trigger + options + asof;
  if (html === walletHtml) return;
  walletHtml = html;
  $("in-wallet").innerHTML = trigger;
  $("in-wallet").title = pick?.address ?? "";
  $("wallet-options").innerHTML = options;
  $("wallet-asof").textContent = asof;
}

function walletMenu(open) {
  $("wallet-menu").hidden = !open;
  $("in-wallet").setAttribute("aria-expanded", String(open));
  if (open) ($("wallet-options").querySelector('[aria-selected="true"]') ?? $("wallet-options").querySelector("button"))?.focus();
}

/** The stored per-chain sizes with the box's current value written back onto its own chain. */
function sizesWithInput() {
  const out = { ...sizes };
  const raw = $("in-size").value.trim();
  const v = Number(raw);
  if (raw === "" || !Number.isFinite(v) || v <= 0) delete out[sizeChain];
  else out[sizeChain] = v;
  return out;
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
  // The wallet picker is the chain picker. Empty before its first render — sent as no chain, not a change.
  const [chain, walletAddress = ""] = $("in-wallet").value.split("|");
  return {
    chain: chain || undefined,
    mode: document.querySelector('#seg-mode button[aria-pressed="true"]')?.dataset.v ?? "paper",
    intervalMinutes: n("in-interval", 15),
    prompt: $("in-prompt").value,
    positionSizeNative: sizesWithInput(),
    maxOpenPositions: n("in-maxpos", 5),
    fixedStrategy: $("in-fixed").checked,
    strategy: rules,
    maxDailyLossPct: n("in-daily", 15),
    timeStopMinutes: n("in-timestop", 180),
    cooldownMinutes: n("in-cooldown", 120),
    gasReserveNative: n("in-gasres", 0),
    refine,
    slippagePct: n("in-slip", 0),
    paperStartEquityUsd: n("in-bankroll", 1000),
    walletAddress,
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
    // Refused, not lost in transit: put the form back to what the server holds — the banner says why.
    saveState("not saved", true);
    dirty = false;
    if (state) fillForm(state.config, state);
    return;
  }
  dirty = false;
  fillForm(r.config, state ?? { liveReady: false, liveReason: "state not loaded yet" });
  saveState(`saved ${clock(Date.now())}`);
}

// ── wiring ────────────────────────────────────────────────────────────
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

$("in-wallet").addEventListener("click", () => walletMenu($("wallet-menu").hidden));

$("wallet-options").addEventListener("click", (e) => {
  const b = e.target.closest('[role="option"]');
  if (!b || b.disabled) return;
  $("in-wallet").value = b.dataset.v;
  walletMenu(false);
  $("in-wallet").focus();
  save();
});

$("wallet-menu").addEventListener("keydown", (e) => {
  const items = [...$("wallet-menu").querySelectorAll("button:not(:disabled)")];
  const i = items.indexOf(document.activeElement);
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  } else if (e.key === "Escape") {
    walletMenu(false);
    $("in-wallet").focus();
  }
});

$("btn-wallet-refresh").addEventListener("click", () => {
  $("wallet-asof").textContent = "refreshing…";
  walletHtml = "";
  loadWallets(true);
});

document.addEventListener("click", (e) => {
  if (!$("wallet-menu").hidden && !e.target.closest(".wallet-wrap")) walletMenu(false);
});
loadWallets();

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
