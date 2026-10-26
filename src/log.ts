import { insert } from "./db.ts";

export type Level = "info" | "trade" | "warn" | "error" | "model";

/** One line to the console and the `logs` table. A write failure must not take down the loop. */
export function log(level: Level, msg: string, detail?: string): void {
  console.log(`${new Date().toISOString().slice(11, 19)} ${level.padEnd(5)} ${msg}${detail ? ` · ${detail}` : ""}`);
  try {
    insert("logs", { at: Date.now(), level, msg, detail: detail ?? null });
  } catch {
    /* the console line above is the record then */
  }
}

/** An error as one short line. */
export const short = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 240);
