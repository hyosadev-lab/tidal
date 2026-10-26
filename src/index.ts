import { loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { CYCLE_MS, entryCycle } from "./entry.ts";
import { exitTick, POLL_MS } from "./exit.ts";
import { log, short } from "./log.ts";
import { openPositions, sampleEquity } from "./trade.ts";

/**
 * The engine, headless: the entry loop every minute, the exit loop every POLL_MS, an equity row
 * every minute. Config is the 'config' row in `settings` (defaults written on first start),
 * re-read every cycle. The dashboard comes later.
 */

const db = openDb();
const cfg = loadConfig();
log(
  "info",
  `Started in ${cfg.mode} mode — ${cfg.sizeSol} SOL per buy, ${cfg.maxOpenPositions} slots, ${cfg.exitMode} exit plan, ` +
    `${openPositions().length} position(s) open.`,
);

const equity = () => sampleEquity(loadConfig()).catch((e) => log("warn", `Equity sample failed: ${short(e)}`));
const timers = [
  setInterval(() => void exitTick(loadConfig()), POLL_MS),
  setInterval(() => void entryCycle(), CYCLE_MS),
  setInterval(() => void equity(), 60_000),
];
void equity().then(entryCycle);

function stop(signal: string): void {
  for (const t of timers) clearInterval(t);
  log("info", `Stopped (${signal}). Open positions are not watched until the next start.`);
  db.close();
  process.exit(0);
}
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
