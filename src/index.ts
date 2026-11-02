import { authProblem } from "./auth.ts";
import { loadConfig } from "./config.ts";
import { bootStopped, getRun } from "./control.ts";
import { openDb } from "./db.ts";
import { exitIdle, exitTick, POLL_MS } from "./exit.ts";
import { log, short } from "./log.ts";
import { startServer } from "./server.ts";
import { runCli, seedTries } from "./research.ts";
import { endRestarted, sampleMigrations, shadowTick, STEP_MS } from "./shadow.ts";
import { openPositions, sampleEquity } from "./trade.ts";

/**
 * The engine and its dashboard, one process: the entry loop (cycle after cycle, started by Start
 * in the dashboard, see entry.ts), the exit loop every POLL_MS, an equity row every minute. The
 * process starts stopped and both loops idle until Start. Config is the 'config' row in
 * `settings`, re-read every cycle.
 */

const PORT = Number(process.env.PORT ?? 3712);
const HOST = process.env.HOST ?? "127.0.0.1";
const TOKEN = process.env.DASHBOARD_TOKEN?.trim() || undefined;
const problem = authProblem(HOST, TOKEN);
if (problem) {
  console.error(`! ${problem}`);
  process.exit(1);
}

const db = openDb();
const cfg = loadConfig();
bootStopped();
seedTries();
const cut = endRestarted();
if (cut) log("info", `${cut} shadow track(s) cut by the restart — left out of every count.`);
const open = openPositions().length;
log(
  "info",
  `Ready in ${cfg.mode} mode, stopped until Start is pressed in the dashboard — ${cfg.sizeSol} SOL per buy, ` +
    `${cfg.maxOpenPositions} slots, ${cfg.exitMode} exit plan.${open ? ` ${open} open position(s) are not watched until then.` : ""}`,
);

const running = () => getRun().state === "running";
const equity = () => sampleEquity(loadConfig()).catch((e) => log("warn", `Equity sample failed: ${short(e)}`));
const timers = [
  setInterval(() => void (running() ? exitTick(loadConfig()) : exitIdle()), POLL_MS),
  setInterval(() => void equity(), 60_000),
  // Shadow tracks run whether trading is started or not: a stop must not cut their 60 minutes.
  setInterval(() => void shadowTick(), STEP_MS),
  setInterval(() => void sampleMigrations(), 60_000), // fresh PumpSwap migrations, never bought
  setInterval(() => runCli("judge", 5 * 60_000), 10 * 60_000), // hypotheses judged in a child process
];
void equity();
startServer({ port: PORT, host: HOST, token: TOKEN });

function stop(signal: string): void {
  for (const t of timers) clearInterval(t);
  log("info", `Stopped (${signal}). Open positions are not watched until the next start.`);
  db.close();
  process.exit(0);
}
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
