import { config as loadDotenv } from 'dotenv';
import { homedir } from 'os';
import { join } from 'path';

// Load global config first (~/.config/gmgn/.env), then project .env
loadDotenv({ path: join(homedir(), '.config', 'gmgn', '.env'), override: true });
loadDotenv();

export type KlineResolution = '1m' | '5m' | '15m' | '1h';

export interface Config {
  // GMGN Auth
  gmgnApiKey: string;
  gmgnPrivateKey: string;
  gmgnHost: string;

  // OpenRouter
  openrouterApiKey: string;
  openrouterModel: string;

  // Wallet
  walletAddress: string;

  // Trading Parameters
  tradeSizeSol: number;
  maxConcurrentPositions: number;
  scanIntervalSec: number;
  positionCheckIntervalSec: number;

  // Strategy Thresholds
  minScoreToBuy: number;
  aiConfidenceThreshold: number;
  minDipFromAthPct: number;
  maxDipFromAthPct: number;

  // Exit Parameters (optional)
  trailingActivatePct: number | null;
  trailingDrawdownPct: number | null;
  stopLossPct: number | null;
  maxHoldDurationMinutes: number;

  // Token Filters — Server-side
  minLiquidityUsd: number | null;
  minHolderCount: number;
  maxTop10HolderRate: number | null;
  maxRugRatio: number | null;
  minTokenAge: string;
  maxTokenAge: string;
  minMarketcap: number | null;
  maxMarketcap: number | null;
  minSmartDegenCount: number;
  minRenownedCount: number;
  maxInsiderRatio: number | null;
  maxCreatorBalanceRate: number | null;
  minTotalFee: number | null;

  // Kline Signal Parameters
  klineResolution: KlineResolution;
  lowZoneMinMinutes: number;
  lowZoneMaxMinutes: number;
  recoveryVolumeLookbackMinutes: number;

  // Execution
  slippage: number;
  autoSlippage: boolean;
  antiMev: boolean;

  // Mode
  dryRun: boolean;
}

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) {
    console.error(`[config] Missing required env var: ${key}`);
    process.exit(1);
  }
  return val;
}

function optionalFloat(key: string): number | null {
  const val = process.env[key];
  if (!val || val.trim() === '') return null;
  const num = parseFloat(val);
  if (isNaN(num)) {
    console.error(`[config] Invalid float for ${key}: ${val}`);
    process.exit(1);
  }
  return num;
}

function requireFloat(key: string): number {
  const val = requireEnv(key);
  const num = parseFloat(val);
  if (isNaN(num)) {
    console.error(`[config] Invalid float for ${key}: ${val}`);
    process.exit(1);
  }
  return num;
}

function requireInt(key: string): number {
  const val = requireEnv(key);
  const num = parseInt(val, 10);
  if (isNaN(num)) {
    console.error(`[config] Invalid int for ${key}: ${val}`);
    process.exit(1);
  }
  return num;
}

function parseBool(key: string, defaultVal: boolean): boolean {
  const val = process.env[key];
  if (!val || val.trim() === '') return defaultVal;
  return val.toLowerCase() === 'true';
}

function parseKlineResolution(val: string): KlineResolution {
  if (['1m', '5m', '15m', '1h'].includes(val)) return val as KlineResolution;
  console.error(`[config] Invalid KLINE_RESOLUTION: ${val}. Must be one of: 1m, 5m, 15m, 1h`);
  process.exit(1);
}

let _config: Config | null = null;

export function getConfig(): Config {
  if (_config) return _config;

  const trailingActivatePct = optionalFloat('TRAILING_ACTIVATE_PCT');
  const trailingDrawdownPct = optionalFloat('TRAILING_DRAWDOWN_PCT');

  // Trailing stop pair validation — must be set together
  if (
    (trailingActivatePct !== null && trailingDrawdownPct === null) ||
    (trailingActivatePct === null && trailingDrawdownPct !== null)
  ) {
    console.error(
      '[config] TRAILING_ACTIVATE_PCT and TRAILING_DRAWDOWN_PCT must be set together, or both left empty.'
    );
    process.exit(1);
  }

  _config = {
    // GMGN Auth
    gmgnApiKey: requireEnv('GMGN_API_KEY'),
    gmgnPrivateKey: requireEnv('GMGN_PRIVATE_KEY').replace(/\\n/g, '\n'),
    gmgnHost: 'https://openapi.gmgn.ai',

    // OpenRouter
    openrouterApiKey: requireEnv('OPENROUTER_API_KEY'),
    openrouterModel: process.env['OPENROUTER_MODEL'] ?? 'anthropic/claude-3-haiku',

    // Wallet
    walletAddress: requireEnv('WALLET_ADDRESS'),

    // Trading
    tradeSizeSol: requireFloat('TRADE_SIZE_SOL'),
    maxConcurrentPositions: requireInt('MAX_CONCURRENT_POSITIONS'),
    scanIntervalSec: requireInt('SCAN_INTERVAL_SEC'),
    positionCheckIntervalSec: requireInt('POSITION_CHECK_INTERVAL_SEC'),

    // Strategy
    minScoreToBuy: requireFloat('MIN_SCORE_TO_BUY'),
    aiConfidenceThreshold: requireFloat('AI_CONFIDENCE_THRESHOLD'),
    minDipFromAthPct: requireInt('MIN_DIP_FROM_ATH_PCT'),
    maxDipFromAthPct: requireInt('MAX_DIP_FROM_ATH_PCT'),

    // Exit
    trailingActivatePct,
    trailingDrawdownPct,
    stopLossPct: optionalFloat('STOP_LOSS_PCT'),
    maxHoldDurationMinutes: requireInt('MAX_HOLD_DURATION_MINUTES'),

    // Token Filters
    minLiquidityUsd: optionalFloat('MIN_LIQUIDITY_USD'),
    minHolderCount: parseInt(process.env['MIN_HOLDER_COUNT'] ?? '0', 10),
    maxTop10HolderRate: optionalFloat('MAX_TOP_10_HOLDER_RATE'),
    maxRugRatio: optionalFloat('MAX_RUG_RATIO'),
    minTokenAge: process.env['MIN_TOKEN_AGE'] ?? '',
    maxTokenAge: process.env['MAX_TOKEN_AGE'] ?? '',
    minMarketcap: optionalFloat('MIN_MARKETCAP'),
    maxMarketcap: optionalFloat('MAX_MARKETCAP'),
    minSmartDegenCount: parseInt(process.env['MIN_SMART_DEGEN_COUNT'] ?? '0', 10),
    minRenownedCount: parseInt(process.env['MIN_RENOWNED_COUNT'] ?? '0', 10),
    maxInsiderRatio: optionalFloat('MAX_INSIDER_RATIO'),
    maxCreatorBalanceRate: optionalFloat('MAX_CREATOR_BALANCE_RATE'),
    minTotalFee: optionalFloat('MIN_TOTAL_FEE'),

    // Kline
    klineResolution: parseKlineResolution(process.env['KLINE_RESOLUTION'] ?? '5m'),
    lowZoneMinMinutes: requireInt('LOW_ZONE_MIN_MINUTES'),
    lowZoneMaxMinutes: requireInt('LOW_ZONE_MAX_MINUTES'),
    recoveryVolumeLookbackMinutes: requireInt('RECOVERY_VOLUME_LOOKBACK_MINUTES'),

    // Execution
    slippage: requireFloat('SLIPPAGE'),
    autoSlippage: parseBool('AUTO_SLIPPAGE', false),
    antiMev: parseBool('ANTI_MEV', true),

    // Mode
    dryRun: parseBool('DRY_RUN', true),
  };

  return _config;
}

// Kline resolution to minutes mapping
export const RESOLUTION_MINUTES: Record<KlineResolution, number> = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '1h': 60,
};

// Convert minutes to candle count based on resolution
export function toCandles(minutes: number, resolution: KlineResolution): number {
  return Math.floor(minutes / RESOLUTION_MINUTES[resolution]);
}
