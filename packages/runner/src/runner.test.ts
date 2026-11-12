import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  conflict,
  type RunnerAcceptor,
  type RunnerSession,
  type SyncResult,
} from "@halinka/protocol";
import { InMemoryTransport } from "@halinka/protocol/inMemoryTransport";
import { testBuild } from "@halinka/protocol/testing";
import { FileLocks } from "@halinka/utils/fileLocks";
import { pathExists } from "@halinka/utils/fs";
import { tempFolder } from "@halinka/utils/testing";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { Runner } from "./runner";
import { claimedRun, fakePlane } from "./testing";

const nothing = { keep: [], claimed: [], answers: [], messages: [], sandboxes: [] };

const serverId = "0123456789ab";

const claimOfGitHubRepo = () => {
  const { repoPath: _repoPath, ...run } = claimedRun(1);
  return { ...run, githubRepoId: 100, baseSha: "a".repeat(40), definitionSha: "a".repeat(40) };
};

// Without a queued answer, a sync keeps the held runs.
class FakeServer implements RunnerAcceptor {
  session: RunnerSession | undefined;
  isEnded = false;
  readonly syncs: SyncResult[] = [];
  readonly finishRun = vi.fn(async () => {});
  readonly finishAgentTest = vi.fn(async () => {});
  onAccept: (session: RunnerSession) => Promise<void> = async () => {};

  async acceptRunner(session: RunnerSession) {
    this.session = session;
    await this.onAccept(session);
    const plane = fakePlane({
      sync: async ({ held }) =>
        this.syncs.shift() ?? { ...nothing, keep: held.map(({ workflowRunId }) => workflowRunId) },
      finishRun: this.finishRun,
      finishAgentTest: this.finishAgentTest,
      readMirrorAccess: async () => {
        throw conflict("A GitHub repo needs the App");
      },
    });
    return { plane, ended: () => (this.isEnded = true), serverId };
  }

  acceptRelay() {
    return undefined;
  }
}

const createRunner = async (server: FakeServer, home?: string, folderRoots?: string[]) => {
  const runner = new Runner(new InMemoryTransport(server, "key"), {
    home: home ?? (await tempFolder()),
    build: testBuild,
    sandboxKind: "worktree",
    capacity: 1,
    ...(folderRoots && { folderRoots }),
  });
  onTestFinished(() => runner.stop());
  return runner;
};

const start = async (server = new FakeServer(), home?: string) => {
  const runner = await createRunner(server, home);
  await runner.start();
  return { server, runner };
};

const startInRoot = async () => {
  const root = await tempFolder();
  const server = new FakeServer();
  await (await createRunner(server, undefined, [root])).start();
  return { root, server, commands: server.session!.commands };
};

describe("Runner", () => {
  it("names an agent test of an agent that the runner does not have", async () => {
    const server = new FakeServer();
    server.syncs.push({
      ...nothing,
      agentTest: { token: "token-1", preset: "unknown" },
    });

    await start(server);

    await vi.waitFor(() =>
      expect(server.finishAgentTest).toHaveBeenCalledWith("token-1", {
        error: "This runner has no agent unknown. Update the runner.",
      }),
    );
  });

  it("removes the folder of an agent test on the host", async () => {
    const home = await tempFolder();
    const server = new FakeServer();
    server.syncs.push({
      ...nothing,
      agentTest: { token: "token-1", preset: "unknown" },
    });

    await start(server, home);

    await vi.waitFor(() => expect(server.finishAgentTest).toHaveBeenCalled());
    expect(await pathExists(join(home, "workspaces", serverId, "agent-test"))).toBe(false);
  });

  it("removes what an earlier agent test left at its start", async () => {
    const home = await tempFolder();
    const leftover = join(home, "workspaces", serverId, "agent-test", "file");
    await mkdir(dirname(leftover), { recursive: true });
    await writeFile(leftover, "left");

    await start(new FakeServer(), home);

    await vi.waitFor(async () => expect(await pathExists(leftover)).toBe(false));
  });

  it("refuses to start with a saved login that it cannot read", async () => {
    const home = await tempFolder();
    await mkdir(join(home, "logins"));
    await writeFile(join(home, "logins", "codex.json"), "{");
    const runner = await createRunner(new FakeServer(), home);

    await expect(runner.start()).rejects.toThrow("Run: halinka agent login codex");
  });

  it("refuses to start while another runner process uses its home", async () => {
    const home = await tempFolder();
    await start(new FakeServer(), home);
    const second = await createRunner(new FakeServer(), home);

    await expect(second.start()).rejects.toThrow("Another Halinka process runs as the runner");
  });

  it("ends with update needed when the server asks for an update", async () => {
    const server = new FakeServer();
    server.syncs.push({ ...nothing, update: "now" });

    const { runner } = await start(server);

    expect(await runner.closed).toMatchObject({ code: "update_needed" });
  });

  it("keeps the lock of its caller after its stop", async () => {
    const home = await tempFolder();
    const locked = await createRunner(new FakeServer(), home);
    await locked.lock();

    await locked.stop();

    await expect(start(new FakeServer(), home)).rejects.toThrow("Another Halinka process");
  });

  it("frees its home when its caller releases the lock", async () => {
    const home = await tempFolder();
    const locked = await createRunner(new FakeServer(), home);
    const release = await locked.lock();
    await locked.stop();

    await release();

    await expect(start(new FakeServer(), home)).resolves.toBeDefined();
  });

  it("starts in the home of a runner whose start failed", async () => {
    const home = await tempFolder();
    await mkdir(join(home, "logins"));
    await writeFile(join(home, "logins", "codex.json"), "{");
    const failed = await createRunner(new FakeServer(), home);
    await failed.start().catch(() => {});
    await rm(join(home, "logins", "codex.json"));

    await expect(start(new FakeServer(), home)).resolves.toBeDefined();
  });

  it("starts in the home of a runner that stopped", async () => {
    const home = await tempFolder();
    const { runner } = await start(new FakeServer(), home);
    await runner.stop();

    await expect(start(new FakeServer(), home)).resolves.toBeDefined();
  });

  it("refuses a relay on a runner without containers", async () => {
    const { server } = await start();

    await expect(
      server.session?.commands.openRelay({ relayId: "relay", workflowRunId: 1 }),
    ).rejects.toThrow("This runner runs no containers");
  });

  it("gives the reason when the server ends the connection", async () => {
    const error = vi.spyOn(console, "error");
    const { server, runner } = await start();

    server.session?.close("An Admin revoked this runner");

    expect(await runner.closed).toMatchObject({
      code: "refused",
      message: "An Admin revoked this runner",
    });
    expect(error).not.toHaveBeenCalled();
  });

  it("rejects the start when a stop comes during the start", async () => {
    const runner = await createRunner(new FakeServer());

    const started = runner.start();
    await runner.stop();

    await expect(started).rejects.toMatchObject({ name: "AbortError" });
  });

  it("opens no session when a stop comes during the start", async () => {
    const server = new FakeServer();
    const runner = await createRunner(server);

    const started = runner.start();
    await runner.stop();
    await started.catch(() => {});

    expect(server.session).toBeUndefined();
  });

  it("ends a second stop only after the first stop closed the connection", async () => {
    const { server, runner } = await start();

    void runner.stop();
    await runner.stop();

    expect(server.isEnded).toBe(true);
  });

  it("gives no reason after a stop", async () => {
    const { runner } = await start();

    await runner.stop();

    expect(await runner.closed).toBeUndefined();
  });

  it("fails a run of another sandbox kind with an error that names --runs-in", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const server = new FakeServer();
    server.syncs.push({ ...nothing, claimed: [claimedRun(1, { sandboxKind: "devcontainer" })] });
    await start(server);

    await server.session?.commands.wake();

    await vi.waitFor(() =>
      expect(server.finishRun).toHaveBeenCalledWith(
        expect.anything(),
        "failed",
        expect.stringContaining("start the runner with --runs-in devcontainer"),
      ),
    );
    expect(error).toHaveBeenCalledWith(expect.stringContaining("--runs-in devcontainer"));
  });

  it("releases the runner lock before it gives the reason of a final close", async () => {
    const home = await tempFolder();
    const server = new FakeServer();
    const error = vi.spyOn(console, "error");
    const { runner } = await start(server, home);

    server.session?.close("revoked");

    expect(await runner.closed).toMatchObject({ code: "refused", message: "revoked" });
    expect(await new FileLocks(home, "other").tryTake("runner")).toBeDefined();
    expect(error).not.toHaveBeenCalled();
  });

  it("keeps the bare clone of a GitHub repo in the folder of the server", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const home = await tempFolder();
    const server = new FakeServer();
    server.syncs.push({ ...nothing, claimed: [claimOfGitHubRepo()] });
    await start(server, home);

    await server.session?.commands.wake();

    await vi.waitFor(() => expect(server.finishRun).toHaveBeenCalled());
    expect(await pathExists(join(home, "github", serverId, "100.git"))).toBe(true);
    expect(error).toHaveBeenCalledWith("Run 1 stopped: A GitHub repo needs the App");
  });

  it("refuses a push that comes before the runner is ready", async () => {
    const server = new FakeServer();
    const pushing = Promise.withResolvers<unknown>();
    server.onAccept = async ({ commands }) => {
      pushing.resolve(commands.pushBranch({} as never).catch((error: Error) => error.message));
    };

    await start(server);

    expect(await pushing.promise).toBe("The runner is not ready");
  });

  it("fails a claimed run of a GitHub repo when the server gives no access", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const server = new FakeServer();
    server.syncs.push({ ...nothing, claimed: [claimOfGitHubRepo()] });
    await start(server);

    await server.session?.commands.wake();

    await vi.waitFor(() =>
      expect(server.finishRun).toHaveBeenCalledWith(
        expect.anything(),
        "failed",
        expect.stringContaining("needs the App"),
      ),
    );
    expect(error).toHaveBeenCalledWith("Run 1 stopped: A GitHub repo needs the App");
  });

  it("refuses a command for a repo outside the folder roots", async () => {
    const { commands } = await startInRoot();

    await expect(commands.readRepo({ repoPath: await tempFolder() })).rejects.toThrow(
      "outside the folders of this runner",
    );
  });

  it("lists the first folder root without a path, with no parent", async () => {
    const { root, commands } = await startInRoot();

    const { path, parent } = await commands.listFolders({});

    expect({ path, parent }).toEqual({ path: root, parent: undefined });
  });

  it("refuses to list a folder outside the folder roots", async () => {
    const { commands } = await startInRoot();

    await expect(commands.listFolders({ path: await tempFolder() })).rejects.toThrow(
      "outside the folders of this runner",
    );
  });

  it("does not check the folder roots for a push from a bare clone", async () => {
    const { commands } = await startInRoot();
    const { repoPath: _repoPath, ...run } = claimedRun(1);
    const input = {
      ...run,
      repoPath: undefined,
      githubRepoId: 100,
      workflowRunId: 1,
      commit: "abc",
    };

    await expect(commands.pushBranch(input)).rejects.toThrow("is not a commit id");
  });

  it("fails a claimed run of a repo outside the folder roots", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { server, commands } = await startInRoot();
    server.syncs.push({ ...nothing, claimed: [claimedRun(1)] }, nothing);

    await commands.wake();

    await vi.waitFor(() =>
      expect(server.finishRun).toHaveBeenCalledWith(
        expect.anything(),
        "failed",
        expect.stringContaining("outside the folders of this runner"),
      ),
    );
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(/^Run 1 stopped: .* is outside the folders of this runner/),
    );
  });

  it("cancels a run that waits for the workspace lock of another process", async () => {
    const home = await tempFolder();
    const workspacesFolder = join(home, "workspaces", serverId);
    await mkdir(workspacesFolder, { recursive: true });
    const holder = { pid: process.pid, instanceId: "other" };
    await writeFile(join(workspacesFolder, "run-1.lock"), JSON.stringify(holder));
    const server = new FakeServer();
    server.syncs.push({ ...nothing, claimed: [claimedRun(1)] }, nothing);
    await start(server, home);

    await server.session?.commands.wake();

    await vi.waitFor(() =>
      expect(server.finishRun).toHaveBeenCalledWith(expect.anything(), "cancelled", null),
    );
  });
});
