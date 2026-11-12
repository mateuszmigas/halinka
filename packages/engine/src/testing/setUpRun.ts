import type { Agent } from "@halinka/agents";
import type { ClaimedRun, ControlPlane } from "@halinka/protocol";

import { executeRun } from "../executeRun";
import type { RunDeps } from "../runDeps";
import { FakeAgent } from "./fakeAgent";
import { FakeControlPlane } from "./fakeControlPlane";
import { FakeInbox } from "./fakeInbox";
import { FakeRepoSource } from "./fakeRepoSource";
import { FakeSandbox } from "./fakeSandbox";
import { keepAll } from "./lent";

export const setUpRun = (overrides?: Partial<ControlPlane>, lent = keepAll) => {
  const plane = new FakeControlPlane(overrides);
  const sandbox = new FakeSandbox();
  const repoSource = new FakeRepoSource();
  const inbox = new FakeInbox();
  const controller = new AbortController();
  const agent = new FakeAgent(sandbox, () => controller.abort());
  const deps: RunDeps = {
    plane,
    sandbox,
    repoSource,
    inbox,
    lent,
    agents: new Map<string, Agent>([
      ["fake", agent],
      ["late", agent.late],
      ["replay", agent.replay],
      [
        "broken",
        {
          open: async () => {
            throw new Error("The agent did not start");
          },
        },
      ],
    ]),
  };
  const execute = (claimed: ClaimedRun) => executeRun(deps, claimed, controller.signal);
  return { deps, plane, sandbox, agent, inbox, repoSource, controller, execute };
};
