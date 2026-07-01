import { getConfig } from '../config.ts';
import { type Position } from '../db/queries.ts';
import { type TokenInfo } from '../services/gmgn-client.ts';
import { computePnlPct, minutesSince } from '../utils/math.ts';

export interface PositionSnapshot {
  price: number;
  volume1h: number;
  buys1h: number;
  sells1h: number;
  buyVolume1h: number;
  sellVolume1h: number;
  buySellRatio1h: number;
  liquidity: number;
  holderCount: number;
  smartWalletCount: number;
  renownedWalletCount: number;
  devStatus: string;
  devHoldRate: number;
  ratTraderPct: number;
  ctoFlag: number;
  pnlPct: number;
  pnlUsd: number;
  holdMinutes: number;
}

export function buildPositionSnapshot(
  position: Position,
  info: TokenInfo,
  solPriceUsd: number
): PositionSnapshot {
  const price = parseFloat(info.price.price);
  const buys1h = info.price.buys_1h ?? 0;
  const sells1h = info.price.sells_1h ?? 0;
  const volume1h = parseFloat(info.price.volume_1h)
  const buyVolume1h = parseFloat(info.price.buy_volume_1h)
  const sellVolume1h = parseFloat(info.price.sell_volume_1h)
  const buySellRatio1h = (buys1h + sells1h) > 0
    ? buys1h / (buys1h + sells1h)
    : 0.5;

  const pnlPct = computePnlPct(position.entry_price_usd, price);
  const pnlUsd = position.sol_invested * solPriceUsd * (pnlPct / 100);
  const holdMinutes = minutesSince(position.opened_at);

  return {
    price,
    volume1h,
    buys1h,
    sells1h,
    buyVolume1h,
    sellVolume1h,
    buySellRatio1h,
    liquidity: parseFloat(info.liquidity),
    holderCount: info.stat?.holder_count ?? 0,
    smartWalletCount: info.wallet_tags_stat?.smart_wallets ?? 0,
    renownedWalletCount: info.wallet_tags_stat?.renowned_wallets ?? 0,
    devStatus: info.dev?.creator_token_status ?? 'unknown',
    devHoldRate: info.stat?.creator_hold_rate ?? 0,
    ratTraderPct: info.stat?.top_rat_trader_percentage ?? 0,
    ctoFlag: info.dev?.cto_flag ?? 0,
    pnlPct,
    pnlUsd,
    holdMinutes,
  };
}

export function buildPositionPrompt(position: Position, snap: PositionSnapshot): string {
  const config = getConfig();

  const trailingInfo = config.trailingActivatePct
    ? `Active after +${config.trailingActivatePct}%, trail ${config.trailingDrawdownPct}% from peak`
    : 'NOT SET — you control exit';

  const slInfo = config.stopLossPct
    ? `-${config.stopLossPct}% from entry`
    : 'NOT SET — you control exit';

  const pnlSign = snap.pnlPct >= 0 ? '+' : '';
  const pnlUsdSign = snap.pnlUsd >= 0 ? '+' : '';

  // ── Red flag detection ───────────────────────────────────────────────────
  const redFlags: string[] = [];

  // Volume collapse — volume sangat rendah = tidak ada minat, liquiditas mengering
  if (snap.volume1h < 5000) {
    redFlags.push(`⚠️ VOLUME COLLAPSE: 1h volume hanya $${snap.volume1h.toFixed(0)} — pasar sudah kehilangan minat`);
  }

  // Sell pressure dominant
  if (snap.buySellRatio1h < 0.40) {
    redFlags.push(`⚠️ SELL PRESSURE: buy/sell ratio 1h = ${snap.buySellRatio1h.toFixed(2)} — sellers sangat dominan`);
  }

  // Smart money turun dari entry
  const smDrop = (position.entry_smart_wallet_count ?? 0) - snap.smartWalletCount;
  if (smDrop >= 2) {
    redFlags.push(`⚠️ SMART MONEY EXIT: smart wallets turun dari ${position.entry_smart_wallet_count} → ${snap.smartWalletCount} (−${smDrop} wallets keluar)`);
  }

  // Holder count turun signifikan — distribusi sedang terjadi
  const holderDrop = (position.entry_holder_count ?? 0) - snap.holderCount;
  const holderDropPct = position.entry_holder_count
    ? (holderDrop / position.entry_holder_count) * 100
    : 0;
  if (holderDropPct >= 10) {
    redFlags.push(`⚠️ HOLDER DISTRIBUTION: holder turun ${holderDropPct.toFixed(0)}% dari entry (${position.entry_holder_count} → ${snap.holderCount})`);
  }

  // Dev masih hold — risiko dev dump
  if (snap.devStatus === 'creator_hold' && snap.devHoldRate > 0.05) {
    redFlags.push(`⚠️ DEV STILL HOLDS: dev masih pegang ${(snap.devHoldRate * 100).toFixed(1)}% supply — risiko dump`);
  }

  // Rat trader tinggi — kemungkinan pump & dump koordinasi
  if (snap.ratTraderPct > 0.15) {
    redFlags.push(`⚠️ HIGH RAT TRADER ACTIVITY: ${(snap.ratTraderPct * 100).toFixed(1)}% dari volume dari rat traders`);
  }

  // Loss besar sudah terjadi
  if (snap.pnlPct <= -20) {
    redFlags.push(`⚠️ SIGNIFICANT LOSS: sudah -${Math.abs(snap.pnlPct).toFixed(1)}% — probabilitas recovery menurun drastis`);
  }

  // Hold terlalu lama dengan PnL flat/negatif
  if (snap.holdMinutes > 60 && snap.pnlPct < 5) {
    redFlags.push(`⚠️ STALE POSITION: hold ${snap.holdMinutes.toFixed(0)} menit dengan PnL hanya ${pnlSign}${snap.pnlPct.toFixed(1)}% — opportunity cost tinggi`);
  }

  const redFlagSection = redFlags.length > 0
    ? `\n--- RED FLAGS (${redFlags.length} ditemukan) ---\n${redFlags.join('\n')}\n`
    : '\n--- RED FLAGS ---\nTidak ada red flag kritis terdeteksi.\n';

  return `
Token: ${position.symbol ?? position.mint_address}
Entry Price: $${position.entry_price_usd}
Current Price: $${snap.price}
PnL: ${pnlSign}${snap.pnlPct.toFixed(1)}% (${pnlUsdSign}$${snap.pnlUsd.toFixed(2)})
Hold Duration: ${snap.holdMinutes.toFixed(0)} minutes
${redFlagSection}
--- 1H PRICE ACTION ---
Volume 1h: $${snap.volume1h.toFixed(0)}
Buys 1h: ${snap.buys1h} | Sells 1h: ${snap.sells1h}
Buy Volume 1h: $${snap.buyVolume1h.toFixed(0)} | Sell Volume 1h: $${snap.sellVolume1h.toFixed(0)}
Buy/Sell Ratio 1h: ${snap.buySellRatio1h.toFixed(2)} (>0.5 = more buys)

--- MARKET STATE ---
Liquidity: $${snap.liquidity.toFixed(0)}
Holder Count: ${snap.holderCount} (was ${position.entry_holder_count ?? 'N/A'} at entry)
Smart Money Holders: ${snap.smartWalletCount} (was ${position.entry_smart_wallet_count ?? 'N/A'} at entry)
KOL Holders: ${snap.renownedWalletCount}

--- DEV & RISK ---
Dev Status: ${snap.devStatus} | Dev Hold Rate: ${(snap.devHoldRate * 100).toFixed(1)}%
Rat Trader Activity: ${(snap.ratTraderPct * 100).toFixed(1)}%
CTO Flag: ${snap.ctoFlag === 1 ? 'YES (community takeover)' : 'No'}

--- EXIT CONFIG ---
Trailing Stop: ${trailingInfo}
Stop Loss: ${slInfo}

--- EXIT DECISION GUIDELINES ---
Default to SELL in any of these situations:
1. Red flags >= 2 — multiple warning signs = elevated risk, do not wait for recovery
2. Buy/sell ratio < 0.40 AND volume is dropping — sellers in control, exit before it gets worse
3. Smart money count dropped since entry — they exited, you should too
4. Holder count dropped >10% since entry — distribution happening
5. PnL <= -20% AND no strong buy signal — cut loss, do not hope for recovery
6. Hold > 90 minutes with PnL < 0% — stale position, capital is better deployed elsewhere

Default to HOLD only if:
- PnL is positive AND buy/sell ratio > 0.55 AND no red flags
- Smart money count held or increased since entry

Be disciplined: small certain losses are better than large uncertain ones.
Should I HOLD or SELL this position now?
  `.trim();
}
