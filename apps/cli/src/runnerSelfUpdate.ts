import { serverOriginOf } from "@halinka/protocol";
import { signedStatus } from "@halinka/protocol/keys";
import type { RunnerKey } from "@halinka/runner/runnerKey";
import { buildLabelOf } from "@halinka/utils/buildLabel";
import { errorMessage, isAbortError } from "@halinka/utils/errors";

import {
  canTryBuild,
  clearUpdateFailures,
  deleteOtherVersions,
  installServerPackage,
  readCurrentVersion,
  readServerPackage,
  recordUpdateFailure,
  runBuild,
  runnerApiOf,
  switchCurrent,
  UnreachableError,
} from "./runnerVersions";

const probeTimeoutMs = 2 * 60 * 1000;
// The server stores this much; a longer reason that the runner signs would be refused.
const maxReasonLength = 2000;

type SelfUpdateOptions = {
  server: string;
  key: RunnerKey;
  home: string;
  buildId: string;
  isInsecure: boolean;
};

// `unreachable`: the server or the network failed, so no failure of the build counted.
export type SelfUpdateOutcome = "updated" | "current" | "failed" | "unreachable" | "no_package";

const probeWithBuild = async (version: string, { server, home, isInsecure }: SelfUpdateOptions) => {
  const args = [
    "runner",
    "--server",
    server,
    ...(isInsecure ? ["--insecure"] : []),
    "--probe-only",
  ];
  const code = await runBuild(home, version, args, {
    signal: AbortSignal.timeout(probeTimeoutMs),
  }).catch((error: unknown) => {
    if (!isAbortError(error)) throw error;
    throw new UnreachableError(
      `The probe of the new build did not end in ${probeTimeoutMs / 1000} s`,
    );
  });
  if (code !== 0) throw new Error(`The probe of the new build ended with code ${code}`);
};

const reportFailure = async (
  { server, key }: SelfUpdateOptions,
  buildId: string,
  reason: string,
) => {
  const answer = await runnerApiOf(server).runner.reportStatus(
    signedStatus(key, {
      serverUrl: serverOriginOf(server),
      sentAt: Date.now(),
      status: "update_failed",
      buildId,
      reason: reason.slice(0, maxReasonLength),
    }),
  );
  if (answer.result !== "accepted") {
    console.error(`The server did not take the report of the failed update: ${answer.result}`);
  }
};

// Call it under the lock of the home, while no runner of the home is connected.
export const updateToServerBuild = async (
  options: SelfUpdateOptions,
): Promise<SelfUpdateOutcome> => {
  const { server, home, buildId } = options;
  const target = await readServerPackage(server).catch((error: unknown) => {
    console.error(`The runner could not read the build of the server: ${errorMessage(error)}`);
    return "unreachable" as const;
  });
  if (target === "unreachable") return target;
  if (!target) return "no_package";
  if (target.buildId === buildId) return "current";
  const label = buildLabelOf(target.version, target.buildId);
  // A broken failure state must not stop the update or its report.
  if (!(await canTryBuild(home, target.buildId).catch(() => true))) {
    const reason = `The update to ${label} failed twice. Run halinka runner install to try it again`;
    console.error(reason);
    // The report ends the request, so the server does not ask for this update again.
    await reportFailure(options, target.buildId, reason).catch(() => {});
    return "failed";
  }
  try {
    const version = await installServerPackage(server, home, target);
    await probeWithBuild(version, options);
    const previous = await readCurrentVersion(home);
    await switchCurrent(home, version);
    // The update is done: a failed cleanup only leaves old folders.
    await clearUpdateFailures(home).catch(() => {});
    await deleteOtherVersions(home, [version, ...(previous ? [previous] : [])]).catch(() => {});
    console.log(`Installed ${label}. The service starts it now.`);
    return "updated";
  } catch (error) {
    const reason = errorMessage(error);
    console.error(`The update to ${label} failed: ${reason}`);
    if (error instanceof UnreachableError) return "unreachable";
    await recordUpdateFailure(home, target.buildId).catch((stateError: unknown) =>
      console.error(`The runner could not record the failed update: ${errorMessage(stateError)}`),
    );
    await reportFailure(options, target.buildId, reason).catch((reportError: unknown) =>
      console.error(`The runner could not report the failed update: ${errorMessage(reportError)}`),
    );
    return "failed";
  }
};
