import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ClaimedAgentTest, ClaimedRun, ControlPlane } from "@halinka/protocol";
import { deleteDevcontainer, reclaimWorkspace } from "@halinka/sandbox/devcontainer";
import { ensureFolder, pathExists } from "@halinka/utils/fs";

import {
  agentOf,
  agentPackageOf,
  agentPackagesOf,
  agentsWith,
  containerAgentStart,
} from "./agentStart";
import { askAgent, requireTestPreset } from "./agentTests";
import type { CodexLogins } from "./codexLogins";
import type { AgentPackage, Containers } from "./containers";
import type { Credentials, ProxyCredentials } from "./credentials";
import type { LentValues } from "./lentValues";
import type { RunSandbox, SandboxRuns } from "./runExecutor";
import { lendSetupSecrets, runSetupCommand } from "./setupCommand";
import type { Located, Workspaces } from "./workspaces";

// It has the git and the node that the container setup needs.
const testImage = "mcr.microsoft.com/devcontainers/javascript-node:22";

type ContainerRunsDeps = {
  containers: Containers;
  workspaces: Workspaces;
  credentials: Pick<Credentials, "newScope">;
  codexLogins: Pick<CodexLogins, "readForStart">;
  lent: LentValues;
  planeOf: (signal: AbortSignal) => ControlPlane;
  testFolder: string;
};

export class ContainerRuns implements SandboxRuns {
  constructor(private readonly deps: ContainerRunsDeps) {}

  // The tree check goes before the clone: a run that cannot have a container gets no workspace.
  async prepare(
    run: Located<ClaimedRun>,
    plane: ControlPlane,
    signal: AbortSignal,
  ): Promise<RunSandbox> {
    const { containers, workspaces, credentials, codexLogins, lent } = this.deps;
    const { workflowRunId } = run.lease;
    const target = { workflowRunId, ...run };
    const tree = await containers.prepareTree(target);
    // Before the clone, so a crash cannot keep a container that the agent changed.
    const { isBranchCreated } = await workspaces.prepareClone(run, () =>
      deleteDevcontainer(containers.nameOf(workflowRunId)),
    );
    if (isBranchCreated) await plane.branchCreated(run.lease);
    const setupSecrets = await lendSetupSecrets(run, plane, lent);
    const scope = credentials.newScope();
    const options = { tree, agents: agentPackagesOf(run), proxy: scope };
    const { sandbox, policy } = await containers.start(target, options, signal);
    containers.registerPolicy(workflowRunId, policy);
    await runSetupCommand(run, { secrets: setupSecrets, sandbox, workspaces }, signal);
    await workspaces.restoreClone(run, sandbox);
    const startAgent = containerAgentStart({
      scope,
      codexLogins,
      readStored: (preset) => plane.readAgentCredentials(run.lease, preset),
    });
    return {
      sandbox,
      publish: (commit) => workspaces.publish(run, sandbox, commit),
      agents: agentsWith(startAgent),
    };
  }

  endRun(workflowRunId: number) {
    this.deps.containers.forgetPolicy(workflowRunId);
  }

  async test(test: ClaimedAgentTest, signal: AbortSignal) {
    const { credentials, codexLogins, planeOf } = this.deps;
    const preset = requireTestPreset(test);
    const scope = credentials.newScope();
    const startAgent = containerAgentStart({
      scope,
      codexLogins,
      readStored: () => planeOf(signal).readTestCredentials(test.token),
    });
    try {
      const packages = [agentPackageOf(preset, test.version)];
      const sandbox = await this.startTest(packages, scope, signal);
      return await askAgent(agentOf(preset, startAgent), { sandbox, model: test.model }, signal);
    } finally {
      // At the latest, the next start of the runner removes what stays.
      await this.deleteTest().catch((error: unknown) => {
        console.error("The runner could not remove the container of the agent test", error);
      });
    }
  }

  // By name also without the folder: a docker client of an aborted start can make the container late.
  async deleteTest() {
    const { containers, testFolder } = this.deps;
    const workspaceFolder = join(testFolder, "workspace");
    // The proxy holds the keys, so it goes also when the release fails.
    try {
      if (await pathExists(workspaceFolder)) await reclaimWorkspace(workspaceFolder);
    } finally {
      await deleteDevcontainer(containers.testName);
    }
    await rm(testFolder, { recursive: true, force: true });
  }

  private async startTest(agents: AgentPackage[], proxy: ProxyCredentials, signal: AbortSignal) {
    await this.deleteTest();
    const { containers, testFolder } = this.deps;
    const treeFolder = join(testFolder, "tree");
    const workspaceFolder = join(testFolder, "workspace");
    await Promise.all([ensureFolder(treeFolder), ensureFolder(workspaceFolder)]);
    const configPath = ".devcontainer.json";
    await writeFile(join(treeFolder, configPath), JSON.stringify({ image: testImage }));
    const spec = { workspaceFolder, treeFolder, configPath, setupNetwork: [], gitConfig: "" };
    const { sandbox } = await containers.startContainer(
      { ...spec, name: containers.testName, agents, proxy },
      signal,
    );
    return sandbox;
  }
}
