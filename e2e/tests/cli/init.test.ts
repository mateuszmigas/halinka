import { test } from "../utils";

const devcontainerPath = ".devcontainer/devcontainer.json";

test.describe("halinka init", () => {
  test("writes the files with the defaults for --yes", async ({ halinka }) => {
    const repo = await halinka.createRepo();
    await halinka.init(repo, ["--yes"]).expectExit(0);
    await repo.expectFile(
      ".halinka/config.yml",
      `schema_version: 1\nserver: local\ndevcontainer: ${devcontainerPath}\n`,
    );
    await repo.expectFile(devcontainerPath);
    await repo.expectFile(".halinka/workflows/smoke.yml");
  });

  test("uses a remote server without a devcontainer", async ({ halinka }) => {
    const repo = await halinka.createRepo();
    await halinka
      .init(repo, ["--server", "https://halinka.example.com/", "--devcontainer", "none"])
      .expectExit(0);
    await repo.expectFile(
      ".halinka/config.yml",
      "schema_version: 1\nserver: https://halinka.example.com\n",
    );
    await repo.expectNoFile(devcontainerPath);
  });

  test("says nothing of the registration on a machine without a runner key", async ({
    halinka,
  }) => {
    const repo = await halinka.createRepo();

    const cli = await halinka.init(repo, ["--yes"]).expectExit(0);

    await cli.expectNoOutputAtClose("did not register the repo");
  });

  test("refuses http to another machine", async ({ halinka }) => {
    const repo = await halinka.createRepo();

    const cli = await halinka
      .init(repo, ["--server", "http://halinka.example.com", "--devcontainer", "none"])
      .expectExit(1);

    await cli.expectOutput("without TLS. Use an https URL.");
    await repo.expectNoFile(".halinka");
  });

  test("uses the only devcontainer of the repo", async ({ halinka }) => {
    const repo = await halinka.createRepo({ [devcontainerPath]: "{}\n" });
    const cli = await halinka.init(repo, ["--server", "local"]).expectExit(0);
    await cli.expectOutput(`Uses ${devcontainerPath}`);
    await repo.expectFile(
      ".halinka/config.yml",
      `schema_version: 1\nserver: local\ndevcontainer: ${devcontainerPath}\n`,
    );
    await repo.expectFile(devcontainerPath, "{}\n");
  });

  test("registers the repo on a local server with any port", async ({ halinka }) => {
    const server = await halinka.start();
    await server.expectRunnerConnected();
    const repo = await halinka.createRepo();

    const cli = await halinka
      .init(repo, ["--server", "local", "--devcontainer", "none"])
      .expectExit(0);

    await cli.expectOutput("Registered the repo on local");
    await server.stop();
  });

  test("registers the repo on the new server after a crash of the old server", async ({
    halinka,
  }) => {
    await (await halinka.start()).crash();
    const server = await halinka.start();
    await server.expectRunnerConnected();
    const repo = await halinka.createRepo();

    const cli = await halinka
      .init(repo, ["--server", "local", "--devcontainer", "none"])
      .expectExit(0);

    await cli.expectOutput("Registered the repo on local");
    await server.stop();
  });

  test("refuses --devcontainer create when the devcontainer exists", async ({ halinka }) => {
    const repo = await halinka.createRepo({ [devcontainerPath]: "{}\n" });
    const cli = await halinka.init(repo, ["--devcontainer", "create", "--yes"]).expectExit(1);
    await cli.expectOutput(`${devcontainerPath} exists. Use --devcontainer ${devcontainerPath}.`);
    await repo.expectNoFile(".halinka");
  });

  test("refuses a folder outside a git repository", async ({ halinka }) => {
    const folder = await halinka.createFolder();
    const cli = await halinka.run(["init", "--yes"], folder).expectExit(1);
    await cli.expectOutput(`${folder} is not in a git repository.`);
  });

  test("refuses a repo that has .halinka/", async ({ halinka }) => {
    const repo = await halinka.createRepo({
      ".halinka/config.yml": "schema_version: 1\nserver: local\n",
    });
    const cli = await halinka.init(repo, ["--yes"]).expectExit(1);
    await cli.expectOutput("This repo already has .halinka/.");
  });

  test("asks for flags when the input is not a terminal", async ({ halinka }) => {
    const repo = await halinka.createRepo();
    const cli = await halinka.init(repo).expectExit(1);
    await cli.expectOutput("The input is not a terminal. Give --server, --devcontainer, or --yes.");
    await repo.expectNoFile(".halinka");
  });
});
