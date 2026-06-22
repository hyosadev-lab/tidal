/**
 * GMGN API client for the trading agent.
 * Ports OpenApiClient.ts + signer.ts from the GMGN reference implementation.
 */

import * as crypto from 'crypto';
import { getConfig } from '../config.ts';
import { logger } from '../utils/logger.ts';
import { CHAIN } from '../utils/math.ts';

// ─── Signer (from signer.ts reference) ───────────────────────────────────────

type SignAlgorithm = 'Ed25519' | 'RSA-SHA256';

function detectAlgorithm(pem: string): SignAlgorithm {
  const key = crypto.createPrivateKey(pem);
  switch (key.asymmetricKeyType) {
    case 'ed25519': return 'Ed25519';
    case 'rsa': return 'RSA-SHA256';
    default:
      throw new Error(`Unsupported key type: ${key.asymmetricKeyType}. Supported: Ed25519, RSA`);
  }
}

function buildAuthQuery(): { timestamp: number; client_id: string } {
  return {
    timestamp: Math.floor(Date.now() / 1000),
    client_id: crypto.randomUUID(),
  };
}

function buildMessage(
  subPath: string,
  queryParams: Record<string, string | number | string[]>,
  body: string,
  timestamp: number
): string {
  const sortedQs = Object.keys(queryParams)
    .sort()
    .flatMap((k) => {
      const v = queryParams[k];
      if (Array.isArray(v)) {
        return [...v].sort().map((item) => `${k}=${item}`);
      }
      return [`${k}=${v}`];
    })
    .join('&');
  return `${subPath}:${sortedQs}:${body}:${timestamp}`;
}

function signMessage(
  message: string,
  privateKeyPem: string,
  algorithm: SignAlgorithm
): string {
  const msgBuf = Buffer.from(message, 'utf-8');
  if (algorithm === 'Ed25519') {
    return crypto.sign(null, msgBuf, privateKeyPem).toString('base64');
  }
  return crypto.sign('sha256', msgBuf, {
    key: privateKeyPem,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  }).toString('base64');
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface StrategyConditionOrder {
  order_type: string;    // 'profit_stop' | 'loss_stop' | 'profit_stop_trace' | 'loss_stop_trace'
  side: string;          // 'sell'
  price_scale?: string;
  sell_ratio: string;
  drawdown_rate?: string;
}

export interface SwapParams {
  chain: string;
  from_address: string;
  input_token: string;
  output_token: string;
  input_amount: string;
  slippage?: number;
  auto_slippage?: boolean;
  is_anti_mev?: boolean;
  priority_fee?: string;
  tip_fee?: string;
  auto_tip_fee?: boolean;
  sell_ratio_type?: string;
  condition_orders?: StrategyConditionOrder[];
}

export interface SwapResponse {
  order_id: string;
  hash: string;
  status: string;
  strategy_order_id?: string;
}

export interface OrderReport {
  price_usd: string;
  input_amount: string;
  input_token_decimals: number;
  output_amount: string;
  output_token_decimals: number;
  gas_usd: string;
}

export interface OrderStatus {
  order_id: string;
  status: string;            // 'pending' | 'processed' | 'confirmed' | 'failed' | 'expired'
  report?: OrderReport;
}

export interface KlineCandle {
  time: number;              // milliseconds
  open: string;
  close: string;
  high: string;
  low: string;
  volume: string;            // USD value
  amount: string;            // token units
}

export interface TokenInfo {
  ath_price:         number;
  price: {
    price:           string;
    ath_price:       string;
    price_1m:        string;
    price_5m:        string;
    price_1h:        string;
    price_6h:        string;
    price_24h:       string;
    buys_1m:         number;
    buys_5m:         number;
    buys_1h:         number;
    buys_6h:         number;
    buys_24h:        number;
    sells_1m:        number;
    sells_5m:        number;
    sells_1h:        number;
    sells_6h:        number;
    sells_24h:       number;
    volume_1m:       string;
    volume_5m:       string;
    volume_1h:       string;
    volume_6h:       string;
    volume_24h:      string;
    buy_volume_1m:   string;
    buy_volume_5m:   string;
    buy_volume_1h:   string;
    buy_volume_6h:   string;
    buy_volume_24h:  string;
    sell_volume_1m:  string;
    sell_volume_5m:  string;
    sell_volume_1h:  string;
    sell_volume_6h:  string;
    sell_volume_24h: string;
    swaps_1m:        number;
    swaps_5m:        number;
    swaps_1h:        number;
    swaps_6h:        number;
    swaps_24h:       number;
    hot_level:       number;
  };
  liquidity: string;
  migration_market_cap: number;
  wallet_tags_stat: {
    smart_wallets: number;
    renowned_wallets: number;
  };
  stat: {
    holder_count: number;
    top_10_holder_rate: number;
    creator_hold_rate: number;
    top_rat_trader_percentage: number;
  };
  dev: {
    creator_token_status: string;
    cto_flag: number;
  };
}

export interface HolderWallet {
  address: string;
  tags: string[];
  amount_percentage: number;
  buy_volume_cur: number;
  sell_volume_cur: number;
  sell_amount_percentage: number;
  start_holding_at: number;
  profit: number;
  realized_profit: number;
  unrealized_profit: number;
  native_balance: string;   // SOL balance in lamports (string)
}

export interface FollowWalletTrade {
  id: string;
  chain: string;
  transaction_hash: string;
  maker: string;                       // followed wallet address
  side: 'buy' | 'sell';
  base_address: string;                // token contract address
  quote_address: string;
  base_amount: string;
  quote_amount: string;
  amount_usd: string;
  cost_usd: string;
  buy_cost_usd: string;
  price: string;
  price_usd: string;
  price_now: string;
  price_change: string;                // ratio vs price at trade time, e.g. "6.66" = +666%
  timestamp: number;                   // unix seconds
  is_open_or_close: number;            // 1 = full open/close, 0 = partial add/reduce
  launchpad: string;
  launchpad_platform: string;
  migrated_pool_exchange: string;
  base_token: {
    symbol: string;
    logo: string;
    hot_level: number;
    total_supply: string;
    token_create_time: number;
    token_open_time: number;
  };
  maker_info: {
    address: string;
    name: string;
    twitter_username: string;
    twitter_name: string;
    tags: string[];
    tag_rank: Record<string, number>;
  };
  balance_info: unknown | null;
}

// ─── GMGN Client ─────────────────────────────────────────────────────────────

const RATE_LIMIT_RETRY_BUFFER_MS = 1000;

class OpenApiError extends Error {
  readonly status: number;
  readonly apiCode?: number | string;
  readonly apiError?: string;
  readonly apiMessage?: string;
  readonly resetAtUnix?: number;

  constructor(params: {
    method: string; path: string; status: number;
    apiCode?: number | string; apiError?: string;
    apiMessage?: string; resetAtUnix?: number;
  }) {
    super(`${params.method} ${params.path} failed: HTTP ${params.status} code=${params.apiCode} error=${params.apiError} message=${params.apiMessage}`);
    this.name = 'OpenApiError';
    this.status = params.status;
    this.apiCode = params.apiCode;
    this.apiError = params.apiError;
    this.apiMessage = params.apiMessage;
    this.resetAtUnix = params.resetAtUnix;
  }
}

function buildUrl(base: string, query: Record<string, string | number | string[]>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (Array.isArray(v)) {
      for (const item of v) params.append(k, item);
    } else {
      params.set(k, String(v));
    }
  }
  return `${base}?${params.toString()}`;
}

function parseRateLimitReset(raw: string | null): number | undefined {
  if (!raw?.trim()) return undefined;
  const parsed = parseInt(raw, 10);
  return isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GmgnClient {
  private readonly apiKey: string;
  private readonly privateKeyPem: string;
  private readonly host: string;
  private readonly algorithm: SignAlgorithm;

  constructor() {
    const config = getConfig();
    this.apiKey = config.gmgnApiKey;
    this.privateKeyPem = config.gmgnPrivateKey;
    this.host = config.gmgnHost;
    this.algorithm = detectAlgorithm(this.privateKeyPem);
  }

  // ── Market Data ────────────────────────────────────────────────────────────

  /**
   * Fetch recent trades from wallets the user follows on the GMGN platform.
   * Uses signed auth (criticalRequest) — the follow list is resolved server-side
   * from the GMGN account bound to the API key. `--wallet` filter is optional
   * and not used here since we want the full follow-list activity.
   */
  async getFollowWallet(params?: {
    side?: 'buy' | 'sell';
    limit?: number;
    minAmountUsd?: number;
    maxAmountUsd?: number;
  }): Promise<FollowWalletTrade[]> {
    const query: Record<string, string | number> = { chain: CHAIN };
    if (params?.side) query['side'] = params.side;
    if (params?.limit) query['limit'] = params.limit;
    if (params?.minAmountUsd != null) query['min_amount_usd'] = params.minAmountUsd;
    if (params?.maxAmountUsd != null) query['max_amount_usd'] = params.maxAmountUsd;

    const data = await this.criticalRequest('GET', '/v1/trade/follow_wallet', query, null) as any;
    return (data?.list ?? []) as FollowWalletTrade[];
  }

  async getTokenInfo(mintAddress: string): Promise<TokenInfo> {
    const data = await this.normalRequest('GET', '/v1/token/info', {
      chain: CHAIN,
      address: mintAddress,
    });
    return data as TokenInfo;
  }

  async getTokenKline(
    mintAddress: string,
    resolution: string,
    from: number,
    to: number
  ): Promise<KlineCandle[]> {
    const data = await this.normalRequest('GET', '/v1/market/token_kline', {
      chain: CHAIN,
      address: mintAddress,
      resolution,
      from,
      to,
    }) as any;
    return (data?.list ?? []) as KlineCandle[];
  }

  async getSmartMoneyHolders(mintAddress: string, limit = 20): Promise<HolderWallet[]> {
    const data = await this.normalRequest('GET', '/v1/market/token_top_holders', {
      chain: CHAIN,
      address: mintAddress,
      tag: 'smart_degen',
      order_by: 'amount_percentage',
      direction: 'desc',
      limit,
    }) as any;
    return (data?.list ?? []) as HolderWallet[];
  }

  async getSmartMoneyTraders(mintAddress: string, limit = 20): Promise<HolderWallet[]> {
    const data = await this.normalRequest('GET', '/v1/market/token_top_traders', {
      chain: CHAIN,
      address: mintAddress,
      tag: 'smart_degen',
      order_by: 'profit',
      direction: 'desc',
      limit,
    }) as any;
    return (data?.list ?? []) as HolderWallet[];
  }

  // ── Trade Execution ────────────────────────────────────────────────────────

  async swap(params: SwapParams): Promise<SwapResponse> {
    const data = await this.criticalRequest('POST', '/v1/trade/swap', {}, params);
    return data as SwapResponse;
  }

  async queryOrder(orderId: string): Promise<OrderStatus> {
    const data = await this.criticalRequest('GET', '/v1/trade/query_order', {
      order_id: orderId,
      chain: CHAIN,
    }, null);
    return data as OrderStatus;
  }

  async cancelStrategyOrder(orderId: string): Promise<void> {
    const config = getConfig();
    await this.criticalRequest('POST', '/v1/trade/strategy/cancel', {}, {
      chain: CHAIN,
      from_address: config.walletAddress,
      order_id: orderId,
    });
  }

  // ── Internal ───────────────────────────────────────────────────────────────


  private async normalRequest(
    method: string,
    subPath: string,
    queryExtra: Record<string, string | number | string[]>,
    body: unknown = null
  ): Promise<unknown> {
    const { timestamp, client_id } = buildAuthQuery();
    const query = { ...queryExtra, timestamp, client_id };
    const url = buildUrl(`${this.host}${subPath}`, query);
    const headers: Record<string, string> = {
      'X-APIKEY': this.apiKey,
      'Content-Type': 'application/json',
    };
    const bodyStr = body !== null ? JSON.stringify(body) : null;

    return this.executeRequest(method, subPath, url, headers, bodyStr, true);
  }

  private async criticalRequest(
    method: string,
    subPath: string,
    queryExtra: Record<string, string | number | string[]>,
    body: unknown
  ): Promise<unknown> {
    const { timestamp, client_id } = buildAuthQuery();
    const query = { ...queryExtra, timestamp, client_id };
    const bodyStr = body !== null ? JSON.stringify(body) : '';
    const message = buildMessage(subPath, query as any, bodyStr, timestamp);
    const signature = signMessage(message, this.privateKeyPem, this.algorithm);
    const url = buildUrl(`${this.host}${subPath}`, query);
    const headers: Record<string, string> = {
      'X-APIKEY': this.apiKey,
      'X-Signature': signature,
      'Content-Type': 'application/json',
    };

    return this.executeRequest(method, subPath, url, headers, bodyStr || null, method !== 'POST');
  }

  private async executeRequest(
    method: string,
    subPath: string,
    url: string,
    headers: Record<string, string>,
    body: string | null,
    autoRetry: boolean
  ): Promise<unknown> {
    const maxAttempts = autoRetry ? 2 : 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, { method, headers, body: body ?? undefined });
      } catch (err) {
        throw new Error(`${method} ${subPath} fetch failed: ${err}`);
      }

      const resetAtUnix = parseRateLimitReset(res.headers.get('x-ratelimit-reset'));
      const text = await res.text();

      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`${method} ${subPath} failed: HTTP ${res.status} (non-JSON response): ${text}`);
      }

      if (json.code !== 0) {
        const err = new OpenApiError({
          method, path: subPath, status: res.status,
          apiCode: json.code, apiError: json.error,
          apiMessage: json.message, resetAtUnix,
        });

        // Auto-retry on rate limit
        if (
          autoRetry &&
          attempt < maxAttempts &&
          (json.error === 'RATE_LIMIT_EXCEEDED' || json.error === 'RATE_LIMIT_BANNED') &&
          resetAtUnix != null
        ) {
          const waitMs = Math.max(resetAtUnix * 1000 - Date.now(), 0) + RATE_LIMIT_RETRY_BUFFER_MS;
          if (waitMs <= 5000) {
            logger.warn('rate_limited', { endpoint: subPath, resetAt: resetAtUnix, waitMs });
            await sleep(waitMs);
            continue;
          }
        }

        logger.error('gmgn_api_error', {
          endpoint: subPath,
          status: res.status,
          code: json.code,
          error: json.error,
          message: json.message,
        });
        throw err;
      }

      return json.data;
    }

    throw new Error('Unexpected retry loop exit');
  }
}

// Singleton
let _client: GmgnClient | null = null;
export function getGmgnClient(): GmgnClient {
  if (!_client) _client = new GmgnClient();
  return _client;
}
