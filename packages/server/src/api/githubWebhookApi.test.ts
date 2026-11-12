import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { gitHubApps, gitHubDeliveries } from "../db/schema";
import { appSecretPlace } from "../secrets";
import {
  connectApp,
  createLoginTestServer,
  createTestServer,
  defaultBody,
  type Delivery,
  deliveryRequest,
  FakeGitHub,
  installationOf,
  repoOf,
  setUpTestDb,
  signatureOf,
  testCipher,
} from "../testing";

const testDb = setUpTestDb();

const deliveries = () => testDb().select().from(gitHubDeliveries);

const leftUnfinishedMinutesAgo = (minutes: number) =>
  testDb()
    .update(gitHubDeliveries)
    .set({ result: null, startedAt: sql`now() - make_interval(mins => ${minutes})` });

const setUp = async (gitHub = new FakeGitHub()) => {
  const server = await createTestServer(testDb());
  await connectApp(server.api, gitHub, []);
  const deliver = async (delivery?: Delivery) => {
    const response = await server.app.fetch(deliveryRequest(delivery));
    await server.services.gitHubDelivery.idle();
    return response;
  };
  const installationReads = () => gitHub.readsOf("/app/installations").length;
  return { ...server, gitHub, deliver, installationReads };
};

const installation = { event: "installation" };

const refuseReads = (gitHub: FakeGitHub) => {
  gitHub.refuseWith = Response.json({ message: "Down" }, { status: 500 });
};

describe("POST /api/github/webhook", () => {
  it("answers 404 with no App", async () => {
    const { app } = await createTestServer(testDb());

    expect((await app.fetch(deliveryRequest())).status).toBe(404);
  });

  it("answers 404 for an App without a webhook", async () => {
    const gitHub = new FakeGitHub();
    gitHub.webhookSecret = null;
    const { deliver } = await setUp(gitHub);

    expect((await deliver()).status).toBe(404);
  });

  it("answers 404 when the server cannot open the secret", async () => {
    const { deliver } = await setUp();
    await testDb().update(gitHubApps).set({ sealedWebhookSecret: "other" });

    expect((await deliver()).status).toBe(404);
  });

  it.each([
    ["another secret", signatureOf(defaultBody, "other")],
    ["other bytes", signatureOf("{ }")],
    ["no prefix", signatureOf(defaultBody).replace("sha256=", "")],
    ["no signature", ""],
  ])("refuses a delivery with %s and stores nothing", async (_name, signature) => {
    const { deliver } = await setUp();

    expect((await deliver({ signature })).status).toBe(401);
    expect(await deliveries()).toEqual([]);
  });

  it.each([
    ["id", { id: "" }],
    ["event", { event: "" }],
  ])("refuses a signed delivery with no %s", async (_name, delivery) => {
    const { deliver } = await setUp();

    expect((await deliver(delivery)).status).toBe(400);
    expect(await deliveries()).toEqual([]);
  });

  it("refuses a signed body that is not JSON", async () => {
    const { deliver } = await setUp();

    expect((await deliver({ body: "not json" })).status).toBe(400);
    expect(await deliveries()).toEqual([]);
  });

  it("refuses a body over the limit of GitHub", async () => {
    const { deliver } = await setUp();

    const response = await deliver({ body: Buffer.alloc(25 * 1024 * 1024 + 1) });

    expect(response.status).toBe(413);
  });

  it("takes a delivery with a login and with any content type", async () => {
    const server = await createLoginTestServer(testDb());
    await connectApp(await server.adminApi(), new FakeGitHub(), []);
    const request = deliveryRequest();
    request.headers.set("content-type", "text/plain");

    const response = await server.app.fetch(request);
    await server.services.gitHubDelivery.idle();

    expect(response.status).toBe(202);
  });

  it("answers before the work ends", async () => {
    const { app, services, gitHub } = await setUp();
    const release = Promise.withResolvers<void>();
    gitHub.duringFirstRead = () => release.promise;

    const response = await app.fetch(deliveryRequest(installation));

    expect(response.status).toBe(202);
    expect(await deliveries()).toMatchObject([{ result: null }]);
    release.resolve();
    await services.gitHubDelivery.idle();
  });

  it.each(["installation", "installation_repositories"])(
    "stores the installations again on %s",
    async (event) => {
      const { api, deliver, gitHub } = await setUp();
      gitHub.installations = [installationOf(1, [repoOf(10, "app")])];

      await deliver({ event });

      const { installations } = await api.github.status();
      expect(installations).toMatchObject([{ githubId: 1, repos: [{ githubId: 10 }] }]);
    },
  );

  it("records the result of a read of the installations", async () => {
    const { deliver } = await setUp();

    await deliver(installation);

    expect(await deliveries()).toMatchObject([
      {
        deliveryId: "delivery-1",
        event: "installation",
        result: "The server read the installations.",
      },
    ]);
  });

  it("reads nothing from GitHub for another event", async () => {
    const { deliver, installationReads } = await setUp();
    const reads = installationReads();

    await deliver({ event: "ping" });

    expect(installationReads()).toBe(reads);
  });

  it("records another event", async () => {
    const { deliver } = await setUp();

    await deliver({ event: "ping" });

    expect(await deliveries()).toMatchObject([
      { event: "ping", result: "The server does not use this event." },
    ]);
  });

  it("records the message of a refusal of GitHub", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deliver, gitHub } = await setUp();
    refuseReads(gitHub);

    await deliver(installation);

    expect(await deliveries()).toMatchObject([{ result: "GitHub answered 500: Down" }]);
    expect(error).toHaveBeenCalledOnce();
  });

  it("logs a refusal of GitHub", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deliver, gitHub } = await setUp();
    refuseReads(gitHub);

    await deliver(installation);

    expect(error).toHaveBeenCalledOnce();
  });

  it("records no message of an unexpected error", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deliver } = await setUp();
    await testDb()
      .update(gitHubApps)
      .set({ sealedPrivateKey: testCipher.seal(appSecretPlace(77, "private-key"), "not a key") });

    await deliver(installation);

    expect(await deliveries()).toMatchObject([{ result: "The work failed. See the server log." }]);
    expect(error).toHaveBeenCalledOnce();
  });
  it("does nothing for a repeated id after the work finished", async () => {
    const { deliver, installationReads } = await setUp();
    await deliver(installation);
    await testDb()
      .update(gitHubDeliveries)
      .set({ startedAt: sql`now() - make_interval(hours => 1)` });
    const reads = installationReads();

    await deliver(installation);

    expect(installationReads()).toBe(reads);
  });

  it("answers a repeated id as a new delivery", async () => {
    const { deliver } = await setUp();
    await deliver(installation);

    expect((await deliver(installation)).status).toBe(202);
  });

  it("does nothing for a repeated id while the work is new", async () => {
    const { deliver, installationReads } = await setUp();
    await deliver(installation);
    await leftUnfinishedMinutesAgo(9);
    const reads = installationReads();

    await deliver(installation);

    expect(installationReads()).toBe(reads);
  });

  it("does the work of a repeated id again after a crash left the row with no result", async () => {
    const { deliver, installationReads } = await setUp();
    await deliver(installation);
    await leftUnfinishedMinutesAgo(11);
    const reads = installationReads();

    await deliver(installation);

    expect(installationReads()).toBe(reads + 1);
  });

  it("records the result of the repeated work", async () => {
    const { deliver } = await setUp();
    await deliver(installation);
    await leftUnfinishedMinutesAgo(11);

    await deliver(installation);

    expect(await deliveries()).toMatchObject([{ result: "The server read the installations." }]);
  });

  it("does not start the same work twice at one time", async () => {
    const { deliver, installationReads } = await setUp();
    await deliver(installation);
    await leftUnfinishedMinutesAgo(11);
    const reads = installationReads();

    await Promise.all([deliver(installation), deliver(installation)]);

    expect(installationReads()).toBe(reads + 1);
  });
});
