import { durationMs } from "@halinka/workflow";

import { loopAllowance, type LoopBudget, loopLimitLabel } from "./limits";

export type TimeLimit = { ms: number; message: string };

type TimedAction<T> = {
  action: (signal: AbortSignal) => Promise<T>;
  atLimit: (timeLimit: TimeLimit) => T;
};

export const stepTimeLimit = (
  timeout: string | undefined,
  loop: LoopBudget | undefined,
): TimeLimit | undefined => {
  const limits: TimeLimit[] = [];
  if (timeout !== undefined) {
    limits.push({ ms: durationMs(timeout), message: `The step timed out after ${timeout}.` });
  }
  const loopMs = loop && loopAllowance(loop).loop_timeout;
  if (loop && loopMs !== undefined) {
    const label = loopLimitLabel("loop_timeout", loop.step);
    limits.push({ ms: Math.max(0, loopMs), message: `The step reached ${label}.` });
  }
  return limits.sort((first, second) => first.ms - second.ms)[0];
};

export const withinTimeLimit = async <T>(
  timeLimit: TimeLimit | undefined,
  { action, atLimit }: TimedAction<T>,
  signal: AbortSignal,
) => {
  const timeout = new AbortController();
  const timer = timeLimit && setTimeout(() => timeout.abort(), timeLimit.ms);
  try {
    return await action(AbortSignal.any([signal, timeout.signal]));
  } catch (error) {
    if (!timeLimit || !timeout.signal.aborted || signal.aborted) throw error;
    return atLimit(timeLimit);
  } finally {
    clearTimeout(timer);
  }
};
