import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, DEFAULT_CONFIG, loadConfig, saveConfig, sanitizeConfig, liveReady } from "./config.ts";
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

const STATE_PATH = join(DATA_DIR, "state.json");
const MAX_LOGS = 400;
const MAX_TRADES = 500;
const MAX_EQUITY = 2000;

type Persisted = {
  cash: number;
  positions: Position[];
  trades: Trade[];
  equity: EquityPoint[];
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

function emptyState(cfg: TradeConfig): Persisted {
  return {
    cash: cfg.paperStartEquityUsd,
    positions: [],
    trades: [],
    equity: [],
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

  constructor() {
    this.config = loadConfig();
    this.s = this.read();
  }

  private read(): Persisted {
    try {
      const raw = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Partial<Persisted>;
      const base = emptyState(this.config);
      return {
        ...base,
        ...raw,
        positions: Array.isArray(raw.positions) ? raw.positions : [],
        trades: Array.isArray(raw.trades) ? raw.trades : [],
        equity: Array.isArray(raw.equity) ? raw.equity : [],
        cooldowns: raw.cooldowns && typeof raw.cooldowns === "object" ? raw.cooldowns : {},
        blacklist: Array.isArray(raw.blacklist) ? raw.blacklist : [],
      };
    } catch {
      return emptyState(this.config);
    }
  }

  /** Debounced atomic write — the loop mutates state far more often than we need to persist. */
  save(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        mkdirSync(DATA_DIR, { recursive: true });
        const tmp = `${STATE_PATH}.tmp`;
        writeFileSync(tmp, JSON.stringify(this.s));
        renameSync(tmp, STATE_PATH);
      } catch (e) {
        console.error("state save failed:", e);
      }
    }, 400);
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
  get trades(): Trade[] {
    return this.s.trades;
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
    this.s.trades.unshift(t);
    if (this.s.trades.length > MAX_TRADES) this.s.trades.length = MAX_TRADES;
    this.save();
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
    const last = this.s.equity[this.s.equity.length - 1];
    // one point per minute is plenty for the tide strip
    if (!last || Date.now() - last.at > 60_000) {
      this.s.equity.push({ at: Date.now(), equity: Number(eq.toFixed(2)) });
      if (this.s.equity.length > MAX_EQUITY) this.s.equity.splice(0, this.s.equity.length - MAX_EQUITY);
      this.save();
    }
  }

  stats(): Stats {
    const closed = this.s.trades.filter((t) => t.side === "sell" && typeof t.pnlUsd === "number");
    const wins = closed.filter((t) => (t.pnlUsd ?? 0) > 0).length;
    const losses = closed.length - wins;
    const realised = closed.reduce((sum, t) => sum + (t.pnlUsd ?? 0), 0);
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
      winRatePct: closed.length ? (wins / closed.length) * 100 : 0,
      dayStartEquity: this.s.dayStartEquity,
      dayPnlPct: this.s.dayStartEquity > 0 ? ((eq - this.s.dayStartEquity) / this.s.dayStartEquity) * 100 : 0,
    };
  }

  // ── config ────────────────────────────────────────────────────────
  updateConfig(patch: Partial<TradeConfig>): TradeConfig {
    const before = this.config;
    this.config = sanitizeConfig({ ...before, ...patch }, before);
    saveConfig(this.config);
    // Resizing the paper bankroll only makes sense on a flat, untouched ledger.
    if (
      this.config.paperStartEquityUsd !== before.paperStartEquityUsd &&
      !this.s.positions.length &&
      !this.s.trades.length
    ) {
      this.s.cash = this.config.paperStartEquityUsd;
      this.s.dayStartEquity = this.config.paperStartEquityUsd;
      this.s.peakEquity = this.config.paperStartEquityUsd;
      this.s.troughEquity = this.config.paperStartEquityUsd;
      this.save();
    }
    return this.config;
  }

  reset(): void {
    this.s = emptyState(this.config);
    this.logs = [];
    this.lastCandidates = [];
    this.runState = "stopped";
    this.haltReason = "";
    this.save();
    this.log("info", "Ledger cleared. Paper balance back to $" + this.config.paperStartEquityUsd.toFixed(0) + ".");
    this.push();
  }

  snapshot(): Snapshot {
    const live = liveReady(this.config);
    return {
      runState: this.runState,
      haltReason: this.haltReason,
      config: this.config,
      positions: this.s.positions,
      trades: this.s.trades.slice(0, 120),
      logs: this.logs.slice(-160),
      equity: this.s.equity,
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
