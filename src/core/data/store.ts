import { db, insertEquity, insertLog, insertTrade, kvGet, kvSet, rowsJson } from "./db.ts";
import { DEFAULT_CONFIG, liveReady, sanitizeConfig } from "../domain/config.ts";
import { WATCH_MAX, WATCH_MINUTES, WATCH_TTL_MINUTES } from "../domain/watchlist.ts";
import type { Candidate, EquityPoint, LogEntry, LogLevel, Position, RunState, Snapshot, Stats, Trade, TradeConfig, Watch } from "../domain/types.ts";

/** Only what the tide strip draws — the table keeps the rest. */
const MAX_EQUITY = 2000;

/** The mutable half: small, rewritten whole into `kv.state`. Trades and equity are rows. */
type Persisted = {
  cash: number;
  positions: Position[];
  watchlist: Watch[];
  dayStartEquity: number;
  dayStamp: string;
  peakEquity: number;
  troughEquity: number;
  cooldowns: Record<string, number>;
  blacklist: string[];
  cycleCount: number;
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** The config is persisted state like any other, so it is read and written here, not in `config.ts`. */
function loadConfig(): TradeConfig {
  const saved = kvGet<Partial<TradeConfig>>("config");
  return saved ? sanitizeConfig(saved) : { ...DEFAULT_CONFIG };
}

function saveConfig(cfg: TradeConfig): void {
  kvSet("config", cfg);
}

function emptyState(cfg: TradeConfig): Persisted {
  return {
    cash: cfg.paperStartEquityUsd,
    positions: [],
    watchlist: [],
    dayStartEquity: cfg.paperStartEquityUsd,
    dayStamp: today(),
    peakEquity: cfg.paperStartEquityUsd,
    troughEquity: cfg.paperStartEquityUsd,
    cooldowns: {},
    blacklist: [],
    cycleCount: 0,
  };
}

export class Store {
  config: TradeConfig;
  runState: RunState = "stopped";
  haltReason = "";
  phase = "idle";
  busy = false;
  lastRunAt = 0;
  nextRunAt = 0;
  lastCandidates: Candidate[] = [];

  private s: Persisted;
  private subs = new Set<(ev: string, data: unknown) => void>();
  private saveTimer: NodeJS.Timeout | null = null;
  private lastEquityAt = 0;

  constructor() {
    this.config = loadConfig();
    this.s = this.read();
    this.lastEquityAt = (db.prepare("select max(at) at from equity").get() as { at: number | null }).at ?? 0;
  }

  private read(): Persisted {
    const raw = kvGet<Partial<Persisted>>("state");
    const base = emptyState(this.config);
    if (!raw) return base;
    return {
      ...base,
      ...raw,
      positions: Array.isArray(raw.positions) ? raw.positions : [],
      watchlist: Array.isArray(raw.watchlist) ? raw.watchlist : [],
      cooldowns: raw.cooldowns && typeof raw.cooldowns === "object" ? raw.cooldowns : {},
      blacklist: Array.isArray(raw.blacklist) ? raw.blacklist : [],
    };
  }

  /** Debounced write — the loop mutates state far more often than we need to persist. */
  save(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.saveNow(), 400);
  }

  saveNow(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try {
      kvSet("state", this.s);
    } catch (e) {
      console.error("state save failed:", e);
    }
  }

  // ── pub/sub for SSE ───────────────────────────────────────────────
  subscribe(fn: (ev: string, data: unknown) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  emit(ev: string, data: unknown): void {
    for (const fn of this.subs) {
      try {
        fn(ev, data);
      } catch {
        /* a dead client must not take down the loop */
      }
    }
  }

  push(): void {
    this.emit("snapshot", this.snapshot());
  }

  log(level: LogLevel, msg: string, detail?: string): LogEntry {
    const at = Date.now();
    let id = at;
    try {
      id = insertLog(at, level, msg, detail);
    } catch (e) {
      console.error("log write failed:", e); // a full disk must not take down the loop
    }
    const entry: LogEntry = { id, at, level, msg, ...(detail ? { detail } : {}) };
    const tag = level === "error" ? "!" : level === "warn" ? "?" : level === "trade" ? "$" : "·";
    console.log(`${tag} ${msg}`);
    this.emit("log", entry);
    return entry;
  }

  // ── accessors ─────────────────────────────────────────────────────
  get cash(): number {
    return this.s.cash;
  }
  set cash(v: number) {
    this.s.cash = Math.max(0, v);
  }
  get positions(): Position[] {
    return this.s.positions;
  }
  /** Oldest first, as the dashboard expects. Unbounded on disk — bounded at the query. */
  logs(limit = 160): LogEntry[] {
    const rows = db.prepare("select id, at, level, msg, detail from logs order by id desc limit ?").all(limit) as (LogEntry & { detail: string | null })[];
    return rows.reverse().map(({ detail, ...r }) => ({ ...r, ...(detail ? { detail } : {}) }));
  }

  /** Newest first, like the array this replaced. Unbounded on disk — bounded at the query. */
  trades(limit = 120): Trade[] {
    return rowsJson<Trade>("select json from trades order by at desc, rowid desc limit ?", limit);
  }

  tradeCount(): number {
    return (db.prepare("select count(*) n from trades").get() as { n: number }).n;
  }
  get cycleCount(): number {
    return this.s.cycleCount;
  }

  bumpCycle(): number {
    return ++this.s.cycleCount;
  }

  position(address: string): Position | undefined {
    return this.s.positions.find((p) => p.address.toLowerCase() === address.toLowerCase());
  }

  addPosition(p: Position): void {
    this.s.positions.push(p);
    this.save();
  }

  removePosition(id: string): void {
    this.s.positions = this.s.positions.filter((p) => p.id !== id);
    this.save();
  }

  addTrade(t: Trade): void {
    insertTrade(t);
    this.emit("trade", t);
  }

  // ── watchlist ─────────────────────────────────────────────────────
  get watchlist(): Watch[] {
    return this.s.watchlist;
  }

  watching(address: string): boolean {
    return this.s.watchlist.some((w) => w.c.address.toLowerCase() === address.toLowerCase());
  }

  /** Takes what a `domain/watchlist.ts` rule returned: the new list, and why it changed. */
  setWatchlist(r: { list: Watch[]; notes: string[] }): void {
    this.s.watchlist = r.list;
    for (const n of r.notes) this.log("info", `Watchlist: ${n}`);
    this.save();
  }

  // ── cooldown / blacklist ──────────────────────────────────────────
  cooldown(address: string, minutes: number): void {
    if (minutes > 0) this.s.cooldowns[address.toLowerCase()] = Date.now() + minutes * 60_000;
  }

  onCooldown(address: string): boolean {
    const until = this.s.cooldowns[address.toLowerCase()];
    if (!until) return false;
    if (until < Date.now()) {
      delete this.s.cooldowns[address.toLowerCase()];
      return false;
    }
    return true;
  }

  blacklist(address: string): void {
    const a = address.toLowerCase();
    if (!this.s.blacklist.includes(a)) this.s.blacklist.push(a);
    this.save();
  }

  isBlacklisted(address: string): boolean {
    return this.s.blacklist.includes(address.toLowerCase());
  }

  /**
   * Why a candidate that cleared the gates still cannot be bought, or "" when it can. Held,
   * cooled-down and blacklisted are all store state and never travel on a Candidate, so the
   * eligible filter, the dashboard's note and the pre-entry re-check all ask this one question
   * and cannot drift apart.
   */
  unavailable(address: string): string {
    if (this.position(address)) return "already held";
    if (this.onCooldown(address)) return "on cooldown after a recent exit";
    if (this.isBlacklisted(address)) return "blacklisted";
    return "";
  }

  // ── equity / stats ────────────────────────────────────────────────
  get exposure(): number {
    return this.s.positions.reduce((sum, p) => sum + p.qty * p.lastPrice, 0);
  }

  get equity(): number {
    return this.s.cash + this.exposure;
  }

  /**
   * Roll the daily loss budget at midnight UTC. A loss halt is left alone: its resume timer
   * (`cycle/control.ts`) is what ends it, and a manual scan rolling the day first must not
   * turn it into a plain stop that never resumes.
   */
  rollDay(): void {
    const d = today();
    if (this.s.dayStamp !== d) {
      this.s.dayStamp = d;
      this.s.dayStartEquity = this.equity;
      this.save();
    }
  }

  markEquity(): void {
    const eq = this.equity;
    this.s.peakEquity = Math.max(this.s.peakEquity, eq);
    this.s.troughEquity = this.s.troughEquity ? Math.min(this.s.troughEquity, eq) : eq;
    // one point per minute is plenty for the tide strip
    if (Date.now() - this.lastEquityAt > 60_000) {
      this.lastEquityAt = Date.now();
      insertEquity(this.lastEquityAt, Number(eq.toFixed(2)));
      this.save();
    }
  }

  equitySeries(limit = MAX_EQUITY): EquityPoint[] {
    const rows = db.prepare("select at, equity from equity order by at desc limit ?").all(limit) as EquityPoint[];
    return rows.reverse();
  }

  stats(): Stats {
    const closed = db
      .prepare("select count(*) n, sum(case when pnl > 0 then 1 else 0 end) wins, sum(pnl) realised from trades where side = 'sell' and pnl is not null")
      .get() as { n: number; wins: number | null; realised: number | null };
    const wins = closed.wins ?? 0;
    const losses = closed.n - wins;
    const realised = closed.realised ?? 0;
    const unrealised = this.s.positions.reduce((sum, p) => sum + (p.qty * p.lastPrice - (p.costUsd - p.realisedUsd)), 0);
    const eq = this.equity;
    const peak = Math.max(this.s.peakEquity, eq);
    return {
      equity: eq,
      cash: this.s.cash,
      exposure: this.exposure,
      realisedUsd: realised,
      unrealisedUsd: unrealised,
      peakEquity: peak,
      troughEquity: this.s.troughEquity || eq,
      maxDrawdownPct: peak > 0 ? ((peak - (this.s.troughEquity || eq)) / peak) * 100 : 0,
      wins,
      losses,
      winRatePct: closed.n ? (wins / closed.n) * 100 : 0,
      dayStartEquity: this.s.dayStartEquity,
      dayPnlPct: this.s.dayStartEquity > 0 ? ((eq - this.s.dayStartEquity) / this.s.dayStartEquity) * 100 : 0,
    };
  }

  // ── config ────────────────────────────────────────────────────────
  updateConfig(patch: Partial<TradeConfig>): TradeConfig {
    const before = this.config;
    this.config = sanitizeConfig({ ...before, ...patch }, before);
    saveConfig(this.config);
    // Coming back from live, `cash` still holds the wallet's spendable balance — the engine
    // overwrites it every live cycle. Paper has to size off the bankroll again, and the only
    // safe moment to put it back is a flat book.
    if (this.config.mode === "paper" && before.mode === "live" && !this.s.positions.length) {
      this.s.cash = this.config.paperStartEquityUsd;
      this.save();
    }
    // Resizing the paper bankroll only makes sense on a flat, untouched ledger.
    if (
      this.config.paperStartEquityUsd !== before.paperStartEquityUsd &&
      !this.s.positions.length &&
      !this.tradeCount()
    ) {
      this.s.cash = this.config.paperStartEquityUsd;
      this.s.dayStartEquity = this.config.paperStartEquityUsd;
      this.s.peakEquity = this.config.paperStartEquityUsd;
      this.s.troughEquity = this.config.paperStartEquityUsd;
      this.save();
    }
    return this.config;
  }

  /** Soundings and outcomes survive on purpose — they are calibration data, not the ledger. */
  reset(): void {
    db.exec("delete from trades; delete from equity; delete from logs;");
    this.lastEquityAt = 0;
    this.s = emptyState(this.config);
    this.lastCandidates = [];
    this.runState = "stopped";
    this.haltReason = "";
    this.save();
    this.log("info", "Ledger cleared. Paper balance back to $" + this.config.paperStartEquityUsd.toFixed(0) + ".");
    this.push();
  }

  /**
   * Re-anchors the day / peak / trough baseline to whatever equity is now.
   *
   * Those three are the yardsticks behind day PnL, max drawdown and the daily loss halt, and
   * they only mean anything against a fixed pot of money. Switching modes or clearing the
   * ledger changes the pot — a $1000 paper baseline against a $46 wallet reads as a 95%
   * drawdown and halts trading on the first cycle.
   */
  rebase(): void {
    const eq = this.equity;
    this.s.dayStartEquity = eq;
    this.s.peakEquity = eq;
    this.s.troughEquity = eq;
    this.save();
  }

  snapshot(): Snapshot {
    const live = liveReady(this.config);
    return {
      runState: this.runState,
      haltReason: this.haltReason,
      config: this.config,
      positions: this.s.positions,
      watchlist: this.s.watchlist,
      watchRules: { max: WATCH_MAX, ttlMinutes: WATCH_TTL_MINUTES, everyMinutes: WATCH_MINUTES },
      trades: this.trades(120),
      logs: this.logs(),
      equity: this.equitySeries(),
      stats: this.stats(),
      cycle: {
        count: this.s.cycleCount,
        lastRunAt: this.lastRunAt,
        nextRunAt: this.nextRunAt,
        busy: this.busy,
        phase: this.phase,
        lastCandidates: this.lastCandidates,
      },
      liveReady: live.ok,
      liveReason: live.reason,
    };
  }
}

export const store = new Store();
export { DEFAULT_CONFIG };
