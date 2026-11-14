import type { PgTransactionConfig } from "drizzle-orm/pg-core";

import type { Db } from "../client";
import { AgentCredentialRepository } from "./agentCredentialRepository";
import { AgentMessageRepository } from "./agentMessageRepository";
import { AgentRepository } from "./agentRepository";
import { AgentTestRepository } from "./agentTestRepository";
import { CliLoginRepository } from "./cliLoginRepository";
import { GitHubAppRepository } from "./githubAppRepository";
import { GitHubDeliveryRepository } from "./githubDeliveryRepository";
import { InboxItemRepository } from "./inboxItemRepository";
import { MemberRepository } from "./memberRepository";
import { PushedBranchRepository } from "./pushedBranchRepository";
import { RepoRepository } from "./repoRepository";
import { RepoSecretRepository } from "./repoSecretRepository";
import { RunCallRepository } from "./runCallRepository";
import { RunnerEnrollmentRepository } from "./runnerEnrollmentRepository";
import { RunnerKeyRepository } from "./runnerKeyRepository";
import { RunnerRepository } from "./runnerRepository";
import { ServerIdentityRepository } from "./serverIdentityRepository";
import { ServerSettingRepository } from "./serverSettingRepository";
import { StepAttemptRepository } from "./stepAttemptRepository";
import { StepRunRepository } from "./stepRunRepository";
import { UserRepository } from "./userRepository";
import { WorkflowRunEventRepository } from "./workflowRunEventRepository";
import { WorkflowRunRepository } from "./workflowRunRepository";
import { WorkflowScheduleRepository } from "./workflowScheduleRepository";
import { WorkflowSnapshotRepository } from "./workflowSnapshotRepository";

export const createRepositories = (db: Db) => ({
  cliLogin: new CliLoginRepository(db),
  agent: new AgentRepository(db),
  agentCredential: new AgentCredentialRepository(db),
  repoSecret: new RepoSecretRepository(db),
  agentTest: new AgentTestRepository(db),
  agentMessage: new AgentMessageRepository(db),
  gitHubApp: new GitHubAppRepository(db),
  gitHubDelivery: new GitHubDeliveryRepository(db),
  inboxItem: new InboxItemRepository(db),
  member: new MemberRepository(db),
  pushedBranch: new PushedBranchRepository(db),
  repo: new RepoRepository(db),
  runCall: new RunCallRepository(db),
  runnerEnrollment: new RunnerEnrollmentRepository(db),
  runnerKey: new RunnerKeyRepository(db),
  runner: new RunnerRepository(db),
  serverIdentity: new ServerIdentityRepository(db),
  serverSetting: new ServerSettingRepository(db),
  stepAttempt: new StepAttemptRepository(db),
  stepRun: new StepRunRepository(db),
  user: new UserRepository(db),
  workflowRun: new WorkflowRunRepository(db),
  workflowRunEvent: new WorkflowRunEventRepository(db),
  workflowSchedule: new WorkflowScheduleRepository(db),
  workflowSnapshot: new WorkflowSnapshotRepository(db),
});

export type Repositories = ReturnType<typeof createRepositories>;

export const inTransaction = <T>(
  db: Db,
  use: (repositories: Repositories) => Promise<T>,
  config?: PgTransactionConfig,
) => db.transaction((tx) => use(createRepositories(tx)), config);
