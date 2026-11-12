import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { tempFolder } from "@halinka/utils/testing";
import { describe, expect, it, vi } from "vitest";

import { readRunnerPackage } from "../runnerPackage";
import {
  createLoginTestServer,
  createTestServer,
  repoPath,
  setUpTestDb,
  testApiUrl,
} from "../testing";
import { contract } from "./contract";

const testDb = setUpTestDb();

const postJson = (path: string, body: string) =>
  new Request(`${testApiUrl}/api${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });

const withPortal = async () => {
  const portalFolder = await tempFolder();
  await mkdir(join(portalFolder, "assets"));
  await writeFile(join(portalFolder, "index.html"), "<p>portal</p>");
  await writeFile(join(portalFolder, "assets", "app.js"), "app();");
  return createTestServer(testDb(), { portalFolder });
};

type Route = { method: string; path: string };

const routesOf = (node: object): Route[] =>
  "~orpc" in node
    ? [(node as { "~orpc": { route: Route } })["~orpc"].route]
    : Object.values(node).flatMap((child: object) => routesOf(child));

const publicRoutes = [
  "GET /health",
  "GET /session",
  "POST /cli-logins",
  "POST /cli-logins/exchange",
  "GET /runner/manifest",
  "POST /runner/probe",
  "POST /runner/status",
  "POST /runner/registrations",
  "POST /runner/enroll",
];

const isPublic = ({ method, path }: Route) => publicRoutes.includes(`${method} ${path}`);

const adminRoutes: Route[] = [
  { method: "PATCH", path: "/agents/codex" },
  { method: "PUT", path: "/agents/codex/credentials/OPENAI_API_KEY" },
  { method: "DELETE", path: "/agents/codex/credentials/OPENAI_API_KEY" },
  { method: "POST", path: "/agents/codex/tests" },
  { method: "GET", path: "/members" },
  { method: "POST", path: "/members" },
  { method: "DELETE", path: "/members/1" },
  { method: "POST", path: "/repos" },
  { method: "POST", path: "/repos/init" },
  { method: "PUT", path: "/repos/1/secrets/NPM_TOKEN" },
  { method: "DELETE", path: "/repos/1/secrets/NPM_TOKEN" },
  { method: "DELETE", path: "/repos/1" },
  { method: "PUT", path: "/repos/1/workflows/build" },
  { method: "PATCH", path: "/runners/1" },
  { method: "GET", path: "/runners/1/folders" },
  { method: "POST", path: "/runners/1/revoke" },
  { method: "POST", path: "/runners/enrollment-tokens" },
  { method: "GET", path: "/runners/requests/CODE" },
  { method: "POST", path: "/runners/requests/CODE/approve" },
];

const withLogin = async () => {
  const server = await createLoginTestServer(testDb());
  const send = ({ method, path }: Route, cookie = "") =>
    server.app.request(`${testApiUrl}/api${path.replaceAll(/{\w+}/g, "1")}`, {
      method,
      headers: { "content-type": "application/json", cookie },
      ...(method !== "GET" && { body: "{}" }),
    });
  return { ...server, send };
};

describe("HTTP API", () => {
  it("answers a plain JSON request at its REST path", async () => {
    const { app, runnerId } = await createTestServer(testDb());
    await app.fetch(postJson("/repos", JSON.stringify({ runnerId, path: repoPath })));

    const response = await app.fetch(
      postJson("/runs", JSON.stringify({ repoId: 1, workflow: "build" })),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: 1, status: "queued" });
  });

  it("accepts a write with JSON and a charset", async () => {
    const { app, runnerId } = await createTestServer(testDb());

    const response = await app.fetch(
      new Request(`${testApiUrl}/api/repos`, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ runnerId, path: repoPath }),
      }),
    );

    expect(response.status).toBe(200);
  });

  it("keeps the fields of GET /api/runner/manifest for each version", async () => {
    const { app } = await createTestServer(testDb());

    const response = await app.fetch(new Request(`${testApiUrl}/api/runner/manifest`));

    expect(Object.keys((await response.json()) as object).toSorted()).toEqual([
      "buildId",
      "protocolVersion",
      "version",
    ]);
  });

  it("serves the runner package of the server", async () => {
    const folder = await tempFolder();
    await writeFile(join(folder, "halinka.tgz"), "package bytes");
    const runnerPackage = await readRunnerPackage(join(folder, "halinka.tgz"));
    const { app } = await createTestServer(testDb(), { runnerPackage });

    const response = await app.fetch(new Request(`${testApiUrl}/api/runner/package`));

    expect(await response.text()).toBe("package bytes");
  });

  it("keeps the manifest out of caches", async () => {
    const { app } = await createTestServer(testDb());

    const response = await app.fetch(new Request(`${testApiUrl}/api/runner/manifest`));

    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("answers 404 for the runner package of a server that has none", async () => {
    const { app } = await createTestServer(testDb());

    const response = await app.fetch(new Request(`${testApiUrl}/api/runner/package`));

    expect(response.status).toBe(404);
  });

  it("accepts localhost at the server's port", async () => {
    const { app } = await createTestServer(testDb());

    const response = await app.fetch(new Request("http://localhost:7070/api/health"));

    expect(response.status).toBe(200);
  });

  it.each(["http://attacker.test:7070", "http://127.0.0.1:7071", "http://localhost"])(
    "refuses the host of %s",
    async (origin) => {
      const { app } = await createTestServer(testDb());

      const response = await app.fetch(new Request(`${origin}/api/health`));

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "FORBIDDEN" });
    },
  );

  it.each([undefined, "text/plain", "application/x-www-form-urlencoded"])(
    "refuses a write with the content type %s",
    async (contentType) => {
      const { app, runnerId } = await createTestServer(testDb());

      const response = await app.fetch(
        new Request(`${testApiUrl}/api/repos`, {
          method: "POST",
          headers: contentType ? { "content-type": contentType } : {},
          body: contentType && JSON.stringify({ runnerId, path: repoPath }),
        }),
      );

      expect(response.status).toBe(415);
      expect(await response.json()).toMatchObject({ code: "UNSUPPORTED_MEDIA_TYPE" });
      const repos = await app.fetch(new Request(`${testApiUrl}/api/repos`));
      expect(await repos.json()).toEqual([]);
    },
  );

  it("answers an unknown route with the error body", async () => {
    const { app } = await createTestServer(testDb());
    const response = await app.fetch(new Request(`${testApiUrl}/api/nothing`));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      code: "NOT_FOUND",
      message: "There is no GET /api/nothing",
    });
  });

  it("answers an unexpected error with 500 and logs it once", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { app, runnerId, commands } = await createTestServer(testDb());
    const boom = new Error("boom");
    commands.readRepo.mockRejectedValueOnce(boom);

    const response = await app.fetch(
      postJson("/repos", JSON.stringify({ runnerId, path: repoPath })),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "Internal server error",
    });
    expect(log).toHaveBeenCalledExactlyOnceWith(boom);
  });

  it("answers an error of a route outside the contract with 500 and logs it", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { app } = await createTestServer(testDb());
    const boom = new Error("boom");
    app.get("/api/webhook", () => {
      throw boom;
    });

    const response = await app.fetch(new Request(`${testApiUrl}/api/webhook`));

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(log).toHaveBeenCalledExactlyOnceWith(boom);
  });

  it("serves a file of the portal", async () => {
    const { app } = await withPortal();

    const response = await app.fetch(new Request(`${testApiUrl}/assets/app.js`));

    expect(await response.text()).toBe("app();");
  });

  it("serves the index of the portal for a client route", async () => {
    const { app } = await withPortal();

    const response = await app.fetch(new Request(`${testApiUrl}/runs/1`));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<p>portal</p>");
  });

  it.each(["/", "/runs/1"])(
    "tells a browser to check the portal index of %s again",
    async (path) => {
      const { app } = await withPortal();

      const response = await app.fetch(new Request(`${testApiUrl}${path}`));

      expect(response.headers.get("cache-control")).toBe("no-cache");
    },
  );

  it.each(["/cli-login?code=ABCD", "/api/session"])(
    "tells a browser not to show %s in a frame",
    async (path) => {
      const { app } = await withPortal();

      const response = await app.fetch(new Request(`${testApiUrl}${path}`));

      expect({
        csp: response.headers.get("content-security-policy"),
        frameOptions: response.headers.get("x-frame-options"),
      }).toEqual({ csp: "frame-ancestors 'none'", frameOptions: "DENY" });
    },
  );

  it("lets a browser keep a hashed file of the portal", async () => {
    const { app } = await withPortal();

    const response = await app.fetch(new Request(`${testApiUrl}/assets/app.js`));

    expect(response.headers.get("cache-control")).toBeNull();
  });

  it("answers an unknown API route with the error body, not the portal", async () => {
    const { app } = await withPortal();

    const response = await app.fetch(new Request(`${testApiUrl}/api/nothing`));

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "NOT_FOUND" });
  });

  it.each(routesOf(contract).filter((route) => !isPublic(route)))(
    "refuses $method $path without a login",
    async (route) => {
      const { send } = await withLogin();

      expect((await send(route)).status).toBe(401);
    },
  );

  it.each(routesOf(contract).filter(isPublic))(
    "answers $method $path without a login",
    async (route) => {
      const { send } = await withLogin();

      expect((await send(route)).status).not.toBe(401);
    },
  );

  it.each(adminRoutes)("refuses $method $path to a Member", async (route) => {
    const { send, memberCookie } = await withLogin();

    expect((await send(route, await memberCookie())).status).toBe(403);
  });
});
