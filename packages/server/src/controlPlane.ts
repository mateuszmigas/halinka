import {
  type AgentQuestions,
  type AgentTestResult,
  type AskHumanOptions,
  type AttemptResult,
  type ClaimedRun,
  conflict,
  type ControlPlane,
  type EventBatch,
  type FinishAttemptOptions,
  invalidInput,
  leaseLost,
  maxMessageBytes,
  maxRunErrorLength,
  proceedDecisions,
  protocolVersion,
  ProtocolError,
  type PushedBranchWrite,
  refused,
  type RunCall,
  type RunEvent,
  type RunLease,
  type RunResult,
  type SandboxKind,
  type SandboxReport,
  type SandboxTarget,
  type StepParent,
  type StepRunResult,
  type SyncRequest,
  type SyncResult,
} from "@halinka/protocol";
import { errorMessage } from "@halinka/utils/errors";
import { hashOf } from "@halinka/utils/hash";
import { type GitHubStep, leafSteps } from "@halinka/workflow";

import type { Db } from "./db/client";
import {
  type AgentSelections,
  createRepositories,
  inTransaction,
  type LastReopen,
  type Repositories,
  type ServerBuild,
} from "./db/repositories";
import { type DbAgentCredential, getsNoSetupSecrets, repoPlaceOf, skipsSetup } from "./db/schema";
import { deleteRunIfGone } from "./deletion";
import { isDatabaseUnavailable } from "./planeErrors";
import { findStaleReview, nothingToPushReason, storePush } from "./pushLease";
import { inRunTransaction, type RunBus, type RunChange } from "./runBus";
import { closeEndedQuestions, endRun, releaseRun } from "./runEnd";
import { noAuthorityReason } from "./runnerAccess";
import { testRunReason } from "./runRefusals";
import { agentFingerprint, credentialPlace, repoSecretPlace, type SecretCipher } from "./secrets";
import type { GitHubAppService } from "./services/githubAppService";
import { ServiceError } from "./services/serviceError";
import { withoutNulls } from "./withoutNulls";

const requireRunning = <T>(row: T | undefined, what: string) => {
  if (row === undefined) throw new Error(`${what} is not running`);
  return row;
};

const lockRunningStep = async (
  { stepRun }: Pick<Repositories, "stepRun">,
  workflowRunId: number,
  stepRunId: number,
) => requireRunning(await stepRun.lockRunning(workflowRunId, stepRunId), `Step run ${stepRunId}`);

const finishAttemptRow = async (
  repositories: Repositories,
  { workflowRunId }: RunCall,
  { attemptId, result }: { attemptId: number; result: AttemptResult },
) => {
  const { stepRunId } = requireRunning(
    await repositories.stepAttempt.finish(workflowRunId, attemptId, result),
    `Attempt ${attemptId}`,
  );
  if (result.checkpoint) await repositories.workflowRun.clearWorkspaceOpened(workflowRunId);
  await closeEndedQuestions(repositories, workflowRunId);
  return stepRunId;
};

// A step run that ends while its item is pending no longer waits for input.
type FinishStepOptions = { workflowRunId: number; stepRunId: number; result: StepRunResult };

const finishStep = async (
  { stepRun, stepAttempt, inboxItem, workflowRun }: Repositories,
  { workflowRunId, stepRunId, result }: FinishStepOptions,
) => {
  requireRunning(await stepRun.finish(workflowRunId, stepRunId, result), `Step run ${stepRunId}`);
  await stepAttempt.markLost(stepRunId);
  await inboxItem.closePendingByStepRun(stepRunId);
  await workflowRun.resume(workflowRunId);
};

const openAttemptItem = async (
  { inboxItem, workflowRun }: Repositories,
  item: Parameters<Repositories["inboxItem"]["create"]>[0],
) => {
  const { id } = await inboxItem.create(item);
  await workflowRun.waitForInput(item.workflowRunId);
  return id;
};

const findCheckpoint = async (
  { stepAttempt }: Repositories,
  workflowRunId: number,
  reopen: LastReopen | undefined,
) => {
  if (!reopen) return { lastCheckpoint: await stepAttempt.findLastCheckpoint(workflowRunId) };
  const { id, replacedId, before, after, attempts } = reopen;
  const checkpoint = await stepAttempt.findLastCheckpoint(workflowRunId, { from: id });
  if (checkpoint) return { lastCheckpoint: checkpoint };
  const hasLaterAttempts = await stepAttempt.hasAttemptBetween(workflowRunId, replacedId, id);
  return {
    lastCheckpoint: before,
    rewind: { stepRunId: id, before, after, isFresh: attempts === 0, hasLaterAttempts },
  };
};

// Store it now: a lost attempt stores no session at finish.
const storeSession = async (
  { stepAttempt }: Repositories,
  workflowRunId: number,
  { kind, payload }: RunEvent,
) => {
  if (kind !== "agent_session") return;
  const { attemptId, sessionId, replacedCostUsd } = payload;
  await stepAttempt.setSession(workflowRunId, attemptId, { sessionId, replacedCostUsd });
};

// A delivered message ends the wait for a question of its attempt.
const deliverPrompt = async (
  { agentMessage, inboxItem, workflowRun }: Repositories,
  workflowRunId: number,
  { kind, payload }: RunEvent,
) => {
  if (kind !== "agent_prompt") return false;
  const { attemptId, answered } = payload;
  if (answered) await inboxItem.markAnswerDelivered(workflowRunId, attemptId, answered.itemId);
  if (!payload.messages?.length) return false;
  const messageIds = payload.messages.map(({ messageId }) => messageId);
  await agentMessage.markDelivered(workflowRunId, attemptId, messageIds);
  if (await inboxItem.closeQuestionsByAttempt(workflowRunId, attemptId)) {
    await workflowRun.resume(workflowRunId);
  }
  return true;
};

type KeyReadFacts = { sandboxKind: SandboxKind | null; allowedAgents: string[] | null };

// A worktree has no proxy, so a real value must not go there.
const requireContainer = <Facts extends Pick<KeyReadFacts, "sandboxKind">>(
  facts: Facts | undefined,
) => {
  if (facts?.sandboxKind !== "devcontainer") {
    throw conflict("Only a run or a test in a container gets a stored value");
  }
  return facts;
};

const requireAllowedKeyRead = (found: KeyReadFacts | undefined, preset: string) => {
  const facts = requireContainer(found);
  if (facts.allowedAgents && !facts.allowedAgents.includes(preset)) {
    throw conflict(`This runner does not allow the agent ${preset} any more`);
  }
};

type RunnerProcess = { runnerId: number; instanceId: string; publicKey: string };

type PlaneOptions = {
  db: Db;
  serverBuild: ServerBuild;
  bus: RunBus;
  leaseSeconds: number;
  cipher: SecretCipher;
  gitHubApp: Pick<GitHubAppService, "findPushToken" | "requireRepoToken">;
};

const repeatedCall = (
  recorded: { leaseToken: string; callHash: string; result: { value?: unknown } } | undefined,
  { workflowRunId, lease, callId }: RunCall,
  callHash: string,
) => {
  if (!recorded || recorded.leaseToken !== lease) throw leaseLost(workflowRunId);
  if (recorded.callHash !== callHash) {
    throw invalidInput(`The call ${callId} repeats another call with other arguments`);
  }
  return recorded.result.value;
};

// The rest of `maxMessageBytes` holds the kept runs, the answers, the messages and the sandboxes.
const maxClaimBytes = maxMessageBytes / 2;

const tooLargeError = (bytes: number) =>
  `The steps, the workflow, the inputs and the chat of the run have ${bytes} bytes, more than a runner can get ` +
  `(${maxClaimBytes}). Start a new run with fewer loop iterations, smaller inputs or a shorter chat.`;

const gitHubActionTexts: Record<GitHubStep["action"], string> = {
  open_pull_request: "open a pull request",
  comment_on_pull_request: "comment on a pull request",
};

type GitHubStepTarget = { workflowRunId: number; stepRunId: number; action: GitHubStep["action"] };

type LeasedOptions = { strength?: "no key update"; change?: RunChange; call?: unknown[] };

export class ServerControlPlane implements ControlPlane {
  constructor(
    private readonly process: RunnerProcess,
    private readonly options: PlaneOptions,
  ) {}

  async sync({
    held,
    capacity,
    capabilities,
    isSweep = false,
    canTest = false,
  }: SyncRequest): Promise<SyncResult> {
    const { runnerId, instanceId, publicKey } = this.process;
    // Own transaction: in the next one, this update of the runner row can deadlock or block syncs.
    const { isChanged: reportedChange, update } = await inTransaction(
      this.options.db,
      async ({ runner }) => {
        await runner.lockById(runnerId);
        return runner.report(runnerId, publicKey, {
          capabilities,
          runnerProtocolVersion: protocolVersion,
          server: this.options.serverBuild,
        });
      },
    );
    if (reportedChange)
      await this.options.bus.notifyQueuedRuns(createRepositories(this.options.db), runnerId);
    // A call that started before a revoke or a new key stops here.
    const checkAuthority = async ({ runner }: Repositories) => {
      if (!(await runner.hasAuthority(runnerId, publicKey))) throw refused(noAuthorityReason);
    };
    const listed = new Map(held.map(({ workflowRunId, lease }) => [workflowRunId, lease]));
    // Its own transaction: a failed claim must not undo the renewals.
    const keep = await inRunTransaction(
      this.options.db,
      this.options.bus,
      async (repositories, changed) => {
        await checkAuthority(repositories);
        const kept: number[] = [];
        const renewed: number[] = [];
        for (const run of await repositories.workflowRun.lockHeldBy(runnerId, instanceId)) {
          if (run.expired || listed.get(run.id) !== run.leaseToken) {
            await releaseRun(repositories, run, changed);
            continue;
          }
          renewed.push(run.id);
          if (!run.cancelRequestedAt) kept.push(run.id);
        }
        await repositories.workflowRun.renewLeases(renewed, this.options.leaseSeconds);
        return kept;
      },
    );
    return inRunTransaction(this.options.db, this.options.bus, async (repositories, changed) => {
      const { agent, workflowRun, stepRun, stepAttempt, inboxItem, agentMessage } = repositories;
      await checkAuthority(repositories);
      const skip = [...listed.keys()];
      const claimed: ClaimedRun[] = [];
      let selections: AgentSelections | undefined;
      let budget = maxClaimBytes;
      while (claimed.length < capacity) {
        const next = await workflowRun.lockNextQueued(runnerId, capabilities.sandboxKind, skip);
        if (!next) break;
        const reopen = await stepRun.findLastReopen(next.id);
        const steps = await stepRun.listRecorded(next.id, reopen);
        const { workflow, inputs, setupNetwork, setupRun } = next;
        const bytes = Buffer.byteLength(
          JSON.stringify({ workflow, inputs, setupNetwork, setupRun, steps }),
        );
        if (bytes > budget && claimed.length > 0) break;
        const run = await workflowRun.claim(next.id, {
          runnerId,
          holder: instanceId,
          sandboxKind: capabilities.sandboxKind,
          leaseSeconds: this.options.leaseSeconds,
        });
        if (!run) throw new Error(`Run ${next.id} was not claimed`);
        // A call id of an earlier lease cannot repeat anymore.
        await repositories.runCall.deleteByRun(run.id);
        changed(run.id, "state");
        const lease = { workflowRunId: run.id, lease: run.leaseToken };
        if (bytes > maxClaimBytes) {
          await endRun(repositories, lease, { result: "failed", error: tooLargeError(bytes) });
          continue;
        }
        budget -= bytes;
        const { lastCheckpoint, rewind } = await findCheckpoint(repositories, run.id, reopen);
        claimed.push({
          lease,
          ...repoPlaceOf(run),
          branch: run.branch,
          baseSha: run.baseSha,
          definitionSha: run.definitionSha,
          sandboxKind: run.sandboxKind,
          ...(run.devcontainer && {
            devcontainer: run.devcontainer,
            setupNetwork: run.setupNetwork,
            ...(run.setupDocker && { setupDocker: true }),
          }),
          ...(run.setupRun !== null && !skipsSetup(run) && { setupRun: run.setupRun }),
          workflow: run.workflow,
          inputs: run.inputs,
          ...(run.pullRequestNumber !== null && { pullRequestNumber: run.pullRequestNumber }),
          isUntrusted: run.untrusted,
          isTestRun: run.testRun,
          steps,
          lastCheckpoint: lastCheckpoint ?? run.baseSha,
          ...(rewind && { rewind }),
          ...(next.workspaceOpened && { isWorkspaceOpened: true }),
          ...(selections ??= await agent.findSelections()),
        });
      }
      const workflowRunIds = [...keep, ...claimed.map(({ lease }) => lease.workflowRunId)];
      const answers = (await inboxItem.listAnswers(workflowRunIds)).map((answer) =>
        withoutNulls(answer),
      );
      const messages = await agentMessage.listUndelivered(workflowRunIds);
      const sandboxes = await Promise.all(
        (await workflowRun.listSandboxes(runnerId, { isSweep })).map(
          async ({ branchToDelete, ...target }): Promise<SandboxTarget> => {
            if (!branchToDelete) return target;
            const lastCheckpoint = await stepAttempt.findLastCheckpoint(target.workflowRunId);
            const runBranch = {
              name: branchToDelete,
              lastCheckpoint: lastCheckpoint ?? target.baseSha,
            };
            return { ...target, runBranch };
          },
        ),
      );
      // A process that restarts for an update must not take an agent test first.
      const agentTest =
        canTest && !update
          ? await this.claimAgentTest(repositories, capabilities.sandboxKind)
          : undefined;
      return {
        keep,
        claimed,
        answers,
        messages,
        sandboxes,
        ...(agentTest && { agentTest }),
        ...(update && { update }),
      };
    });
  }

  startStep(lease: RunCall, stepId: string, parent?: StepParent) {
    return this.leased(
      lease,
      async ({ stepRun }) => {
        if (parent) await lockRunningStep({ stepRun }, lease.workflowRunId, parent.stepRunId);
        return stepRun.start(lease.workflowRunId, stepId, { parent });
      },
      { call: ["startStep", stepId, parent] },
    );
  }

  finishStep(lease: RunCall, stepRunId: number, result: StepRunResult) {
    return this.leased(
      lease,
      async (repositories) => {
        await finishStep(repositories, { workflowRunId: lease.workflowRunId, stepRunId, result });
        return repositories.stepRun.readFacts(lease.workflowRunId, stepRunId);
      },
      { call: ["finishStep", stepRunId, result] },
    );
  }

  startAttempt(lease: RunCall, stepRunId: number) {
    return this.leased(
      lease,
      async (repositories) => {
        const { stepAttempt, inboxItem } = repositories;
        await lockRunningStep(repositories, lease.workflowRunId, stepRunId);
        await stepAttempt.markLost(stepRunId);
        await inboxItem.markAttemptItemsDelivered(stepRunId);
        await closeEndedQuestions(repositories, lease.workflowRunId);
        return stepAttempt.start(stepRunId);
      },
      { call: ["startAttempt", stepRunId] },
    );
  }

  finishAttempt(lease: RunCall, attemptId: number, options: FinishAttemptOptions) {
    const { result, stepResult } = options;
    return this.leased(
      lease,
      async (repositories) => {
        const stepRunId = await finishAttemptRow(repositories, lease, { attemptId, result });
        if (stepResult) {
          await finishStep(repositories, {
            workflowRunId: lease.workflowRunId,
            stepRunId,
            result: stepResult,
          });
        }
        return repositories.stepRun.readFacts(lease.workflowRunId, stepRunId);
      },
      { call: ["finishAttempt", attemptId, options] },
    );
  }

  // `no key update`, so the appends of one run commit in `seq` order
  appendEvents(lease: RunLease, batch: EventBatch) {
    return this.leased(
      lease,
      async (repositories, changed) => {
        const { workflowRunId } = lease;
        if (!(await repositories.workflowRunEvent.append(workflowRunId, batch))) return;
        for (const event of batch.events) {
          await storeSession(repositories, workflowRunId, event);
          if (await deliverPrompt(repositories, workflowRunId, event)) changed("state");
        }
      },
      { strength: "no key update", change: "events" },
    );
  }

  openApproval(lease: RunCall, stepRunId: number, message: string) {
    return this.leased(
      lease,
      async ({ stepRun, inboxItem, workflowRun }) => {
        const { workflowRunId } = lease;
        await lockRunningStep({ stepRun }, workflowRunId, stepRunId);
        const item =
          (await inboxItem.findApproval(stepRunId)) ??
          (await inboxItem.create({ workflowRunId, stepRunId, kind: "approval", message }));
        if (!item.resolvedAt) await workflowRun.waitForInput(workflowRunId);
        return item.id;
      },
      { strength: "no key update", call: ["openApproval", stepRunId, message] },
    );
  }

  askHuman(lease: RunCall, attemptId: number, options: AskHumanOptions) {
    const { result, kind, message } = options;
    return this.leased(
      lease,
      async (repositories) => {
        const { workflowRunId } = lease;
        const stepRunId = await finishAttemptRow(repositories, lease, { attemptId, result });
        const row = { workflowRunId, stepRunId, stepAttemptId: attemptId, kind, message };
        // The next prompt carries the message; only a person raises a limit.
        if (kind === "limit" || !(await repositories.agentMessage.hasUndelivered(stepRunId))) {
          return openAttemptItem(repositories, row);
        }
        const { id } = await repositories.inboxItem.create(row);
        await repositories.inboxItem.resolve(id, {
          decision: proceedDecisions[kind],
          note: null,
          answer: null,
          resolvedBy: "halinka",
        });
        return id;
      },
      { strength: "no key update", call: ["askHuman", attemptId, options] },
    );
  }

  askQuestion(lease: RunCall, attemptId: number, questions: AgentQuestions) {
    return this.leased(
      lease,
      async (repositories) => {
        const { workflowRunId } = lease;
        const { stepRunId } = requireRunning(
          await repositories.stepAttempt.lockRunning(workflowRunId, attemptId),
          `Attempt ${attemptId}`,
        );
        return openAttemptItem(repositories, {
          workflowRunId,
          stepRunId,
          stepAttemptId: attemptId,
          kind: "question",
          questions,
        });
      },
      { strength: "no key update", call: ["askQuestion", attemptId, questions] },
    );
  }

  branchCreated(lease: RunCall) {
    return this.leased(
      lease,
      ({ workflowRun }) => workflowRun.markBranchCreated(lease.workflowRunId),
      { strength: "no key update", call: ["branchCreated"] },
    );
  }

  async readAgentCredentials(lease: RunLease, preset: string) {
    const rows = await inTransaction(this.options.db, async (repositories) => {
      const facts = await this.readHeldRunFacts(repositories, lease);
      requireAllowedKeyRead(facts, preset);
      if (!facts?.agents.includes(preset)) {
        throw conflict(
          `The workflow of run ${lease.workflowRunId} does not use the agent ${preset}`,
        );
      }
      const { agentCredential } = repositories;
      const own =
        facts.authorId === null ? [] : await agentCredential.listByPreset(preset, facts.authorId);
      // All values of one owner: with a mix, the agent can select the key of the team.
      return own.length > 0 ? own : agentCredential.listByPreset(preset, null);
    });
    return this.openCredentials(rows);
  }

  async readSetupSecrets(lease: RunLease) {
    const { rows, names } = await inTransaction(this.options.db, async (repositories) => {
      const facts = requireContainer(await this.readHeldRunFacts(repositories, lease));
      return {
        rows: await repositories.repoSecret.listByRepo(facts.repoId),
        names: getsNoSetupSecrets(facts) ? [] : facts.setupSecrets,
      };
    });
    const opened = names.map((name) => {
      const row = rows.find((item) => item.name === name);
      return {
        name,
        value: row && this.options.cipher.open(repoSecretPlace(row.repoId, name), row.sealed),
      };
    });
    return {
      values: opened.flatMap(({ name, value }) =>
        value === undefined ? [] : [{ variable: name, value }],
      ),
      missing: opened.filter(({ value }) => value === undefined).map(({ name }) => name),
    };
  }

  async readMirrorAccess(lease: RunLease) {
    const facts = await inTransaction(this.options.db, (repositories) =>
      this.readHeldRunFacts(repositories, lease),
    );
    if (facts?.repoKind !== "github") {
      throw conflict(`Run ${lease.workflowRunId} is not a run of a GitHub repo`);
    }
    return this.readAppToken((gitHub) => gitHub.requireRepoToken(facts.githubRepoId, "clone"));
  }

  async readPushAccess(lease: RunLease, stepRunId: number) {
    const { facts, commit, pushedCommit } = await inTransaction(
      this.options.db,
      async (repositories) => {
        const facts = await this.readHeldRunFacts(repositories, lease);
        if (!facts) throw leaseLost(lease.workflowRunId);
        const { run, commit } = await this.pushTarget(repositories, lease, stepRunId);
        const pushed = await repositories.pushedBranch.find(run.repoId, run.branch);
        return { facts, commit, pushedCommit: pushed?.commit };
      },
    );
    const github = await this.readAppToken((service) =>
      service.findPushToken(facts, "openPullRequest"),
    );
    return { commit, github, pushedCommit };
  }

  storePushedBranch(lease: RunCall, stepRunId: number, write: PushedBranchWrite) {
    return this.leased(
      lease,
      async (repositories) => {
        const { run, commit } = await this.pushTarget(repositories, lease, stepRunId);
        const problem = await storePush(repositories, {
          repoId: run.repoId,
          branch: run.branch,
          write: { ...write, commit },
        });
        if (problem) throw conflict(problem);
      },
      { call: ["storePushedBranch", stepRunId, write] },
    );
  }

  async readCommentAccess(lease: RunLease, stepRunId: number) {
    const { githubRepoId, pullRequestNumber, commentUrl } = await inTransaction(
      this.options.db,
      async (repositories) => {
        const facts = await this.readHeldRunFacts(repositories, lease);
        if (!facts) throw leaseLost(lease.workflowRunId);
        return this.commentTarget(repositories, lease, stepRunId);
      },
    );
    if (commentUrl !== null) return { url: commentUrl };
    const github = await this.readAppToken((service) =>
      service.requireRepoToken(githubRepoId, "comment"),
    );
    return { pullRequestNumber, github };
  }

  storeComment(lease: RunCall, stepRunId: number, url: string) {
    return this.leased(
      lease,
      async (repositories) => {
        await this.commentTarget(repositories, lease, stepRunId);
        await repositories.stepRun.storeComment(stepRunId, url);
      },
      { call: ["storeComment", stepRunId, url] },
    );
  }

  private async commentTarget(repositories: Repositories, lease: RunLease, stepRunId: number) {
    const { run, running } = await this.gitHubStepTarget(repositories, {
      workflowRunId: lease.workflowRunId,
      stepRunId,
      action: "comment_on_pull_request",
    });
    if (run.pullRequestNumber === null) {
      throw conflict(`Run ${run.id} did not start from a pull request`);
    }
    return {
      pullRequestNumber: run.pullRequestNumber,
      githubRepoId: run.githubRepoId,
      commentUrl: running.commentUrl,
    };
  }

  // The checks of "Open PR": a runner on the network does not select the commit.
  private async pushTarget(repositories: Repositories, lease: RunLease, stepRunId: number) {
    const { run } = await this.gitHubStepTarget(repositories, {
      workflowRunId: lease.workflowRunId,
      stepRunId,
      action: "open_pull_request",
    });
    const commit = (await repositories.stepAttempt.findLastCheckpoint(run.id)) ?? run.baseSha;
    if (commit === run.baseSha) throw conflict(nothingToPushReason(run.id));
    const stale = await findStaleReview(repositories, run, commit);
    if (stale) throw conflict(stale);
    return { run, commit };
  }

  private async gitHubStepTarget(
    { stepRun, workflowRun }: Repositories,
    { workflowRunId, stepRunId, action }: GitHubStepTarget,
  ) {
    const run = await workflowRun.findById(workflowRunId);
    const running = await stepRun.lockRunning(workflowRunId, stepRunId);
    if (!run || !running) {
      throw conflict(`Step run ${stepRunId} of run ${workflowRunId} is not running`);
    }
    if (run.testRun) throw conflict(testRunReason(workflowRunId));
    const step = leafSteps(run.workflow).find(({ id }) => id === running.stepId);
    if (step?.type !== "github" || step.action !== action) {
      throw conflict(`The step ${running.stepId} does not ${gitHubActionTexts[action]}`);
    }
    return { run, running };
  }

  async readTestCredentials(token: string) {
    const { runnerId, publicKey } = this.process;
    const rows = await inTransaction(
      this.options.db,
      async ({ agentCredential, agentTest, runner }) => {
        if (!(await runner.hasAuthority(runnerId, publicKey))) throw refused(noAuthorityReason);
        const test = await agentTest.holdRunning(token, runnerId);
        if (!test) throw conflict("The test ended, or a later request replaced it");
        requireAllowedKeyRead(await runner.findById(runnerId), test.preset);
        const rows = await agentCredential.listByPreset(test.preset, test.memberId);
        // With no value, the runner uses its own login.
        if (test.memberId !== null && rows.length === 0) {
          throw conflict("The key of this test is gone");
        }
        return rows;
      },
    );
    return this.openCredentials(rows);
  }

  async finishAgentTest(token: string, result: AgentTestResult) {
    const { runnerId, publicKey } = this.process;
    await inTransaction(this.options.db, async ({ agentTest, runner }) => {
      if (!(await runner.hasAuthority(runnerId, publicKey))) throw refused(noAuthorityReason);
      await agentTest.finish(token, runnerId, result);
    });
  }

  // Call it after the transaction: the lease lock must not wait for GitHub.
  private readAppToken<T>(read: (gitHub: PlaneOptions["gitHubApp"]) => Promise<T>) {
    return read(this.options.gitHubApp).catch((error: unknown) => {
      throw error instanceof ServiceError ? conflict(error.message) : error;
    });
  }

  private async readHeldRunFacts(
    { workflowRun }: Repositories,
    { workflowRunId, lease }: RunLease,
  ) {
    if (!(await workflowRun.holdLease(workflowRunId, lease, this.process))) {
      throw leaseLost(workflowRunId);
    }
    return workflowRun.findCredentialFacts(workflowRunId, this.process.runnerId);
  }

  private openCredentials(rows: DbAgentCredential[]) {
    return rows.map((row) => {
      const value = this.options.cipher.open(credentialPlace(row), row.sealed);
      if (value === undefined) {
        throw conflict(
          `The server cannot read the stored ${row.variable}: it has another master key. Enter the value again on the Agents page.`,
        );
      }
      return { variable: row.variable, value };
    });
  }

  private async claimAgentTest(
    { agent, agentCredential, agentTest }: Repositories,
    sandboxKind: SandboxKind,
  ) {
    const { runnerId } = this.process;
    const open = await agentTest.lockOpen(runnerId);
    // With `canTest`, a running row belongs to a process that ended.
    if (open.some(({ status }) => status === "running")) {
      await agentTest.failRunning(runnerId, "The runner stopped during the test");
    }
    const next = open.find(({ status }) => status === "requested");
    if (!next) return undefined;
    const { id, preset, token, memberId } = next;
    // The runner can restart in worktree mode, and that test spends its login.
    if (memberId !== null && sandboxKind !== "devcontainer") {
      await agentTest.fail(id, "This runner has no container now, so it cannot test your key");
      return undefined;
    }
    const { agentVersions, agentModels } = await agent.findSelections();
    const version = agentVersions[preset];
    const model = agentModels[preset];
    // Only a container test can be old: a worktree test uses neither the version nor the keys.
    const testedWith =
      sandboxKind === "devcontainer"
        ? agentFingerprint(preset, await agentCredential.listByPreset(preset, memberId), {
            version,
            model,
          })
        : null;
    await agentTest.start(id, testedWith);
    return { token, preset, version, model };
  }

  // A run whose result the server cannot store fails, so the server does not queue it again.
  async finishRun(lease: RunCall, result: RunResult, error?: string) {
    try {
      return await this.leased(
        lease,
        async (repositories) => {
          const { workflowRunId } = lease;
          if (result === "succeeded" && (await repositories.stepRun.hasRunning(workflowRunId))) {
            throw new ProtocolError(
              "result_refused",
              `Run ${workflowRunId} still has a running step`,
            );
          }
          await endRun(repositories, lease, { result, error });
        },
        { strength: "no key update", call: ["finishRun", result, error ?? null] },
      );
    } catch (caught) {
      if (caught instanceof ProtocolError || isDatabaseUnavailable(caught)) throw caught;
      console.error(caught);
      const notStored = `The server did not store the result "${result}" of the run: ${errorMessage(caught)}`;
      await this.leased(
        lease,
        (repositories) => endRun(repositories, lease, { result: "failed", error: notStored }),
        {
          strength: "no key update",
        },
      );
      throw caught;
    }
  }

  reportSandbox(input: SandboxReport) {
    const report =
      "error" in input ? { ...input, error: input.error.slice(0, maxRunErrorLength) } : input;
    const { runnerId, publicKey } = this.process;
    return inRunTransaction(this.options.db, this.options.bus, async (repositories, changed) => {
      const { runner, workflowRun } = repositories;
      if (!(await runner.hasAuthority(runnerId, publicKey))) throw refused(noAuthorityReason);
      if (!(await workflowRun.recordSandbox(runnerId, report))) return;
      changed(report.workflowRunId, "state");
      if ("observed" in report && report.observed === "absent") {
        await deleteRunIfGone(repositories, report.workflowRunId);
      }
    });
  }

  // A call with a call id takes its `run_calls` row first, so a repeat needs no valid lease.
  private leased<T>(
    lease: RunCall,
    use: (repositories: Repositories, changed: (change: RunChange) => void) => Promise<T>,
    { strength, change = "state", call }: LeasedOptions = {},
  ) {
    const { workflowRunId, callId } = lease;
    return inRunTransaction(this.options.db, this.options.bus, async (repositories, changed) => {
      const receipt =
        callId && call
          ? { workflowRunId, callId, callHash: hashOf(JSON.stringify(call)) }
          : undefined;
      if (receipt) {
        const started = await repositories.runCall.start({ ...receipt, leaseToken: lease.lease });
        if (!started) {
          const recorded = await repositories.runCall.find(workflowRunId, receipt.callId);
          return repeatedCall(recorded, lease, receipt.callHash) as T;
        }
      }
      if (
        !(await repositories.workflowRun.holdLease(workflowRunId, lease.lease, {
          ...this.process,
          strength,
        }))
      ) {
        throw leaseLost(workflowRunId);
      }
      changed(workflowRunId, change);
      const result = await use(repositories, (other) => changed(workflowRunId, other));
      if (receipt) await repositories.runCall.finish(workflowRunId, receipt.callId, result);
      return result;
    });
  }
}
