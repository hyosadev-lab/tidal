import { startScreeningSession } from "./sessions/screening";
import { startManagingSession } from "./sessions/managing";
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

async function main() {
  logger.info("Starting Trenches Trading Agent...");

  validateEnv();

  // Start sessions in parallel
  startScreeningSession();
  startManagingSession();

  logger.info("Agent is running. Press Ctrl+C to stop.");
}

main().catch((error) => {
  logger.error("Fatal error in main loop", { error: String(error) });
  process.exit(1);
});
