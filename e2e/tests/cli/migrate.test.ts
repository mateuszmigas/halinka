import { legacyWorkflow, test } from "../utils";

const legacyFiles = {
  ".halinka/config.yml": "server: local\nenvironments:\n  default:\n    sandbox: host\n",
  ".halinka/workflows/build.yml": legacyWorkflow("make"),
};

test.describe("halinka migrate", () => {
  test("prints the changes without --write", async ({ halinka }) => {
    const repo = await halinka.createRepo(legacyFiles);

    const cli = await halinka.run(["migrate"], repo.path).expectExit(0);

    await cli.expectOutput(".halinka/workflows/build.yml:2 Deleted environment.");
  });

  test("writes files that check accepts with --write", async ({ halinka }) => {
    const repo = await halinka.createRepo(legacyFiles);

    await halinka.run(["migrate", "--write"], repo.path).expectExit(0);

    await halinka.run(["check"], repo.path).expectExit(0);
  });

  test("prints the problems that stay and exits with 1", async ({ halinka }) => {
    const repo = await halinka.createRepo({
      ...legacyFiles,
      ".halinka/workflows/review.yml":
        "name: Review\nsteps:\n  - id: pr\n    type: github\n    action: open_pull_request\n    with:\n      title: Fix\n      draft: true\n",
    });

    const cli = await halinka.run(["migrate", "--write"], repo.path).expectExit(1);

    await cli.expectOutput(".halinka/workflows/review.yml:7:5 A github step has no with.");
  });
});
