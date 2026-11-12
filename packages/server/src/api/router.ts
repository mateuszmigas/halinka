import { implement, ORPCError } from "@orpc/server";

import type { ApiUser } from "../auth/auth";
import type { Services } from "../services";
import { noLogin, ServiceError } from "../services/serviceError";
import { contract } from "./contract";
import { startSeq, toEventIterator } from "./runEventStream";

type ApiContext = {
  services: Services;
  // The server URL that the portal uses, from the request.
  origin: string;
  isLoginRequired: boolean;
  findUser: () => Promise<ApiUser | undefined>;
};

const api = implement(contract).$context<ApiContext>();

const logInFirst = () => new ORPCError("UNAUTHORIZED", { message: "Log in first" });

const member = api.use(async ({ context, next }) => {
  const user = await context.findUser();
  if (!user) throw logInFirst();
  return next({ context: { user } });
});

// A token acts only for itself: it must not make a new token or end another one.
const inPortal = member.use(({ context, next }) => {
  if (context.user.cliLoginId !== undefined) {
    throw new ORPCError("FORBIDDEN", { message: "Do this in the portal" });
  }
  return next();
});

const person = member.use(({ context, next }) => {
  const { memberId } = context.user;
  if (memberId === undefined) {
    throw new ServiceError("BAD_REQUEST", "This server has no login, so it has only team keys");
  }
  return next({ context: { memberId } });
});

const admin = member.use(({ context, next }) => {
  if (context.user.role !== "admin") {
    throw new ORPCError("FORBIDDEN", { message: "Only an Admin can do this" });
  }
  return next();
});

export const router = api.router({
  health: api.health.handler(async ({ context }) => {
    await context.services.run.ping();
    return { ok: true as const };
  }),
  session: api.session.handler(async ({ context }) => ({
    isLoginRequired: context.isLoginRequired,
    serverUrl: context.origin,
    user: await context.findUser(),
  })),
  cliLogin: {
    start: api.cliLogin.start.handler(({ context }) => {
      if (!context.isLoginRequired) throw noLogin();
      return context.services.cliLogin.start();
    }),
    exchange: api.cliLogin.exchange.handler(({ input, context }) =>
      context.services.cliLogin.exchange(input.deviceCode),
    ),
    list: inPortal.cliLogin.list.handler(({ context }) =>
      context.services.cliLogin.list(context.user.memberId),
    ),
    end: inPortal.cliLogin.end.handler(({ input, context }) =>
      context.services.cliLogin.end(input.id, context.user.memberId),
    ),
    logout: member.cliLogin.logout.handler(({ context }) => {
      const { cliLoginId, memberId } = context.user;
      if (cliLoginId === undefined) throw new ServiceError("BAD_REQUEST", "Send a token");
      return context.services.cliLogin.end(cliLoginId, memberId);
    }),
    approve: inPortal.cliLogin.approve.handler(({ input, context }) =>
      context.services.cliLogin.approve(input.userCode, context.user.memberId),
    ),
  },
  agents: {
    list: member.agents.list.handler(({ context }) =>
      context.services.agent.list(context.user.memberId),
    ),
    update: admin.agents.update.handler(({ input: { preset, ...settings }, context }) =>
      context.services.agent.update(preset, settings),
    ),
    setCredential: admin.agents.setCredential.handler(({ input, context }) =>
      context.services.agent.setCredential(input),
    ),
    deleteCredential: admin.agents.deleteCredential.handler(({ input, context }) =>
      context.services.agent.deleteCredential(input.preset, input.variable),
    ),
    test: admin.agents.test.handler(({ input, context }) =>
      context.services.agent.test(input.preset, input.runner),
    ),
    setMyCredential: person.agents.setMyCredential.handler(({ input, context }) =>
      context.services.agent.setCredential(input, context.memberId),
    ),
    deleteMyCredential: person.agents.deleteMyCredential.handler(({ input, context }) =>
      context.services.agent.deleteCredential(input.preset, input.variable, context.memberId),
    ),
    testMine: person.agents.testMine.handler(({ input, context }) =>
      context.services.agent.test(input.preset, input.runner, context.memberId),
    ),
  },
  github: {
    status: admin.github.status.handler(({ context }) => context.services.gitHubApp.status()),
    manifest: admin.github.manifest.handler(({ input, context }) =>
      context.services.gitHubApp.manifest(
        context.origin,
        context.user.memberId,
        input.organization,
      ),
    ),
    connect: admin.github.connect.handler(({ input, context }) =>
      context.services.gitHubApp.connect(context.user.memberId, input.code, input.state),
    ),
    disconnect: admin.github.disconnect.handler(({ context }) =>
      context.services.gitHubApp.disconnect(),
    ),
    refresh: admin.github.refresh.handler(({ context }) => context.services.gitHubApp.refresh()),
  },
  members: {
    list: admin.members.list.handler(({ context }) => context.services.member.list()),
    create: admin.members.create.handler(({ input, context }) =>
      context.services.member.create(input.login, input.role),
    ),
    delete: admin.members.delete.handler(({ input, context }) =>
      context.services.member.delete(input.id),
    ),
  },
  repos: {
    list: member.repos.list.handler(({ context }) => context.services.repo.list()),
    secrets: member.repos.secrets.handler(({ input, context }) =>
      context.services.repoSecret.list(input.id),
    ),
    setSecret: admin.repos.setSecret.handler(({ input, context }) =>
      context.services.repoSecret.set(input.id, input.name, input.value),
    ),
    deleteSecret: admin.repos.deleteSecret.handler(({ input, context }) =>
      context.services.repoSecret.delete(input.id, input.name),
    ),
    register: admin.repos.register.handler(({ input, context }) =>
      context.services.repo.register(input.runnerId, input.path),
    ),
    init: admin.repos.init.handler(({ input, context }) =>
      context.services.repo.init({ ...input, origin: context.origin }),
    ),
    createGitHub: admin.repos.createGitHub.handler(({ input, context }) =>
      context.services.repo.createGitHub(input.githubRepoId),
    ),
    linkGitHub: admin.repos.linkGitHub.handler(({ input, context }) =>
      context.services.repo.linkGitHub(input.id, input.githubRepoId),
    ),
    workflows: member.repos.workflows.handler(({ input, context }) =>
      context.services.repo.listWorkflows(input.id),
    ),
    workflow: member.repos.workflow.handler(({ input, context }) =>
      context.services.repo.readWorkflow(input.id, input.workflow),
    ),
    delete: admin.repos.delete.handler(({ input, context }) =>
      context.services.repo.delete(input.id),
    ),
    writeWorkflow: admin.repos.writeWorkflow.handler(({ input: { id, ...file }, context }) =>
      context.services.repo.writeWorkflow(id, file),
    ),
    publishWorkflow: member.repos.publishWorkflow.handler(({ input: { id, ...draft }, context }) =>
      context.services.repo.publishWorkflow(id, draft, context.user.login),
    ),
  },
  runners: {
    list: member.runners.list.handler(({ context }) => context.services.runner.list()),
    update: admin.runners.update.handler(({ input: { id, ...changes }, context }) =>
      context.services.runner.update(id, changes),
    ),
    folders: admin.runners.folders.handler(({ input, context }) =>
      context.services.runner.folders(input.id, input.path),
    ),
    revoke: admin.runners.revoke.handler(({ input, context }) =>
      context.services.runner.revoke(input.id),
    ),
    requestUpdate: admin.runners.requestUpdate.handler(({ input: { id, isNow }, context }) =>
      context.services.runner.requestUpdate(id, { isNow }),
    ),
    cancelUpdate: admin.runners.cancelUpdate.handler(({ input, context }) =>
      context.services.runner.cancelUpdate(input.id),
    ),
    createEnrollmentToken: admin.runners.createEnrollmentToken.handler(({ input, context }) =>
      context.services.runner.createEnrollmentToken(input),
    ),
    findRequest: admin.runners.findRequest.handler(({ input, context }) =>
      context.services.runner.findRequest(input.userCode),
    ),
    approveRequest: admin.runners.approveRequest.handler(
      ({ input: { userCode, ...target }, context }) =>
        context.services.runner.approve(userCode, target),
    ),
  },
  runner: {
    manifest: api.runner.manifest.handler(({ context }) => context.services.runner.manifest()),
    probe: api.runner.probe.handler(({ input, context }) => context.services.runner.probe(input)),
    reportStatus: api.runner.reportStatus.handler(({ input, context }) =>
      context.services.runner.reportStatus(input),
    ),
    register: api.runner.register.handler(({ input, context }) =>
      context.services.runner.register(input),
    ),
    enroll: api.runner.enroll.handler(({ input: { token, ...registration }, context }) =>
      context.services.runner.enroll(token, registration),
    ),
  },
  costs: {
    list: member.costs.list.handler(({ context }) => context.services.run.listCosts()),
  },
  inbox: {
    list: member.inbox.list.handler(({ context }) => context.services.inbox.listPending()),
    resolve: member.inbox.resolve.handler(({ input, context }) =>
      context.services.inbox.resolve(input.id, input, context.user.login),
    ),
  },
  runs: {
    create: member.runs.create.handler(({ input, context }) =>
      context.services.run.create(input, context.user.memberId),
    ),
    test: member.runs.test.handler(({ input, context }) =>
      context.services.run.createTest(input, context.user.memberId),
    ),
    list: member.runs.list.handler(({ input, context }) => context.services.run.list(input)),
    totals: member.runs.totals.handler(({ context }) => context.services.run.totals(new Date())),
    get: member.runs.get.handler(({ input, context }) => context.services.run.get(input.id)),
    events: member.runs.events.handler(({ input, context }) =>
      context.services.run.listEvents(input.id, input.after),
    ),
    watch: member.runs.watch.handler(async ({ input, context, lastEventId, signal }) =>
      toEventIterator(
        await context.services.run.watch(input.id, startSeq(lastEventId, input.after)),
        signal,
        async () => {
          if (!(await context.findUser())) throw logInFirst();
        },
      ),
    ),
    cancel: member.runs.cancel.handler(({ input, context }) =>
      context.services.run.cancel(input.id),
    ),
    delete: member.runs.delete.handler(({ input, context }) =>
      context.services.run.delete(input.id),
    ),
    sshHostKey: member.runs.sshHostKey.handler(({ input, context }) =>
      context.services.run.sshHostKey(input.id),
    ),
    setSandbox: member.runs.setSandbox.handler(({ input, context }) =>
      context.services.run.setSandbox(input.id, input.spec),
    ),
    push: member.runs.push.handler(({ input, context }) => context.services.push.push(input.id)),
    openPullRequest: member.runs.openPullRequest.handler(({ input, context }) =>
      context.services.push.openPullRequest(input.id),
    ),
    removeSandbox: member.runs.removeSandbox.handler(({ input, context }) =>
      context.services.run.removeSandbox(input.id),
    ),
    sendMessage: member.runs.sendMessage.handler(({ input, context }) =>
      context.services.run.sendMessage(input, context.user.login),
    ),
    retryStep: member.runs.retryStep.handler(({ input, context }) =>
      context.services.run.retryStep(input.id, input.stepRunId),
    ),
  },
});
