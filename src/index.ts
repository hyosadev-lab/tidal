import { startScreeningSession } from "./sessions/screening";
import { startManagingSession, executeSellOrder } from "./sessions/managing";
import { generateLearnings } from "./agent/learner";
import { setLearningTriggerCallback, getPositions } from "./storage/db";
import { logger } from "./utils/logger";

// Validate environment variables
function validateEnv() {
  const required = ["GMGN_API_KEY", "GMGN_WALLET_ADDRESS", "OPENROUTER_API_KEY"];
  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    logger.error(`Missing environment variables: ${missing.join(", ")}`);
    process.exit(1);
  }
}

let isShuttingDown = false;

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`Received ${signal}. Closing all open positions...`);

  const positions = await getPositions();

  if (positions.length === 0) {
    logger.info("No open positions to close.");
    process.exit(0);
  }

  logger.info(`Closing ${positions.length} positions...`);

  for (const position of positions) {
    try {
      logger.info(`Selling ${position.tokenSymbol} (${position.tokenAddress})...`);
      await executeSellOrder({
        position,
        exitReason: "shutdown",
        aiReasoning: `Emergency sell on ${signal} signal`,
        signalsUsed: ["graceful_shutdown"],
      });
    } catch (error) {
      logger.error(`Failed to sell ${position.tokenSymbol}: ${String(error)}`);
    }
  }

  logger.info("All positions closed. Shutting down.");
  process.exit(0);
}

async function main() {
  logger.info("Starting Trenches Trading Agent...");

  validateEnv();

  // Register graceful shutdown handlers
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

  // Register event-based learning trigger (every 30 completed decisions)
  setLearningTriggerCallback(generateLearnings);
  logger.info("Event-based learning enabled (triggers every 30 new decisions)");

  // Start sessions in parallel
  startScreeningSession();
  startManagingSession();

  logger.info("Agent is running. Press Ctrl+C to stop.");
}

main().catch((error) => {
  logger.error("Fatal error in main loop", { error: String(error) });
  process.exit(1);
});
