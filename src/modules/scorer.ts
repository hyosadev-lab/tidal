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
      const solPriceUsd = await getSolPriceUsd();
      info.migration_market_cap = info.migration_market_cap * solPriceUsd;
    }
    await sleep(500);
  } catch (err) {
    logger.error('enrichment_failed', { mint: token.address, endpoint: 'token_info', error: String(err) });
    return null;
  }

  let candles: KlineCandle[];
  try {
    const from = token.complete_timestamp;
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
  const migrationPrice = info.migration_market_cap > 0 && token.usd_market_cap > 0
    ? currentPrice * (info.migration_market_cap / token.usd_market_cap)
    : currentPrice;

  const dip = scoreDipRecovery(
    candles,
    currentPrice,
    parseFloat(info.price.buy_volume_5m),
    parseFloat(info.price.sell_volume_5m),
    info.price.buys_5m ?? 0,
    info.price.sells_5m ?? 0,
  );

  const momentum = scoreMomentum(
    candles,
    info.price,
  );

  const smartMoney = scoreSmartMoney(smartHolders);

  // ── Composite score ───────────────────────────────────────────────────────

  const composite =
    dip.score * 0.70 +
    momentum.score * 0 +
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
      hasLowerLow: dip.hasLowerLow,
      buyVolumeRatio5m: dip.buyVolumeRatio5m,
      buyTxRatio5m: dip.buyTxRatio5m,
    },
    momentumDetails: {
      buyPressureRatio5m: momentum.buyPressureRatio5m,
      swaps5m: momentum.swaps5m,
      volumeAcceleration: momentum.volumeAcceleration,
      greenCandlePct: momentum.greenCandlePct,
    },
    smartMoneyDetails: {
      trackedWalletCount: smartMoney.trackedWalletCount,
      activeTrackedCount: smartMoney.activeTrackedCount,
      hasTrackedEntry: smartMoney.hasTrackedEntry,
      recentEntry: smartMoney.recentEntry,
      recentEntryCount: smartMoney.recentEntryCount,
      hotEntryCount: smartMoney.hotEntryCount,
      freshEntryCount: smartMoney.freshEntryCount,
      validEntryCount: smartMoney.validEntryCount,
      bestEntryWindow: smartMoney.bestEntryWindow,
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

  const minutesSinceGrad = Math.round((nowUnix() - token.complete_timestamp) / 60);
  const currentPrice = parseFloat(info.price.price);

  const sm = scores.smartMoney;
  const allExited = sm.hasTrackedEntry && sm.activeTrackedCount === 0;

  return `
Token: ${token.symbol} / ${token.name}
Mint: ${token.address}
Platform: ${token.launchpad_platform}
Graduated: ${minutesSinceGrad} minutes ago
Price at graduation: $${migrationPrice.toFixed(8)}
Current Price: $${currentPrice.toFixed(8)}
Market Cap: $${token.usd_market_cap}
Liquidity: $${info.liquidity}
Holders: ${token.holder_count}

--- SECURITY ---
Rug Ratio: ${token.rug_ratio}
Top 10 Holders: ${(token.top_10_holder_rate * 100).toFixed(1)}% of supply
Developer Status: ${token.creator_token_status === 'creator_hold'
  ? 'Creator still holds tokens ⚠️'
  : 'Creator holds no tokens ✅'} (${(token.dev_team_hold_rate * 100).toFixed(1)}% of total supply)

--- SIGNAL SCORES ---
Composite: ${scores.composite.toFixed(1)}/100 (threshold: ${config.minScoreToBuy})
Dip Recovery Score: ${scores.dip.score.toFixed(1)}/100
  → ATH since graduation: $${scores.dip.athPrice}
  → Dip from ATH: ${scores.dip.dipFromAthPct.toFixed(1)}%
  → Lower low forming: ${scores.dip.hasLowerLow} (false = downtrend slowing)
  → Buy volume ratio 5m: ${scores.dip.buyVolumeRatio5m.toFixed(2)} (>0.60 = buyers dominant)
  → Buy tx ratio 5m: ${scores.dip.buyTxRatio5m.toFixed(2)} (>0.60 = more buyers than sellers)
  `+
// Momentum Score: ${scores.momentum.score.toFixed(1)}/100
//   → Buy pressure ratio 5m: ${scores.momentum.buyPressureRatio5m.toFixed(2)} (>0.60 = buyers dominant)
//   → Swaps 5m: ${scores.momentum.swaps5m} (>= 50 = active)
//   → Volume acceleration: ${scores.momentum.volumeAcceleration.toFixed(2)}x (last 3 vs prior 3 candles)
//   → Green candles: ${scores.momentum.greenCandlePct.toFixed(0)}% of recent 6 candles
  `
Smart Money Score: ${sm.score.toFixed(1)}/100
  → Tracked wallets found in token: ${sm.trackedWalletCount}
  → Still holding: ${sm.activeTrackedCount}${allExited ? ' ⚠️ ALL EXITED — bearish' : ''}
  → Recent entries: ${sm.recentEntryCount} (best window: ${sm.bestEntryWindow})
  → Entry window breakdown: hot <5m=(${sm.hotEntryCount}) fresh 5–25m=(${sm.freshEntryCount}) valid 25–45m=(${sm.validEntryCount})
  → Cluster signal: ${
      sm.recentEntryCount >= 3 ? '🔥 HIGH CONVICTION (3+ tracked wallets)' :
      sm.recentEntryCount === 2 ? '✅ GOOD SIGNAL (2 tracked wallets)'     :
      sm.recentEntryCount === 1 ? '⚠️ WEAK SIGNAL (1 tracked wallet)'      :
      sm.activeTrackedCount > 0 ? '⏳ STALE — tracked wallets holding but entry window passed' :
                                  '❌ NO TRACKED WALLET ENTRY'
    }

--- 5M PRICE ACTION ---
${(() => {
  const p5m = parseFloat(info.price.price_5m);
  const pct5m = p5m > 0 ? (((currentPrice - p5m) / p5m) * 100).toFixed(1) : 'N/A';
  return `5m price change: ${pct5m}%`;
})()}
5m volume: $${info.price.volume_5m}
5m buy volume: $${info.price.buy_volume_5m}
5m sell volume: $${info.price.sell_volume_5m}
5m swaps: ${info.price.swaps_5m}

--- 1H PRICE ACTION ---
${(() => {
  const p1h = parseFloat(info.price.price_1h);
  const pct1h = p1h > 0 ? (((currentPrice - p1h) / p1h) * 100).toFixed(1) : 'N/A';
  return `1h price change: ${pct1h}%`;
})()}
1h volume: $${info.price.volume_1h}
1h buy volume: $${info.price.buy_volume_1h}
1h sell volume: $${info.price.sell_volume_1h}
1h swaps: ${info.price.swaps_1h}

Buy ${config.tradeSizeSol} SOL of this token? Respond in JSON only.
  `.trim();
}
