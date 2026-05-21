import { getDb } from './database.ts';
import { nowUnix } from '../utils/math.ts';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TokenCandidate {
  id: number;
  mint_address: string;
  symbol: string | null;
  name: string | null;
  launchpad_platform: string | null;
  graduated_at: number | null;
  first_seen_at: number;
  liquidity_usd: number | null;
  holder_count: number | null;
  top_10_holder_rate: number | null;
  smart_degen_count: number | null;
  renowned_count: number | null;
  rug_ratio: number | null;
  creator_token_status: string | null;
  is_wash_trading: number | null;
  usd_market_cap: number | null;
  status: string;
}

export interface Position {
  id: number;
  mint_address: string;
  symbol: string | null;
  opened_at: number;
  closed_at: number | null;
  entry_price_usd: number;
  exit_price_usd: number | null;
  sol_invested: number;
  token_amount: string;
  sol_returned: number | null;
  pnl_usd: number | null;
  pnl_pct: number | null;
  exit_reason: string | null;
  exit_handler: string | null;
  strategy_order_id: string | null;
  entry_holder_count: number | null;
  entry_smart_wallet_count: number | null;
  status: string;
}

export interface Trade {
  id: number;
  mint_address: string;
  side: string;
  executed_at: number;
  sol_amount: number | null;
  token_amount: string | null;
  price_usd: number | null;
  order_id: string | null;
  strategy_order_id: string | null;
  tx_hash: string | null;
  status: string;
}

// ─── Token Candidates ────────────────────────────────────────────────────────

export function tokenExists(mintAddress: string): boolean {
  const db = getDb();
  const row = db
    .prepare('SELECT 1 FROM token_candidates WHERE mint_address = ?')
    .get(mintAddress);
  return !!row;
}

export function insertTokenCandidate(params: {
  mintAddress: string;
  symbol?: string;
  name?: string;
  launchpadPlatform?: string;
  graduatedAt?: number;
  liquidityUsd?: number;
  holderCount?: number;
  top10HolderRate?: number;
  smartDegenCount?: number;
  renownedCount?: number;
  rugRatio?: number;
  creatorTokenStatus?: string;
  isWashTrading?: boolean;
  usdMarketCap?: number;
}): void {
  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO token_candidates (
      mint_address, symbol, name, launchpad_platform, graduated_at,
      liquidity_usd, holder_count, top_10_holder_rate, smart_degen_count,
      renowned_count, rug_ratio, creator_token_status, is_wash_trading, usd_market_cap
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `).run(
    params.mintAddress,
    params.symbol ?? null,
    params.name ?? null,
    params.launchpadPlatform ?? null,
    params.graduatedAt ?? null,
    params.liquidityUsd ?? null,
    params.holderCount ?? null,
    params.top10HolderRate ?? null,
    params.smartDegenCount ?? null,
    params.renownedCount ?? null,
    params.rugRatio ?? null,
    params.creatorTokenStatus ?? null,
    params.isWashTrading != null ? (params.isWashTrading ? 1 : 0) : null,
    params.usdMarketCap ?? null
  );
}

export function updateTokenStatus(
  mintAddress: string,
  status: 'pending' | 'bought' | 'skipped' | 'error'
): void {
  getDb()
    .prepare('UPDATE token_candidates SET status = ? WHERE mint_address = ?')
    .run(status, mintAddress);
}

// ─── Signal Scores ───────────────────────────────────────────────────────────

export function insertSignalScores(params: {
  mintAddress: string;
  dipScore: number;
  momentumScore: number;
  smartMoneyScore: number;
  compositeScore: number;
  dipDetails: object;
  momentumDetails: object;
  smartMoneyDetails: object;
}): void {
  getDb().prepare(`
    INSERT INTO signal_scores (
      mint_address, dip_score, momentum_score, smart_money_score,
      composite_score, dip_details, momentum_details, smart_money_details
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.mintAddress,
    params.dipScore,
    params.momentumScore,
    params.smartMoneyScore,
    params.compositeScore,
    JSON.stringify(params.dipDetails),
    JSON.stringify(params.momentumDetails),
    JSON.stringify(params.smartMoneyDetails)
  );
}

// ─── AI Decisions ────────────────────────────────────────────────────────────

export function insertAiDecision(params: {
  mintAddress: string;
  decisionType: 'entry' | 'position';
  action: 'BUY' | 'SKIP' | 'HOLD' | 'SELL';
  confidence: number;
  reasoning: string;
  redFlags?: string[];
  rawResponse: string;
}): void {
  getDb().prepare(`
    INSERT INTO ai_decisions (
      mint_address, decision_type, action, confidence, reasoning, red_flags, raw_response
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.mintAddress,
    params.decisionType,
    params.action,
    params.confidence,
    params.reasoning,
    params.redFlags ? JSON.stringify(params.redFlags) : null,
    params.rawResponse
  );
}

// ─── Trades ──────────────────────────────────────────────────────────────────

export function insertTrade(params: {
  mintAddress: string;
  side: 'BUY' | 'SELL';
  solAmount: number;
  tokenAmount?: string;
  priceUsd?: number;
  orderId?: string;
  strategyOrderId?: string;
  txHash?: string;
  status?: string;
}): void {
  getDb().prepare(`
    INSERT INTO trades (
      mint_address, side, sol_amount, token_amount, price_usd,
      order_id, strategy_order_id, tx_hash, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.mintAddress,
    params.side,
    params.solAmount,
    params.tokenAmount ?? null,
    params.priceUsd ?? null,
    params.orderId ?? null,
    params.strategyOrderId ?? null,
    params.txHash ?? null,
    params.status ?? 'pending'
  );
}

export function updateTradeStatus(orderId: string, status: string, extra?: {
  tokenAmount?: string;
  priceUsd?: number;
  txHash?: string;
}): void {
  if (extra) {
    getDb().prepare(`
      UPDATE trades
      SET status = ?, token_amount = COALESCE(?, token_amount),
          price_usd = COALESCE(?, price_usd), tx_hash = COALESCE(?, tx_hash)
      WHERE order_id = ?
    `).run(status, extra.tokenAmount ?? null, extra.priceUsd ?? null, extra.txHash ?? null, orderId);
  } else {
    getDb().prepare('UPDATE trades SET status = ? WHERE order_id = ?').run(status, orderId);
  }
}

// ─── Positions ───────────────────────────────────────────────────────────────

export function insertPosition(params: {
  mintAddress: string;
  symbol?: string;
  entryPriceUsd: number;
  solInvested: number;
  tokenAmount: string;
  strategyOrderId?: string;
  entryHolderCount?: number;
  entrySmartWalletCount?: number;
}): void {
  getDb().prepare(`
    INSERT INTO positions (
      mint_address, symbol, entry_price_usd, sol_invested, token_amount,
      strategy_order_id, entry_holder_count, entry_smart_wallet_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.mintAddress,
    params.symbol ?? null,
    params.entryPriceUsd,
    params.solInvested,
    params.tokenAmount,
    params.strategyOrderId ?? null,
    params.entryHolderCount ?? null,
    params.entrySmartWalletCount ?? null
  );
}

export function getOpenPositions(): Position[] {
  return getDb()
    .prepare("SELECT * FROM positions WHERE status = 'open'")
    .all() as Position[];
}

export function countOpenPositions(): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) as count FROM positions WHERE status = 'open'")
    .get() as { count: number };
  return row.count;
}

export function closePosition(params: {
  mintAddress: string;
  exitPriceUsd: number;
  solReturned: number;
  pnlUsd: number;
  pnlPct: number;
  exitReason: string;
  exitHandler: string;
}): void {
  getDb().prepare(`
    UPDATE positions
    SET status = 'closed',
        closed_at = ?,
        exit_price_usd = ?,
        sol_returned = ?,
        pnl_usd = ?,
        pnl_pct = ?,
        exit_reason = ?,
        exit_handler = ?
    WHERE mint_address = ?
  `).run(
    nowUnix(),
    params.exitPriceUsd,
    params.solReturned,
    params.pnlUsd,
    params.pnlPct,
    params.exitReason,
    params.exitHandler,
    params.mintAddress
  );
}

// ─── Daily Stats ─────────────────────────────────────────────────────────────

export function upsertDailyStats(date: string, pnlUsd: number, solTraded: number, won: boolean): void {
  const db = getDb();

  db.prepare(`
    INSERT INTO daily_stats (date, trades_total, trades_won, trades_lost, pnl_usd, sol_traded)
    VALUES (?, 1, ?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET
      trades_total = trades_total + 1,
      trades_won = trades_won + ?,
      trades_lost = trades_lost + ?,
      pnl_usd = pnl_usd + ?,
      sol_traded = sol_traded + ?
  `).run(
    date,
    won ? 1 : 0,
    won ? 0 : 1,
    pnlUsd,
    solTraded,
    won ? 1 : 0,
    won ? 0 : 1,
    pnlUsd,
    solTraded
  );

  // Recompute win_rate and avg_pnl_per_trade
  db.prepare(`
    UPDATE daily_stats
    SET win_rate = CAST(trades_won AS REAL) / trades_total,
        avg_pnl_per_trade = pnl_usd / trades_total
    WHERE date = ?
  `).run(date);
}

export function getDailyStats(date: string) {
  return getDb()
    .prepare('SELECT * FROM daily_stats WHERE date = ?')
    .get(date);
}

export function getBestAndWorstTrades(date: string): {
  best: { symbol: string; pnlUsd: number; pnlPct: number; exitReason: string } | null;
  worst: { symbol: string; pnlUsd: number; pnlPct: number; exitReason: string } | null;
} {
  const db = getDb();
  const dateStart = new Date(date);
  dateStart.setHours(0, 0, 0, 0);
  const dateEnd = new Date(date);
  dateEnd.setHours(23, 59, 59, 999);

  const startUnix = Math.floor(dateStart.getTime() / 1000);
  const endUnix = Math.floor(dateEnd.getTime() / 1000);

  const best = db.prepare(`
    SELECT p.symbol, p.pnl_usd, p.pnl_pct, p.exit_reason
    FROM positions p
    WHERE p.status = 'closed' AND p.closed_at BETWEEN ? AND ?
    ORDER BY p.pnl_usd DESC LIMIT 1
  `).get(startUnix, endUnix) as any;

  const worst = db.prepare(`
    SELECT p.symbol, p.pnl_usd, p.pnl_pct, p.exit_reason
    FROM positions p
    WHERE p.status = 'closed' AND p.closed_at BETWEEN ? AND ?
    ORDER BY p.pnl_usd ASC LIMIT 1
  `).get(startUnix, endUnix) as any;

  return {
    best: best ? { symbol: best.symbol, pnlUsd: best.pnl_usd, pnlPct: best.pnl_pct, exitReason: best.exit_reason } : null,
    worst: worst ? { symbol: worst.symbol, pnlUsd: worst.pnl_usd, pnlPct: worst.pnl_pct, exitReason: worst.exit_reason } : null,
  };
}
