import { startScreeningSession } from "./sessions/screening";
import { startManagingSession } from "./sessions/managing";
import { generateLearnings } from "./agent/learner";
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

// Start periodic learning generation (every 30 minutes)
function startLearningGeneration() {
  const LEARNING_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

  logger.info(`Starting learning generation (every 30 minutes)`);

  // Run immediately on startup
  generateLearnings().catch((error) => {
    logger.error("Error in initial learning generation", { error: String(error) });
  });

  // Run every 30 minutes
  setInterval(async () => {
    try {
      logger.info("Running scheduled learning generation...");
      await generateLearnings();
    } catch (error) {
      logger.error("Error in scheduled learning generation", { error: String(error) });
    }
  }, LEARNING_INTERVAL_MS);
}

async function main() {
  logger.info("Starting Trenches Trading Agent...");

  validateEnv();

  // Start sessions in parallel
  startScreeningSession();
  startManagingSession();

  // Start periodic learning generation
  startLearningGeneration();

  logger.info("Agent is running. Press Ctrl+C to stop.");
}

main().catch((error) => {
  logger.error("Fatal error in main loop", { error: String(error) });
  process.exit(1);
});
