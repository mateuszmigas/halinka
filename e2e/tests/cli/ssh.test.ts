import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { sshHostOf } from "@halinka/utils/sshHost";
import { expect } from "@playwright/test";

import { shellWorkflow, test, type TestHalinka } from "../utils";

const server = "https://halinka.example.com";

const firstKey = "ssh-ed25519 AAAAfirst";
const secondKey = "ssh-ed25519 AAAAsecond";

// A server that gives `key.current` as the SSH key of the runner of any run. Without a
// `runnerId`, each run has its own runner.
const startKeyServer = (halinka: TestHalinka, key: { current: string; runnerId?: number }) =>
  halinka.startFakeServer((request, response) => {
    const workflowRunId = Number(/\/runs\/(\d+)\//.exec(request.url ?? "")?.[1]);
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({ runnerId: key.runnerId ?? workflowRunId, sshHostKey: key.current }),
    );
  });

const hostOf = (url: string) => sshHostOf(url, 12);

test.describe("halinka ssh", () => {
  test("writes a config block for the server with the path of this command", async ({
    halinka,
  }) => {
    const cli = halinka.run(["ssh", "config", "--server", server]);

    await cli.expectOutput("Host halinka-halinka.example.com-*");
    await cli.waitForMatch(
      /ProxyCommand "\/[^"]*node[^"]*" .* ssh '%n' --server "https:\/\/halinka\.example\.com"\n/,
    );
    await cli.expectExit(0);
  });

  test("offers no key and no agent in the config block", async ({ halinka }) => {
    const cli = halinka.run(["ssh", "config", "--server", server]);

    await cli.expectOutput("PubkeyAuthentication no");
    await cli.expectOutput("ForwardAgent no");
    await cli.expectExit(0);
  });

  test("makes ssh check the key of the runner", async ({ halinka }) => {
    const cli = halinka.run(["ssh", "config", "--server", server]);

    await cli.waitForMatch(/KnownHostsCommand "\/.* ssh known-hosts '%n' --server /);
    await cli.expectOutput("StrictHostKeyChecking yes");
    await cli.expectExit(0);
  });

  test("gives ssh the key of the runner at the first use", async ({ halinka }) => {
    const url = await startKeyServer(halinka, { current: firstKey, runnerId: 3 });

    const cli = halinka.run(["ssh", "known-hosts", hostOf(url), "--server", url]);

    await cli.expectOutput(`${hostOf(url)} ${firstKey}\n`);
    await cli.expectExit(0);
  });

  test("keeps the saved key from other users", async ({ halinka }) => {
    const url = await startKeyServer(halinka, { current: firstKey });

    await halinka.run(["ssh", "known-hosts", hostOf(url), "--server", url]).expectExit(0);

    expect((await stat(join(halinka.home, "ssh_host_keys.json"))).mode & 0o777).toBe(0o600);
  });

  test("gives ssh the saved key when the server gives another", async ({ halinka }) => {
    const key = { current: firstKey, runnerId: 3 };
    const url = await startKeyServer(halinka, key);
    await halinka.run(["ssh", "known-hosts", hostOf(url), "--server", url]).expectExit(0);
    key.current = secondKey;

    const cli = halinka.run(["ssh", "known-hosts", hostOf(url), "--server", url]);

    await cli.expectOutput(`${hostOf(url)} ${firstKey}\n`);
    await cli.expectOutput("The SSH key of runner 3 changed");
    await cli.expectExit(0);
  });

  test("saves a key for each runner", async ({ halinka }) => {
    const key = { current: firstKey, runnerId: 3 };
    const url = await startKeyServer(halinka, key);
    await halinka.run(["ssh", "known-hosts", hostOf(url), "--server", url]).expectExit(0);
    Object.assign(key, { current: secondKey, runnerId: 4 });

    const cli = halinka.run(["ssh", "known-hosts", hostOf(url), "--server", url]);

    await cli.expectOutput(`${hostOf(url)} ${secondKey}\n`);
    await cli.expectExit(0);
  });

  test("saves the keys of runners that connect at one time", async ({ halinka }) => {
    const url = await startKeyServer(halinka, { current: firstKey });
    const runs = [1, 2, 3, 4, 5, 6];

    await Promise.all(
      runs.map((run) =>
        halinka.run(["ssh", "known-hosts", String(run), "--server", url]).expectExit(0),
      ),
    );

    const saved = JSON.parse(await readFile(join(halinka.home, "ssh_host_keys.json"), "utf8"));
    expect(
      Object.keys(saved[url])
        .map(Number)
        .sort((a, b) => a - b),
    ).toEqual(runs);
  });

  test("fails for a saved key with more than one line", async ({ halinka }) => {
    const url = await startKeyServer(halinka, { current: firstKey, runnerId: 3 });
    const damaged = { [url]: { 3: `${firstKey}\n* ${secondKey}` } };
    await mkdir(halinka.home, { recursive: true });
    await writeFile(join(halinka.home, "ssh_host_keys.json"), JSON.stringify(damaged), {
      mode: 0o600,
    });

    const cli = halinka.run(["ssh", "known-hosts", hostOf(url), "--server", url]);

    await cli.expectOutput("holds a key that is not valid");
    await cli.expectExit(1);
  });

  test("refuses a key of the server with more than one line", async ({ halinka }) => {
    const url = await startKeyServer(halinka, { current: `${firstKey}\n* ${secondKey}` });

    const cli = halinka.run(["ssh", "known-hosts", hostOf(url), "--server", url]);

    await cli.expectOutput("gave an SSH key that is not valid");
    await cli.expectExit(1);
  });

  test("takes the server of halinka use", async ({ halinka }) => {
    const logins = JSON.stringify({ current: server, tokens: {} });
    await mkdir(halinka.home, { recursive: true });
    await writeFile(join(halinka.home, "logins.json"), logins);

    const cli = halinka.run(["ssh", "config"]);

    await cli.expectOutput("Host halinka-halinka.example.com-*");
    await cli.expectExit(0);
  });

  test("asks for a server when none is selected", async ({ halinka }) => {
    const cli = halinka.run(["ssh", "1"]);

    await cli.expectOutput("Give --server <url>.");
    await cli.expectExit(1);
  });

  test("does not send a token to another machine without TLS", async ({ halinka }) => {
    const cli = halinka.run(["ssh", "1", "--server", "http://halinka.example.com"]);

    await cli.expectOutput("without TLS");
    await cli.expectExit(1);
  });

  test("refuses a target without a run", async ({ halinka }) => {
    const cli = halinka.run(["ssh", "the-run", "--server", server]);

    await cli.expectOutput('There is no run in "the-run"');
    await cli.expectExit(1);
  });

  test("gives the refusal of a run in a worktree, for a host of the config", async ({
    halinka,
  }) => {
    const { server: local } = await halinka.startInRepo({
      "build.yml": shellWorkflow("echo built"),
    });
    await local.postJson("/api/runs", { repoId: 1, workflow: "build" });
    await expect.poll(() => local.get("/api/runs/1")).toMatchObject({ status: "succeeded" });

    const cli = halinka.run(["ssh", sshHostOf(local.url, 1), "--server", local.url]);

    await cli.expectOutput("works in a worktree");
    await cli.expectExit(1);
    await local.stop();
  });
});
