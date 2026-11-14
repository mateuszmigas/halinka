import type { Build } from "@halinka/protocol";

import { type ConnectedRunners, createWakeRunner } from "../connectedRunners";
import type { Db } from "../db/client";
import { createRepositories } from "../db/repositories";
import type { RunBus } from "../runBus";
import type { RunnerPackage } from "../runnerPackage";
import type { SecretCipher } from "../secrets";
import type { ServerSettings } from "../serverSettings";
import { AgentService } from "./agentService";
import { CliLoginService } from "./cliLoginService";
import { GitHubAppService } from "./githubAppService";
import { GitHubDeliveryService } from "./githubDeliveryService";
import { InboxService } from "./inboxService";
import { MemberService } from "./memberService";
import { PushService } from "./pushService";
import { RepoSecretService } from "./repoSecretService";
import { RepoService } from "./repoService";
import { RunnerService } from "./runnerService";
import { RunService } from "./runService";
import { ScheduleService } from "./scheduleService";
import { ServerSettingsService } from "./serverSettingsService";
import { TriggerService } from "./triggerService";

type ServicesOptions = {
  db: Db;
  build: Build;
  publicUrl?: string;
  runnerPackage?: RunnerPackage;
  connectedRunners: ConnectedRunners;
  bus: RunBus;
  localRunnerId: () => number | undefined;
  cipher: SecretCipher;
  serverSettings: ServerSettings;
};

export const createServices = ({
  db,
  build,
  publicUrl,
  runnerPackage,
  connectedRunners,
  bus,
  localRunnerId,
  cipher,
  serverSettings,
}: ServicesOptions) => {
  const repositories = createRepositories(db);
  const gitHubApp = new GitHubAppService(db, repositories, cipher);
  const repo = new RepoService({
    db,
    repositories,
    connectedRunners,
    bus,
    gitHubApp,
    localRunnerId,
  });
  const wakeRunner = createWakeRunner(repositories, connectedRunners);
  const run = new RunService({
    db,
    repositories,
    repo,
    connectedRunners,
    wakeRunner,
    bus,
    localRunnerId,
  });
  const trigger = new TriggerService(repositories, repo, run);
  return {
    agent: new AgentService({ repositories, cipher, bus, connectedRunners }),
    cliLogin: new CliLoginService(repositories),
    gitHubApp,
    gitHubDelivery: new GitHubDeliveryService({ repositories, gitHubApp, repo, trigger }),
    inbox: new InboxService({ db, repositories, wakeRunner, bus }),
    member: new MemberService(db, repositories),
    push: new PushService({ db, bus, gitHubApp, connectedRunners }),
    repoSecret: new RepoSecretService(repositories, cipher),
    repo,
    run,
    runner: new RunnerService({
      db,
      build,
      publicUrl,
      runnerPackage,
      repositories,
      connectedRunners,
      bus,
    }),
    schedule: new ScheduleService(repositories, repo, run),
    serverSettings: new ServerSettingsService(repositories, serverSettings),
  };
};

export type Services = ReturnType<typeof createServices>;
