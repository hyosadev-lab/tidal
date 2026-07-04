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

/**
 * Tidak ada gate di sini — semua candidate yang berhasil di-fetch akan
 * diteruskan ke AI (buildEntryPrompt di ai-decision.ts) dengan skor mentah
 * apa adanya. Filtering BUY/SKIP sepenuhnya jadi tanggung jawab AI + threshold
 * confidence di index.ts. Return null HANYA kalau fetch API gagal.
 */
export async function enrichAndScore(
  candidate: ScanCandidate,
): Promise<EnrichedToken | null> {
  const config = getConfig();
  const client = getGmgnClient();
  const mintAddress = candidate.mintAddress;

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

  // ── Compute signals ────────────────────────────────────────────────────
  // Urutan tetap: priceAction dulu, karena volumeSurge butuh priceChange5m-nya
  // sebagai parameter (lihat catatan di signals/volume-surge.ts).

  const dip = scoreDipRecovery(candles, info);
  const priceAction = scorePriceAction(candles, info.price);
  const volumeSurge = scoreVolumeSurge(
    candles,
    info.price,
    priceAction.priceChange5m,
  );
  const smartMoney = scoreSmartMoney(candidate.trades);

  const composite =
    dip.score * config.weightDip +
    priceAction.score * config.weightPriceAction +
    volumeSurge.score * config.weightVolumeSurge +
    smartMoney.score * config.weightSmartMoney;

  const scores: AllSignalScores = {
    composite,
    dip,
    priceAction,
    volumeSurge,
    smartMoney,
  };

  // ── Persist scores ────────────────────────────────────────────────────

  insertSignalScores({
    mintAddress,
    dipScore: dip.score,
    priceActionScore: priceAction.score,
    volumeSurgeScore: volumeSurge.score,
    smartMoneyScore: smartMoney.score,
    compositeScore: composite,
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
      exitedWalletCount: smartMoney.exitedWalletCount,
      reducedWalletCount: smartMoney.reducedWalletCount,
      hasRecentSmartMoneyExit: smartMoney.hasRecentSmartMoneyExit,
      totalSolInvested: smartMoney.totalSolInvested,
    },
  });

  logger.info("token_scored", {
    mint: mintAddress,
    symbol: candidate.symbol,
    composite: composite.toFixed(1),
    dip: dip.score.toFixed(1),
    price_action: priceAction.score.toFixed(1),
    volume_surge: volumeSurge.score.toFixed(1),
    smart_money: smartMoney.score.toFixed(1),
    is_late_entry: priceAction.isLateEntry,
    is_suspected_fomo: volumeSurge.isSuspectedFomo,
    price_change_5m: priceAction.priceChange5m.toFixed(1),
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
