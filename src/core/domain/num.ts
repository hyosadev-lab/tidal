/**
 * Coercion for values off the GMGN wire, which arrive as `unknown` — string, number, null or
 * absent. Kept apart from anything that reads them so the pure layer can parse a feed row
 * without importing the HTTP client to do it.
 */

export const num = (v: unknown, d = 0): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : d;
};

/**
 * `num` for fields only one of the two feeds reports. A missing rate is not a rate of zero —
 * "no insider trading" and "this feed does not measure insider trading" are opposite readings
 * of the same 0, and the analyst is told to treat a blank as a blank.
 */
export const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** GMGN reports booleans as `true`, `1`, `"true"` or `"yes"` depending on the route. */
export const truthy = (v: unknown): boolean => {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v === 1;
  if (typeof v === "string") return ["1", "yes", "true"].includes(v.trim().toLowerCase());
  return false;
};

/**
 * Coerce, then bound. The fallback is clamped too, so no stored or model-supplied value can
 * widen a limit by being unreadable.
 */
export function clamp(n: unknown, lo: number, hi: number, fallback: number): number {
  const v = num(n, NaN);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
}

/** An error squashed to one loggable line. */
export function short(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/\s+/g, " ").slice(0, 220);
}
