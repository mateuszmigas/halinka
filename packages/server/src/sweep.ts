import type { Db } from "./db/client";
import { createRepositories, inTransaction, type Repositories } from "./db/repositories";
import { inRunTransaction, type RunBus } from "./runBus";
import { releaseRun } from "./runEnd";

// More than the time limits of a test and of its container on the runner.
const maxAgentTestSeconds = 30 * 60;

const maxWaitHours = 24;

const sandboxTtlHours = 24;

// A runner repeats a write soon after a lost answer.
const runCallTtlHours = 24;

// GitHub can send a delivery again for 3 days.
const gitHubDeliveryTtlDays = 7;

const releaseExpiredRuns = (db: Db, bus: RunBus) =>
  inRunTransaction(db, bus, async (repositories, changed) => {
    for (const run of await repositories.workflowRun.lockExpired()) {
      await releaseRun(repositories, run, changed);
    }
  });

// A person waits for the result, and a runner that returns later must not run an old request.
const failLostAgentTests = ({ agentTest }: Repositories, leaseSeconds: number) =>
  agentTest.failLost(leaseSeconds, maxAgentTestSeconds, "The runner did not finish the test");

// No wake: the runner stops these runs at its next `sync`.
const expireWaitingRuns = (db: Db, bus: RunBus) =>
  inRunTransaction(db, bus, async (repositories, changed) => {
    const { workflowRun, stepAttempt, inboxItem } = repositories;
    for (const id of await workflowRun.lockWaitingLongerThan(maxWaitHours)) {
      if (!(await workflowRun.expire(id, maxWaitHours))) continue;
      changed(id, "state");
      await stepAttempt.closeRunning(id, "lost");
      await inboxItem.closeQuestionsOfEndedAttempts(id);
      await workflowRun.stopSandbox(id);
    }
  });

// No wake: the runner removes these sandboxes at its next `sync`.
const removeOldSandboxes = (db: Db, bus: RunBus) =>
  inRunTransaction(db, bus, async ({ workflowRun }, changed) => {
    for (const id of await workflowRun.destroySandboxesKeptBefore(sandboxTtlHours)) {
      changed(id, "state");
    }
  });

const deleteOldRows = async ({
  cliLogin,
  gitHubDelivery,
  runCall,
  runnerEnrollment,
}: Repositories) => {
  await runCall.deleteOfRunsFinishedBefore(runCallTtlHours);
  await runnerEnrollment.deleteExpired();
  await cliLogin.deleteExpired();
  await gitHubDelivery.deleteStartedBefore(gitHubDeliveryTtlDays);
};

// Each job has its own transaction, so a failed job does not stop the next one.
export const sweep = async (db: Db, bus: RunBus, leaseSeconds: number) => {
  const repositories = createRepositories(db);
  const jobs = [
    () => releaseExpiredRuns(db, bus),
    () => failLostAgentTests(repositories, leaseSeconds),
    () => expireWaitingRuns(db, bus),
    () => removeOldSandboxes(db, bus),
    () => repositories.repo.deleteGone(),
    () => inTransaction(db, deleteOldRows),
  ];
  for (const job of jobs) await job().catch((error: unknown) => console.error(error));
};
