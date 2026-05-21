import { logger } from './logger.ts';

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (attempt: number, error: unknown) => void;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    baseDelayMs = 1000,
    maxDelayMs = 10000,
    onRetry,
  } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === maxAttempts) break;

      const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);

      if (onRetry) {
        onRetry(attempt, error);
      } else {
        logger.warn('retry', { attempt, nextAttemptIn: `${delay}ms`, error: String(error) });
      }

      await sleep(delay);
    }
  }

  throw lastError;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Wait until a specific unix timestamp (seconds)
export async function waitUntil(unixSeconds: number): Promise<void> {
  const nowMs = Date.now();
  const targetMs = unixSeconds * 1000;
  const delayMs = targetMs - nowMs;
  if (delayMs > 0) {
    await sleep(delayMs + 1000); // +1s buffer
  }
}
