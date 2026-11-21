import { test } from "../utils";

const devcontainerPath = ".devcontainer/devcontainer.json";

test.describe("halinka init", () => {
  test("writes the files with the defaults for --yes", async ({ halinka }) => {
    const repo = await halinka.createRepo();
    await halinka.init(repo, ["--yes"]).expectExit(0);
    await repo.expectFile(
      ".halinka/config.yml",
      `schema_version: 1\ndevcontainer: ${devcontainerPath}\n`,
    );
    await repo.expectFile(devcontainerPath);
    await repo.expectFile(".halinka/workflows/smoke.yml");
  });

  test("writes no server in the config for a remote server", async ({ halinka }) => {
    const repo = await halinka.createRepo();
    await halinka
      .init(repo, ["--server", "https://halinka.example.com/", "--devcontainer", "none"])
      .expectExit(0);
    await repo.expectFile(".halinka/config.yml", "schema_version: 1\n");
    await repo.expectNoFile(devcontainerPath);
  });

  test("names the login of a remote server in the next steps", async ({ halinka }) => {
    const repo = await halinka.createRepo();
    await halinka.run(["use", "https://halinka.example.com"]).expectExit(0);

    const cli = await halinka.init(repo, ["--devcontainer", "none"]).expectExit(0);

    await cli.expectOutput("Log in first: halinka login --server https://halinka.example.com");
  });

  test("says nothing of the registration on a machine without a runner key", async ({
    halinka,
  }) => {
    const repo = await halinka.createRepo();

    const cli = await halinka.init(repo, ["--yes"]).expectExit(0);

    await cli.expectNoOutputAtClose("did not register the repo");
  });

  test("does not warn when the local server does not run", async ({ halinka }) => {
    await (await halinka.start()).crash();
    const repo = await halinka.createRepo();

    const cli = await halinka
      .init(repo, ["--server", "local", "--devcontainer", "none"])
      .expectExit(0);

    await cli.expectNoOutputAtClose("did not register the repo");
  });

  test("names no login for the URL of the server of this machine", async ({ halinka }) => {
    const server = await halinka.start();
    await server.crash();
    halinka.setServerUrl(server.url);
    const repo = await halinka.createRepo();

    const cli = await halinka.init(repo, ["--devcontainer", "none"]).expectExit(0);

    await cli.expectNoOutputAtClose("halinka login");
  });

  test("warns when another server does not answer", async ({ halinka }) => {
    const other = await halinka.start();
    await other.crash();
    const server = await halinka.start();
    const repo = await halinka.createRepo();

    const cli = await halinka
      .init(repo, ["--server", other.url, "--devcontainer", "none"])
      .expectExit(0);

    await cli.expectOutput("did not register the repo");
    await server.stop();
  });

  test("names the key command of the smoke agent", async ({ halinka }) => {
    const repo = await halinka.createRepo();

    const cli = await halinka.init(repo, ["--yes"]).expectExit(0);

    // The note box wraps the command after the agent.
    await cli.expectOutput("halinka agent key claude-code");
    await cli.expectOutput("<ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN>");
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
      `schema_version: 1\ndevcontainer: ${devcontainerPath}\n`,
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
      ".halinka/config.yml": "schema_version: 1\n",
    });
    const cli = await halinka.init(repo, ["--yes"]).expectExit(1);
    await cli.expectOutput("This repo already has .halinka/.");
  });

  test("asks for flags when the input is not a terminal", async ({ halinka }) => {
    const repo = await halinka.createRepo();
    const cli = await halinka.init(repo).expectExit(1);
    await cli.expectOutput("The input is not a terminal. Give --devcontainer, or --yes.");
    await repo.expectNoFile(".halinka");
  });
});
