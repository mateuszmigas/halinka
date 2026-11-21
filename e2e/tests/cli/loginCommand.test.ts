import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "@playwright/test";

import { test, type TestHalinka } from "../utils";

const token = "cli-token";

// A server that approves each login at once, and records the auth header of its other requests.
const startApprovingServer = async (halinka: TestHalinka) => {
  const headers: (string | undefined)[] = [];
  const url = await halinka.startFakeServer((request, response) => {
    const answers: Record<string, unknown> = {
      "/api/cli-logins": { deviceCode: "device", userCode: "ABCD-EFGH", expiresAt: new Date() },
      "/api/cli-logins/exchange": { status: "approved", token },
      "/api/cli-logins/logout": { id: 1 },
      "/api/session": {
        isLoginRequired: true,
        serverUrl: "",
        user: { login: "octo", role: "admin" },
      },
    };
    if (request.url === "/api/runners") headers.push(request.headers.authorization);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(answers[request.url ?? ""] ?? []));
  });
  return { url, headers };
};

const readLogins = async (halinka: TestHalinka) =>
  JSON.parse(await readFile(join(halinka.home, "logins.json"), "utf8")) as {
    tokens: Record<string, { token: string }>;
    current?: string;
  };

test.describe("halinka login", () => {
  test("keeps the token in a file that only the user can read", async ({ halinka }) => {
    const server = await startApprovingServer(halinka);

    const cli = await halinka.run(["login", "--server", server.url]).expectExit(0);

    await cli.expectOutput("Logged in to");
    expect((await readLogins(halinka)).tokens[server.url]?.token).toBe(token);
    expect((await stat(join(halinka.home, "logins.json"))).mode & 0o777).toBe(0o600);
  });

  test("sends the token to the server of the login", async ({ halinka }) => {
    const server = await startApprovingServer(halinka);
    await halinka.run(["login", "--server", server.url]).expectExit(0);
    const repo = await halinka.createRepo({ ".halinka/config.yml": "schema_version: 1\n" });
    await halinka.start().then((local) => local.stop());

    await halinka.run(["run", "build", "--repo", repo.path]).expectExit(1);

    expect(server.headers[0]).toBe(`Bearer ${token}`);
  });

  test("sends no token to another server", async ({ halinka }) => {
    const server = await startApprovingServer(halinka);
    const other = await startApprovingServer(halinka);
    await halinka.run(["login", "--server", server.url]).expectExit(0);
    const repo = await halinka.createRepo({
      ".halinka/config.yml": "schema_version: 1\n",
    });
    await halinka.start().then((local) => local.stop());

    await halinka.run(["run", "build", "--repo", repo.path, "--server", other.url]).expectExit(1);

    expect(other.headers[0]).toBeUndefined();
  });

  test("refuses http to another machine", async ({ halinka }) => {
    const cli = halinka.run(["login", "--server", "http://halinka.example.com"]);

    await cli.expectOutput("without TLS. Use an https URL.");
    await cli.expectExit(1);
  });
});

test.describe("halinka logout", () => {
  test("removes the token of this machine", async ({ halinka }) => {
    const server = await startApprovingServer(halinka);
    await halinka.run(["login", "--server", server.url]).expectExit(0);

    await halinka.run(["logout"]).expectExit(0);

    expect((await readLogins(halinka)).tokens).toEqual({});
  });

  test("keeps the selected server", async ({ halinka }) => {
    const server = await startApprovingServer(halinka);
    await halinka.run(["login", "--server", server.url]).expectExit(0);

    await halinka.run(["logout"]).expectExit(0);

    const cli = await halinka.run(["use"]).expectExit(0);
    await cli.expectOutput(`halinka use selects ${server.url} for the next commands.`);
  });

  test("refuses a server without a login", async ({ halinka }) => {
    const cli = halinka.run(["logout", "--server", "https://halinka.example.com"]);

    await cli.expectOutput("This machine has no login on https://halinka.example.com");
    await cli.expectExit(1);
  });

  test("refuses http to another machine", async ({ halinka }) => {
    const cli = halinka.run(["logout", "--server", "http://halinka.example.com"]);

    await cli.expectOutput("without TLS. Use an https URL.");
    await cli.expectExit(1);
  });
});

test.describe("halinka use", () => {
  test("names the login of a server that it selects without one", async ({ halinka }) => {
    const cli = halinka.run(["use", "https://halinka.example.com"]);

    await cli.expectOutput(
      "halinka use selects https://halinka.example.com. Log in first: halinka login --server https://halinka.example.com",
    );
    await cli.expectExit(0);
  });

  test("says that HALINKA_SERVER_URL has priority", async ({ halinka }) => {
    halinka.setServerUrl("https://halinka.example.com");

    const cli = await halinka.run(["use", "local"]).expectExit(0);

    await cli.expectOutput(
      "HALINKA_SERVER_URL selects https://halinka.example.com. It has priority over halinka use.",
    );
  });

  test("selects the server of this machine with local", async ({ halinka }) => {
    await halinka.run(["use", "https://halinka.example.com"]).expectExit(0);

    await halinka.run(["use", "local"]).expectExit(0);

    const cli = await halinka.run(["use"]).expectExit(0);
    await cli.expectOutput("The next commands use the server of this machine");
  });
});
