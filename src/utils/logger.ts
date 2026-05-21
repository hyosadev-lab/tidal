import winston from 'winston';
import { getConfig } from '../config.ts';

const { combine, timestamp, printf, colorize } = winston.format;

const logFormat = printf(({ level, message, timestamp, ...meta }) => {
  const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
  return `${timestamp} [${level}] ${message}${metaStr}`;
});

export const logger = winston.createLogger({
  level: 'info',
  format: combine(
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    logFormat
  ),
  transports: [
    new winston.transports.Console({
      format: combine(
        colorize(),
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        logFormat
      ),
    }),
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
    }),
    new winston.transports.File({
      filename: 'logs/agent.log',
    }),
  ],
});

export function logDailySummary(stats: {
  date: string;
  tradesTotal: number;
  tradesWon: number;
  tradesLost: number;
  pnlUsd: number;
  winRate: number;
  avgPnlPerTrade: number;
  bestTrade?: { symbol: string; pnlUsd: number; pnlPct: number; exitReason: string };
  worstTrade?: { symbol: string; pnlUsd: number; pnlPct: number; exitReason: string };
}): void {
  const config = getConfig();
  const mode = config.dryRun ? '[DRY RUN] ' : '';

  const lines = [
    `====== ${mode}[${stats.date}] DAILY SUMMARY ======`,
    `Trades:  ${stats.tradesTotal} total | ${stats.tradesWon} won | ${stats.tradesLost} lost | ${(stats.winRate * 100).toFixed(1)}% win rate`,
    `PnL:     ${stats.pnlUsd >= 0 ? '+' : ''}$${stats.pnlUsd.toFixed(2)} | avg/trade: $${stats.avgPnlPerTrade.toFixed(2)}`,
  ];

  if (stats.bestTrade) {
    lines.push(
      `Best:    ${stats.bestTrade.symbol} +$${stats.bestTrade.pnlUsd.toFixed(2)} (+${stats.bestTrade.pnlPct.toFixed(0)}%) — ${stats.bestTrade.exitReason}`
    );
  }
  if (stats.worstTrade) {
    lines.push(
      `Worst:   ${stats.worstTrade.symbol} $${stats.worstTrade.pnlUsd.toFixed(2)} (${stats.worstTrade.pnlPct.toFixed(0)}%) — ${stats.worstTrade.exitReason}`
    );
  }

  lines.push('=========================================');

  for (const line of lines) {
    logger.info(line);
  }
}
