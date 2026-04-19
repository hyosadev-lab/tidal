type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function getTimestamp(): string {
  return new Date().toISOString();
}

function shouldLog(level: LogLevel): boolean {
  const envLevel = (process.env.LOG_LEVEL || "info") as LogLevel;
  return LOG_LEVELS[level] >= LOG_LEVELS[envLevel];
}

export function log(level: LogLevel, message: string, meta?: Record<string, any>) {
  if (!shouldLog(level)) return;

  const timestamp = getTimestamp();
  const prefix = `[${timestamp}] [${level.toUpperCase()}]`;
  const metaStr = meta ? JSON.stringify(meta) : "";

  // Bun's console handles different log levels
  switch (level) {
    case "debug":
      console.debug(prefix, message, metaStr);
      break;
    case "info":
      console.info(prefix, message, metaStr);
      break;
    case "warn":
      console.warn(prefix, message, metaStr);
      break;
    case "error":
      console.error(prefix, message, metaStr);
      break;
  }
}

export const logger = {
  debug: (message: string, meta?: Record<string, any>) => log("debug", message, meta),
  info: (message: string, meta?: Record<string, any>) => log("info", message, meta),
  warn: (message: string, meta?: Record<string, any>) => log("warn", message, meta),
  error: (message: string, meta?: Record<string, any>) => log("error", message, meta),
};
