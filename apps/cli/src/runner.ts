import { arch, platform } from "node:os";
import { text } from "node:stream/consumers";

import {
  type Build,
  hasCode,
  protocolVersion,
  refused,
  serverOriginOf,
  updateNeeded,
} from "@halinka/protocol";
import { signedProbe, signedRegistration } from "@halinka/protocol/keys";
import { WebSocketClientTransport } from "@halinka/protocol/webSocket";
import { Runner } from "@halinka/runner";
import { loadOrCreateRunnerKey, type RunnerKey } from "@halinka/runner/runnerKey";
import { ORPCError } from "@halinka/server/client";
import { errorMessage } from "@halinka/utils/errors";
import { halinkaHome } from "@halinka/utils/halinkaHome";
import { poll } from "@halinka/utils/poll";

import { fail, failWithError, parseCommandArgs, parseRunnerFlags, runnerFlags } from "./args";
import { readBuild } from "./readBuild";
import { parseServerFlag, readFolderRoots, runnerConnectionFlags } from "./runnerArgs";
import { updateToServerBuild } from "./runnerSelfUpdate";
import { connectedLineOf, failWithRefusal, startRunner, warnOfWorktree } from "./runnerStart";
import { noPackageReason, readRunnerHome, runnerApiOf } from "./runnerVersions";
import { stopOnSignals } from "./signals";

const usage = `Usage: halinka runner --server <url> [options]
       halinka runner install --server <url> [options]
       halinka runner status
       halinka runner uninstall

Makes this machine a runner of the server, in this terminal. At the first start, an Admin approves it in
the portal, or the runner uses a one-time enrollment token from HALINKA_ENROLL_TOKEN. On Linux, install
runs it as a systemd user service instead, which starts again after a reboot.

Options:
${runnerConnectionFlags.usage}
  --enroll-only   Enroll this machine, then stop (install runs it and holds the lock of the home)
  --unit <name>   The systemd unit that runs this process (install sets it)
  --no-self-update  Under the unit: install no build of the server; an update needs halinka runner install
  --probe-only    Check the key and the protocol with the server, then stop (an update runs it)
${runnerFlags.usage}`;

const pollMs = 5000;

type ReadEnrollTokenOptions = { isFromStdin: boolean };

const readEnrollToken = async ({ isFromStdin }: ReadEnrollTokenOptions) => {
  const token = isFromStdin ? await text(process.stdin) : process.env.HALINKA_ENROLL_TOKEN;
  return token?.trim() || undefined;
};

const registrationOf = (key: RunnerKey) =>
  signedRegistration(key, { name: key.name, os: platform(), arch: arch() });

const retryUntilAnswered = <T>(server: string, call: () => Promise<T>) =>
  poll(
    () =>
      call().catch((error: unknown) => {
        // All runners behind one proxy share the rate limit of its address.
        if (error instanceof ORPCError && error.code !== "TOO_MANY_REQUESTS") {
          return fail(`${server} refused the runner: ${error.message}`);
        }
        console.error(`${server} did not answer: ${errorMessage(error)}. The runner tries again.`);
        return undefined;
      }),
    pollMs,
  );

const maxClockSkewTries = 3;
const manifestRetryMs = 30_000;

type ProbeOptions = { hasClockSkewLimit?: boolean };

// Runs before `enroll`: a later server can change the enrollment API.
const probe = (
  server: string,
  key: RunnerKey,
  build: Build,
  { hasClockSkewLimit = false }: ProbeOptions = {},
) => {
  const api = runnerApiOf(server);
  let clockSkews = 0;
  return poll(async () => {
    const probed = await retryUntilAnswered(server, () =>
      api.runner.probe(
        signedProbe(key, {
          serverUrl: serverOriginOf(server),
          protocolVersion,
          build,
          sentAt: Date.now(),
        }),
      ),
    );
    if (probed.result !== "clock_skew") return probed;
    if (hasClockSkewLimit && ++clockSkews >= maxClockSkewTries) return probed;
    console.error(`${probed.message}. The runner tries again.`);
    return undefined;
  }, pollMs);
};

// The check that a new build runs before `install` or an update makes it `current`.
const probeOnly = async (server: string, key: RunnerKey, build: Build) => {
  const answer = await probe(server, key, build, { hasClockSkewLimit: true });
  if (answer.result !== "accepted") {
    fail(`The server answered ${answer.result}${"message" in answer ? `: ${answer.message}` : ""}`);
  }
};

const subcommands: Record<string, () => Promise<(args: string[]) => Promise<void>>> = {
  install: async () => (await import("./runnerInstall")).runnerInstall,
  status: async () => (await import("./runnerUnitCommands")).runnerStatus,
  uninstall: async () => (await import("./runnerUnitCommands")).runnerUninstall,
};

// Without a token: the device flow.
const enroll = async (server: string, key: RunnerKey, token: string | undefined) => {
  const api = runnerApiOf(server);
  const registration = registrationOf(key);
  if (token) {
    await retryUntilAnswered(server, () => api.runner.enroll({ token, ...registration }));
    return;
  }
  let shownCode: string | undefined;
  await poll(async () => {
    const answer = await retryUntilAnswered(server, () => api.runner.register(registration));
    if (answer.status === "approved") return answer;
    if (answer.userCode !== shownCode) {
      shownCode = answer.userCode;
      console.log(
        `Ask an Admin to approve this runner: ${server}/runners/approve?code=${shownCode}\nCode: ${shownCode}`,
      );
    }
    return undefined;
  }, pollMs);
};

export const runner = async (args: string[]) => {
  const [first = "", ...rest] = args;
  if (Object.hasOwn(subcommands, first)) return (await subcommands[first]!())(rest);
  const flags = parseCommandArgs(
    args,
    {
      ...runnerConnectionFlags.option,
      "enroll-only": { type: "boolean", default: false },
      "probe-only": { type: "boolean", default: false },
      "no-self-update": { type: "boolean", default: false },
      unit: { type: "string" },
      ...runnerFlags.option,
    },
    usage,
  );
  const server = await parseServerFlag(flags.server, { isInsecure: flags.insecure, usage });
  const runnerOptions = parseRunnerFlags(flags, usage);
  const folderRoots = await readFolderRoots(flags.root);
  const isUnderUnit = flags.unit !== undefined;
  const canUpdate = isUnderUnit && !flags["no-self-update"];
  const home = await readRunnerHome();
  const key = await loadOrCreateRunnerKey(halinkaHome()).catch((error: unknown) =>
    fail(errorMessage(error)),
  );
  const build = await readBuild();
  // `--probe-only` takes no lock: the `install` or the update that runs it holds the lock.
  if (flags["probe-only"]) return probeOnly(server, key, build);
  const runner = new Runner(new WebSocketClientTransport(server, key), {
    home,
    build,
    canUpdate,
    ...runnerOptions,
    folderRoots,
    onFailedAttempt: (error) => console.error(`${errorMessage(error)}. The runner tries again.`),
  });
  // Before the probe: a second process with this key would change the build the server shows.
  const releaseLock = flags["enroll-only"] ? undefined : await runner.lock().catch(failWithError);
  const answer = await probe(server, key, build);
  if (answer.result === "refused") failWithRefusal("", refused(answer.message));
  const isUpdateDue =
    answer.result === "update_needed" || (answer.result === "accepted" && answer.isUpdateRequested);
  const update = () =>
    updateToServerBuild({ server, key, home, buildId: build.id, isInsecure: flags.insecure });
  if (isUpdateDue && canUpdate) {
    // This process cannot connect with another protocol, so it waits for the manifest: a restart would count.
    const outcome =
      answer.result === "update_needed"
        ? await poll(async () => {
            const result = await update();
            return result === "unreachable" ? undefined : result;
          }, manifestRetryMs)
        : await update();
    if (outcome === "updated") {
      await releaseLock?.();
      process.exit(75);
    }
    if (outcome === "no_package" && answer.result === "update_needed") {
      failWithRefusal("", updateNeeded(noPackageReason(server)), { isUnderUnit });
    }
    // A request that this process cannot carry out would stop it again at each idle sync.
    if (outcome !== "current") runner.refuseUpdates();
  }
  // Here no update ran or it failed, so the next start would end the same way.
  if (answer.result === "update_needed") {
    failWithRefusal("", updateNeeded(answer.message), { isUnderUnit });
  }
  if (answer.result === "unknown") {
    // A service has no terminal for the enrollment.
    if (isUnderUnit) {
      failWithRefusal(
        "",
        refused("This runner is not enrolled. Enroll it with halinka runner install"),
      );
    }
    await enroll(server, key, await readEnrollToken({ isFromStdin: flags["enroll-stdin"] }));
  }
  if (flags["enroll-only"]) {
    await runner.stop();
    console.log(`runner "${key.name}" is enrolled at ${server}`);
    return;
  }

  stopOnSignals(() => runner.stop());
  if (!(await startRunner(runner, { isUnderUnit, canUpdate }))) return;
  console.log(connectedLineOf(key.name, server, runner.serverId));
  warnOfWorktree(runnerOptions.sandboxKind);

  const refusal = await runner.closed;
  // One start per update: this process installs the build under its lock, and the start after it connects.
  if (refusal && hasCode(refusal, "update_needed") && canUpdate) {
    const outcome = await update();
    await releaseLock?.();
    if (outcome === "current") fail("The service starts the runner again.", 75);
    if (outcome !== "updated") {
      fail("The update failed. The service starts the runner again with its build.", 75);
    }
  }
  await releaseLock?.();
  if (refusal) {
    failWithRefusal("The server ended the connection: ", refusal, { isUnderUnit, canUpdate });
  }
};
