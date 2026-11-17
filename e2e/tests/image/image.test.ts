import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";

const run = promisify(execFile);

const repoRoot = join(import.meta.dirname, "../../..");

const login = {
  HALINKA_PUBLIC_URL: "http://localhost:7070",
  HALINKA_AUTH_SECRET: "s".repeat(32),
  HALINKA_MASTER_KEY: randomBytes(32).toString("base64"),
  HALINKA_GITHUB_CLIENT_ID: "test-client",
  HALINKA_GITHUB_CLIENT_SECRET: "test-secret",
  HALINKA_ADMIN_GITHUB: "octo",
};

const expectHealthy = async (address: string) => {
  await expect
    .poll(
      () =>
        fetch(`http://${address}/api/health`).then(
          ({ status }) => status,
          () => 0,
        ),
      { timeout: 90_000 },
    )
    .toBe(200);
};

test.describe.configure({ mode: "serial", timeout: 900_000 });

test.describe("the image", () => {
  const id = randomUUID();
  const image = `halinka-test:${id}`;
  const container = `halinka-test-${id}`;

  test.afterAll(async () => {
    await run("docker", ["rm", "--force", "--volumes", container]).catch(() => {});
    await run("docker", ["rmi", image]).catch(() => {});
  });

  const readAddress = async () =>
    (await run("docker", ["port", container, "7070/tcp"])).stdout.trim().split("\n")[0]!;

  test("restarts after a hard kill", async () => {
    await run("docker", ["build", "--file", "infrastructure/Dockerfile", "--tag", image, "."], {
      cwd: repoRoot,
      maxBuffer: 2 ** 28,
    });
    const env = Object.entries(login).flatMap(([name, value]) => ["--env", `${name}=${value}`]);
    await run("docker", [
      "run",
      "--detach",
      "--name",
      container,
      "--publish",
      "127.0.0.1::7070",
      ...env,
      image,
    ]);
    await expectHealthy(await readAddress());

    await run("docker", ["kill", container]);
    await run("docker", ["start", container]);

    await expectHealthy(await readAddress());
  });
});

test.describe("the compose file", () => {
  const project = `halinka-test-${randomUUID()}`;
  const compose = (...args: string[]) =>
    run("docker", ["compose", "--project-name", project, ...args], {
      cwd: join(repoRoot, "infrastructure"),
      maxBuffer: 2 ** 28,
      env: {
        ...process.env,
        ...login,
        POSTGRES_PASSWORD: "test",
        HALINKA_TRUSTED_PROXY: "172.30.0.1",
        HALINKA_PORT: "0",
      },
    });

  test.afterAll(async () => {
    await compose("down", "--volumes").catch(() => {});
    await run("docker", ["rmi", "halinka:source"]).catch(() => {});
  });

  test("serves the portal from a server on Postgres", async () => {
    await compose("up", "--detach", "--wait");

    const { stdout } = await compose("port", "server", "7070");
    const address = stdout.trim();
    await expectHealthy(address);

    const portal = await fetch(`http://${address}/`);
    expect(portal.headers.get("content-type")).toContain("text/html");
  });

  test("does not limit a few sign-ins of one server to three", async () => {
    const { stdout } = await compose("port", "server", "7070");
    const signIn = () =>
      fetch(`http://${stdout.trim()}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: login.HALINKA_PUBLIC_URL },
        body: JSON.stringify({ provider: "github", callbackURL: "/" }),
      });

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 5; attempt++) statuses.push((await signIn()).status);

    expect(statuses).toEqual([200, 200, 200, 200, 200]);
  });

  test("keeps the build from source on a pull", async () => {
    const readImageId = async () =>
      (
        await run("docker", ["image", "inspect", "--format", "{{.Id}}", "halinka:source"])
      ).stdout.trim();
    const builtId = await readImageId();

    await compose("pull", "server");

    expect(await readImageId()).toBe(builtId);
  });
});
