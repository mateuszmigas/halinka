import { test } from "../utils";

test.describe("halinka check", () => {
  test("passes on the files that init writes", async ({ halinka }) => {
    const repo = await halinka.createRepo();
    await halinka.init(repo, ["--yes"]).expectExit(0);
    const cli = await halinka.run(["check"], repo.path).expectExit(0);
    await cli.expectOutput("Workflows checked: 1.");
  });

  test("prints the path and the line of a problem", async ({ halinka }) => {
    const repo = await halinka.createRepo({
      ".halinka/config.yml": "schema_version: 1\nserver: local\n",
      ".halinka/workflows/build.yml":
        "schema_version: 1\nname: Build\nsteps:\n  - id: Not Valid\n    type: shell\n    run: make\n",
    });
    const cli = await halinka.run(["check"], repo.path).expectExit(1);
    await cli.expectOutput(".halinka/workflows/build.yml:4:5 ");
  });

  test("checks the repo that --repo names", async ({ halinka }) => {
    const repo = await halinka.createRepo();
    const folder = await halinka.createFolder();
    const cli = await halinka.run(["check", "--repo", repo.path], folder).expectExit(1);
    await cli.expectOutput(".halinka/config.yml does not exist.");
  });

  test("refuses a folder outside a git repository", async ({ halinka }) => {
    const folder = await halinka.createFolder();
    const cli = await halinka.run(["check"], folder).expectExit(1);
    await cli.expectOutput(`${folder} is not in a git repository.`);
  });
});
