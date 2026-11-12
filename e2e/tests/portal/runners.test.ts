import { test, TestPortal } from "../utils";

test.describe("runners", () => {
  test("keeps the labels that a person gives a runner", async ({ halinka, page }) => {
    const server = await halinka.start();
    const runner = await halinka.readLocalRunnerName();
    const portal = new TestPortal(page, server);
    const runnersPage = await portal.openRunners();

    await runnersPage.setLabels(runner, "gpu, linux");

    const reloaded = await portal.openRunners();
    await reloaded.expectLabels(runner, "gpu, linux");
  });

  test("shows a runner that connects, with no reload", async ({ halinka, page }) => {
    const server = await halinka.start();
    const runnersPage = await new TestPortal(page, server).openRunners();
    const { token } = await server.postJson<{ token: string }>("/api/runners/enrollment-tokens", {
      labels: [],
      allowedAgents: null,
    });

    const runner = await halinka.runRemoteRunner(server, "build-1", ["--enroll-stdin"]);
    runner.input(`${token}\n`);

    await runnersPage.expectStatus("build-1", "online");
  });

  test("approves a runner from the link that the CLI prints", async ({ halinka, page }) => {
    const server = await halinka.start();
    const runner = await halinka.runRemoteRunner(server, "build-1");
    const [link] = await runner.waitForMatch(/\S+\/runners\/approve\?code=\S+/);
    const runnersPage = await new TestPortal(page, server).openApproveLink(link);

    await runnersPage.approve("gpu-box");

    await runnersPage.expectStatus("gpu-box", "online");
  });
});
