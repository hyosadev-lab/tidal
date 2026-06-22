import {
  getGmgnClient,
  type TokenInfo,
  type KlineCandle,
} from "../services/gmgn-client.ts";
import { type ScanCandidate } from "./scanner.ts";
import { getConfig, RESOLUTION_MINUTES } from "../config.ts";
import { logger } from "../utils/logger.ts";
import { insertSignalScores } from "../db/queries.ts";
import {
  scoreDipRecovery,
  type DipRecoverySignal,
} from "../strategies/dip-recovery.ts";
import { scoreMomentum, type MomentumSignal } from "../strategies/momentum.ts";
import {
  scoreSmartMoney,
  type SmartMoneySignal,
} from "../strategies/smart-money.ts";
import { unixMillis, unixSeconds } from "../utils/math.ts";
import { sleep } from "../utils/retry.ts";

export interface AllSignalScores {
  composite: number;
  dip: DipRecoverySignal;
  momentum: MomentumSignal;
  smartMoney: SmartMoneySignal;
}

export interface EnrichedToken {
  candidate: ScanCandidate;
  info: TokenInfo;
  candles: KlineCandle[];
  scores: AllSignalScores;
}

export async function enrichAndScore(
  candidate: ScanCandidate,
): Promise<EnrichedToken | null> {
  const config = getConfig();
  const client = getGmgnClient();
  const mintAddress = candidate.mintAddress;

  // ── Fetch enrichment data ─────────────────────────────────────────────────
  // Catatan: smart-money signal TIDAK di-fetch ulang di sini — datanya sudah
  // didapat di scan loop (follow_wallet trades), diteruskan lewat `candidate`.

  let info: TokenInfo;
  try {
    info = await client.getTokenInfo(mintAddress);
    await sleep(500);
  } catch (err) {
    logger.error("enrichment_failed", {
      mint: mintAddress,
      endpoint: "token_info",
      error: String(err),
    });
    return null;
  }

  let candles: KlineCandle[];
  try {
    const candleCount = 21; // fixed window — cukup untuk momentum (8) & dip-recovery (6) komponen non-ATH
    const candleToTime =
      candleCount * RESOLUTION_MINUTES[config.klineResolution] * 60 * 1000;

    const to = unixMillis();
    const from = to - candleToTime;
    candles = await client.getTokenKline(
      mintAddress,
      config.klineResolution,
      from,
      to,
    );

    await sleep(500);
  } catch (err) {
    logger.error("enrichment_failed", {
      mint: mintAddress,
      endpoint: "token_kline",
      error: String(err),
    });
    return null;
  }

  // ── Compute signals ───────────────────────────────────────────────────────

  const dip = scoreDipRecovery(candles, info);

  const momentum = scoreMomentum(candles, info.price);

  // Smart money signal dihitung dari trade yang sudah dikumpulkan di scan loop —
  // tidak ada API call tambahan di sini.
  const smartMoney = scoreSmartMoney(candidate.trades);

  // ── Composite score ───────────────────────────────────────────────────────

  const composite =
    dip.score * 0.3 + momentum.score * 0.3 + smartMoney.score * 0.4;

  const scores: AllSignalScores = { composite, dip, momentum, smartMoney };

  // ── Persist scores ────────────────────────────────────────────────────────

  insertSignalScores({
    mintAddress,
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
      surgeRatio: momentum.surgRatio,
      buyDominance: momentum.buyDominance,
      volumeAcceleration: momentum.volumeAcceleration,
      priceMomentum5m: momentum.priceMomentum5m,
      greenCandlePct: momentum.greenCandlePct,
      swaps5m: momentum.swaps5m,
    },
    smartMoneyDetails: {
      distinctWalletCount: smartMoney.distinctWalletCount,
      hasFollowedEntry: smartMoney.hasFollowedEntry,
      recentEntry: smartMoney.recentEntry,
      recentEntryCount: smartMoney.recentEntryCount,
      hotEntryCount: smartMoney.hotEntryCount,
      freshEntryCount: smartMoney.freshEntryCount,
      validEntryCount: smartMoney.validEntryCount,
      bestEntryWindow: smartMoney.bestEntryWindow,
      fullOpenCount: smartMoney.fullOpenCount,
      partialAddCount: smartMoney.partialAddCount,
    },
  });

  logger.info("token_scored", {
    mint: mintAddress,
    symbol: candidate.symbol,
    composite: composite.toFixed(1),
    dip: dip.score.toFixed(1),
    momentum: momentum.score.toFixed(1),
    smart_money: smartMoney.score.toFixed(1),
    threshold: config.minScoreToBuy,
  });

  // ── Gate: below threshold → skip ─────────────────────────────────────────

  if (composite < config.minScoreToBuy) {
    logger.warn("token_skipped", {
      mint: mintAddress,
      symbol: candidate.symbol,
      reason: "below_score_threshold",
      composite: composite.toFixed(1),
    });
    return null;
  }

  return { candidate, info, candles, scores };
}

export function buildEntryPrompt({
  candidate,
  info,
  scores,
}: EnrichedToken): string {
  const config = getConfig();

  const currentPrice = parseFloat(info.price.price);
  const sm = scores.smartMoney;
  const allExited =
    sm.hasFollowedEntry &&
    sm.recentEntryCount === 0 &&
    sm.distinctWalletCount > 0;

  return `
Token: ${candidate.symbol}
Mint: ${candidate.mintAddress}
Current Price: $${currentPrice.toFixed(8)}
Liquidity: $${info.liquidity}
Holders: ${info.stat.holder_count}

--- SECURITY ---
Top 10 Holders: ${(info.stat.top_10_holder_rate * 100).toFixed(1)}% of supply
Developer Status: ${
    info.dev.creator_token_status === "creator_hold"
      ? "Creator still holds tokens ⚠️"
      : "Creator holds no tokens ✅"
  }

--- SIGNAL SCORES ---
Composite: ${scores.composite.toFixed(1)}/100 (threshold: ${config.minScoreToBuy})
Dip Recovery Score: ${scores.dip.score.toFixed(1)}/100
  → All-time high price: $${scores.dip.athPrice}
  → Dip from ATH: ${scores.dip.dipFromAthPct.toFixed(1)}%
  → Lower low forming: ${scores.dip.hasLowerLow} (false = downtrend slowing)
  → Buy volume ratio 5m: ${scores.dip.buyVolumeRatio5m.toFixed(2)} (>0.60 = buyers dominant)
  → Buy tx ratio 5m: ${scores.dip.buyTxRatio5m.toFixed(2)} (>0.60 = more buyers than sellers)
Momentum Score: ${scores.momentum.score.toFixed(1)}/100
  → Volume surge ratio: ${scores.momentum.surgRatio.toFixed(2)}x (volume_5m vs avg 5m in 1h; >=4.0x = explosion)
  → Buy dominance 5m: ${scores.momentum.buyDominance.toFixed(2)} (>0.65 = buyers in control)
  → Volume acceleration: ${scores.momentum.volumeAcceleration.toFixed(2)}x (last 3 vs prior 3 candles)
  → Price change 5m: ${scores.momentum.priceMomentum5m.toFixed(1)}% (+20% = max score)
  → Green candles: ${scores.momentum.greenCandlePct.toFixed(0)}% of recent 8 candles
  → Swaps 5m: ${scores.momentum.swaps5m} (>= 100 = very active)
Smart Money Score: ${sm.score.toFixed(1)}/100
  → Distinct followed wallets bought this token: ${sm.distinctWalletCount}
  → Recent entries (within 45m): ${sm.recentEntryCount} (best window: ${sm.bestEntryWindow})${allExited ? " ⚠️ entries are stale — no recent activity" : ""}
  → Entry window breakdown: hot <5m=(${sm.hotEntryCount}) fresh 5–25m=(${sm.freshEntryCount}) valid 25–45m=(${sm.validEntryCount})
  → Conviction: full position opens=(${sm.fullOpenCount}) partial adds=(${sm.partialAddCount})
  → Cluster signal: ${
    sm.recentEntryCount >= 3
      ? "🔥 HIGH CONVICTION (3+ followed wallets)"
      : sm.recentEntryCount === 2
        ? "✅ GOOD SIGNAL (2 followed wallets)"
        : sm.recentEntryCount === 1
          ? "⚠️ WEAK SIGNAL (1 followed wallet)"
          : sm.distinctWalletCount > 0
            ? "⏳ STALE — followed wallets bought but entry window passed"
            : "❌ NO FOLLOWED WALLET ENTRY"
  }

--- 5M PRICE ACTION ---
${(() => {
  const p5m = parseFloat(info.price.price_5m);
  const pct5m =
    p5m > 0 ? (((currentPrice - p5m) / p5m) * 100).toFixed(1) : "N/A";
  return `5m price change: ${pct5m}%`;
})()}
5m volume: $${info.price.volume_5m}
5m buy volume: $${info.price.buy_volume_5m}
5m sell volume: $${info.price.sell_volume_5m}
5m swaps: ${info.price.swaps_5m}

--- 1H PRICE ACTION ---
${(() => {
  const p1h = parseFloat(info.price.price_1h);
  const pct1h =
    p1h > 0 ? (((currentPrice - p1h) / p1h) * 100).toFixed(1) : "N/A";
  return `1h price change: ${pct1h}%`;
})()}
1h volume: $${info.price.volume_1h}
1h buy volume: $${info.price.buy_volume_1h}
1h sell volume: $${info.price.sell_volume_1h}
1h swaps: ${info.price.swaps_1h}

Buy ${config.tradeSizeSol} SOL of this token? Respond in JSON only.
  `.trim();
}
