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
    dip.score * 1 +
    momentum.score * 0 +
    smartMoney.score * 0;

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
      smartWalletCount: smartMoney.smartWalletCount,
      activeSmartWalletCount: smartMoney.activeSmartWalletCount,
      totalSmartHoldingPct: smartMoney.totalSmartHoldingPct,
      avgSolBalance: smartMoney.avgSolBalance,
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
  const minutesSinceGrad = Math.round((nowUnixSecond - token.complete_timestamp) / 60);

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
  : 'Creator holds no tokens ✅'} (${(token.dev_team_hold_rate * 100).toFixed(1)}% of total supply)

--- SIGNAL SCORES ---
Composite: ${scores.composite.toFixed(1)}/100 (threshold: ${config.minScoreToBuy})
Dip Recovery Score: ${scores.dip.score.toFixed(1)}/100
  → ATH since graduation: $${scores.dip.athPrice}
  → Dip from ATH: ${scores.dip.dipFromAthPct.toFixed(1)}%
  → Lower low forming: ${scores.dip.hasLowerLow} (false = downtrend slowing)
  → Buy volume ratio 5m: ${scores.dip.buyVolumeRatio5m.toFixed(2)} (>0.60 = buyers dominant)
  → Buy tx ratio 5m: ${scores.dip.buyTxRatio5m.toFixed(2)} (>0.60 = more buyers than sellers)
Momentum Score: ${scores.momentum.score.toFixed(1)}/100
  → Buy pressure ratio 5m: ${scores.momentum.buyPressureRatio5m.toFixed(2)} (>0.60 = buyers dominant)
  → Swaps 5m: ${scores.momentum.swaps5m} (>= 50 = active)
  → Volume acceleration: ${scores.momentum.volumeAcceleration.toFixed(2)}x (last 3 vs prior 3 candles)
  → Green candles: ${scores.momentum.greenCandlePct.toFixed(0)}% of recent 6 candles
Smart Money Score: ${scores.smartMoney.score.toFixed(1)}/100
  → Total smart wallets: ${scores.smartMoney.smartWalletCount} (active: ${scores.smartMoney.activeSmartWalletCount})
  → Combined supply held: ${(scores.smartMoney.totalSmartHoldingPct * 100).toFixed(1)}%
  → Avg SOL balance: ${scores.smartMoney.avgSolBalance.toFixed(2)} SOL
  → Recent entry (<1min): ${scores.smartMoney.recentEntry}
  → Still holding: ${scores.smartMoney.smartWalletsStillHolding}

--- PRICE ACTION ---
Price at graduation: $${migrationPrice.toFixed(8)}
1h price change: ${info.price.price_1h}%
1h volume: $${info.price.volume_1h}
1h buy volume: $${info.price.buy_volume_1h}
1h sell volume: $${info.price.sell_volume_1h}
1h swaps: ${info.price.swaps_1h}
Smart money wallets: ${info.wallet_tags_stat.smart_wallets}
KOL wallets: ${info.wallet_tags_stat.renowned_wallets}

Buy 0.1 SOL of this token? Respond in JSON only.
  `.trim();
}
