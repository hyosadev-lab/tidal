import { getGmgnClient, type TrenchesToken, type TokenInfo, type KlineCandle, type HolderWallet } from '../services/gmgn-client.ts';
import { getConfig } from '../config.ts';
import { logger } from '../utils/logger.ts';
import { insertSignalScores } from '../db/queries.ts';
import { scoreDipRecovery, type DipRecoverySignal } from '../strategies/dip-recovery.ts';
import { scoreMomentum, type MomentumSignal } from '../strategies/momentum.ts';
import { scoreSmartMoney, type SmartMoneySignal } from '../strategies/smart-money.ts';
import { nowUnix } from '../utils/math.ts';
import { sleep } from '../utils/retry.ts';
import { getSolPriceUsd } from '../services/coingecko.ts';

export interface AllSignalScores {
  composite: number;
  dip: DipRecoverySignal;
  momentum: MomentumSignal;
  smartMoney: SmartMoneySignal;
}

export interface EnrichedToken {
  token: TrenchesToken;
  info: TokenInfo;
  candles: KlineCandle[];
  smartHolders: HolderWallet[];
  migrationPrice: number;
  scores: AllSignalScores;
}

export async function enrichAndScore(token: TrenchesToken): Promise<EnrichedToken | null> {
  const config = getConfig();
  const client = getGmgnClient();

  // ── Fetch enrichment data ─────────────────────────────────────────────────

  let info: TokenInfo & { migration_market_cap_quote?: string };
  try {
    info = await client.getTokenInfo(token.address);
    if (info.migration_market_cap_quote === 'SOL') {
      const solPrice = await getSolPriceUsd();
      info.migration_market_cap = info.migration_market_cap * solPrice;
    }
    await sleep(500);
  } catch (err) {
    logger.error('enrichment_failed', { mint: token.address, endpoint: 'token_info', error: String(err) });
    return null;
  }

  let candles: KlineCandle[];
  try {
    const from = token.open_timestamp;
    const to = nowUnix();
    candles = await client.getTokenKline(token.address, config.klineResolution, from, to);
    await sleep(500);
  } catch (err) {
    logger.error('enrichment_failed', { mint: token.address, endpoint: 'token_kline', error: String(err) });
    return null;
  }

  let smartHolders: HolderWallet[];
  try {
    smartHolders = await client.getSmartMoneyHolders(token.address, 20);
    await sleep(500);
  } catch (err) {
    logger.warn('enrichment_failed', { mint: token.address, endpoint: 'smart_money_holders', error: String(err) });
    smartHolders = [];
  }

  // ── Compute signals ───────────────────────────────────────────────────────

  const currentPrice = parseFloat(info.price.price);
  const price5m = parseFloat(info.price.price_5m);
  const price1h = parseFloat(info.price.price_1h);
  const migrationPrice = info.migration_market_cap > 0 && token.usd_market_cap > 0
    ? currentPrice * (info.migration_market_cap / token.usd_market_cap)
    : currentPrice;

  const dip = scoreDipRecovery(
    candles,
    currentPrice,
    config.klineResolution,
    config.lowZoneMinMinutes,
    config.lowZoneMaxMinutes,
    config.recoveryVolumeLookbackMinutes
  );

  const priceChange1h = price1h > 0 ? ((currentPrice - price1h) / price1h) * 100 : 0;
  const nowUnixSecond = nowUnix() / 1000;
  const minutesSinceGrad = Math.round((nowUnixSecond - token.open_timestamp) / 60);
  const priceChangeSinceGrad = migrationPrice > 0 && migrationPrice !== currentPrice
    ? ((currentPrice - migrationPrice) / migrationPrice) * 100
    : 0;

  const momentum = scoreMomentum(
    candles,
    info.price.swaps_1h,
    parseFloat(info.price.buy_volume_1h),
    parseFloat(info.price.sell_volume_1h),
    priceChangeSinceGrad,
    priceChange1h,
    minutesSinceGrad,
  );

  const smartMoney = scoreSmartMoney(smartHolders);

  // ── Composite score ───────────────────────────────────────────────────────

  const composite =
    dip.score * 0.35 +
    momentum.score * 0.35 +
    smartMoney.score * 0.30;

  const scores: AllSignalScores = { composite, dip, momentum, smartMoney };

  // ── Persist scores ────────────────────────────────────────────────────────

  insertSignalScores({
    mintAddress: token.address,
    dipScore: dip.score,
    momentumScore: momentum.score,
    smartMoneyScore: smartMoney.score,
    compositeScore: composite,
    dipDetails: {
      athPrice: dip.athPrice,
      dipFromAthPct: dip.dipFromAthPct,
      lowZoneCandles: dip.lowZoneCandles,
      volumeRecoveryPct: dip.volumeRecoveryPct,
    },
    momentumDetails: {
      buyPressureRatio: momentum.buyPressureRatio,
      swaps1h: momentum.swaps1h,
      organicGrowth: momentum.organicGrowth,
      volumeAcceleration: momentum.volumeAcceleration,
      priceChangePct: momentum.priceChangePct,
      priceChangeSinceGrad: momentum.priceChangeSinceGrad,
      priceChange1h: momentum.priceChange1h,
    },
    smartMoneyDetails: {
      smartWalletCount: smartMoney.smartWalletCount,
      totalSmartHoldingPct: smartMoney.totalSmartHoldingPct,
      recentEntry: smartMoney.recentEntry,
      smartWalletsStillHolding: smartMoney.smartWalletsStillHolding,
    },
  });

  logger.info('token_scored', {
    mint: token.address,
    symbol: token.symbol,
    composite: composite.toFixed(1),
    dip: dip.score.toFixed(1),
    momentum: momentum.score.toFixed(1),
    smart_money: smartMoney.score.toFixed(1),
    threshold: config.minScoreToBuy,
  });

  // ── Gate: below threshold → skip ─────────────────────────────────────────

  if (composite < config.minScoreToBuy) {
    logger.warn('token_skipped', {
      mint: token.address,
      symbol: token.symbol,
      reason: 'below_score_threshold',
      composite: composite.toFixed(1),
    });
    return null;
  }

  return { token, info, candles, smartHolders, migrationPrice, scores };
}

export function buildEntryPrompt({ token, info, scores, migrationPrice }: EnrichedToken): string {
  const config = getConfig();

  const nowUnixSecond = nowUnix() / 1000;
  const minutesSinceGrad = Math.round((nowUnixSecond - token.open_timestamp) / 60);
  const currentPrice = parseFloat(info.price.price);
  const priceChangeSinceGrad = migrationPrice > 0
    ? ((currentPrice - migrationPrice) / migrationPrice * 100).toFixed(1)
    : 'N/A';

  return `
Token: ${token.symbol} / ${token.name}
Mint: ${token.address}
Platform: ${token.launchpad_platform}
Graduated: ${minutesSinceGrad} minutes ago
Current Price: $${info.price.price}
Market Cap: $${token.usd_market_cap}
Liquidity: $${info.liquidity}
Holders: ${token.holder_count}

--- SECURITY ---
Rug Ratio: ${token.rug_ratio}
Top 10 Holders: ${(token.top_10_holder_rate * 100).toFixed(1)}% of supply
Developer Status: ${token.creator_token_status === 'creator_hold'
  ? 'Creator still holds tokens'
  : 'Creator holds no tokens'} (${(token.dev_team_hold_rate * 100).toFixed(1)}% of total supply)

--- SIGNAL SCORES ---
Composite: ${scores.composite.toFixed(1)}/100 (threshold: ${config.minScoreToBuy})
Dip Recovery Score: ${scores.dip.score.toFixed(1)}/100
  → ATH since graduation: $${scores.dip.athPrice}
  → Dip from ATH: ${scores.dip.dipFromAthPct.toFixed(1)}%
  → Time in low zone: ${scores.dip.lowZoneCandles} candles
  → Volume recovery: +${scores.dip.volumeRecoveryPct.toFixed(0)}% vs low zone avg
Momentum Score: ${scores.momentum.score.toFixed(1)}/100
  → Buy pressure ratio 1h: ${scores.momentum.buyPressureRatio.toFixed(2)} (>0.55 = buyer dominant)
  → Swaps 1h: ${scores.momentum.swaps1h}
  → Organic growth: ${scores.momentum.organicGrowth} (false if pump >${150}% or extreme candle spike)
  → Volume acceleration: ${scores.momentum.volumeAcceleration.toFixed(2)}x (last 3 vs prior 3 candles)
  → Price change (${minutesSinceGrad < 60 ? 'since graduation' : '1h'}): ${scores.momentum.priceChangePct.toFixed(1)}%
Smart Money Score: ${scores.smartMoney.score.toFixed(1)}/100
  → Smart wallets holding: ${scores.smartMoney.smartWalletCount}
  → Combined supply held: ${(scores.smartMoney.totalSmartHoldingPct * 100).toFixed(1)}%
  → Recent entry (<30min): ${scores.smartMoney.recentEntry}
  → Still holding: ${scores.smartMoney.smartWalletsStillHolding}

--- PRICE ACTION ---
Price at graduation: $${migrationPrice.toFixed(8)}
Change since graduation: ${scores.momentum.priceChangeSinceGrad.toFixed(1)}%
1h price change: ${scores.momentum.priceChange1h.toFixed(1)}%
1h volume: $${info.price.volume_1h}
1h buy volume: $${info.price.buy_volume_1h}
1h sell volume: $${info.price.sell_volume_1h}
1h swaps: ${info.price.swaps_1h}
Smart money wallets: ${info.wallet_tags_stat.smart_wallets}
KOL wallets: ${info.wallet_tags_stat.renowned_wallets}

Buy 0.1 SOL of this token? Respond in JSON only.
  `.trim();
}
