import { expect } from "@playwright/test";

import { test } from "../utils";

const publicUrl = "https://halinka.example.com";

test.describe("halinka server with a login", () => {
  test("refuses the API without a login", async ({ halinka }) => {
    halinka.setLogin(publicUrl);
    const server = await halinka.startServer();

    expect((await fetch(`${server.url}/api/runners`)).status).toBe(401);

    await server.stop();
  });

  test("sends a login to GitHub with its client id", async ({ halinka }) => {
    halinka.setLogin(publicUrl);
    const server = await halinka.startServer();

    const answer = await server.post("/api/auth/sign-in/social", {
      provider: "github",
      callbackURL: "/",
    });

    const { url } = (await answer.json()) as { url: string };
    expect(new URL(url).host).toBe("github.com");
    expect(new URL(url).searchParams.get("client_id")).toBe("test-client");
    await server.stop();
  });

  test("names the missing values of a part of the config", async ({ halinka }) => {
    halinka.setEnv("HALINKA_PUBLIC_URL", publicUrl);

    const server = halinka.run(["server", "--port", "0"]);

    await server.expectOutput("Set also HALINKA_AUTH_SECRET");
    await server.expectExit(1);
  });

  test("halinka start has no login", async ({ halinka }) => {
    halinka.setLogin(publicUrl);
    const server = await halinka.start();

    expect((await fetch(`${server.url}/api/runners`)).status).toBe(200);

    await server.stop();
  });
});

test.describe("halinka server --host", () => {
  test("refuses another address without a login", async ({ halinka }) => {
    const server = halinka.run(["server", "--port", "0", "--host", "0.0.0.0"]);

    await server.expectOutput("listens on 0.0.0.0 only with a login");
    await server.expectExit(1);
  });

  test("listens on another address with a login", async ({ halinka }) => {
    halinka.setLogin(publicUrl);
    const process = halinka.run(["server", "--port", "0", "--host", "0.0.0.0"]);

    const url = await process.waitForUrl();

    expect((await fetch(`${url}/api/health`)).status).toBe(200);
    process.interrupt();
    await process.expectExit(0);
  });
});
