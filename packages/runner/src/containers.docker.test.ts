import { execFileSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { agentPresets } from "@halinka/presets";
import type { ClaimedRun, SandboxTarget } from "@halinka/protocol";
import { deleteDevcontainer } from "@halinka/sandbox/devcontainer";
import { HostSandbox, hostGit } from "@halinka/sandbox/host";
import { readProxyPolicy, runNetworksOf, testCredential } from "@halinka/sandbox/testing";
import { pathExists } from "@halinka/utils/fs";
import { Git } from "@halinka/utils/git";
import { tempFolder } from "@halinka/utils/testing";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { agentPackageOf } from "./agentStart";
import { type AgentPackage, type ContainersOptions, Containers } from "./containers";
import type { ProxyCredentials } from "./credentials";
import { runSetupCommand } from "./setupCommand";
import {
  claimedRun,
  commitAll,
  createRepo,
  identity,
  recordedStep,
  writeDefinition,
} from "./testing";
import { type Located, Workspaces } from "./workspaces";

// Local in the image cache, with git; the tests need no network.
const image = "mcr.microsoft.com/devcontainers/base:alpine";

const nodeImage = "mcr.microsoft.com/devcontainers/javascript-node:22";

const { signal } = new AbortController();

const setUp = async (
  devcontainerImage = image,
  options?: ContainersOptions,
  lifecycle: Record<string, string> = {},
) => {
  const repoPath = await createRepo();
  await writeDefinition(
    repoPath,
    ".devcontainer/devcontainer.json",
    JSON.stringify({ image: devcontainerImage, ...lifecycle }),
  );
  const baseSha = await commitAll(repoPath, "devcontainer");
  const workspacesFolder = await tempFolder();
  const workspaces = new Workspaces(workspacesFolder);
  const containers = await Containers.create(workspacesFolder, workspaces, options);
  const workflowRunId = randomInt(100_000, 1_000_000);
  const run = claimedRun(workflowRunId, {
    repoPath,
    baseSha,
    definitionSha: baseSha,
    sandboxKind: "devcontainer",
    devcontainer: ".devcontainer/devcontainer.json",
    setupNetwork: [],
    lastCheckpoint: baseSha,
  }) as Located<ClaimedRun>;
  const target = (spec: SandboxTarget["spec"]): Located<SandboxTarget> => ({
    workflowRunId,
    kind: "devcontainer",
    repoPath,
    isMirror: false,
    baseSha,
    definitionSha: baseSha,
    devcontainer: ".devcontainer/devcontainer.json",
    setupNetwork: [],
    spec,
    generation: 1,
  });
  const apply = (spec: SandboxTarget["spec"]) => containers.apply(target(spec), signal);
  onTestFinished(async () => {
    await apply("destroyed");
  });
  const start = async (agents?: AgentPackage[], proxy?: ProxyCredentials, claimed = run) => {
    const container = { workflowRunId, ...claimed };
    const tree = await containers.prepareTree(container);
    await workspaces.prepareClone(claimed);
    const { sandbox, policy } = await containers.start(container, { tree, agents, proxy }, signal);
    containers.registerPolicy(workflowRunId, policy);
    await workspaces.restoreClone(claimed, sandbox);
    return sandbox;
  };
  return { repoPath, run, workspaces, containers, apply, start };
};

const runningContainers = (name: string) =>
  execFileSync("docker", ["ps", "-q", "--filter", `label=halinka.sandbox=${name}`], {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);

// A container without a repo, with the node that the agents need.
const startNodeContainer = async (agents: AgentPackage[]) => {
  const folder = await tempFolder();
  const containers = await Containers.create(folder, new Workspaces(folder));
  const treeFolder = join(folder, "tree");
  const workspaceFolder = join(folder, "workspace");
  await Promise.all([mkdir(treeFolder), mkdir(workspaceFolder)]);
  await writeFile(join(treeFolder, ".devcontainer.json"), JSON.stringify({ image: nodeImage }));
  const name = containers.testName;
  onTestFinished(() => deleteDevcontainer(name));
  const spec = { name, workspaceFolder, treeFolder, configPath: ".devcontainer.json" };
  const options = { setupNetwork: [], gitConfig: "", agents, proxy: { forProxy: () => ({}) } };
  const { sandbox } = await containers.startContainer({ ...spec, ...options }, signal);
  return sandbox;
};

const credentials = { ANTHROPIC_API_KEY: testCredential("https://api.anthropic.com") };

const abortedStart = async () => {
  const set = await setUp(image, undefined, { postCreateCommand: "sleep 600" });
  const { containers, workspaces, run } = set;
  const name = containers.nameOf(run.lease.workflowRunId);
  const container = { workflowRunId: run.lease.workflowRunId, ...run };
  const tree = await containers.prepareTree(container);
  await workspaces.prepareClone(run);
  const controller = new AbortController();
  const started = containers.start(container, { tree }, controller.signal);
  await vi.waitFor(() => expect(runningContainers(name)).not.toEqual([]), {
    timeout: 60_000,
    interval: 500,
  });
  controller.abort();
  return { ...set, started };
};

describe("Containers", { timeout: 120_000 }, () => {
  it("publishes the checkpoint of a command in the clone to the checkout", async () => {
    const { repoPath, run, workspaces, start } = await setUp();
    const sandbox = await start();
    const git = new Git(sandbox, identity);

    await sandbox.exec(["sh", "-c", "echo built > build.log"]);
    await git.run("add", "--all");
    await git.run("commit", "--quiet", "-m", "build");
    const checkpoint = await git.run("rev-parse", "HEAD");
    await workspaces.publish(run, sandbox, checkpoint);

    expect(await hostGit(repoPath).findBranch(run.branch)).toBe(checkpoint);
    const folder = workspaces.folderOf(run.lease.workflowRunId);
    expect(await readFile(join(folder, "build.log"), "utf8")).toBe("built\n");
  });

  it("runs a command of a relay as the remote user, in the workspace", async () => {
    const { containers, run, start } = await setUp();
    await start();
    const processes = await containers.inspectProcesses(run.lease.workflowRunId);

    const child = processes.run('echo "$(id -un) $PWD $1"', ["argument"]);
    child.stdin.end();
    const [output] = (await once(child.stdout, "data")) as [Buffer];

    expect(String(output).trim()).toMatch(/^vscode \/workspaces\/\S+ argument$/);
  });

  it("connects a relay to a port on the loopback of the container", async () => {
    const { containers, run, start } = await setUp();
    await start();
    const processes = await containers.inspectProcesses(run.lease.workflowRunId);
    const listener = processes.run("echo from the container | nc -l -p 45123");
    onTestFinished(() => {
      listener.kill();
    });
    await vi.waitFor(async () => {
      const check = processes.run("grep -qs :B043 /proc/net/tcp /proc/net/tcp6");
      check.stdin.end();
      expect((await once(check, "close"))[0]).toBe(0);
    });

    const bridge = processes.connect(45_123);
    onTestFinished(() => {
      bridge.kill();
    });
    const [output] = (await once(bridge.stdout, "data")) as [Buffer];

    expect(String(output)).toBe("from the container\n");
  });

  it("restores the git config of the clone when the stopped container starts", async () => {
    const { workspaces, run, apply, start } = await setUp();
    await start();
    const config = join(workspaces.folderOf(run.lease.workflowRunId), ".git", "config");
    await apply("stopped");
    await writeFile(config, "[core]\n\tfsmonitor = ./agent.sh\n");

    await apply("running");

    expect(await readFile(config, "utf8")).toBe(
      await workspaces.readGitConfig(run.lease.workflowRunId),
    );
  });

  it("refuses to start the container of a clone without its git config copy", async () => {
    const { containers, workspaces, run, apply } = await setUp();
    const container = { workflowRunId: run.lease.workflowRunId, ...run };
    const tree = await containers.prepareTree(container);
    await workspaces.prepareClone(run);
    await rm(`${workspaces.folderOf(container.workflowRunId)}.git-config`);

    await expect(containers.start(container, { tree }, signal)).rejects.toThrow(
      "is missing. Delete the folder",
    );

    expect(await apply("stopped")).toEqual({ observed: "absent" });
  });

  it("refuses a devcontainer without git", async () => {
    const { start } = await setUp("alpine:3.22");

    await expect(start()).rejects.toThrow("The devcontainer has no git");
  });

  it("refuses agents in a devcontainer without node", async () => {
    const { start } = await setUp();

    await expect(
      start([{ command: "claude", package: "@anthropic-ai/claude-code" }]),
    ).rejects.toThrow("The devcontainer has no node");
  });

  it("stops the container when its setup fails, so the next start sets it up", async () => {
    const { containers, run, start } = await setUp();

    await start([{ command: "claude", package: "@anthropic-ai/claude-code" }]).catch(() => {});

    const name = containers.nameOf(run.lease.workflowRunId);
    const proxy = execFileSync(
      "docker",
      ["ps", "-q", "--filter", `name=^${runNetworksOf(name).proxy}$`],
      { encoding: "utf8" },
    );
    expect({ containers: runningContainers(name), proxy }).toEqual({ containers: [], proxy: "" });
  });

  it("stops the container of a run", async () => {
    const { apply, start } = await setUp();
    await start();

    expect(await apply("stopped")).toEqual({ observed: "stopped" });
  });

  it("removes the networks of a container that stopped outside the runner", async () => {
    const { containers, apply, start, run } = await setUp();
    await start();
    const name = containers.nameOf(run.lease.workflowRunId);
    const running = execFileSync(
      "docker",
      ["ps", "-q", "--filter", `label=halinka.sandbox=${name}`],
      {
        encoding: "utf8",
      },
    );
    execFileSync("docker", ["stop", "--timeout", "0", ...running.split("\n").filter(Boolean)]);

    await apply("stopped");

    const { internal } = runNetworksOf(name);
    const left = execFileSync("docker", ["network", "ls", "-q", "--filter", `name=^${internal}$`], {
      encoding: "utf8",
    });
    expect(left).toBe("");
  });

  it("publishes the current credentials to the proxy of a started run", async () => {
    let current = {};
    const { containers, run, start } = await setUp(image, {
      machineCredentials: { forProxy: () => current },
    });
    await start();
    current = credentials;

    await containers.writePolicies();

    expect(readProxyPolicy(containers.nameOf(run.lease.workflowRunId))?.credentials).toEqual(
      credentials,
    );
  });

  it("gives the proxy of a run the values of its scope", async () => {
    let current = {};
    const { containers, run, start } = await setUp();
    await start([], { forProxy: () => current });
    current = credentials;

    await containers.writePolicies();

    expect(readProxyPolicy(containers.nameOf(run.lease.workflowRunId))?.credentials).toEqual(
      credentials,
    );
  });

  it("refuses an agent package from a host other than the npm registry", async () => {
    const agents = [{ command: "halinka-no-agent", package: "https://example.invalid/agent.tgz" }];

    await expect(startNodeContainer(agents)).rejects.toThrow("403");
  });

  it("gives the lifecycle commands the setup network of the run", async () => {
    // The proxy tries a host of the list, and the name does not resolve: 502, not 403.
    const fetch = "wget -T 5 -O - http://setup.invalid/ 2>/tmp/fetch || true";
    const { start, run } = await setUp(image, undefined, { postCreateCommand: fetch });
    run.setupNetwork = ["setup.invalid"];

    const sandbox = await start();

    const { stdout } = await sandbox.exec(["cat", "/tmp/fetch"]);
    expect(stdout).toContain("502");
  });

  it("gives setup.run a secret that a later command does not get", async () => {
    const { start, run, workspaces } = await setUp();
    const sandbox = await start();
    const setupRun = 'printf %s "$NPM_TOKEN" > /tmp/setup';
    const values = [{ variable: "NPM_TOKEN", value: "npm_made_up_value" }];

    await runSetupCommand(
      { ...run, setupRun },
      { secrets: { values, missing: [] }, sandbox, workspaces },
      signal,
    );

    const seen = await sandbox.exec(["cat", "/tmp/setup"]);
    const later = await sandbox.exec(["sh", "-c", 'printf %s "$NPM_TOKEN"']);
    expect({ seen: seen.stdout, later: later.stdout }).toEqual({
      seen: "npm_made_up_value",
      later: "",
    });
  });

  it("installs the agents of the presets through the npm registry", async () => {
    const agents = Object.values(agentPresets).map((preset) => agentPackageOf(preset));

    const sandbox = await startNodeContainer(agents);

    const { exitCode } = await sandbox.exec(["which", ...agents.map(({ command }) => command)]);
    expect(exitCode).toBe(0);
  });

  it("leaves the npm cache of the remote user to that user when it installs an agent", async () => {
    const sandbox = await startNodeContainer([agentPackageOf(agentPresets["claude-code"]!)]);

    const { stdout, exitCode } = await sandbox.exec([
      "sh",
      "-c",
      'mkdir -p "$HOME/.npm" && find "$HOME/.npm" -user root',
    ]);
    expect({ stdout, exitCode }).toEqual({ stdout: "", exitCode: 0 });
  });

  it("stops a start at an abort", async () => {
    const { started } = await abortedStart();

    await expect(started).rejects.toMatchObject({ name: "AbortError" });
  });

  it("removes the new container of a start at an abort", async () => {
    const { started, apply } = await abortedStart();

    await started.catch(() => {});

    expect(await apply("stopped")).toEqual({ observed: "absent" });
  });

  it("stops the container when a start stops after up", async () => {
    const { containers, workspaces, run } = await setUp(nodeImage);
    const name = containers.nameOf(run.lease.workflowRunId);
    const container = { workflowRunId: run.lease.workflowRunId, ...run };
    const tree = await containers.prepareTree(container);
    await workspaces.prepareClone(run);
    const controller = new AbortController();
    const agents = [agentPackageOf(agentPresets["claude-code"]!)];
    const started = containers.start(container, { tree, agents }, controller.signal);
    await vi.waitFor(
      () => {
        const [id] = runningContainers(name);
        expect(id).toBeDefined();
        expect(execFileSync("docker", ["top", id!], { encoding: "utf8" })).toContain("npm");
      },
      { timeout: 120_000, interval: 500 },
    );

    controller.abort();

    await expect(started).rejects.toMatchObject({ name: "AbortError" });
    expect(runningContainers(name)).toEqual([]);
  });

  it("gives a stopped container that starts again the values of the machine", async () => {
    const { containers, run, apply, start } = await setUp(image, {
      machineCredentials: { forProxy: () => credentials },
    });
    await start([], { forProxy: () => ({}) });
    containers.forgetPolicy(run.lease.workflowRunId);
    await apply("stopped");

    await apply("running");
    await containers.writePolicies();

    expect(readProxyPolicy(containers.nameOf(run.lease.workflowRunId))?.credentials).toEqual(
      credentials,
    );
  });

  it("publishes again to a proxy whose write failed", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let current = {};
    const { containers, run, start } = await setUp(image, {
      machineCredentials: { forProxy: () => current },
    });
    await start();
    const { proxy } = runNetworksOf(containers.nameOf(run.lease.workflowRunId));
    execFileSync("docker", ["stop", proxy]);
    current = credentials;
    await containers.writePolicies();

    execFileSync("docker", ["start", proxy]);

    await vi.waitFor(
      () =>
        expect(readProxyPolicy(containers.nameOf(run.lease.workflowRunId))?.credentials).toEqual(
          credentials,
        ),
      { timeout: 30_000, interval: 1000 },
    );
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(`the proxy of run ${run.lease.workflowRunId}:`),
    );
  });

  it("publishes nothing to the proxy of a released run", async () => {
    let current = {};
    const { containers, run, start } = await setUp(image, {
      machineCredentials: { forProxy: () => current },
    });
    await start();
    containers.forgetPolicy(run.lease.workflowRunId);
    current = credentials;

    await containers.writePolicies();

    expect(readProxyPolicy(containers.nameOf(run.lease.workflowRunId))?.credentials).toEqual({});
  });

  it("stops a paused container of a run", async () => {
    const { containers, apply, start, run } = await setUp();
    await start();
    const name = containers.nameOf(run.lease.workflowRunId);
    execFileSync("docker", ["pause", ...runningContainers(name)]);

    await apply("stopped");

    expect(runningContainers(name)).toEqual([]);
  });

  it("starts a paused container of a run again", async () => {
    const { containers, apply, start, run } = await setUp();
    await start();
    const name = containers.nameOf(run.lease.workflowRunId);
    execFileSync("docker", ["pause", ...runningContainers(name)]);

    expect(await apply("running")).toMatchObject({ observed: "running" });
    expect(
      execFileSync(
        "docker",
        ["ps", "--filter", `label=halinka.sandbox=${name}`, "--format", "{{.State}}"],
        { encoding: "utf8" },
      ).trim(),
    ).toBe("running");
  });

  it("starts the stopped container of a run", async () => {
    const { apply, start } = await setUp();
    await start();
    await apply("stopped");

    expect(await apply("running")).toMatchObject({ observed: "running" });
  });

  it("gives the container and the workspace path of a running container for an attach", async () => {
    const { containers, apply, start, run } = await setUp();
    await start();
    const { workflowRunId } = run.lease;
    const label = `label=halinka.sandbox=${containers.nameOf(workflowRunId)}`;
    const name = execFileSync("docker", ["ps", "--filter", label, "--format", "{{.Names}}"], {
      encoding: "utf8",
    }).trim();

    expect(await apply("running")).toEqual({
      observed: "running",
      attach: { containerName: name, containerFolder: `/workspaces/run-${workflowRunId}` },
    });
  });

  it("refuses to start a removed container", async () => {
    const { apply, start } = await setUp();
    await start();
    await apply("destroyed");

    await expect(apply("running")).rejects.toThrow("Reopen a step to make it again");
  });

  it("runs the lifecycle commands of a new clone on the base files", async () => {
    const lifecycle = { postCreateCommand: "ls > /tmp/files" };
    const { run, workspaces, start } = await setUp(image, undefined, lifecycle);
    const { workflowRunId } = run.lease;
    const folder = workspaces.folderOf(workflowRunId);
    await workspaces.prepareClone(run);
    const host = new HostSandbox(folder);
    await workspaces.restoreClone(run, host);
    await writeFile(join(folder, "agent.md"), "agent\n");
    const git = hostGit(folder, identity);
    await git.run("add", "--all");
    await git.run("commit", "--quiet", "-m", `agent\n\nHalinka-Run: ${workflowRunId}`);
    const checkpoint = await git.run("rev-parse", "HEAD");
    await workspaces.publish(run, host, checkpoint);
    await workspaces.deleteClone(workflowRunId, run.repoPath);

    const reopened = { ...run, steps: [recordedStep], lastCheckpoint: checkpoint };
    const sandbox = await start(undefined, undefined, reopened);

    const { stdout } = await sandbox.exec(["cat", "/tmp/files"]);
    expect(stdout.split("\n")).toEqual(expect.arrayContaining(["README.md"]));
    expect(stdout).not.toContain("agent.md");
  });

  it("removes the container, the clone and the tree of a run", async () => {
    const { workspaces, run, apply, start } = await setUp();
    await start();

    expect(await apply("destroyed")).toEqual({ observed: "absent" });

    expect(await pathExists(workspaces.folderOf(run.lease.workflowRunId))).toBe(false);
    expect(await pathExists(`${workspaces.folderOf(run.lease.workflowRunId)}.tree`)).toBe(false);
    expect(await apply("stopped")).toEqual({ observed: "absent" });
  });
});
