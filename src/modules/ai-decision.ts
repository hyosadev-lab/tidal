import { getConfig } from "../config.ts";
import { type Position, getSignalScoreById } from "../db/queries.ts";
import { type TokenInfo } from "../services/gmgn-client.ts";
import { type EnrichedToken } from "./scorer.ts";
import { computePnlPct, minutesSince } from "../utils/math.ts";

export type UserPromptObject = {
  type: string;
  text?: string;
};

export type UserPromptPayload = UserPromptObject[];

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
  solPriceUsd: number,
): PositionSnapshot {
  const price = parseFloat(info.price.price);
  const buys1h = info.price.buys_1h ?? 0;
  const sells1h = info.price.sells_1h ?? 0;
  const volume1h = parseFloat(info.price.volume_1h);
  const buyVolume1h = parseFloat(info.price.buy_volume_1h);
  const sellVolume1h = parseFloat(info.price.sell_volume_1h);
  const buySellRatio1h =
    buys1h + sells1h > 0 ? buys1h / (buys1h + sells1h) : 0.5;

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
    devStatus: info.dev?.creator_token_status ?? "unknown",
    devHoldRate: info.stat?.creator_hold_rate ?? 0,
    ratTraderPct: info.stat?.top_rat_trader_percentage ?? 0,
    ctoFlag: info.dev?.cto_flag ?? 0,
    pnlPct,
    pnlUsd,
    holdMinutes,
  };
}

export function buildPositionPrompt(
  position: Position,
  snap: PositionSnapshot,
): UserPromptPayload {
  const config = getConfig();

  const holderDropPct = position.entry_holder_count
    ? ((position.entry_holder_count - snap.holderCount) / position.entry_holder_count) * 100
    : 0;
  const smDelta = snap.smartWalletCount - (position.entry_smart_wallet_count ?? 0);

  // ── Entry signal snapshot via FK (bisa null untuk posisi lama/pre-migrasi) ──
  let entrySignals: Record<string, unknown> | null = null;
  if (position.entry_signal_score_id != null) {
    const row = getSignalScoreById(position.entry_signal_score_id);
    if (row) {
      entrySignals = {
        compositeScore: row.composite_score,
        dipScore: row.dip_score,
        priceActionScore: row.price_action_score,
        volumeSurgeScore: row.volume_surge_score,
        smartMoneyScore: row.smart_money_score,
        smartMoneyDetailsAtEntry: JSON.parse(row.smart_money_details),
        priceActionDetailsAtEntry: JSON.parse(row.price_action_details),
      };
    }
  }

  // ── Structured flags — data mentah, bukan kalimat jadi. AI yang menyusun
  // reasoning-nya sendiri dari angka, bukan membaca kesimpulan yang sudah dibakar. ──
  const flags: Array<Record<string, unknown>> = [];

  if (snap.volume1h < 5000) {
    flags.push({ type: "volume_collapse", severity: "high", volume1hUsd: snap.volume1h });
  }
  if (snap.buySellRatio1h < 0.4) {
    flags.push({ type: "sell_pressure", severity: "medium", buySellRatio1h: snap.buySellRatio1h });
  }
  if (smDelta <= -2) {
    flags.push({
      type: "smart_money_exit",
      severity: "high",
      smartWalletCountAtEntry: position.entry_smart_wallet_count,
      smartWalletCountNow: snap.smartWalletCount,
      delta: smDelta,
    });
  }
  if (holderDropPct >= 10) {
    flags.push({
      type: "holder_distribution",
      severity: "medium",
      holderCountAtEntry: position.entry_holder_count,
      holderCountNow: snap.holderCount,
      dropPct: holderDropPct,
    });
  }
  if (snap.devStatus === "creator_hold" && snap.devHoldRate > 0.05) {
    flags.push({ type: "dev_still_holds", severity: "medium", devHoldRatePct: snap.devHoldRate * 100 });
  }
  if (snap.ratTraderPct > 0.15) {
    flags.push({ type: "high_rat_trader_activity", severity: "medium", ratTraderPct: snap.ratTraderPct * 100 });
  }
  if (snap.pnlPct <= -20) {
    flags.push({ type: "significant_loss", severity: "high", pnlPct: snap.pnlPct });
  }
  if (snap.holdMinutes > 60 && snap.pnlPct < 5) {
    flags.push({ type: "stale_position", severity: "low", holdMinutes: snap.holdMinutes, pnlPct: snap.pnlPct });
  }

  const payload = {
    position: {
      symbol: position.symbol ?? position.mint_address,
      mintAddress: position.mint_address,
      entryPriceUsd: position.entry_price_usd,
      currentPriceUsd: snap.price,
      pnlPct: snap.pnlPct,
      pnlUsd: snap.pnlUsd,
      holdMinutes: snap.holdMinutes,
    },
    entrySignals, // null kalau posisi lama tanpa signal_score_id — AI harus tangani ini
    market: {
      liquidityUsd: snap.liquidity,
      holderCount: snap.holderCount,
      smartWalletCount: snap.smartWalletCount,
      renownedWalletCount: snap.renownedWalletCount,
      volume1hUsd: snap.volume1h,
      buys1h: snap.buys1h,
      sells1h: snap.sells1h,
      buyVolume1hUsd: snap.buyVolume1h,
      sellVolume1hUsd: snap.sellVolume1h,
      buySellRatio1h: snap.buySellRatio1h,
    },
    changeSinceEntry: {
      holderCountAtEntry: position.entry_holder_count,
      holderCountDeltaPct: -holderDropPct,
      smartWalletCountAtEntry: position.entry_smart_wallet_count,
      smartWalletCountDelta: smDelta,
    },
    risk: {
      devStatus: snap.devStatus,
      devHoldRatePct: snap.devHoldRate * 100,
      ratTraderPct: snap.ratTraderPct * 100,
      ctoFlag: snap.ctoFlag === 1,
    },
    flags,
    exitConfig: {
      trailingStop: config.trailingActivatePct
        ? { activatePct: config.trailingActivatePct, drawdownPct: config.trailingDrawdownPct }
        : null,
      stopLossPct: config.stopLossPct ?? null,
    },
    exitDecisionPrinciples: [
      "Your primary job is judging whether the ORIGINAL entry thesis (entrySignals) is still intact, not just reacting to the current snapshot alone.",
      "flags with severity 'high' should weigh heavily toward SELL, especially smart_money_exit and significant_loss — do not wait for recovery once these appear.",
      "If entrySignals is null, this position predates signal-score tracking — rely on flags and market state only, and be more conservative since you lack the original thesis for comparison.",
      "A smart_money_exit flag means followed wallets that helped justify this entry have already sold — treat this as more urgent than a raw price-based stop loss.",
      "Small certain losses are better than large uncertain ones — do not hold a broken thesis hoping for recovery.",
    ],
  };

  return [
    {
      type: "text",
      text: "Should this position be held or sold now? Answer only with JSON.",
    },
    {
      type: "text",
      text: JSON.stringify(payload, null, 2),
    },
  ];
}

// ─── Entry Prompt ───────────────────────────────────────────────────────────
//
// Format JSON — bukan free-text seperti sebelumnya. Karena scorer.ts tidak
// lagi punya gate (smart money primary gate, FOMO gate, SM hard gate semua
// dihapus atas instruksi eksplisit), field entryTimingGuidance di bawah
// adalah satu-satunya defense anti-FOMO yang tersisa di jalur BUY. Kalau ini
// tidak cukup ketat diikuti AI, tidak ada lagi hard filter di kode yang
// mencegah entry pada token yang sudah pump ekstrem atau smart money lemah.

export function buildEntryPrompt(enriched: EnrichedToken): UserPromptPayload {
  const { candidate, info, scores } = enriched;
  const config = getConfig();

  const currentPrice = parseFloat(info.price.price);
  const sm = scores.smartMoney;
  const pa = scores.priceAction;
  const vs = scores.volumeSurge;
  const dip = scores.dip;

  const payload = {
    token: {
      symbol: candidate.symbol,
      mint: candidate.mintAddress,
      currentPriceUsd: currentPrice,
      liquidityUsd: parseFloat(info.liquidity),
      holderCount: info.stat.holder_count,
    },
    security: {
      top10HolderRatePct: info.stat.top_10_holder_rate * 100,
      developerStatus: info.dev.creator_token_status,
      developerStillHolds: info.dev.creator_token_status === "creator_hold",
    },
    signals: {
      composite: scores.composite,
      dipRecovery: {
        score: dip.score,
        athPriceUsd: dip.athPrice,
        dipFromAthPct: dip.dipFromAthPct,
        isInSweetSpot: dip.isInSweetSpot,
        isDowntrendSlowing: dip.isDowntrendSlowing,
        buyerDominance: dip.buyerDominance,
        hasRejectionWick: dip.hasRejectionWick,
        recentBouncePct: dip.recentBouncePct,
        isDeadCatBounceRisk: dip.isDeadCatBounce,
      },
      priceAction: {
        score: pa.score,
        priceChange5mPct: pa.priceChange5m,
        priceChange15mPct: pa.priceChange15m,
        priceChange1hPct: pa.priceChange1h,
        momentumLevel: pa.momentumLevel,
        isLateEntry: pa.isLateEntry,
        fomoPenaltyApplied: pa.fomoPenalty,
        greenCandlePct: pa.greenCandlePct,
        hasStrongBullCandle: pa.hasStrongBullCandle,
      },
      volumeSurge: {
        score: vs.score,
        surgeRatio: vs.surgeRatio,
        buyDominance: vs.buyDominance,
        volumeAcceleration: vs.volumeAcceleration,
        swaps5m: vs.swaps5m,
        classification: vs.isExplosive
          ? "explosive"
          : vs.isStrong
            ? "strong"
            : vs.isHealthy
              ? "healthy"
              : "weak",
        isSuspectedFomo: vs.isSuspectedFomo,
      },
      smartMoney: {
        score: sm.score,
        distinctWalletCount: sm.distinctWalletCount,
        totalSolInvested: sm.totalSolInvested,
        recentEntryCount: sm.recentEntryCount,
        bestEntryWindow: sm.bestEntryWindow,
        hotEntryCount: sm.hotEntryCount,
        freshEntryCount: sm.freshEntryCount,
        validEntryCount: sm.validEntryCount,
        fullOpenCount: sm.fullOpenCount,
        partialAddCount: sm.partialAddCount,
        exitedWalletCount: sm.exitedWalletCount,
        reducedWalletCount: sm.reducedWalletCount,
        hasRecentSmartMoneyExit: sm.hasRecentSmartMoneyExit,
        clusterSignal:
          sm.recentEntryCount >= 3
            ? "high_conviction"
            : sm.recentEntryCount === 2
              ? "good_signal"
              : sm.recentEntryCount === 1
                ? "weak_signal"
                : sm.distinctWalletCount > 0
                  ? "stale"
                  : "none",
      },
    },
    rawPriceAction: {
      last5m: {
        volumeUsd: parseFloat(info.price.volume_5m),
        buyVolumeUsd: parseFloat(info.price.buy_volume_5m),
        sellVolumeUsd: parseFloat(info.price.sell_volume_5m),
        swaps: info.price.swaps_5m,
      },
      last1h: {
        volumeUsd: parseFloat(info.price.volume_1h),
        buyVolumeUsd: parseFloat(info.price.buy_volume_1h),
        sellVolumeUsd: parseFloat(info.price.sell_volume_1h),
        swaps: info.price.swaps_1h,
      },
    },
    tradeSizeSol: config.tradeSizeSol,
    entryTimingGuidance: [
      "This agent has a documented history of buying at local tops — entering after a token already pumped, then losing 30-55% as price reverted.",
      "priceChange5mPct above +50 is the strongest known predictor of that failure mode.",
      "High volumeSurge score with low smartMoney score (isSuspectedFomo=true) means retail chasing, not smart entry — treat as a negative signal, not confirmation.",
      'Prefer entries where momentumLevel is "early" or "healthy" with fresh/hot smart money entries over entries where momentumLevel is "extended" or "extreme".',
      "If priceChange5mPct is already large and smartMoney confirmation is weak (score < 65 or recentEntryCount < 2), default to SKIP even if composite crossed a typical threshold.",
      "signals.smartMoney only counts wallets whose LATEST action was a buy (still holding). If exitedWalletCount > 0, that many followed wallets already fully sold this exact token recently — this is a red flag even if other wallets are currently buying, since it may indicate early distribution.",
    ],
  };

  return [
    {
      type: "text",
      text: "Buy this token now? Answer only with JSON.",
    },
    {
      type: "text",
      text: JSON.stringify(payload, null, 2),
    },
  ];
}
