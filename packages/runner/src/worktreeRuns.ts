import { rm } from "node:fs/promises";

import type { ClaimedAgentTest, ClaimedRun, ControlPlane } from "@halinka/protocol";
import { HostSandbox, stopLeftoverGroups } from "@halinka/sandbox/host";
import { ensureFolder } from "@halinka/utils/fs";

import { agentOf, agentsWith, startHostAgent } from "./agentStart";
import { askAgent, requireTestPreset } from "./agentTests";
import type { RunSandbox, SandboxRuns } from "./runExecutor";
import type { Located, Workspaces } from "./workspaces";

const hostAgents = agentsWith(startHostAgent);

export class WorktreeRuns implements SandboxRuns {
  constructor(
    private readonly workspaces: Pick<Workspaces, "prepareWorktree" | "groupsFileOf">,
    private readonly testFolder: string,
  ) {}

  async prepare(run: Located<ClaimedRun>, plane: ControlPlane): Promise<RunSandbox> {
    const { folder, isBranchCreated, lockFiles } = await this.workspaces.prepareWorktree(run);
    if (isBranchCreated) await plane.branchCreated(run.lease);
    const groupsFile = this.workspaces.groupsFileOf(run.lease.workflowRunId);
    return {
      sandbox: new HostSandbox(folder, groupsFile, lockFiles),
      // The worktree branch is in the checkout already.
      publish: async () => {},
      agents: hostAgents,
    };
  }

  endRun() {}

  async test(test: ClaimedAgentTest, signal: AbortSignal) {
    const { testFolder } = this;
    await ensureFolder(testFolder);
    try {
      const sandbox = new HostSandbox(testFolder, this.groupsFile);
      const agent = agentOf(requireTestPreset(test), startHostAgent);
      return await askAgent(agent, { sandbox, model: test.model }, signal);
    } finally {
      await this.deleteTest();
    }
  }

  async deleteTest() {
    await stopLeftoverGroups(this.groupsFile);
    await rm(this.groupsFile, { force: true });
    await rm(this.testFolder, { recursive: true, force: true });
  }

  private get groupsFile() {
    return `${this.testFolder}.groups`;
  }
}
