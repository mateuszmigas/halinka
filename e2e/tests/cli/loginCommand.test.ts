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

test.describe("halinka login", () => {
  test("keeps the token in a file that only the user can read", async ({ halinka }) => {
    const server = await startApprovingServer(halinka);

    const cli = await halinka.run(["login", "--server", server.url]).expectExit(0);

    await cli.expectOutput("Logged in to");
    const file = join(halinka.home, "logins.json");
    expect(JSON.parse(await readFile(file, "utf8")).tokens[server.url].token).toBe(token);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  test("sends the token to the server of the login", async ({ halinka }) => {
    const server = await startApprovingServer(halinka);
    await halinka.run(["login", "--server", server.url]).expectExit(0);
    const repo = await halinka.createRepo({
      ".halinka/config.yml": `schema_version: 1\nserver: ${server.url}\n`,
    });
    await halinka.start().then((local) => local.stop());

    await halinka.run(["run", "build", "--repo", repo.path]).expectExit(1);

    expect(server.headers[0]).toBe(`Bearer ${token}`);
  });

  test("sends no token to another server", async ({ halinka }) => {
    const server = await startApprovingServer(halinka);
    const other = await startApprovingServer(halinka);
    await halinka.run(["login", "--server", server.url]).expectExit(0);
    const repo = await halinka.createRepo({
      ".halinka/config.yml": "schema_version: 1\nserver: local\n",
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

    const { tokens, current } = JSON.parse(
      await readFile(join(halinka.home, "logins.json"), "utf8"),
    ) as { tokens: object; current?: string };
    expect(tokens).toEqual({});
    expect(current).toBeUndefined();
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
  test("refuses a server without a login", async ({ halinka }) => {
    const cli = halinka.run(["use", "https://halinka.example.com"]);

    await cli.expectOutput("Log in first: halinka login --server https://halinka.example.com");
    await cli.expectExit(1);
  });
});

test.describe("a server that a repo selects", () => {
  test("gets nothing before a login", async ({ halinka }) => {
    const repo = await halinka.createRepo({
      ".halinka/config.yml": "schema_version: 1\nserver: https://halinka.example.com\n",
    });

    const cli = halinka.run(["run", "build", "--repo", repo.path]);

    await cli.expectOutput("selects the server https://halinka.example.com");
    await cli.expectExit(1);
  });

  test("gets nothing over http on another machine", async ({ halinka }) => {
    const repo = await halinka.createRepo({
      ".halinka/config.yml": "schema_version: 1\nserver: http://halinka.example.com\n",
    });

    const cli = halinka.run(["run", "build", "--repo", repo.path]);

    await cli.expectOutput("without TLS. Use an https URL.");
    await cli.expectExit(1);
  });
});
