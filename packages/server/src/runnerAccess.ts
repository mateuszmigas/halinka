import type { DbRunner, DbRunnerKeyState } from "./db/schema";

export const revokedReason = "An Admin revoked this runner";

export const keyRetiredReason = "A newer key of this runner replaced this key";

export const noAuthorityReason = "The runner is revoked, or a newer key replaced its key";

// The hello, the enrollment and the device flow refuse the same keys.
export const keyRefusalReason = (
  runner: Pick<DbRunner, "state"> & { keyState: DbRunnerKeyState },
) => {
  if (runner.state === "revoked") return revokedReason;
  if (runner.keyState === "retired") return keyRetiredReason;
  return undefined;
};
