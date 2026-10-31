import type { Config } from "./config.ts";
import { getRun, status } from "./control.ts";
import { db } from "./db.ts";
import { tokenStatus } from "./entry.ts";
import { POLL_MS } from "./exit.ts";
import * as jup from "./jupiter/client.ts";
import { lossDay, openPositions, paperCash } from "./trade.ts";

/**
 * What the dashboard shows, read off the ledger. Reads only; every number the dashboard prints
 * comes from here, so it never disagrees with what the loops did. Times are epoch ms, money USD.
 * "Today" and the chart's days are the viewer's (`tz`, an IANA zone the browser sends); only the
 * daily loss limit runs on the engine's day, 00:00 UTC.
 */

const DAY = 86_400_000;

// ── days in the viewer's zone ─────────────────────────────────────────

const zones = new Map<string, Intl.DateTimeFormat>(); // bounded: only valid IANA names get in

/** How far `tz` runs ahead of UTC at `at`, in ms. Throws a RangeError on an unknown zone. */
function offset(at: number, tz: string): number {
  let f = zones.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
    });
    zones.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - (at - (at % 1000));
}

/** The browser's zone if it is one, else the server's. */
export function zone(tz: string | null): string {
  try {
    if (tz) return (offset(0, tz), tz);
  } catch {}
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Epoch ms of the midnight that starts `at`'s day in `tz`, DST included. */
export function dayStart(at: number, tz: string): number {
  const local = at + offset(at, tz);
  const midnight = local - (local % DAY);
  return midnight - offset(midnight - offset(at, tz), tz);
}
const shortAddr = (a: string) => (a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);
const one = <T>(sql: string, ...p: (string | number)[]) => db.prepare(sql).get(...p) as T | undefined;
const all = <T>(sql: string, ...p: (string | number)[]) => db.prepare(sql).all(...p) as T[];
const symbolOf = (address: string) =>
  one<{ symbol: string | null }>("select symbol from tokens where address = ?", address)?.symbol ?? null;

// ── positions ─────────────────────────────────────────────────────────

export function positions(cfg: Config, now: number) {
  return openPositions().map((p) => {
    const price = p.last_price_usd ?? p.entry_price_usd;
    const qty = Number(p.qty) / 10 ** p.decimals;
    const share = Number(p.qty) / Number(p.original_qty);
    const realised = one<{ s: number }>("select coalesce(sum(pnl_usd), 0) s from trades where position_id = ? and side = 'sell'", p.id)!.s;
    const openPnl = qty * price - p.cost_usd * share;
    const heldMin = Math.floor((now - p.opened_at) / 60_000);
    return {
      id: p.id,
      token: p.token,
      symbol: p.symbol,
      mint: shortAddr(p.token),
      mode: p.mode,
      openedAt: p.opened_at,
      heldMin,
      pnlPct: (price / p.entry_price_usd - 1) * 100,
      pnlUsd: realised + openPnl,
      openPnl,
      peakPct: ((p.peak_price_usd ?? price) / p.entry_price_usd - 1) * 100,
      price,
      entry: p.entry_price_usd,
      heldPct: share * 100,
      qtyLeft: qty,
      valueUsd: qty * price,
      timeLeftMin: Math.max(0, cfg.timeStopMinutes - heldMin),
      rules: all<{ kind: string; at_pct: number; sell_pct: number; filled_at: number | null }>(
        "select kind, at_pct, sell_pct, filled_at from exit_rules where position_id = ? order by seq",
        p.id,
      ).map((r) => ({ kind: r.kind, at: r.at_pct, sell: r.sell_pct, filled: r.filled_at !== null })),
    };
  });
}

// ── overview ──────────────────────────────────────────────────────────

type EquityRow = { at: number; e: number; c: number };

/** Paper cash is derived; live cash is the wallet's, as the last live equity sample read it. */
function cashNow(cfg: Config): number {
  if (cfg.mode === "paper") return paperCash(cfg);
  return one<{ c: number }>("select cash_usd c from equity where mode = 'live' order by at desc limit 1")?.c ?? 0;
}

/** Equity rows are per mode: a switch starts a fresh curve, never one carried over from the other book. */
function equityAt(mode: string, midnight: number): number | null {
  return (
    one<{ e: number }>("select equity_usd e from equity where mode = ? and at >= ? order by at limit 1", mode, midnight) ??
    one<{ e: number }>("select equity_usd e from equity where mode = ? and at < ? order by at desc limit 1", mode, midnight)
  )?.e ?? null;
}

export function overview(cfg: Config, range: string, now: number, tz: string) {
  const pos = positions(cfg, now);
  const held = pos.filter((p) => p.mode === cfg.mode).reduce((t, p) => t + p.valueUsd, 0);
  const cash = cashNow(cfg);
  const equity = cash + held;
  const first = one<EquityRow>("select at, equity_usd e from equity where mode = ? order by at limit 1", cfg.mode);
  const start = first?.e ?? (cfg.mode === "paper" ? cfg.paperStartUsd : equity);
  const midnight = dayStart(now, tz);
  const todayStart = equityAt(cfg.mode, midnight) ?? equity;
  const lossStart = equityAt(cfg.mode, lossDay(now)) ?? equity; // the engine's day, so the meter matches the pause
  const today = one<{ pnl: number; n: number }>(
    "select coalesce(sum(pnl_usd), 0) pnl, count(*) n from trades where side = 'sell' and at >= ?",
    midnight,
  )!;

  const closed = all<{ pnl: number }>(
    `select coalesce(sum(t.pnl_usd), 0) pnl from positions p join trades t on t.position_id = p.id
     where p.status = 'closed' group by p.id`,
  );

  // Max drawdown off every equity sample: the deepest fall from a running peak.
  let peak = 0;
  let dd = { pct: 0, usd: 0, at: 0 };
  for (const r of all<EquityRow>("select at, equity_usd e from equity where mode = ? order by at", cfg.mode)) {
    peak = Math.max(peak, r.e);
    const pct = peak > 0 ? (r.e / peak - 1) * 100 : 0;
    if (pct < dd.pct) dd = { pct, usd: r.e - peak, at: r.at };
  }

  return {
    mode: cfg.mode,
    equity,
    cash,
    held,
    sinceStart: { usd: equity - start, pct: start > 0 ? (equity / start - 1) * 100 : 0, at: first?.at ?? now },
    today: {
      usd: equity - todayStart,
      pct: todayStart > 0 ? (equity / todayStart - 1) * 100 : 0,
      realised: today.pnl,
      sells: today.n,
      open: pos.reduce((t, p) => t + p.openPnl, 0),
      dayStart: lossStart,
      limitUsd: (lossStart * cfg.maxDailyLossPct) / 100,
      usedUsd: Math.max(0, lossStart - equity),
    },
    slots: { used: pos.length, max: cfg.maxOpenPositions },
    winRate: { won: closed.filter((c) => c.pnl > 0).length, closed: closed.length },
    drawdown: dd,
    chart: chart(range, now, tz, cfg.mode),
    positions: pos,
    fills: fills(midnight),
  };
}

function chart(range: string, now: number, tz: string, mode: string) {
  const today = dayStart(now, tz);
  const firstAt =
    one<{ at: number }>("select min(at) at from (select min(at) at from trades union all select min(at) at from equity)")?.at ?? now;
  const days = range === "30d" ? 30 : range === "all" ? Math.min(120, Math.max(1, Math.round((today - dayStart(firstAt, tz)) / DAY) + 1)) : 7;
  // Midday of each day back from today: a DST hour never moves it off its date.
  const pnl = Array.from({ length: days }, (_, i) => ({ at: dayStart(today - (days - 1 - i) * DAY + DAY / 2, tz), pnl: 0, sells: 0 }));
  const from = pnl[0]!.at;
  let d = 0;
  for (const s of all<{ at: number; pnl: number | null }>("select at, pnl_usd pnl from trades where side = 'sell' and at >= ? order by at", from)) {
    while (d + 1 < days && s.at >= pnl[d + 1]!.at) d++;
    pnl[d]!.pnl += s.pnl ?? 0;
    pnl[d]!.sells++;
  }
  // Equity samples arrive once a minute; a chart needs a few hundred points, not thousands.
  const rows = all<EquityRow>("select at, equity_usd e from equity where mode = ? and at >= ? order by at", mode, from);
  const step = Math.max(1, Math.ceil(rows.length / 240));
  const equity = rows.filter((_, i) => i % step === 0 || i === rows.length - 1).map((r) => ({ at: r.at, e: r.e }));
  return { range, from, pnl, equity };
}

function fills(since: number) {
  return all<Record<string, any>>(
    `select t.id, t.at, t.side, t.qty, t.usd, t.pnl_usd, t.reason, p.original_qty, coalesce(k.symbol, substr(p.token, 1, 6)) symbol,
       r.at_pct rule_at
     from trades t join positions p on p.id = t.position_id join tokens k on k.address = p.token
     left join exit_rules r on r.id = t.exit_rule_id
     where t.at >= ? order by t.at desc, t.id desc limit 200`,
    since,
  ).map((t) => ({
    at: t.at,
    side: t.side,
    symbol: t.symbol,
    soldPct: t.side === "sell" ? (Number(t.qty) / Number(t.original_qty)) * 100 : null,
    usd: t.usd,
    pnl: t.pnl_usd,
    reason: t.reason,
    ruleAt: t.rule_at,
  }));
}

// ── health ────────────────────────────────────────────────────────────

export function health(cfg: Config, now: number, tz: string) {
  const run = getRun();
  const stopped = run.state === "stopped";
  const paused = run.pausedAt !== null;
  const midnight = dayStart(now, tz);
  const last = one<Record<string, any>>("select id, status, started_at, finished_at, error from agent_runs order by id desc limit 1");
  const day = one<{ n: number; failed: number; tin: number; tout: number }>(
    `select count(*) n, coalesce(sum(status = 'error'), 0) failed, coalesce(sum(input_tokens), 0) tin,
       coalesce(sum(output_tokens), 0) tout from agent_runs where started_at >= ?`,
    midnight,
  )!;
  const open = openPositions().length;
  const wallet = jup.address();
  return {
    run: stopped ? "stopped" : paused ? "paused" : "running",
    lossResume: cfg.lossResume,
    openPositions: open,
    entry: { lastAt: status.entry.lastAt, note: status.entry.note },
    agent: last
      ? {
          id: last.id,
          status: last.status,
          secs: last.finished_at ? (last.finished_at - last.started_at) / 1000 : null,
          error: last.error,
          today: day,
        }
      : null,
    exit: { lastAt: status.exit.lastAt, mints: open, pollMs: POLL_MS, priceError: status.exit.priceError },
    gmgn: status.gmgn.errorAt >= midnight ? status.gmgn : null,
    swaps: { mode: cfg.mode, wallet: wallet ? shortAddr(wallet) : null },
    alerts: all<{ at: number; level: string; msg: string }>(
      "select at, level, msg from logs where level in ('warn', 'error') and at >= ? order by id desc limit 8",
      midnight,
    ),
  };
}

// ── trading desk ──────────────────────────────────────────────────────

type BriefToken = Record<string, any>;
const briefs = new Map<number, BriefToken[]>();

/** The brief a finished run sent, parsed out of its transcript once and kept: runs never change after. */
function briefOf(runId: number): BriefToken[] | null {
  const hit = briefs.get(runId);
  if (hit) return hit;
  const r = one<{ messages: string | null }>("select messages from agent_runs where id = ?", runId);
  if (!r?.messages) return null;
  let rows: BriefToken[] = [];
  try {
    const user = String((JSON.parse(r.messages) as { role: string; content: string }[]).find((m) => m.role === "user")?.content ?? "");
    const at = user.indexOf("<brief>\n");
    rows = JSON.parse(user.slice(at + 8, user.lastIndexOf("\n</brief>")));
  } catch {
    /* a transcript in another shape shows no brief */
  }
  briefs.set(runId, rows);
  return rows;
}

const why = (b: BriefToken) => (!b.last ? "new" : b.last.action === "wait" ? "wait ended" : b.last.action === "buy" ? "cooldown over" : "asked again");

function toolSummary(name: string, result: string | null): { text: string; ok: boolean } {
  const r = result ?? "";
  if (r.startsWith("tool budget spent")) return { text: "refused: tool budget used", ok: false };
  if (r.startsWith("error:") || r.startsWith("unknown tool")) return { text: r.slice(0, 100), ok: false };
  const kb = `${(r.length / 1000).toFixed(1)} kB`;
  try {
    const v = JSON.parse(r);
    const noun = name.includes("kline") ? "candles" : name.includes("holders") ? "holders" : name.includes("traders") ? "traders" : "rows";
    if (Array.isArray(v)) return { text: `${v.length} ${noun} · ${kb}`, ok: true };
    if (Array.isArray(v?.tokens)) return { text: `${v.inner_count ?? v.tokens.length} launches · ${kb}`, ok: true };
  } catch {
    return { text: `${kb}+ (cut)`, ok: true };
  }
  return { text: kb, ok: true };
}

function lookupTarget(args: string | null): string {
  try {
    const a = JSON.parse(args ?? "{}");
    if (a.address) return String(a.address);
    if (a.wallet) return String(a.wallet);
  } catch {
    /* none */
  }
  return "";
}

type RunRow = { id: number; started_at: number; finished_at: number | null; status: string; error: string | null };

/** Every event of these runs, newest first. Each carries its runId so pages can be merged. */
function activityOf(runs: RunRow[]) {
  const activity: Record<string, any>[] = [];
  for (const r of runs) {
    const brief = briefOf(r.id);
    activity.push({ at: r.started_at, kind: "run", runId: r.id, text: brief ? `started · ${brief.length} due: ${brief.map((b) => b.symbol ?? shortAddr(b.address)).join(", ")}` : "started" });
    for (const c of all<Record<string, any>>("select at, name, args, result from tool_calls where run_id = ? order by id", r.id)) {
      const target = lookupTarget(c.args);
      activity.push({ at: c.at, kind: "lookup", runId: r.id, token: symbolOf(target) ?? shortAddr(target), address: target, text: `${c.name} · ${toolSummary(c.name, c.result).text}` });
    }
    for (const d of all<Record<string, any>>(
      `select d.token, d.action, d.conviction, d.recheck_at, d.thesis, coalesce(t.symbol, substr(d.token, 1, 6)) symbol from decisions d
       join tokens t on t.address = d.token where d.run_id = ? order by d.id`,
      r.id,
    ))
      activity.push({ at: r.finished_at ?? r.started_at, kind: "verdict", runId: r.id, token: d.symbol, address: d.token, action: d.action, conviction: d.conviction, until: d.recheck_at, veto: String(d.thesis ?? "").startsWith("risk check:") ? d.thesis : null });
    if (r.status === "error") activity.push({ at: r.finished_at ?? r.started_at, kind: "error", runId: r.id, text: r.error });
  }
  return activity.sort((a, b) => b.at - a.at);
}

/** The Activity tab's lazy load: up to `n` runs started since `since`, before run `before`, and whether more remain. */
export function activityBefore(before: number, since: number, n = 10) {
  const runs = all<RunRow>(
    "select id, started_at, finished_at, status, error from agent_runs where id < ? and started_at >= ? order by id desc limit ?",
    before,
    since,
    n + 1,
  );
  return { activity: activityOf(runs.slice(0, n)), more: runs.length > n };
}

const RUN_COLS = "id, started_at, finished_at, status, error, input_tokens, output_tokens";

/** One row of the Runs list. */
function runSummary(r: Record<string, any>) {
  const brief = briefOf(r.id);
  const counts = all<{ action: string; n: number }>("select action, count(*) n from decisions where run_id = ? group by action", r.id);
  const tools = all<{ name: string; result: string | null }>("select name, result from tool_calls where run_id = ?", r.id);
  return {
    id: r.id,
    at: r.started_at,
    status: r.status,
    due: brief?.length ?? null,
    counts: Object.fromEntries(counts.map((c) => [c.action, c.n])),
    toolsUsed: tools.filter((t) => toolSummary(t.name, t.result).ok).length,
    tin: r.input_tokens,
    tout: r.output_tokens,
    secs: r.finished_at ? (r.finished_at - r.started_at) / 1000 : null,
  };
}

/** The Runs list's lazy load: up to `n` runs started since `since`, before run `before`; `failed` keeps errors only. */
export function runsBefore(before: number, since: number, failed: boolean, n = 20) {
  const rows = all<Record<string, any>>(
    `select ${RUN_COLS} from agent_runs where id < ? and started_at >= ?${failed ? " and status = 'error'" : ""} order by id desc limit ?`,
    before,
    since,
    n + 1,
  );
  return { runs: rows.slice(0, n).map(runSummary), more: rows.length > n };
}

export function trading(cfg: Config, now: number, tz: string) {
  const midnight = dayStart(now, tz);
  const runs = all<Record<string, any>>(`select ${RUN_COLS} from agent_runs order by id desc limit 4`);
  const latest = runs.find((r) => r.status !== "running");
  const act = activityBefore(Number.MAX_SAFE_INTEGER, midnight);
  const inLatest = new Set((latest ? (briefOf(latest.id) ?? []) : []).map((b) => b.address));

  // The feed: the last fetch's rows, plus waits now due that the fetch did not carry.
  const fetched = new Map(status.fetch.rows.map((r) => [r.address, r]));
  const waits = all<{ token: string }>(
    `select d.token from decisions d where d.action = 'wait' and d.recheck_at <= ?
     and d.id = (select max(id) from decisions where token = d.token)`,
    now,
  ).map((r) => r.token);
  const feed = [...new Set([...fetched.keys(), ...waits])].map((address) => {
    const f = fetched.get(address);
    const s = one<Record<string, any>>(
      `select s.id, s.market_cap_usd, s.liquidity_usd, s.top_10_holder_rate, s.top_bundler_trader_percentage, s.price_usd, f.buys, f.sells, f.price_usd p1h
       from token_snapshots s left join snapshot_flow f on f.snapshot_id = s.id and f.span = '1h'
       where s.token = ? order by s.id desc limit 1`,
      address,
    );
    const t = one<{ symbol: string | null; created_at: number | null }>("select symbol, created_at from tokens where address = ?", address);
    const st = tokenStatus(address, cfg, now);
    return {
      address,
      mint: shortAddr(address),
      symbol: t?.symbol ?? f?.symbol ?? shortAddr(address),
      source: f?.source ?? "wait due",
      ...st,
      inRun: inLatest.has(address) ? latest!.id : null,
      mcap: f?.mcap ?? s?.market_cap_usd ?? null,
      liq: f?.liq ?? s?.liquidity_usd ?? null,
      buys: f?.buys ?? s?.buys ?? null,
      sells: f?.sells ?? s?.sells ?? null,
      change1h: f?.change1h ?? (s?.p1h > 0 ? (s!.price_usd / s!.p1h - 1) * 100 : null),
      top10: f?.top10 ?? s?.top_10_holder_rate ?? null,
      bundler: f?.bundler ?? s?.top_bundler_trader_percentage ?? null,
      rug: f?.rug ?? null,
      createdAt: f?.createdAt ?? t?.created_at ?? null,
    };
  });

  return {
    feed,
    fetchedAt: status.fetch.at,
    filters: cfg.filters,
    // Agent activity: today's last ten runs; older ones of today page in through activityBefore.
    activity: act.activity,
    activityMore: act.more,
    lastRun: runs[0]?.id ?? null,
    lastDone: latest?.id ?? null,
    // Today's runs, a page each for All and Failed; older pages come through runsBefore.
    runsSince: midnight,
    runs: { all: runsBefore(Number.MAX_SAFE_INTEGER, midnight, false), failed: runsBefore(Number.MAX_SAFE_INTEGER, midnight, true) },
    runsToday: one<{ n: number; failed: number; tin: number; tout: number }>(
      `select count(*) n, coalesce(sum(status = 'error'), 0) failed, coalesce(sum(input_tokens), 0) tin,
         coalesce(sum(output_tokens), 0) tout from agent_runs where started_at >= ?`,
      midnight,
    ),
    toolBudget: cfg.toolCalls,
    maxSteps: cfg.maxSteps,
  };
}

export function runDetail(id: number) {
  const r = one<Record<string, any>>("select * from agent_runs where id = ?", id);
  if (!r) return null;
  let messages: { role: string; content: string | null; tool_calls?: { function: { name: string; arguments: string } }[] }[] = [];
  try {
    messages = r.messages ? JSON.parse(r.messages) : [];
  } catch {
    /* none */
  }
  return {
    id: r.id,
    model: r.model,
    status: r.status,
    error: r.error,
    at: r.started_at,
    secs: r.finished_at ? (r.finished_at - r.started_at) / 1000 : null,
    steps: messages.filter((m) => m.role === "assistant").length,
    tin: r.input_tokens,
    tout: r.output_tokens,
    brief: (briefOf(id) ?? []).map((b) => ({
      address: b.address,
      mint: shortAddr(String(b.address)),
      symbol: b.symbol ?? shortAddr(String(b.address)),
      why: why(b),
      mcap: b.market_cap_usd ?? null,
      liq: b.liquidity_usd ?? null,
      vol: b.flow?.["1h"]?.volume_usd ?? null,
      txs: b.flow?.["1h"] ? (b.flow["1h"].buys ?? 0) + (b.flow["1h"].sells ?? 0) : null,
      change1h: b.flow?.["1h"]?.change_pct ?? null,
      top10: b.top_10_holder_rate ?? null,
    })),
    verdicts: all<Record<string, any>>(
      `select d.token address, d.action, d.conviction, d.thesis, d.recheck_at, coalesce(t.symbol, substr(d.token, 1, 6)) symbol
       from decisions d join tokens t on t.address = d.token where d.run_id = ? order by d.id`,
      id,
    ),
    tools: all<Record<string, any>>("select at, name, args, result from tool_calls where run_id = ? order by id", id).map((c) => ({
      offset: (c.at - r.started_at) / 1000,
      name: c.name,
      args: c.args,
      ...toolSummary(c.name, c.result),
    })),
    transcript: messages.map((m) => ({
      role: m.role,
      text: m.tool_calls?.length
        ? [m.content ?? "", ...m.tool_calls.map((c) => `→ ${c.function.name} ${c.function.arguments}`)].filter(Boolean).join("\n")
        : String(m.content ?? "").slice(0, 6000),
    })),
  };
}

export function tokenDetail(address: string, cfg: Config, now: number) {
  const t = one<Record<string, any>>("select address, symbol, blocked_reason from tokens where address = ?", address);
  const d = one<Record<string, any>>(
    `select d.run_id, d.action, d.conviction, d.thesis, d.recheck_at, r.started_at from decisions d
     join agent_runs r on r.id = d.run_id where d.token = ? order by d.id desc limit 1`,
    address,
  );
  const like = `%${address.replace(/[%_]/g, "")}%`;
  return {
    address,
    mint: shortAddr(address),
    symbol: t?.symbol ?? shortAddr(address),
    source: status.fetch.rows.find((r) => r.address === address)?.source ?? null,
    ...tokenStatus(address, cfg, now),
    verdict: d ? { run: d.run_id, action: d.action, conviction: d.conviction, thesis: d.thesis, until: d.recheck_at, at: d.started_at } : null,
    lookups: all<Record<string, any>>("select at, name, result from tool_calls where args like ? order by id desc limit 10", like).map((c) => ({
      at: c.at,
      name: c.name,
      text: toolSummary(c.name, c.result).text,
    })),
  };
}
