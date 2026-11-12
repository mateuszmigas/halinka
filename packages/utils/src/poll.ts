import { setTimeout as sleep } from "node:timers/promises";

export const poll = async <T>(read: () => Promise<T | undefined>, intervalMs: number) => {
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    await sleep(intervalMs);
  }
};
