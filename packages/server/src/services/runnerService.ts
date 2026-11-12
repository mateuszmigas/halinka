import { findAgentPreset } from "@halinka/presets";
import {
  type Build,
  protocolVersion,
  unsupportedVersionReason,
  wrongServerReason,
} from "@halinka/protocol";
import {
  isPublicKey,
  isSignedProbe,
  isSignedRegistration,
  isSignedStatus,
  type SignedProbe,
  type SignedStatus,
  type SignedRegistration,
} from "@halinka/protocol/keys";
import { hashOf } from "@halinka/utils/hash";
import { isRunnerLabel, runnerLabelHint } from "@halinka/workflow";

import {
  type ConnectedRunners,
  isConnected,
  requireKnownRunner,
  wakeProcesses,
} from "../connectedRunners";
import type { Db } from "../db/client";
import {
  inTransaction,
  type NewRunner,
  type Repositories,
  type RunnerChanges,
  type RunnerSettings,
} from "../db/repositories";
import type { DbRunner } from "../db/schema";
import type { RunBus } from "../runBus";
import { keyRefusalReason, revokedReason } from "../runnerAccess";
import type { RunnerPackage } from "../runnerPackage";
import { newToken, newUserCode } from "../tokens";
import { withoutNulls } from "../withoutNulls";
import { noOpenRequest, noRunner, ServiceError } from "./serviceError";

const nameTaken = (name: string) =>
  new ServiceError("CONFLICT", `Another runner is named "${name}". Use another name.`);

const revoked = () => new ServiceError("CONFLICT", revokedReason);

const requireValidRegistration = (registration: SignedRegistration) => {
  if (!isPublicKey(registration.publicKey)) {
    throw new ServiceError("BAD_REQUEST", "The public key is not an Ed25519 key in base64url");
  }
  if (!isSignedRegistration(registration)) {
    throw new ServiceError("BAD_REQUEST", "The signature of the registration is not valid");
  }
};

const maxClockSkewMs = 5 * 60 * 1000;

const maxUpdateFailureLength = 2000;

type SignedCallCheck =
  | { result: "clock_skew" | "refused"; message: string }
  | { found: Awaited<ReturnType<Repositories["runner"]["findByPublicKey"]>> };

const clockSkewReason = "The clocks of this machine and of the server differ by more than 5 min";

const issue = (path: string[], message: string) => ({ path, message });

// Gives the settings sorted and once each; each issue names its field, for the portal.
const requireValidSettings = <T extends Partial<RunnerSettings>>(settings: T): T => {
  const { labels, allowedAgents } = settings;
  const issues = [
    ...(labels ?? []).flatMap((label) =>
      isRunnerLabel(label) ? [] : [issue(["labels"], `"${label}": ${runnerLabelHint}`)],
    ),
    ...(allowedAgents ?? []).flatMap((agent) =>
      findAgentPreset(agent) ? [] : [issue(["allowedAgents"], `There is no agent "${agent}"`)],
    ),
  ];
  if (issues.length > 0) {
    throw new ServiceError("BAD_REQUEST", "Check the runner settings", { issues });
  }
  return {
    ...settings,
    ...(labels && { labels: [...new Set(labels)].sort() }),
    ...(allowedAgents && { allowedAgents: [...new Set(allowedAgents)].sort() }),
  };
};

type Registered = { status: "approved" } | { status: "pending"; userCode: string; expiresAt: Date };

type TokenTarget = RunnerSettings | { runnerId: number };

type ApprovalTarget = (RunnerSettings & { name: string }) | { runnerId: number };

const activeRunner = async (runner: Repositories["runner"], id: number) => {
  const found = await runner.findById(id);
  if (!found) throw noRunner(id);
  if (found.state === "revoked") throw revoked();
  return found;
};

// Call it in a transaction.
const addRunner = async (
  { runner, runnerKey }: Repositories,
  publicKey: string,
  values: NewRunner,
) => {
  const created = await runner.create(values);
  if (!created) throw nameTaken(values.name);
  await runnerKey.create(created.id, publicKey, "current");
  return created;
};

// Call it in a transaction.
const addKey = async ({ runner, runnerKey }: Repositories, runnerId: number, publicKey: string) => {
  await runner.lockById(runnerId);
  const found = await activeRunner(runner, runnerId);
  await runnerKey.replacePending(runnerId, publicKey);
  return found;
};

const apiRunnerOf = <T extends DbRunner>(runner: T) =>
  withoutNulls({ ...runner, hasAutoUpdate: runner.autoUpdate });

const noPackage = () =>
  new ServiceError(
    "BAD_REQUEST",
    "This server has no package for runners. Run the server from its Docker image",
  );

const notUpdatable = () =>
  new ServiceError(
    "BAD_REQUEST",
    "This runner cannot update itself: it runs without its service unit, or with self-update off. Update it with halinka runner install",
  );

const buildStatusOf = (runner: Pick<DbRunner, "buildId" | "protocolVersion">, build: Build) => {
  if (runner.buildId === null) return undefined;
  if (runner.protocolVersion !== null && runner.protocolVersion !== protocolVersion) {
    return "update_needed" as const;
  }
  return runner.buildId === build.id ? ("current" as const) : ("outdated" as const);
};

type RunnerServiceOptions = {
  db: Db;
  build: Build;
  // the URL that a runner must sign; undefined without a login
  publicUrl?: string;
  runnerPackage?: RunnerPackage;
  repositories: Repositories;
  connectedRunners: ConnectedRunners;
  bus: RunBus;
};

export class RunnerService {
  constructor(private readonly options: RunnerServiceOptions) {}

  manifest() {
    const { build, runnerPackage } = this.options;
    return {
      version: build.version,
      buildId: build.id,
      protocolVersion,
      ...(runnerPackage && { package: { sha512: runnerPackage.sha512, size: runnerPackage.size } }),
    };
  }

  async probe(probe: SignedProbe, now = new Date()) {
    const checked = await this.checkSignedCall(probe, isSignedProbe(probe), now);
    if ("result" in checked) return checked;
    const { found } = checked;
    const { runner } = this.options.repositories;
    // Before the enrollment, so that a runner of another version never calls its API.
    if (probe.protocolVersion !== protocolVersion) {
      // A connected runner reports its build in each sync; a replayed probe must not change it.
      if (found && !isConnected(this.options.connectedRunners, found.id)) {
        const { publicKey, build } = probe;
        await runner.reportBuild(found.id, publicKey, {
          build,
          runnerProtocolVersion: probe.protocolVersion,
        });
      }
      const message = unsupportedVersionReason(probe.protocolVersion);
      return { result: "update_needed" as const, message };
    }
    if (!found) return { result: "unknown" as const };
    return { result: "accepted" as const, ...(found.updateRequest && { isUpdateRequested: true }) };
  }

  async reportStatus(report: SignedStatus, now = new Date()) {
    const checked = await this.checkSignedCall(report, isSignedStatus(report), now);
    if ("result" in checked) return checked;
    if (!checked.found) return { result: "unknown" as const };
    const { buildId, reason } = report;
    await this.options.repositories.runner.reportUpdateFailure(checked.found.id, {
      buildId,
      reason: reason.slice(0, maxUpdateFailureLength),
    });
    return { result: "accepted" as const };
  }

  // The checks of each signed call that a runner makes before it connects.
  private async checkSignedCall(
    call: { publicKey: string; serverUrl: string; sentAt: number },
    isSigned: boolean,
    now: Date,
  ): Promise<SignedCallCheck> {
    if (!isPublicKey(call.publicKey) || !isSigned) {
      throw new ServiceError("BAD_REQUEST", "The signature of the call is not valid");
    }
    if (Math.abs(now.getTime() - call.sentAt) > maxClockSkewMs) {
      return { result: "clock_skew", message: clockSkewReason };
    }
    const { publicUrl } = this.options;
    const wrongServer = publicUrl && wrongServerReason(call.serverUrl, publicUrl);
    if (wrongServer) return { result: "refused", message: wrongServer };
    const found = await this.options.repositories.runner.findByPublicKey(call.publicKey);
    const reason = found && keyRefusalReason(found);
    if (reason) return { result: "refused", message: reason };
    return { found };
  }

  async list() {
    const runners = await this.options.repositories.runner.list();
    return runners.map((runner) =>
      apiRunnerOf({
        ...runner,
        isConnected: isConnected(this.options.connectedRunners, runner.id),
        buildStatus: buildStatusOf(runner, this.options.build),
      }),
    );
  }

  async createEnrollmentToken(target: TokenTarget) {
    const token = newToken();
    if ("runnerId" in target) await activeRunner(this.options.repositories.runner, target.runnerId);
    const values = "runnerId" in target ? target : requireValidSettings(target);
    const { expiresAt } = await this.options.repositories.runnerEnrollment.createToken(
      hashOf(token),
      values,
    );
    return { token, expiresAt };
  }

  // A runner with this key is enrolled already: the token stays unused.
  async enroll(token: string, registration: SignedRegistration): Promise<DbRunner> {
    requireValidRegistration(registration);
    const known = await this.knownRunner(registration.publicKey);
    if (known) return known;
    const { publicKey, name, os, arch } = registration;
    return inTransaction(this.options.db, async (repositories) => {
      const { runnerEnrollment } = repositories;
      const enrollment = await runnerEnrollment.useToken(hashOf(token));
      if (!enrollment) {
        throw new ServiceError("BAD_REQUEST", "The enrollment token is not valid, used or expired");
      }
      if (enrollment.runnerId) return addKey(repositories, enrollment.runnerId, publicKey);
      const { labels, allowedAgents } = enrollment;
      const created = await addRunner(repositories, publicKey, {
        name,
        labels,
        allowedAgents,
        os,
        arch,
      });
      await runnerEnrollment.setRunner(enrollment.id, created.id);
      return created;
    });
  }

  async register(registration: SignedRegistration): Promise<Registered> {
    requireValidRegistration(registration);
    if (await this.knownRunner(registration.publicKey)) return { status: "approved" };
    const { runnerEnrollment } = this.options.repositories;
    const { publicKey, name, os, arch } = registration;
    const request =
      (await runnerEnrollment.findOpenRequestByPublicKey(publicKey)) ??
      (await runnerEnrollment.createRequest({
        userCode: newUserCode(),
        publicKey,
        hostName: name,
        os,
        arch,
      }));
    return { status: "pending", userCode: request.userCode ?? "", expiresAt: request.expiresAt };
  }

  async findRequest(userCode: string) {
    const request = await this.options.repositories.runnerEnrollment.findOpenRequest(userCode);
    if (!request) throw noOpenRequest(userCode);
    return withoutNulls({ ...request, userCode });
  }

  async approve(userCode: string, target: ApprovalTarget) {
    const approved = await inTransaction(this.options.db, async (repositories) => {
      const request = await repositories.runnerEnrollment.useRequest(userCode);
      if (!request?.publicKey) throw noOpenRequest(userCode);
      const { publicKey, os, arch } = request;
      const runner =
        "runnerId" in target
          ? await addKey(repositories, target.runnerId, publicKey)
          : await addRunner(repositories, publicKey, { ...requireValidSettings(target), os, arch });
      await repositories.runnerEnrollment.setRunner(request.id, runner.id);
      return runner;
    });
    return apiRunnerOf(approved);
  }

  async update(id: number, changes: RunnerChanges) {
    const { runner } = this.options.repositories;
    const updated = await runner.update(id, requireValidSettings(changes));
    if (updated) {
      await this.options.bus.notifyQueuedRuns(this.options.repositories, id);
      return apiRunnerOf(updated);
    }
    if (await runner.findById(id)) throw revoked();
    throw noRunner(id);
  }

  async folders(id: number, path: string | undefined) {
    const runner = await requireKnownRunner(
      this.options.repositories,
      this.options.connectedRunners,
      id,
    );
    return runner.listFolders({ path });
  }

  async revoke(id: number) {
    const runner = await this.options.repositories.runner.revoke(id);
    if (!runner) throw noRunner(id);
    this.options.connectedRunners.close(id, revokedReason);
    await inTransaction(this.options.db, async (repositories) => {
      await repositories.workflowRun.deleteDeletingByRunner(id);
      await repositories.repo.deleteGone();
    });
    await this.options.bus.notifyQueuedRuns(this.options.repositories, id);
    return apiRunnerOf(runner);
  }

  async requestUpdate(id: number, { isNow }: { isNow: boolean }) {
    if (!this.options.runnerPackage) throw noPackage();
    const { runner } = this.options.repositories;
    if (!(await runner.requestUpdate(id, isNow ? "now" : "when_idle", this.options.build.id))) {
      const found = await runner.findById(id);
      if (!found) throw noRunner(id);
      if (found.state === "revoked") throw revoked();
      if (found.buildId === this.options.build.id) {
        throw new ServiceError("BAD_REQUEST", "The runner runs the build of the server already");
      }
      throw notUpdatable();
    }
    await this.wakeAfterUpdateChange(id);
  }

  async cancelUpdate(id: number) {
    if (!(await this.options.repositories.runner.cancelUpdate(id))) throw noRunner(id);
    await this.wakeAfterUpdateChange(id);
  }

  // The runner learns the request at its next sync, and queued runs can go to it again after a cancel.
  private async wakeAfterUpdateChange(id: number) {
    await this.options.bus.notifyQueuedRuns(this.options.repositories, id);
    wakeProcesses(this.options.connectedRunners, id);
  }

  private async knownRunner(publicKey: string) {
    const runner = await this.options.repositories.runner.findByPublicKey(publicKey);
    const reason = runner && keyRefusalReason(runner);
    if (reason) throw new ServiceError("CONFLICT", reason);
    return runner;
  }
}
