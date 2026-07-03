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
} from "../signals/dip-recovery.ts";
import {
  scorePriceAction,
  type PriceActionSignal,
} from "../signals/price-action.ts";
import {
  scoreVolumeSurge,
  type VolumeSurgeSignal,
} from "../signals/volume-surge.ts";
import {
  scoreSmartMoney,
  type SmartMoneySignal,
} from "../signals/smart-money.ts";
import { unixMillis } from "../utils/math.ts";
import { sleep } from "../utils/retry.ts";

export interface AllSignalScores {
  composite: number;
  dip: DipRecoverySignal;
  priceAction: PriceActionSignal;
  volumeSurge: VolumeSurgeSignal;
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

  // ── Step 1: Smart Money Primary Gate (no API call needed) ────────────────
  // Hitung smart money duluan — datanya sudah ada di candidate.trades, tidak
  // perlu API call. Gate ini dipasang SEBELUM fetch token_info dan kline supaya
  // kita tidak buang 2 API call untuk token yang pasti ditolak.
  //
  // Syarat minimum: minimal 2 distinct followed wallet dengan hot (<5m) ATAU
  // fresh (<20m) entry. Valid-only (20-40m) tidak cukup — terlalu stale.
  const smartMoney = scoreSmartMoney(candidate.trades);
  const hotFreshCount = smartMoney.hotEntryCount + smartMoney.freshEntryCount;

  if (hotFreshCount < 2) {
    logger.warn("token_skipped", {
      mint: mintAddress,
      symbol: candidate.symbol,
      reason: "smart_money_primary_gate_failed",
      hot_entry_count: smartMoney.hotEntryCount,
      fresh_entry_count: smartMoney.freshEntryCount,
      best_window: smartMoney.bestEntryWindow,
    });
    return null;
  }

  // ── Step 2: Fetch enrichment data ────────────────────────────────────────

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
    const candleCount = 21; // fixed window — cukup untuk price-action (8) & dip-recovery (6) komponen non-ATH
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

  // ── Step 3: Compute signals ───────────────────────────────────────────────
  // Urutan penting: priceAction dihitung dulu karena volumeSurge butuh
  // priceChange5m-nya sebagai parameter (lihat catatan di signals/volume-surge.ts)
  // supaya tidak ada dua definisi "price change 5m" yang bisa saling kontradiksi.

  const dip = scoreDipRecovery(candles, info);
  const priceAction = scorePriceAction(candles, info.price);
  const volumeSurge = scoreVolumeSurge(candles, info.price, priceAction.priceChange5m);

  // ── Step 4: Composite score ───────────────────────────────────────────────

  const composite =
    dip.score * config.weightDip +
    priceAction.score * config.weightPriceAction +
    volumeSurge.score * config.weightVolumeSurge +
    smartMoney.score * config.weightSmartMoney;

  // ── Step 5: FOMO Gate ──────────────────────────────────────────────────────
  // Sinyal FOMO sekarang datang dari DUA sumber independen:
  //  - priceAction.isLateEntry (price sudah pump ekstrem dalam 5m)
  //  - volumeSurge.isSuspectedFomo (surge volume tinggi TAPI muncul setelah pump)
  // Kalau salah satu true DAN smart money masih lemah, ini pola hype/FOMO
  // retail — bukan alpha genuine dari smart money masuk lebih dulu.
  const FOMO_SM_WEAK_THRESHOLD = 40;
  const fomoSignalTriggered = priceAction.isLateEntry || volumeSurge.isSuspectedFomo;
  const fomoGateTriggered =
    fomoSignalTriggered && smartMoney.score < FOMO_SM_WEAK_THRESHOLD;

  const compositeAfterFomoGate = fomoGateTriggered ? composite * 0.35 : composite;

  // ── Step 6: Smart Money Score Hard Gate ──────────────────────────────────
  const SM_SCORE_MIN = 65;
  const smartMoneyGateFailed = smartMoney.score < SM_SCORE_MIN;
  const compositeAfterGate = smartMoneyGateFailed ? 0 : compositeAfterFomoGate;

  const scores: AllSignalScores = {
    composite: compositeAfterGate,
    dip,
    priceAction,
    volumeSurge,
    smartMoney,
  };

  // ── Persist scores ────────────────────────────────────────────────────────

  insertSignalScores({
    mintAddress,
    dipScore: dip.score,
    priceActionScore: priceAction.score,
    volumeSurgeScore: volumeSurge.score,
    smartMoneyScore: smartMoney.score,
    compositeScore: compositeAfterGate,
    dipDetails: {
      athPrice: dip.athPrice,
      dipFromAthPct: dip.dipFromAthPct,
      isInSweetSpot: dip.isInSweetSpot,
      hasLowerLow: dip.hasLowerLow,
      isDowntrendSlowing: dip.isDowntrendSlowing,
      buyVolumeRatio5m: dip.buyVolumeRatio5m,
      buyTxRatio5m: dip.buyTxRatio5m,
      buyerDominance: dip.buyerDominance,
      hasRejectionWick: dip.hasRejectionWick,
      recentBouncePct: dip.recentBouncePct,
      isDeadCatBounce: dip.isDeadCatBounce,
    },
    priceActionDetails: {
      priceChange5m: priceAction.priceChange5m,
      priceChange15m: priceAction.priceChange15m,
      priceChange1h: priceAction.priceChange1h,
      greenCandlePct: priceAction.greenCandlePct,
      hasStrongBullCandle: priceAction.hasStrongBullCandle,
      hasRejectionWick: priceAction.hasRejectionWick,
      isLateEntry: priceAction.isLateEntry,
      fomoPenalty: priceAction.fomoPenalty,
      momentumLevel: priceAction.momentumLevel,
      isBullish: priceAction.isBullish,
      isStable: priceAction.isStable,
    },
    volumeSurgeDetails: {
      surgeRatio: volumeSurge.surgeRatio,
      buyDominance: volumeSurge.buyDominance,
      buyTxRatio: volumeSurge.buyTxRatio,
      swaps5m: volumeSurge.swaps5m,
      volumeAcceleration: volumeSurge.volumeAcceleration,
      isExplosive: volumeSurge.isExplosive,
      isStrong: volumeSurge.isStrong,
      isHealthy: volumeSurge.isHealthy,
      isSuspectedFomo: volumeSurge.isSuspectedFomo,
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
      totalSolInvested: smartMoney.totalSolInvested,
    },
  });

  logger.info("token_scored", {
    mint: mintAddress,
    symbol: candidate.symbol,
    composite: compositeAfterGate.toFixed(1),
    composite_raw: composite.toFixed(1),
    dip: dip.score.toFixed(1),
    price_action: priceAction.score.toFixed(1),
    volume_surge: volumeSurge.score.toFixed(1),
    smart_money: smartMoney.score.toFixed(1),
    threshold: config.minScoreToBuy,
    fomo_gate_triggered: fomoGateTriggered,
    smart_money_gate_failed: smartMoneyGateFailed,
    is_late_entry: priceAction.isLateEntry,
    is_suspected_fomo: volumeSurge.isSuspectedFomo,
    price_change_5m: priceAction.priceChange5m.toFixed(1),
  });

  // ── Gate: below threshold → skip ─────────────────────────────────────────

  if (compositeAfterGate < config.minScoreToBuy) {
    const reason = smartMoneyGateFailed
      ? "smart_money_score_below_minimum"
      : fomoGateTriggered
        ? "fomo_gate_high_momentum_low_smart_money"
        : "below_score_threshold";

    logger.warn("token_skipped", {
      mint: mintAddress,
      symbol: candidate.symbol,
      reason,
      composite: compositeAfterGate.toFixed(1),
      smart_money_score: smartMoney.score.toFixed(1),
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
  const pa = scores.priceAction;
  const vs = scores.volumeSurge;
  const dip = scores.dip;
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

Dip Recovery Score: ${dip.score.toFixed(1)}/100
  → All-time high price: $${dip.athPrice}
  → Dip from ATH: ${dip.dipFromAthPct.toFixed(1)}% ${dip.isInSweetSpot ? "✅ in sweet spot (55-75%)" : ""}
  → Downtrend slowing: ${dip.isDowntrendSlowing} (false = still making lower lows)
  → Buyer dominance: ${dip.buyerDominance.toFixed(2)} (>0.65 = strong)
  → Rejection wick at low: ${dip.hasRejectionWick}
  → Recent bounce from low: ${dip.recentBouncePct.toFixed(1)}%
  → Dead cat bounce risk: ${dip.isDeadCatBounce ? "⚠️ YES" : "No"}

Price Action Score: ${pa.score.toFixed(1)}/100
  → Price change 5m: ${pa.priceChange5m.toFixed(1)}% ${pa.isLateEntry ? "⚠️ LATE ENTRY — price already pumped" : "(healthy range)"}
  → Price change 15m: ${pa.priceChange15m.toFixed(1)}%
  → Price change 1h: ${pa.priceChange1h.toFixed(1)}%
  → Momentum level: ${pa.momentumLevel}
  → Green candles: ${pa.greenCandlePct.toFixed(0)}% of recent 8
  → Strong bull candle: ${pa.hasStrongBullCandle}
  ${pa.fomoPenalty > 0 ? `→ FOMO penalty applied: -${pa.fomoPenalty.toFixed(0)} pts (price moved >50% in 5m — historically correlated with -30% to -55% losses on this agent)` : ""}

Volume Surge Score: ${vs.score.toFixed(1)}/100
  → Surge ratio: ${vs.surgeRatio.toFixed(2)}x (volume_5m vs avg 5m in 1h)
  → Buy dominance: ${vs.buyDominance.toFixed(2)} (>0.65 = buyers in control)
  → Volume acceleration: ${vs.volumeAcceleration.toFixed(2)}x (last 3 vs prior 3 candles)
  → Swaps 5m: ${vs.swaps5m}
  → Classification: ${vs.isExplosive ? "🔥 EXPLOSIVE" : vs.isStrong ? "✅ STRONG" : vs.isHealthy ? "🟢 HEALTHY" : "⚪ WEAK"}
  ${vs.isSuspectedFomo ? "→ ⚠️ SUSPECTED FOMO: high surge but price already pumped — this volume may be retail chasing, not smart entry" : ""}

Smart Money Score: ${sm.score.toFixed(1)}/100
  → Distinct followed wallets bought this token: ${sm.distinctWalletCount}
  → Total SOL invested by followed wallets: ${sm.totalSolInvested.toFixed(2)} SOL
  → Recent entries (within 40m): ${sm.recentEntryCount} (best window: ${sm.bestEntryWindow})${allExited ? " ⚠️ entries are stale — no recent activity" : ""}
  → Entry window breakdown: hot <5m=(${sm.hotEntryCount}) fresh 5–20m=(${sm.freshEntryCount}) valid 20–40m=(${sm.validEntryCount})
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

--- 5M PRICE ACTION (raw) ---
5m volume: $${info.price.volume_5m}
5m buy volume: $${info.price.buy_volume_5m}
5m sell volume: $${info.price.sell_volume_5m}
5m swaps: ${info.price.swaps_5m}

--- 1H PRICE ACTION (raw) ---
1h volume: $${info.price.volume_1h}
1h buy volume: $${info.price.buy_volume_1h}
1h sell volume: $${info.price.sell_volume_1h}
1h swaps: ${info.price.swaps_1h}

--- ENTRY TIMING CHECK (READ CAREFULLY) ---
This agent has a documented history of buying at local tops — entering after a
token already pumped, then losing 30–55% as price reverted. Price moves above
+50% within 5 minutes are the single strongest predictor of this failure mode.

Before answering BUY, explicitly check:
1. Has the price already moved sharply in the last 5 minutes? If yes, the easy
   gains are likely already gone.
2. Is momentum being driven by smart money (Smart Money Score) or by generic
   volume/hype (Volume Surge isSuspectedFomo)? High volume surge + low/no
   smart money entries is a FOMO pattern, not an alpha signal.
3. Would you rather enter when momentum is just starting than when it's
   already large?

If price change 5m is already large and smart money confirmation is weak,
default to SKIP or WAIT even if the composite score crossed the threshold.

Buy ${config.tradeSizeSol} SOL of this token? Respond in JSON only.
  `.trim();
}
