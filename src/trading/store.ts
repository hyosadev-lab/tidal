import { DEFAULT_CONFIG, sanitizeConfig, liveReady } from "./config.ts";
import { db, insertEquity, insertTrade, kvGet, kvSet, rowsJson } from "./db.ts";
import type {
  Candidate,
  EquityPoint,
  LogEntry,
  LogLevel,
  Position,
  RunState,
  Snapshot,
  Stats,
  Trade,
  TradeConfig,
} from "./types.ts";

const MAX_LOGS = 400;
/** Only what the tide strip draws — the table keeps the rest. */
const MAX_EQUITY = 2000;

/** The mutable half: small, rewritten whole into `kv.state`. Trades and equity are rows. */
type Persisted = {
  cash: number;
  positions: Position[];
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
  logs: LogEntry[] = [];

  private s: Persisted;
  private logSeq = 1;
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
    const entry: LogEntry = { id: this.logSeq++, at: Date.now(), level, msg, ...(detail ? { detail } : {}) };
    this.logs.push(entry);
    if (this.logs.length > MAX_LOGS) this.logs.splice(0, this.logs.length - MAX_LOGS);
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

  // ── equity / stats ────────────────────────────────────────────────
  get exposure(): number {
    return this.s.positions.reduce((sum, p) => sum + p.qty * p.lastPrice, 0);
  }

  get equity(): number {
    return this.s.cash + this.exposure;
  }

  /** Roll the daily loss budget at midnight local time. */
  rollDay(): void {
    const d = today();
    if (this.s.dayStamp !== d) {
      this.s.dayStamp = d;
      this.s.dayStartEquity = this.equity;
      if (this.runState === "halted") {
        this.runState = "stopped";
        this.haltReason = "";
        this.log("info", "Daily loss budget reset — restart the agent when you're ready.");
      }
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
    db.exec("delete from trades; delete from equity;");
    this.lastEquityAt = 0;
    this.s = emptyState(this.config);
    this.logs = [];
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
      trades: this.trades(120),
      logs: this.logs.slice(-160),
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
    };
  }
}

export const store = new Store();
export { DEFAULT_CONFIG };
