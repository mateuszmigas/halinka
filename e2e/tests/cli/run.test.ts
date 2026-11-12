import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { expect } from "@playwright/test";

import { shellWorkflow, test, type TestHalinka } from "../utils";

const approvalWorkflow = [
  "schema_version: 1",
  "name: Ship",
  "steps:",
  "  - { id: approve, type: approval, message: Check the diff }",
  "  - { id: after, type: shell, run: echo after }",
  "",
].join("\n");

const startWithRepoConfig = async (halinka: TestHalinka, config: string) => {
  const server = await halinka.start();
  await server.expectRunnerConnected();
  const repo = await halinka.createRepo({
    ".halinka/config.yml": config,
    ".halinka/workflows/build.yml": shellWorkflow("ls"),
  });
  return { server, repo };
};

test.describe("halinka run", () => {
  test("exits with 0 after it prints a run that succeeds", async ({ halinka }) => {
    const { repo, server } = await halinka.startInRepo({
      "build.yml": shellWorkflow("echo built"),
    });

    const cli = await halinka.run(["run", "build"], repo.path).expectExit(0);

    await cli.expectOutput(`Run 1: ${server.url}/runs/1`);
    await cli.expectOutput("built");
    await cli.expectOutput("Run 1: succeeded");
    await server.stop();
  });

  test("exits with 1 when the run fails", async ({ halinka }) => {
    const { repo, server } = await halinka.startInRepo({ "fail.yml": shellWorkflow("exit 3") });

    const cli = await halinka.run(["run", "fail"], repo.path).expectExit(1);

    await cli.expectOutput("Run 1: failed");
    await server.stop();
  });

  test("gives the inputs to the workflow", async ({ halinka }) => {
    const { repo, server } = await halinka.startInRepo({
      "fix.yml": [
        "schema_version: 1",
        "name: Fix",
        "inputs:",
        "  issue: { type: number, required: true }",
        "branch:",
        "  name: fix/issue-${{ inputs.issue }}",
        "steps:",
        "  - { id: notes, type: shell, run: echo notes > notes.md }",
        "",
      ].join("\n"),
    });

    await halinka.run(["run", "fix", "--input", "issue=12"], repo.path).expectExit(0);

    await repo.expectCommittedFile("fix/issue-12", "notes.md", "notes\n");
    await server.stop();
  });

  test("prints the problem of an input that the workflow refuses", async ({ halinka }) => {
    const { repo, server } = await halinka.startInRepo({
      "fix.yml": [
        "schema_version: 1",
        "name: Fix",
        "inputs:",
        "  issue: { type: number, required: true }",
        "steps:",
        "  - { id: work, type: shell, run: ls }",
        "",
      ].join("\n"),
    });

    const cli = await halinka.run(["run", "fix", "--input", "issue=x"], repo.path).expectExit(1);

    await cli.expectOutput("inputs.issue: Use a number");
    await server.stop();
  });

  test("names a workflow that does not exist", async ({ halinka }) => {
    const { repo, server } = await halinka.startInRepo({ "build.yml": shellWorkflow("ls") });

    const cli = await halinka.run(["run", "deploy"], repo.path).expectExit(1);

    await cli.expectOutput("There is no workflow deploy");
    await server.stop();
  });

  test("follows a run that waits for a person to its end", async ({ halinka }) => {
    const { repo, server } = await halinka.startInRepo({ "ship.yml": approvalWorkflow });

    const cli = halinka.run(["run", "ship"], repo.path);

    await cli.expectOutput(`The run waits for a person: ${server.url}/runs/1`);
    const [item] = (await server.get("/api/inbox")) as { id: number }[];
    await server.postJson(`/api/inbox/${item?.id}/resolve`, { decision: "approve" });
    await cli.expectExit(0);
    await cli.expectOutput("after");
    await server.stop();
  });

  test("stops only the follow at a Ctrl+C", async ({ halinka }) => {
    const { repo, server } = await halinka.startInRepo({ "ship.yml": approvalWorkflow });
    const cli = halinka.run(["run", "ship"], repo.path);
    await cli.expectOutput("The run waits for a person");

    cli.interrupt();

    await cli.expectExit(130);
    await cli.expectOutput(`The run continues: ${server.url}/runs/1`);
    expect(await server.get("/api/runs/1")).toMatchObject({ status: "waiting_input" });
    await server.stop();
  });

  test("registers a repo that the server does not know", async ({ halinka }) => {
    const { server, repo } = await startWithRepoConfig(
      halinka,
      "schema_version: 1\nserver: local\n",
    );

    await halinka.run(["run", "build"], repo.path).expectExit(0);

    expect(await server.get("/api/repos")).toMatchObject([{ path: repo.path }]);
    await server.stop();
  });

  test("uses one repo for a path through a symlink and the path of the checkout", async ({
    halinka,
  }) => {
    const { server, repo } = await startWithRepoConfig(
      halinka,
      "schema_version: 1\nserver: local\n",
    );
    const link = join(dirname(repo.path), "link");
    await symlink(repo.path, link);
    await server.postJson("/api/repos", { runnerId: 1, path: link });

    await halinka.run(["run", "build"], repo.path).expectExit(0);

    expect(await server.get("/api/repos")).toMatchObject([{ path: repo.path }]);
    await server.stop();
  });

  // Registering refuses a repo without the config, and a run of a known repo does not need it.
  test("does not register a repo that the server knows", async ({ halinka }) => {
    const { repo, server } = await halinka.startInRepo({ "build.yml": shellWorkflow("ls") });
    await rm(join(repo.path, ".halinka/config.yml"));

    await halinka.run(["run", "build", "--server", server.url], repo.path).expectExit(0);

    await server.stop();
  });

  test("follows the repo of --repo", async ({ halinka }) => {
    const { repo, server } = await halinka.startInRepo({
      "build.yml": shellWorkflow("echo built"),
    });

    const cli = await halinka.run(["run", "build", "--repo", repo.path]).expectExit(0);

    await cli.expectOutput("built");
    await server.stop();
  });

  test("prints the lines of a workflow that is not valid", async ({ halinka }) => {
    const { repo, server } = await halinka.startInRepo({
      "bad.yml": "schema_version: 1\nname: Bad\nsteps: 1\n",
    });

    const cli = await halinka.run(["run", "bad"], repo.path).expectExit(1);

    await cli.expectOutput("line 3:");
    await server.stop();
  });

  test("says that the run can exist at a Ctrl+C while the server creates it", async ({
    halinka,
  }) => {
    await (await halinka.start()).stop();
    const key = await readFile(join(halinka.home, "runner.json"), "utf8");
    const { publicKey } = JSON.parse(key) as { publicKey: string };
    const repo = await halinka.createRepo({
      ".halinka/config.yml": "schema_version: 1\nserver: local\n",
    });
    const creating = Promise.withResolvers<void>();
    const url = await halinka.startFakeServer((request, response) => {
      if (request.method === "POST") return creating.resolve();
      const lists: Record<string, unknown> = {
        "/api/runners": [{ id: 1, publicKey }],
        "/api/repos": [{ id: 1, path: repo.path, runnerId: 1 }],
      };
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(lists[request.url ?? ""]));
    });
    const cli = halinka.run(["run", "build", "--server", url], repo.path);
    await creating.promise;

    cli.interrupt();

    await cli.expectExit(130);
    await cli.expectOutput(`Look in the portal: ${url}/runs`);
  });

  test("names a --repo that does not exist without a stack trace", async ({ halinka }) => {
    const cli = await halinka.run(["run", "build", "--repo", "/does/not/exist"]).expectExit(1);

    await cli.expectNoOutputAtClose("    at ");
  });

  test("refuses a folder outside a git repository", async ({ halinka }) => {
    const folder = await halinka.createFolder();

    const cli = await halinka.run(["run", "build"], folder).expectExit(1);

    await cli.expectOutput(`${folder} is not in a git repository.`);
  });

  test("refuses a repo without .halinka/config.yml", async ({ halinka }) => {
    const repo = await halinka.createRepo();

    const cli = await halinka.run(["run", "build"], repo.path).expectExit(1);

    await cli.expectOutput("has no .halinka/config.yml. Run halinka init.");
  });

  test("names the problems of a repo config that is not valid", async ({ halinka }) => {
    const repo = await halinka.createRepo({
      ".halinka/config.yml": "schema_version: 1\nserver: local\nunknown: 1\n",
    });

    const cli = await halinka.run(["run", "build"], repo.path).expectExit(1);

    await cli.expectOutput(".halinka/config.yml is not valid: line 3: Unknown key");
  });

  test("refuses a server that is not local or a URL", async ({ halinka }) => {
    const repo = await halinka.createRepo();

    const cli = await halinka.run(["run", "build", "--server", "nas"], repo.path).expectExit(1);

    await cli.expectOutput('The server must be "local" or an http or https URL');
  });

  test("takes --server over HALINKA_SERVER_URL and the repo config", async ({ halinka }) => {
    const { server, repo } = await startWithRepoConfig(
      halinka,
      "schema_version: 1\nserver: http://127.0.0.1:1\n",
    );
    halinka.setServerUrl("http://127.0.0.1:2");

    await halinka.run(["run", "build", "--server", server.url], repo.path).expectExit(0);

    await server.stop();
  });

  test("takes HALINKA_SERVER_URL over the repo config", async ({ halinka }) => {
    const { server, repo } = await startWithRepoConfig(
      halinka,
      "schema_version: 1\nserver: http://127.0.0.1:1\n",
    );
    halinka.setServerUrl(server.url);

    await halinka.run(["run", "build"], repo.path).expectExit(0);

    await server.stop();
  });

  test("gives a hint when this machine is not a runner of the server", async ({ halinka }) => {
    const server = await halinka.startServer();
    const repo = await halinka.createRepo({
      ".halinka/config.yml": "schema_version: 1\nserver: local\n",
    });

    const cli = await halinka.run(["run", "build"], repo.path).expectExit(1);

    await cli.expectOutput(`Make it a runner: halinka runner --server ${server.url}`);
    await server.stop();
  });

  test("says that no server answers", async ({ halinka }) => {
    await (await halinka.start()).stop();
    const repo = await halinka.createRepo({
      ".halinka/config.yml": "schema_version: 1\nserver: http://127.0.0.1:1\n",
    });

    const cli = await halinka.run(["run", "build"], repo.path).expectExit(1);

    await cli.expectOutput("http://127.0.0.1:1 did not answer");
  });

  test("names a damaged server.json without a stack trace", async ({ halinka }) => {
    const repo = await halinka.createRepo({
      ".halinka/config.yml": "schema_version: 1\nserver: local\n",
    });
    await mkdir(halinka.home, { recursive: true });
    const urlFile = join(halinka.home, "server.json");
    await writeFile(urlFile, "{");

    const cli = await halinka.run(["run", "build"], repo.path).expectExit(1);

    await cli.expectOutput(`${urlFile} has no server URL`);
    await cli.expectNoOutputAtClose("    at ");
  });

  test("refuses an input without a value", async ({ halinka }) => {
    const cli = await halinka.run(["run", "build", "--input", "who"]).expectExit(1);

    await cli.expectOutput('--input must be name=value. Got "who".');
  });

  test("refuses a call without a workflow", async ({ halinka }) => {
    const cli = await halinka.run(["run"]).expectExit(1);

    await cli.expectOutput("Give one workflow.");
  });
});
