import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import {
  type ControlPlane,
  controlPlaneMethods,
  isTransient,
  methodsOf,
  type RunLease,
  wrapMethods,
} from "@halinka/protocol";
import { backoffMs } from "@halinka/utils/retry";

import type { LentValues } from "./lentValues";

const repeatBackoff = { initialDelayMs: 250, maxDelayMs: 5000 };

type RunCallMethod = {
  [K in keyof ControlPlane]: "callId" extends keyof Parameters<ControlPlane[K]>[0] ? K : never;
}[keyof ControlPlane];

// A repeat under the same call id gets the first result.
const runCallMethods = new Set<string>(
  methodsOf<Pick<ControlPlane, RunCallMethod>>({
    startStep: true,
    finishStep: true,
    startAttempt: true,
    finishAttempt: true,
    openApproval: true,
    askHuman: true,
    askQuestion: true,
    branchCreated: true,
    finishRun: true,
    storePushedBranch: true,
    storeComment: true,
  }),
);

// Their callers repeat them: the supervisor loop, `EventLog`, and the next `sync` for a sandbox.
const unrepeatedMethods = new Set<string>([
  "sync",
  "appendEvents",
  "reportSandbox",
] satisfies (keyof ControlPlane)[]);

// After the abort, the last transient error stays.
const whileTransient = async (send: () => Promise<unknown>, signal: AbortSignal) => {
  for (let failures = 0; ; failures++) {
    try {
      return await send();
    } catch (error) {
      if (!isTransient(error) || signal.aborted) throw error;
      await sleep(backoffMs(failures, repeatBackoff), undefined, { signal }).catch(() => {
        throw error;
      });
    }
  }
};

export const runnerPlane = (
  plane: ControlPlane,
  lent: Pick<LentValues, "mask">,
  signal: AbortSignal,
) =>
  wrapMethods(plane, controlPlaneMethods, (method, name) => async (...args) => {
    if (unrepeatedMethods.has(name)) return method(...lent.mask(args));
    const [lease, ...rest] = args;
    const sent = runCallMethods.has(name)
      ? [{ ...(lease as RunLease), callId: randomUUID() }, ...rest]
      : args;
    // A value lent during the backoff is masked too.
    return whileTransient(() => method(...lent.mask(sent)), signal);
  });
