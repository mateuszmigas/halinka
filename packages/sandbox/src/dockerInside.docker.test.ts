import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeFiles } from "@halinka/utils/testing";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";

import {
  agentUser,
  attachDevcontainer,
  type Devcontainer,
  DevcontainerSandbox,
  type DevcontainerOptions,
  deleteDevcontainer,
  hasSysboxRuntime,
  stopDevcontainer,
  upDevcontainer,
} from "./devcontainer";
import { InnerDocker } from "./dockerInside";
import { EgressPolicy } from "./runNetwork";
import { docker, image, readProxyPolicy } from "./testing";

const name = `halinka-test-${process.pid}-docker-inside`;

const dockerHub = ["registry-1.docker.io", "auth.docker.io", "production.cloudfront.docker.com"];

describe.skipIf(!(await hasSysboxRuntime()))(
  "Docker inside the container",
  { timeout: 120_000 },
  () => {
    let root: string;
    let workspaceFolder: string;
    let policy: EgressPolicy;
    let options: DevcontainerOptions;
    let container: Devcontainer;
    let sandbox: DevcontainerSandbox;

    const inContainer = (script: string) =>
      docker("exec", container.containerId, "sh", "-c", script);

    const run = (script: string, network: string[] = []) =>
      sandbox.exec(["sh", "-c", script], { network, isRepoCode: true });

    const asAgent = async () => {
      await sandbox.assignWorkspace("agent");
      onTestFinished(() => sandbox.assignWorkspace("host"));
    };

    beforeAll(async () => {
      const config = { build: { dockerfile: "Dockerfile" }, remoteUser: "dev" };
      root = await realpath(await mkdtemp(join(tmpdir(), "halinka-")));
      workspaceFolder = join(root, "workspace");
      const treeFolder = join(root, "tree");
      await writeFiles(workspaceFolder, { ".git/config": "[core]\n" });
      await writeFiles(treeFolder, {
        ".devcontainer/devcontainer.json": JSON.stringify(config),
        ".devcontainer/Dockerfile": `FROM ${image}\nRUN apk add --no-cache docker iptables && adduser -D dev\n`,
      });
      policy = new EgressPolicy(name);
      options = {
        name,
        workspaceFolder,
        treeFolder,
        configPath: ".devcontainer/devcontainer.json",
        setupNetwork: [],
        policy,
        isDockerInside: true,
      };
      container = await upDevcontainer(options);
      sandbox = await attachDevcontainer(container, { policy, runnerGitConfig: "[core]\n" });
      // Setup creates the agent user after the start, where Sysbox finds no name.
      inContainer(`adduser -D -s /bin/sh ${agentUser}`);
    }, 300_000);

    afterAll(async () => {
      await deleteDevcontainer(name);
      await rm(root, { recursive: true, force: true });
    });

    it("runs an inner container from a pull with the hosts of the command", async () => {
      const { exitCode, stdout } = await run(`docker run --rm ${image} echo inside`, dockerHub);

      expect({ exitCode, stdout }).toEqual({ exitCode: 0, stdout: "inside\n" });
    });

    it("refuses a pull to a command without hosts", async () => {
      const { exitCode } = await run("docker pull busybox:1.37");

      expect(exitCode).not.toBe(0);
    });

    it("revokes the hosts of the daemon when the command ends", async () => {
      await run("true", dockerHub);

      const grants = Object.values(readProxyPolicy(name)?.tokens ?? {});
      expect(grants.filter(({ hosts }) => hosts.includes("registry-1.docker.io"))).toEqual([]);
    });

    it("removes the inner containers when the command ends", async () => {
      const started = await run(`docker run --detach ${image} sleep 1000`, dockerHub);

      expect({ exitCode: started.exitCode, left: inContainer("docker ps -aq") }).toEqual({
        exitCode: 0,
        left: "",
      });
    });

    it("gives the agent user no socket", async () => {
      await asAgent();

      const { stderr } = await sandbox.exec(["docker", "ps"], { user: "agent" });

      expect(stderr).toContain("permission denied");
    });

    it("gives the files of the agent to the host user", async () => {
      await sandbox.assignWorkspace("agent");
      const written = await sandbox.exec(["sh", "-c", "echo agent > agent.txt"], { user: "agent" });

      await sandbox.assignWorkspace("host");

      const uid = String(process.getuid!());
      const others = execFileSync("find", [workspaceFolder, "!", "-user", uid], {
        encoding: "utf8",
      });
      expect({ exitCode: written.exitCode, others }).toEqual({ exitCode: 0, others: "" });
    });

    it("refuses a second daemon", async () => {
      const { containerId, remoteUser, noProxy } = container;

      await expect(InnerDocker.start({ containerId, remoteUser, noProxy, policy })).rejects.toThrow(
        "A Docker daemon already runs in the devcontainer",
      );
    });

    it("starts Docker again after a restart of the kept container", async () => {
      await stopDevcontainer(name);
      container = await upDevcontainer(options);
      sandbox = await attachDevcontainer(container, { policy, runnerGitConfig: "[core]\n" });

      const { exitCode } = await run("docker ps");

      expect(exitCode).toBe(0);
    });
  },
);
