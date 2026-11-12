import { dirname } from "node:path";

import { legacyWorkflow, shellWorkflow, test, TestPortal } from "../utils";

const buildWorkflow = shellWorkflow("echo build");

test.describe("repos", () => {
  test("registers a repo of this machine", async ({ halinka, page }) => {
    const server = await halinka.start();
    await server.expectRunnerConnected();
    const repo = await halinka.createRepo({
      ".halinka/config.yml": "schema_version: 1\nserver: local\n",
    });
    const reposPage = await new TestPortal(page, server).openRepos();

    await reposPage.register(await halinka.readLocalRunnerName(), repo.path);

    await reposPage.expectRepo(repo.name);
  });

  test("registers a repo that a person selects in the folder list", async ({ halinka, page }) => {
    const server = await halinka.start();
    await server.expectRunnerConnected();
    const repo = await halinka.createRepo({
      ".halinka/config.yml": "schema_version: 1\nserver: local\n",
    });
    const reposPage = await new TestPortal(page, server).openRepos();

    await reposPage.registerFromFolderList(
      await halinka.readLocalRunnerName(),
      dirname(repo.path),
      repo.name,
    );

    await reposPage.expectRepo(repo.name);
  });

  test("registers a repo without .halinka/ with a new config", async ({ halinka, page }) => {
    const server = await halinka.start();
    await server.expectRunnerConnected();
    const repo = await halinka.createRepo();
    const reposPage = await new TestPortal(page, server).openRepos();

    await reposPage.initAndRegister(
      await halinka.readLocalRunnerName(),
      repo.path,
      "None: workflows run only in worktrees",
    );

    await reposPage.expectRepo(repo.name);
    await repo.expectFile(".halinka/config.yml", "schema_version: 1\nserver: local\n");
  });

  test("opens the editor from the first problem of a workflow", async ({ halinka, page }) => {
    const { repo, server } = await halinka.startInRepo({
      "build.yml": legacyWorkflow("echo build"),
    });
    const reposPage = await new TestPortal(page, server).openRepos();
    const repoPage = await reposPage.openRepo(repo.name);

    const workflowPage = await repoPage.openProblem("Line 1: This file is from an older Halinka.");

    await workflowPage.expectSourceText("environment: default");
  });

  test("keeps the notes of the migration after Apply fixes", async ({ halinka, page }) => {
    const { repo, server } = await halinka.startInRepo({
      "build.yml": legacyWorkflow("echo build"),
    });
    const reposPage = await new TestPortal(page, server).openRepos();
    const repoPage = await reposPage.openRepo(repo.name);
    const workflowPage = await repoPage.openProblem("Line 1: This file is from an older Halinka.");

    await workflowPage.applyFixes();

    await workflowPage.expectNote(
      "A step reaches no network now unless it names the hosts in network.",
    );
  });

  test("saves the fixes of a workflow from an older Halinka", async ({ halinka, page }) => {
    const { repo, server } = await halinka.startInRepo({
      "build.yml": legacyWorkflow("echo build"),
    });
    const reposPage = await new TestPortal(page, server).openRepos();
    const repoPage = await reposPage.openRepo(repo.name);
    const workflowPage = await repoPage.openProblem("Line 1: This file is from an older Halinka.");

    await (await workflowPage.applyFixes()).save();

    await repo.expectFile(
      ".halinka/workflows/build.yml",
      `schema_version: 1\n${legacyWorkflow("echo build").replace("environment: default\n", "")}`,
    );
  });

  test("creates a workflow that runs from the repo page", async ({ halinka, page }) => {
    const { repo, server } = await halinka.startInRepo({});
    const reposPage = await new TestPortal(page, server).openRepos();
    const repoPage = await reposPage.openRepo(repo.name);

    const workflowPage = await repoPage.createWorkflow("hello.yml");
    const runPage = await workflowPage.startRun();

    await runPage.expectStatus("succeeded");
  });

  test("shows a test run of a draft that waits for a container", async ({ halinka, page }) => {
    const { repo, server } = await halinka.startInRepo({ "build.yml": buildWorkflow });
    const reposPage = await new TestPortal(page, server).openRepos();
    const repoPage = await reposPage.openRepo(repo.name);
    const workflowPage = await repoPage.openWorkflow("Build");
    const step = await workflowPage.selectStep("build");
    await step.fill("Step ID", "compile");

    const runPage = await workflowPage.startTestRun();

    await runPage.expectTestRun();
    await runPage.expectWaits("is a test of a draft");
  });

  test("completes a key of the workflow schema while a person types", async ({ halinka, page }) => {
    const { repo, server } = await halinka.startInRepo({ "build.yml": `\n${buildWorkflow}` });
    const reposPage = await new TestPortal(page, server).openRepos();
    const repoPage = await reposPage.openRepo(repo.name);
    const workflowPage = await repoPage.openWorkflow("Build");
    await workflowPage.typeInSource("ru");

    await workflowPage.acceptCompletion("runs-on");

    await workflowPage.expectSourceText("runs-on");
  });

  test("shows the changes of a draft against the file", async ({ halinka, page }) => {
    const { repo, server } = await halinka.startInRepo({ "build.yml": buildWorkflow });
    const reposPage = await new TestPortal(page, server).openRepos();
    const repoPage = await reposPage.openRepo(repo.name);
    const workflowPage = await repoPage.openWorkflow("Build");
    const step = await workflowPage.selectStep("build");
    await step.fill("Step ID", "compile");
    await workflowPage.openCode();

    await workflowPage.showChanges();

    await workflowPage.expectChanges("build", "compile");
  });

  test("keeps the undo history after the changes of a draft", async ({ halinka, page }) => {
    const { repo, server } = await halinka.startInRepo({ "build.yml": buildWorkflow });
    const reposPage = await new TestPortal(page, server).openRepos();
    const repoPage = await reposPage.openRepo(repo.name);
    const workflowPage = await repoPage.openWorkflow("Build");
    await workflowPage.typeInSource("x");
    await workflowPage.showChanges();
    await workflowPage.hideChanges();

    await workflowPage.undoInSource();

    await workflowPage.expectSaved();
  });

  test("undoes the typing in a Properties field as one edit", async ({ halinka, page }) => {
    const { repo, server } = await halinka.startInRepo({ "build.yml": buildWorkflow });
    const reposPage = await new TestPortal(page, server).openRepos();
    const repoPage = await reposPage.openRepo(repo.name);
    const workflowPage = await repoPage.openWorkflow("Build");
    const step = await workflowPage.selectStep("build");
    await step.type("Step ID", "_two");

    await workflowPage.undo();

    await workflowPage.expectSaved();
  });

  test("redoes an edit with the keys outside the code editor", async ({ halinka, page }) => {
    const { repo, server } = await halinka.startInRepo({ "build.yml": buildWorkflow });
    const reposPage = await new TestPortal(page, server).openRepos();
    const repoPage = await reposPage.openRepo(repo.name);
    const workflowPage = await repoPage.openWorkflow("Build");
    const step = await workflowPage.selectStep("build");
    await step.fill("Step ID", "compile");
    await workflowPage.undo();

    await workflowPage.redoWithKeys();

    await workflowPage.expectStep("compile");
  });

  test("undoes the edits of two Properties fields separately", async ({ halinka, page }) => {
    const { repo, server } = await halinka.startInRepo({ "build.yml": buildWorkflow });
    const reposPage = await new TestPortal(page, server).openRepos();
    const repoPage = await reposPage.openRepo(repo.name);
    const workflowPage = await repoPage.openWorkflow("Build");
    const step = await workflowPage.selectStep("build");
    await step.fill("Step ID", "compile");
    await step.fill("Command", "echo compile");

    await workflowPage.undo();

    await workflowPage.expectStep("compile");
  });

  test("undoes one edit with the keys in the code editor", async ({ halinka, page }) => {
    const { repo, server } = await halinka.startInRepo({ "build.yml": buildWorkflow });
    const reposPage = await new TestPortal(page, server).openRepos();
    const repoPage = await reposPage.openRepo(repo.name);
    const workflowPage = await repoPage.openWorkflow("Build");
    const step = await workflowPage.selectStep("build");
    await step.fill("Step ID", "compile");
    await workflowPage.typeInSource("x");

    await workflowPage.undoInSource();

    await workflowPage.expectUnsaved();
  });

  test("clears the undo history when the file changes", async ({ halinka, page }) => {
    const { repo, server } = await halinka.startInRepo({ "build.yml": buildWorkflow });
    const reposPage = await new TestPortal(page, server).openRepos();
    const repoPage = await reposPage.openRepo(repo.name);
    const workflowPage = await repoPage.openWorkflow("Build");
    const compileWorkflow = buildWorkflow.replace("id: build", "id: compile");
    await repo.writeFile(".halinka/workflows/build.yml", compileWorkflow);

    await workflowPage.returnToPage();

    await workflowPage.expectStep("compile");
    await workflowPage.expectNoUndo();
  });

  test("keeps the source shown when a person types after a discard", async ({ halinka, page }) => {
    const { repo, server } = await halinka.startInRepo({ "build.yml": buildWorkflow });
    const reposPage = await new TestPortal(page, server).openRepos();
    const repoPage = await reposPage.openRepo(repo.name);
    const workflowPage = await repoPage.openWorkflow("Build");
    await workflowPage.typeInSource("x");
    await workflowPage.showChanges();
    await workflowPage.discardDraft();

    await workflowPage.typeInSource("y");

    await workflowPage.expectSourceShown();
  });

  test("restores a draft after a reload", async ({ halinka, page }) => {
    const { repo, server } = await halinka.startInRepo({ "build.yml": buildWorkflow });
    const reposPage = await new TestPortal(page, server).openRepos();
    const repoPage = await reposPage.openRepo(repo.name);
    const workflowPage = await repoPage.openWorkflow("Build");
    const step = await workflowPage.selectStep("build");
    await step.fill("Step ID", "compile");

    await page.reload();

    await workflowPage.expectUnsaved();
  });

  test("keeps one draft of a workflow in two tabs", async ({ halinka, page, context }) => {
    const { repo, server } = await halinka.startInRepo({ "build.yml": buildWorkflow });
    const reposPage = await new TestPortal(page, server).openRepos();
    const repoPage = await reposPage.openRepo(repo.name);
    const workflowPage = await repoPage.openWorkflow("Build");
    const otherPage = await workflowPage.openInOtherTab(context);
    await otherPage.expectStep("build");

    const step = await workflowPage.selectStep("build");
    await step.fill("Step ID", "compile");
    await otherPage.expectStep("compile");
    const renamed = await workflowPage.selectStep("compile");
    await renamed.fill("Step ID", "compile_two");

    await otherPage.expectStep("compile_two");
    await workflowPage.expectStep("compile_two");
  });

  test("runs a workflow with a step that a person renamed", async ({ halinka, page }) => {
    const { repo, server } = await halinka.startInRepo({ "build.yml": buildWorkflow });
    const reposPage = await new TestPortal(page, server).openRepos();
    const repoPage = await reposPage.openRepo(repo.name);
    const workflowPage = await repoPage.openWorkflow("Build");

    const step = await workflowPage.selectStep("build");
    await step.fill("Step ID", "compile");
    await workflowPage.save();
    const runPage = await workflowPage.startRun();

    await runPage.expectStep("compile", "succeeded");
  });
});
