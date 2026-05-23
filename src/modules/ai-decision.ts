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

  return `
Token: ${position.symbol ?? position.mint_address}
Entry Price: $${position.entry_price_usd}
Current Price: $${snap.price}
PnL: ${pnlSign}${snap.pnlPct.toFixed(1)}% (${pnlUsdSign}$${snap.pnlUsd.toFixed(2)})
Hold Duration: ${snap.holdMinutes.toFixed(0)} minutes

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

Should I HOLD or SELL this position now?
  `.trim();
}
