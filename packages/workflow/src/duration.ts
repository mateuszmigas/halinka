import { z } from "zod";

const durationPattern = /^([1-9]\d*)(s|m|h)$/;

const unitMs = { s: 1000, m: 60_000, h: 3_600_000 };

export const durationMs = (text: string) => {
  const [, amount, unit] = durationPattern.exec(text) ?? [];
  if (!amount || !unit) throw new Error(`"${text}" is not a duration`);
  return Number(amount) * unitMs[unit as keyof typeof unitMs];
};

// The longest delay of `setTimeout`
const maxDurationMs = 2 ** 31 - 1;

export const durationSchema = z
  .string()
  .regex(durationPattern, "Use a whole number and s, m or h, for example 45m")
  .refine(
    (text) => !durationPattern.test(text) || durationMs(text) <= maxDurationMs,
    "Use 596h or less",
  );
