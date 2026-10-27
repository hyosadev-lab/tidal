import { db, insert, tx } from "./db.ts";
import { gmgnClient } from "./gmgn/client.ts";

/**
 * One GMGN /v1/token/info read, frozen: `tokens` (what never changes after launch, upserted),
 * `token_snapshots` (everything that moves) and `snapshot_flow` (the price.* block, one row per
 * window). Field paths verified against a live response (26 Oct 2026). GMGN sends numbers as
 * strings and timestamps in seconds; both are converted here, at the edge.
 */

export const SPANS = ["1m", "5m", "1h", "6h", "24h"] as const;
export type SnapshotKind = "entry" | "exit" | "decision";

const n = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};
const int = (v: unknown): number | null => {
  const x = n(v);
  return x === null ? null : Math.round(x);
};
const ms = (sec: unknown): number | null => {
  const x = n(sec);
  return x !== null && x > 0 ? Math.round(x * 1000) : null;
};
const text = (v: unknown, max = 300): string | null => (typeof v === "string" && v ? v.slice(0, max) : null);

/** The rows one response becomes, or null when it carries no address or price. Pure. */
export function toRows(info: any, now: number) {
  const price = n(info?.price?.price);
  const address = text(info?.address, 64);
  if (!address || !price || price <= 0) return null;
  const p = info.price ?? {};
  const pool = info.pool ?? {};
  const stat = info.stat ?? {};
  const tags = info.wallet_tags_stat ?? {};
  const dev = info.dev ?? {};
  const link = info.link ?? {};
  const supply = n(info.circulating_supply);

  const token = {
    address,
    symbol: text(info.symbol, 40),
    name: text(info.name, 80),
    decimals: int(info.decimals),
    standard: text(info.standard, 10),
    creator_address: text(dev.creator_address, 64),
    launchpad: text(info.launchpad, 40),
    launchpad_platform: text(info.launchpad_platform, 40),
    created_at: ms(info.creation_timestamp),
    opened_at: ms(info.open_timestamp),
    migrated_at: ms(info.migrated_timestamp),
    first_seen_at: now,
  };

  const snapshot = {
    token: address,
    taken_at: now,
    price_usd: price,
    market_cap_usd: supply !== null ? price * supply : null,
    ath_price_usd: n(info.ath_price),
    liquidity_usd: n(info.liquidity),
    holder_count: int(info.holder_count),
    circulating_supply: supply,
    total_supply: n(info.total_supply),
    locked_ratio: n(info.locked_ratio),
    launchpad_progress: n(info.launchpad_progress),
    migration_market_cap: n(info.migration_market_cap),
    trade_fee: n(info.trade_fee),
    total_fee: n(info.total_fee),
    hot_level: int(p.hot_level ?? info.hot_level),
    visiting_count: int(info.visiting_count),
    image_dup_count: int(info.image_dup_count),

    pool_address: text(pool.pool_address, 64),
    pool_exchange: text(pool.exchange, 40),
    pool_quote_symbol: text(pool.quote_symbol, 20),
    pool_base_reserve: n(pool.base_reserve),
    pool_quote_reserve: n(pool.quote_reserve),
    pool_initial_liquidity: n(pool.initial_liquidity),
    pool_initial_base_reserve: n(pool.initial_base_reserve),
    pool_initial_quote_reserve: n(pool.initial_quote_reserve),

    top_10_holder_rate: n(stat.top_10_holder_rate),
    dev_team_hold_rate: n(stat.dev_team_hold_rate),
    creator_hold_rate: n(stat.creator_hold_rate),
    top_bundler_trader_percentage: n(stat.top_bundler_trader_percentage),
    top70_sniper_hold_rate: n(stat.top70_sniper_hold_rate),
    fresh_wallet_rate: n(stat.fresh_wallet_rate),
    bot_degen_rate: n(stat.bot_degen_rate),
    bot_degen_count: int(stat.bot_degen_count),
    top_rat_trader_percentage: n(stat.top_rat_trader_percentage),
    top_entrapment_trader_percentage: n(stat.top_entrapment_trader_percentage),
    private_vault_hold_rate: n(stat.private_vault_hold_rate),
    signal_count: int(stat.signal_count),
    degen_call_count: int(stat.degen_call_count),

    smart_wallets: int(tags.smart_wallets),
    renowned_wallets: int(tags.renowned_wallets),
    whale_wallets: int(tags.whale_wallets),
    top_wallets: int(tags.top_wallets),
    fresh_wallets: int(tags.fresh_wallets),
    sniper_wallets: int(tags.sniper_wallets),
    bundler_wallets: int(tags.bundler_wallets),
    rat_trader_wallets: int(tags.rat_trader_wallets),
    creator_wallets: int(tags.creator_wallets),

    creator_token_status: text(dev.creator_token_status, 40),
    creator_token_balance: n(dev.creator_token_balance),
    creator_open_count: int(dev.creator_open_count),
    creator_created_count: int(stat.creator_created_count),
    dev_ath_token: text(dev.ath_token_info?.ath_token, 64),
    dev_ath_mc_usd: n(dev.ath_token_info?.ath_mc),
    cto_flag: int(dev.cto_flag),
    twitter_create_token_count: int(dev.twitter_create_token_count),
    twitter_del_post_token_count: int(dev.twitter_del_post_token_count),
    twitter_name_changes: Array.isArray(dev.twitter_name_change_history) ? dev.twitter_name_change_history.length : null,

    dexscr_ad: int(dev.dexscr_ad),
    dexscr_update_link: int(dev.dexscr_update_link),
    dexscr_boost_fee: n(dev.dexscr_boost_fee),
    dexscr_trending_bar: int(dev.dexscr_trending_bar),

    twitter: text(link.twitter_username),
    website: text(link.website),
    telegram: text(link.telegram),

    raw: JSON.stringify(info),
  };

  const flow = SPANS.map((s) => ({
    span: s,
    price_usd: n(p[`price_${s}`]),
    buys: int(p[`buys_${s}`]),
    sells: int(p[`sells_${s}`]),
    swaps: int(p[`swaps_${s}`]),
    volume_usd: n(p[`volume_${s}`]),
    buy_volume_usd: n(p[`buy_volume_${s}`]),
    sell_volume_usd: n(p[`sell_volume_${s}`]),
  }));

  return { token, snapshot, flow };
}

const UPSERT_TOKEN = `
insert into tokens (address, symbol, name, decimals, standard, creator_address, launchpad,
  launchpad_platform, created_at, opened_at, migrated_at, first_seen_at)
values ($address, $symbol, $name, $decimals, $standard, $creator_address, $launchpad,
  $launchpad_platform, $created_at, $opened_at, $migrated_at, $first_seen_at)
on conflict(address) do update set symbol = excluded.symbol, name = excluded.name,
  decimals = coalesce(tokens.decimals, excluded.decimals), standard = excluded.standard,
  creator_address = excluded.creator_address, launchpad = excluded.launchpad,
  launchpad_platform = excluded.launchpad_platform, created_at = excluded.created_at,
  opened_at = excluded.opened_at, migrated_at = excluded.migrated_at`;

/** Writes one response; returns the snapshot id. Throws when the response carries no price. */
export function writeSnapshot(info: unknown, kind: SnapshotKind, now = Date.now()): number {
  const rows = toRows(info, now);
  if (!rows) throw new Error("token info carried no address or price");
  return tx(() => {
    db.prepare(UPSERT_TOKEN).run(rows.token as never);
    const id = insert("token_snapshots", { ...rows.snapshot, kind });
    for (const f of rows.flow) insert("snapshot_flow", { ...f, snapshot_id: id });
    return id;
  });
}

export async function takeSnapshot(mint: string, kind: SnapshotKind): Promise<number> {
  return writeSnapshot(await gmgnClient().getTokenInfo("sol", mint), kind);
}

// ── signals ───────────────────────────────────────────────────────────

/** GMGN's signal types by number (gmgn-market SKILL.md), as the brief names them. The API refuses 14–16. */
export const SIGNAL_NAMES: Record<number, string> = {
  1: "kline_spike", 2: "dex_ad", 3: "dex_link_update", 4: "dex_trending_bar", 5: "dex_boost",
  6: "price_spike", 7: "price_ath", 8: "mcap_key_level", 9: "live_stream", 10: "bundler_sell",
  11: "cto", 12: "smart_money_buy", 13: "platform_call", 14: "large_buy", 15: "multi_buy",
  16: "multi_large_buy", 17: "bags_claim", 18: "pump_claim", 19: "platform_call_v2", 20: "kol_buy",
  21: "banker_claim",
};
const signalName = (t: unknown) => SIGNAL_NAMES[Number(t)] ?? `type_${t}`;

/**
 * One /v1/market/token_signal row: one event, keyed by GMGN's id. Seen again, only its counts
 * move. signal_times_by_type is the token's tally over every type, warnings included.
 */
export function writeSignal(token: string, row: any): void {
  const at = ms(row?.trigger_at);
  const type = int(row?.signal_type);
  if (!row?.id || !at || type === null) return;
  db.prepare(
    `insert into token_signals (id, token, signal_type, trigger_at, trigger_mc, first_trigger_mc, signal_times, times_by_type)
     values (?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(id) do update set signal_times = excluded.signal_times, times_by_type = excluded.times_by_type`,
  ).run(String(row.id), token, type, at, n(row.trigger_mc), n(row.first_trigger_mc), int(row.signal_times), JSON.stringify(row.signal_times_by_type ?? {}));
}

/** The token's signals up to `at`: counts per type (the highest tally seen), first-signal market cap, the latest five. */
function signalBrief(token: string, at: number): Record<string, unknown> | undefined {
  const rows = db.prepare("select * from token_signals where token = ? and trigger_at <= ? order by trigger_at desc").all(token, at) as Record<string, any>[];
  if (!rows.length) return undefined;
  const top = rows.reduce((a, b) => ((b.signal_times ?? 0) > (a.signal_times ?? 0) ? b : a)); // tallies only grow
  return compact({
    counts: Object.fromEntries(Object.entries(JSON.parse(top.times_by_type ?? "{}")).map(([k, v]) => [signalName(k), v])),
    first_mc_usd: top.first_trigger_mc,
    recent: rows.slice(0, 5).map((r) => compact({ type: signalName(r.signal_type), minutes_ago: Math.round((at - r.trigger_at) / 60_000), mc_usd: r.trigger_mc })),
  });
}

// ── the brief row ─────────────────────────────────────────────────────

const round = (v: unknown) => (typeof v === "number" && !Number.isInteger(v) ? Number(v.toPrecision(4)) : v);
const compact = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, round(v)]));

/**
 * What the model is shown for one snapshot: the stored columns themselves (their names are the
 * glossary), the token's static facts, and per window the % change and the flow. Blanks drop out;
 * floats are cut to 4 significant digits.
 */
export function briefRow(snapshotId: number): Record<string, unknown> {
  const s = db.prepare("select * from token_snapshots where id = ?").get(snapshotId) as Record<string, any>;
  const t = db.prepare("select * from tokens where address = ?").get(s.token) as Record<string, any>;
  const flow = db.prepare("select * from snapshot_flow where snapshot_id = ?").all(snapshotId) as Record<string, any>[];
  const { id: _id, token: _t, taken_at, kind: _k, decision_id: _d, raw: _r, ...cols } = s;
  return compact({
    address: t.address,
    symbol: t.symbol,
    name: t.name,
    age_minutes: t.created_at ? Math.round((taken_at - t.created_at) / 60_000) : null,
    launchpad: t.launchpad_platform,
    migrated: t.migrated_at != null,
    creator_address: t.creator_address,
    ...cols,
    signals: signalBrief(t.address, taken_at),
    flow: Object.fromEntries(
      flow.map((f) => [
        f.span,
        compact({
          change_pct: f.price_usd > 0 ? (s.price_usd / f.price_usd - 1) * 100 : null,
          buys: f.buys,
          sells: f.sells,
          swaps: f.swaps,
          volume_usd: f.volume_usd,
          buy_volume_usd: f.buy_volume_usd,
          sell_volume_usd: f.sell_volume_usd,
        }),
      ]),
    ),
  });
}
