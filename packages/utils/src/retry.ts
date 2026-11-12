export type Backoff = { initialDelayMs: number; maxDelayMs: number };

export const backoffMs = (failures: number, { initialDelayMs, maxDelayMs }: Backoff) =>
  Math.min(initialDelayMs * 2 ** failures, maxDelayMs);
