import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { text } from "node:stream/consumers";

import { pathExists } from "@halinka/utils/fs";
import { writeFiles } from "@halinka/utils/testing";
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";

import {
  agentUser,
  attachDevcontainer,
  type Devcontainer,
  type DevcontainerOptions,
  DevcontainerSandbox,
  reclaimWorkspace,
  deleteDevcontainer,
  upDevcontainer,
} from "./devcontainer";
import { InnerDocker } from "./dockerInside";
import { EgressPolicy, proxyRouteUrl } from "./runNetwork";
import {
  docker,
  dockerAddressPools,
  firstLine,
  image,
  startOutsideHost,
  testCredential,
} from "./testing";

const name = `halinka-test-${process.pid}-sandbox`;

const abortError = expect.objectContaining({ name: "AbortError" });

const gitConfig = "[core]\n\trepositoryformatversion = 0\n";

describe("DevcontainerSandbox", { timeout: 30_000 }, () => {
  let root: string;
  let workspaceFolder: string;
  let treeFolder: string;
  let policy: EgressPolicy;
  let options: DevcontainerOptions;
  let container: Devcontainer;
  let sandbox: DevcontainerSandbox;
  let outside: ReturnType<typeof startOutsideHost>;

  const inContainer = (script: string) => docker("exec", container.containerId, "sh", "-c", script);

  // A zombie has ended; PID 1 has not removed it.
  const isRunning = (pid: string) => {
    expect(pid).toMatch(/^\d+$/);
    const state = inContainer(`cut -d" " -f3 /proc/${pid}/stat 2>/dev/null || true`);
    return state !== "" && state !== "Z";
  };

  const setUp = () => {
    const controller = new AbortController();
    onTestFinished(() => controller.abort());
    const abortAtFirstOutput = () => {
      let pid = "";
      const onOutput = (chunk: string) => {
        pid ||= chunk.trim();
        controller.abort();
      };
      return { onOutput, pid: () => pid };
    };
    return { controller, abortAtFirstOutput };
  };

  const fetchOutside = (options: { network?: string[]; proxy?: string } = {}) =>
    sandbox.exec(
      [
        "sh",
        "-c",
        '[ -z "$1" ] || export http_proxy="$1"; wget -q -T 5 -O - "$2"',
        "fetch",
        options.proxy ?? "",
        outside.url,
      ],
      { network: options.network },
    );

  beforeAll(async () => {
    // On Linux the CLI changes the owner of the remote user's home, so the user needs a home other than `/`.
    const config = {
      build: { dockerfile: "Dockerfile" },
      remoteUser: "dev",
      remoteEnv: { GREETING: "hello", PAIR: "a=b\nc", RUNNER_HOME: "${localEnv:HOME}" },
    };
    root = await realpath(await mkdtemp(join(tmpdir(), "halinka-")));
    workspaceFolder = join(root, "workspace");
    treeFolder = join(root, "tree");
    await writeFiles(workspaceFolder, { ".git/config": gitConfig });
    await writeFiles(treeFolder, {
      ".devcontainer/devcontainer.json": JSON.stringify(config),
      ".devcontainer/Dockerfile": `FROM ${image}\nRUN adduser -D dev\n`,
    });
    const credentials = { anthropic: testCredential("https://provider.invalid") };
    policy = new EgressPolicy(name, {
      credentials: () => credentials,
      reachable: dockerAddressPools,
    });
    options = {
      name,
      workspaceFolder,
      treeFolder,
      configPath: ".devcontainer/devcontainer.json",
      setupNetwork: [],
      policy,
    };
    container = await upDevcontainer(options);
    sandbox = await attachDevcontainer(container, { policy, runnerGitConfig: gitConfig });
    outside = startOutsideHost(name);
  }, 180_000);

  afterAll(async () => {
    outside?.delete();
    await deleteDevcontainer(name);
    await rm(root, { recursive: true, force: true });
  });

  it("runs the command in the workspace folder", async () => {
    const { stdout } = await sandbox.exec(["pwd"]);

    expect(stdout).toBe(`${sandbox.workspaceFolder}\n`);
  });

  it("runs the command as the remote user", async () => {
    const { stdout } = await sandbox.exec(["id", "-un"]);

    expect(stdout).toBe("dev\n");
  });

  it("gives the command the environment of the devcontainer", async () => {
    const { stdout } = await sandbox.exec(["printenv", "GREETING"]);

    expect(stdout).toBe("hello\n");
  });

  it("keeps a value longer than a line of an env file", async () => {
    const value = "x".repeat(70_000);

    const { stdout } = await sandbox.exec(["printenv", "LONG"], { env: { LONG: value } });

    expect(stdout).toBe(`${value}\n`);
  });

  it("keeps an equals sign and a newline in a value of the environment", async () => {
    const { stdout } = await sandbox.exec(["printenv", "PAIR"]);

    expect(stdout).toBe("a=b\nc\n");
  });

  it("fills the environment of the devcontainer from an empty home", async () => {
    const { stdout } = await sandbox.exec(["printenv", "RUNNER_HOME"]);

    expect(stdout).toContain("halinka-devcontainer-");
  });

  it("gives the environment of the call precedence over the devcontainer's", async () => {
    const { stdout } = await sandbox.exec(["printenv", "GREETING"], { env: { GREETING: "hi" } });

    expect(stdout).toBe("hi\n");
  });

  it("returns the exit code and the output of the command", async () => {
    const result = await sandbox.exec(["sh", "-c", "echo out; echo err >&2; exit 3"]);

    expect(result).toEqual({ exitCode: 3, stdout: "out\n", stderr: "err\n" });
  });

  it("reports each output chunk with its stream", async () => {
    const onOutput = vi.fn();

    await sandbox.exec(["sh", "-c", "echo out; echo err >&2"], { onOutput });

    expect(onOutput.mock.calls).toEqual(
      expect.arrayContaining([
        ["out\n", "stdout"],
        ["err\n", "stderr"],
      ]),
    );
  });

  it("rejects an empty command", async () => {
    await expect(sandbox.exec([])).rejects.toThrow("Command is empty");
  });

  it("stops the processes that the command leaves", async () => {
    const { stdout } = await sandbox.exec(["sh", "-c", "sleep 30 & echo $!"]);

    expect(isRunning(stdout.trim())).toBe(false);
  });

  it("kills a process that the command leaves and that ignores TERM", async () => {
    const { stdout } = await sandbox.exec(["sh", "-c", 'trap "" TERM; sleep 30 & echo $!']);

    expect(isRunning(stdout.trim())).toBe(false);
  });

  it("rejects with an abort error when the signal aborts", async () => {
    const { controller, abortAtFirstOutput } = setUp();
    const { onOutput } = abortAtFirstOutput();

    const result = sandbox.exec(["sh", "-c", "echo $$; exec sleep 30"], {
      signal: controller.signal,
      onOutput,
    });

    await expect(result).rejects.toThrow(abortError);
  });

  it("stops the command when the signal aborts", async () => {
    const { controller, abortAtFirstOutput } = setUp();
    const { onOutput, pid } = abortAtFirstOutput();

    const script = 'trap "" TERM; echo $$; sleep 30';
    await sandbox
      .exec(["sh", "-c", script], { signal: controller.signal, onOutput })
      .catch(() => {});

    expect(isRunning(pid())).toBe(false);
  });

  it("stops the command at the time limit with an error that is not an AbortError", async () => {
    const pids: string[] = [];

    const result = sandbox.exec(["sh", "-c", 'trap "" TERM; echo $$; sleep 30'], {
      timeoutMs: 1000,
      onOutput: (chunk) => pids.push(chunk.trim()),
    });

    await expect(result).rejects.toThrow(
      expect.objectContaining({ name: "Error", message: "The sandbox did not end `sh` in 1 s" }),
    );
    expect(isRunning(pids[0]!)).toBe(false);
  });

  it("stops a root command at the time limit", async () => {
    const pids: string[] = [];

    const result = sandbox.execAsRoot(["sh", "-c", 'trap "" TERM; echo $$; sleep 30'], {
      timeoutMs: 1000,
      onOutput: (chunk) => pids.push(chunk.trim()),
    });

    await expect(result).rejects.toThrow("The sandbox did not end `sh` in 1 s");
    expect(isRunning(pids[0]!)).toBe(false);
  });

  it("stops or does not start a command whose signal aborts at once", async () => {
    const { controller } = setUp();
    const result = sandbox.exec(["sh", "-c", 'trap "" TERM; sleep 31'], {
      signal: controller.signal,
    });

    controller.abort();

    await expect(result).rejects.toThrow(abortError);
    expect(inContainer("pgrep -f 'sleep 3[1]' || true")).toBe("");
  });

  it("does not run the command for a signal that aborted before", async () => {
    const marker = `/tmp/ran-${process.pid}`;

    await sandbox.exec(["touch", marker], { signal: AbortSignal.abort() }).catch(() => {});

    expect(inContainer(`test -e ${marker} && echo ran || true`)).toBe("");
  });

  it("gives stdin to a spawned command", async () => {
    const { controller } = setUp();
    const child = await sandbox.spawn(["cat"], { signal: controller.signal });

    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode("hello"));
    await writer.close();

    expect(await text(child.stdout)).toBe("hello");
  });

  it("gives the exit code of a spawned command", async () => {
    const { controller } = setUp();
    const child = await sandbox.spawn(["sh", "-c", "exit 4"], { signal: controller.signal });

    expect(await child.exited).toBe(4);
  });

  it("ends stopped after the processes that a spawned command leaves end", async () => {
    const { controller } = setUp();
    const child = await sandbox.spawn(["sh", "-c", 'trap "" TERM; sleep 30 & echo $!'], {
      signal: controller.signal,
    });
    const pid = (await text(child.stdout)).trim();

    await child.stopped;

    expect(isRunning(pid)).toBe(false);
  });

  it("stops a spawned command when the signal aborts", async () => {
    const { controller } = setUp();
    const child = await sandbox.spawn(["sh", "-c", 'trap "" TERM; echo $$; sleep 30'], {
      signal: controller.signal,
    });
    const pid = await firstLine(child.stdout);

    controller.abort();
    await child.stopped;

    expect(isRunning(pid)).toBe(false);
  });

  it("rejects when the container does not run", async () => {
    const missing = {
      containerId: "halinka-missing",
      remoteUser: "root",
      remoteWorkspaceFolder: "/",
      noProxy: [],
      isDockerInside: false,
    };

    await expect(
      new DevcontainerSandbox(missing, {
        environment: {},
        policy,
        runnerGitConfig: gitConfig,
      }).exec(["true"]),
    ).rejects.toThrow("does not run");
  });

  it("rejects attach with the error of the CLI for a container that does not exist", async () => {
    const missing = {
      containerId: "halinka-missing",
      remoteUser: "root",
      remoteWorkspaceFolder: "/",
      noProxy: [],
      isDockerInside: false,
    };

    await expect(
      attachDevcontainer(missing, { policy, runnerGitConfig: gitConfig }),
    ).rejects.toThrow(/\S/);
  });

  it("refuses Docker in a devcontainer without dockerd", async () => {
    const { containerId, remoteUser, noProxy } = container;

    await expect(InnerDocker.start({ containerId, remoteUser, noProxy, policy })).rejects.toThrow(
      "The devcontainer has no dockerd",
    );
  });

  it("revokes the setup token after the start", async () => {
    const label = docker("inspect", container.containerId, "--format", "{{json .Config.Labels}}");
    const [{ remoteEnv }] = JSON.parse(JSON.parse(label)["devcontainer.metadata"]);
    const { HTTP_PROXY } = remoteEnv;

    const { stderr } = await fetchOutside({ proxy: HTTP_PROXY });

    expect(stderr).toContain("407");
  });

  it("lets a command reach a host of its list through the proxy", async () => {
    const { stdout } = await fetchOutside({ network: [outside.host] });

    expect(stdout).toBe("outside\n");
  });

  it("refuses a host outside the list of the command", async () => {
    const { exitCode, stderr } = await fetchOutside({ network: ["registry.npmjs.org"] });

    expect({ exitCode, stderr }).toEqual({ exitCode: 1, stderr: expect.stringContaining("403") });
  });

  it("lends credentials to a command without hosts", async () => {
    const route = `${proxyRouteUrl("/anthropic")}/v1/messages`;

    const { stderr } = await sandbox.exec(["wget", "-q", "-T", "5", "-O", "-", route], {
      credentialNames: ["anthropic"],
    });

    // The proxy cannot resolve the provider, so a lent credential gives 502.
    expect(stderr).toContain("502");
  });

  it("lends no credential to a command without credentials", async () => {
    const route = `${proxyRouteUrl("/anthropic")}/v1/messages`;

    const { stderr } = await sandbox.exec(["wget", "-q", "-T", "5", "-O", "-", route], {
      network: [outside.host],
    });

    expect(stderr).toContain("404");
  });

  it("grants no token to a command without hosts and credentials", async () => {
    const { stderr } = await fetchOutside();

    // The environment of the container has the revoked setup token.
    expect(stderr).toContain("407");
  });

  it("revokes the token of a command when it ends", async () => {
    const { stdout: proxy } = await sandbox.exec(["printenv", "http_proxy"], {
      network: [outside.host],
    });

    const { stderr } = await fetchOutside({ proxy: proxy.trim() });

    expect(stderr).toContain("407");
  });

  it("keeps the values of the environment out of the process list", async () => {
    const { controller } = setUp();
    const value = `secret-${process.pid}`;
    const child = await sandbox.spawn(["sleep", "5"], {
      env: { HALINKA_TEST_SECRET: value },
      signal: controller.signal,
    });

    expect(execFileSync("ps", ["-ax", "-o", "command"], { encoding: "utf8" })).not.toContain(value);

    controller.abort();
    await child.stopped;
  });

  it("restarts a running container before up", async () => {
    const startedAt = () =>
      docker("inspect", "--format", "{{.State.StartedAt}}", container.containerId);
    const before = startedAt();

    await upDevcontainer(options);

    expect(startedAt()).not.toBe(before);
  });

  const owner = () => inContainer(`stat -c %u ${sandbox.workspaceFolder}`);
  // Docker Desktop shows root as the owner of each file of a bind mount.
  const itOnLinux = it.runIf(process.platform === "linux");

  beforeAll(() => {
    inContainer(`id ${agentUser} > /dev/null 2>&1 || adduser -D -s /bin/sh ${agentUser}`);
  });

  const gitFolder = () => `${sandbox.workspaceFolder}/.git`;
  const replaceGit = (script: string) => {
    inContainer(`mv ${gitFolder()} ${gitFolder()}-moved && ${script}`);
    onTestFinished(() => {
      inContainer(`rm -rf ${gitFolder()} && mv ${gitFolder()}-moved ${gitFolder()}`);
    });
  };

  const startAgentSleeper = () =>
    docker(
      "exec",
      "--user",
      agentUser,
      container.containerId,
      "sh",
      "-c",
      "setsid sleep 30 > /dev/null 2>&1 & echo $!",
    );
  const openFolder = () => `${sandbox.workspaceFolder}/open`;
  const outsideFile = "/tmp/halinka-outside";

  const setUpAgent = () => {
    onTestFinished(async () => {
      await sandbox.assignWorkspace("host");
      inContainer(`rm -rf ${openFolder()} ${outsideFile}`);
    });
    return setUp();
  };

  it("runs the command as the agent user with its own home", async () => {
    setUpAgent();
    const { stdout } = await sandbox.exec(["sh", "-c", 'id -un; echo "$HOME"'], {
      user: "agent",
    });

    expect(stdout).toBe(`${agentUser}\n/home/${agentUser}\n`);
  });

  it("ends stopped after all processes of the agent user end", async () => {
    const { controller } = setUpAgent();
    const child = await sandbox.spawn(["sh", "-c", "setsid sleep 30 > /dev/null 2>&1 & echo $!"], {
      user: "agent",
      signal: controller.signal,
    });
    const pid = await firstLine(child.stdout);

    await child.stopped;

    expect(isRunning(pid)).toBe(false);
  });

  it("stops a process of the agent user that ignores TERM when the signal aborts", async () => {
    const { controller } = setUpAgent();
    const stray = `setsid sh -c 'trap "" TERM; sleep 30' > /dev/null 2>&1 & echo $!`;
    const script = `${stray}; sleep 30`;
    const child = await sandbox.spawn(["sh", "-c", script], {
      user: "agent",
      signal: controller.signal,
    });
    const pid = await firstLine(child.stdout);

    controller.abort();
    await child.stopped;

    expect(isRunning(pid)).toBe(false);
  });

  it("stops the processes of the agent user after the agent ends its wrapper", async () => {
    const { controller } = setUpAgent();
    const script = "setsid sleep 30 > /dev/null 2>&1 & echo $!; kill -KILL $PPID";
    const child = await sandbox.spawn(["sh", "-c", script], {
      user: "agent",
      signal: controller.signal,
    });
    const pid = await firstLine(child.stdout);

    await child.stopped;

    expect(isRunning(pid)).toBe(false);
  });

  itOnLinux("gives the workspace to the agent user", async () => {
    setUpAgent();
    await sandbox.assignWorkspace("agent");

    expect(owner()).toBe(inContainer(`id -u ${agentUser}`));
  });

  itOnLinux("gives the workspace back to the host user", async () => {
    setUpAgent();
    await sandbox.assignWorkspace("agent");

    await sandbox.assignWorkspace("host");

    expect(owner()).toBe(String(process.getuid!()));
  });

  it("gives the workspace back with the git config of the runner", async () => {
    setUpAgent();
    inContainer(
      `printf '[core]\\n\\tfsmonitor = ./agent.sh\\n' > ${sandbox.workspaceFolder}/.git/config`,
    );

    await sandbox.assignWorkspace("host");

    expect(await readFile(join(workspaceFolder, ".git", "config"), "utf8")).toBe(gitConfig);
  });

  it("removes the .git/commondir of the agent when it gives the workspace back", async () => {
    setUpAgent();
    inContainer(`echo /tmp/agent-git > ${gitFolder()}/commondir`);

    await sandbox.assignWorkspace("host");

    expect(await pathExists(join(workspaceFolder, ".git", "commondir"))).toBe(false);
  });

  it("removes the git locks that a stopped git call left when it restores the git config", async () => {
    setUpAgent();
    const locks = [
      "index.lock",
      "refs/heads/main.lock",
      "logs/refs/heads/main.lock",
      "reftable/tables.list.lock",
    ];
    const folders = "refs/heads logs/refs/heads reftable";
    inContainer(`cd ${gitFolder()} && mkdir -p ${folders} && touch ${locks.join(" ")}`);

    await sandbox.restoreGitConfig();

    expect(inContainer(`cd ${gitFolder()} && ls ${locks.join(" ")} 2>/dev/null || true`)).toBe("");
  });

  it("stops the processes of the agent user before it gives the workspace back", async () => {
    setUpAgent();
    const pid = startAgentSleeper();

    await sandbox.assignWorkspace("host");

    expect(isRunning(pid)).toBe(false);
  });

  it("stops an agent process that keeps forking before it gives the workspace back", async () => {
    setUpAgent();
    docker(
      "exec",
      "--user",
      agentUser,
      container.containerId,
      "sh",
      "-c",
      "setsid sh -c 'while :; do sleep 1 & sleep 0.01; done' > /dev/null 2>&1 &",
    );

    await sandbox.assignWorkspace("host");

    const agentProcesses = inContainer(
      `u=$(id -u ${agentUser}); for d in /proc/[0-9]*; do ` +
        `grep -qE "^Uid:\\s+$u\\s" $d/status 2>/dev/null && ` +
        `[ "$(cut -d" " -f3 $d/stat 2>/dev/null)" != Z ] && echo $d; done; true`,
    );
    expect(agentProcesses).toBe("");
  });

  it("takes the write access of group and others from the workspace when it gives it back", async () => {
    setUpAgent();
    inContainer(`mkdir ${openFolder()} && chmod 777 ${openFolder()}`);

    await sandbox.assignWorkspace("host");

    expect(inContainer(`stat -c %a ${openFolder()}`)).toBe("755");
  });

  it("keeps the mode of a file outside the workspace that a link in it names", async () => {
    setUpAgent();
    inContainer(
      `touch ${outsideFile} && chmod 666 ${outsideFile} && ln -s ${outsideFile} ${openFolder()}`,
    );

    await sandbox.assignWorkspace("host");

    expect(inContainer(`stat -c %a ${outsideFile}`)).toBe("666");
  });

  it("removes the git locks that a stopped git call left when it gives the workspace back", async () => {
    setUpAgent();
    inContainer(
      `cd ${gitFolder()} && mkdir -p refs/heads && touch index.lock refs/heads/main.lock`,
    );

    await sandbox.assignWorkspace("host");

    expect(
      inContainer(`cd ${gitFolder()} && ls index.lock refs/heads/main.lock 2>/dev/null || true`),
    ).toBe("");
  });

  it("writes nothing through a .git/config link of the agent", async () => {
    setUpAgent();
    inContainer(`rm ${gitFolder()}/config && ln -s /etc/halinka-probe ${gitFolder()}/config`);

    await sandbox.assignWorkspace("host");

    expect(inContainer("test -e /etc/halinka-probe && echo written || true")).toBe("");
    expect(await readFile(join(workspaceFolder, ".git", "config"), "utf8")).toBe(gitConfig);
  });

  it("refuses to give back a workspace whose .git is a link", async () => {
    setUpAgent();
    replaceGit(`ln -s /etc ${gitFolder()}`);

    await expect(sandbox.assignWorkspace("host")).rejects.toThrow(".git is not a folder");
  });

  it("writes nothing through a .git link at a give-back", async () => {
    setUpAgent();
    replaceGit(`ln -s /etc ${gitFolder()}`);

    await sandbox.assignWorkspace("host").catch(() => {});

    expect(inContainer("test -e /etc/config && echo written || true")).toBe("");
  });

  it("refuses to give back a workspace whose .git is a file", async () => {
    setUpAgent();
    replaceGit(`echo "gitdir: /tmp/agent-git" > ${gitFolder()}`);

    await expect(sandbox.assignWorkspace("host")).rejects.toThrow(".git is not a folder");
  });

  itOnLinux("keeps a process of the agent from a write to .git after the give-back", async () => {
    setUpAgent();
    await sandbox.assignWorkspace("agent");
    await sandbox.exec(["chmod", "777", ".", ".git"], { user: "agent" });
    await sandbox.assignWorkspace("host");

    const write = await sandbox.exec(["sh", "-c", "echo x > .git/agent"], { user: "agent" });

    expect(write.exitCode).not.toBe(0);
  });

  itOnLinux("gives the workspace back to the host user before a removal", async () => {
    setUpAgent();
    await sandbox.assignWorkspace("agent");

    await reclaimWorkspace(workspaceFolder);

    expect(owner()).toBe(String(process.getuid!()));
  });
});
