import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, readlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { listenForTest } from "@halinka/runner/testing";
import { tempFolder } from "@halinka/utils/testing";
import { describe, expect, it } from "vitest";

import {
  canTryBuild,
  deleteOtherVersions,
  installServerPackage,
  recordUpdateFailure,
  type ServerPackage,
  switchCurrent,
} from "./runnerVersions";

const run = promisify(execFile);

const buildId = "a".repeat(64);

const packedPackage = async (packedBuildId = buildId) => {
  const folder = await tempFolder();
  await mkdir(join(folder, "package", "dist"), { recursive: true });
  await writeFile(join(folder, "package", "package.json"), '{"name":"halinka","version":"0.0.1"}');
  await writeFile(
    join(folder, "package", "dist", "build.json"),
    JSON.stringify({ id: packedBuildId }),
  );
  await run("tar", ["-czf", "halinka.tgz", "package"], { cwd: folder });
  return readFile(join(folder, "halinka.tgz"));
};

const manifestOf = (bytes: Buffer): ServerPackage => ({
  version: "0.0.1",
  buildId,
  sha512: createHash("sha512").update(bytes).digest("hex"),
  size: bytes.length,
});

const serve = async (bytes: Buffer) => {
  let requests = 0;
  const server = await listenForTest((_, response) => {
    requests++;
    response.end(bytes);
  });
  return { server, requests: () => requests };
};

const setUp = async (bytes: Buffer) => ({
  ...(await serve(bytes)),
  expected: manifestOf(bytes),
  home: await tempFolder(),
});

const versionsOf = async (home: string) =>
  (await readdir(join(home, "versions"))).filter((name) => !name.startsWith("."));

describe("runnerVersions", () => {
  it("installs the package of the server into a folder of its version and build", async () => {
    const { server, expected, home } = await setUp(await packedPackage());

    const name = await installServerPackage(server, home, expected);

    expect(
      await readFile(join(home, "versions", name, "node_modules/halinka/dist/build.json"), "utf8"),
    ).toContain(buildId);
  });

  it("keeps an installed folder of the same build", async () => {
    const { server, expected, home, requests } = await setUp(await packedPackage());
    await installServerPackage(server, home, expected);

    await installServerPackage(server, home, expected);

    expect(requests()).toBe(1);
  });

  it("installs no package whose build id is not the build id of the manifest", async () => {
    const { server, expected, home } = await setUp(await packedPackage("b".repeat(64)));

    await expect(installServerPackage(server, home, expected)).rejects.toThrow("build id");
    expect(await versionsOf(home)).toEqual([]);
  });

  it("installs no package whose sha512 is not the sha512 of the manifest", async () => {
    const { server, expected, home } = await setUp(await packedPackage());

    await expect(installServerPackage(server, home, { ...expected, sha512: "0" })).rejects.toThrow(
      "sha512",
    );
  });

  it("refuses a version that holds a path", async () => {
    const { server, expected, home } = await setUp(await packedPackage());

    await expect(
      installServerPackage(server, home, { ...expected, version: "../../x" }),
    ).rejects.toThrow("cannot name a folder");
  });

  it("stops a download that is larger than the manifest says", async () => {
    const { server, expected, home } = await setUp(await packedPackage());

    await expect(installServerPackage(server, home, { ...expected, size: 10 })).rejects.toThrow(
      "larger",
    );
  });

  it("does not follow a redirect of the package to another server", async () => {
    const bytes = await packedPackage();
    const other = await serve(bytes);
    const server = await listenForTest((_, response) => {
      response.writeHead(302, { location: `${other.server}/api/runner/package` }).end();
    });

    await installServerPackage(server, await tempFolder(), manifestOf(bytes)).catch(() => {});

    expect(other.requests()).toBe(0);
  });

  it("refuses a third try of a build that failed twice", async () => {
    const home = await tempFolder();
    await mkdir(join(home, "versions"));
    await recordUpdateFailure(home, buildId);

    await recordUpdateFailure(home, buildId);

    expect(await canTryBuild(home, buildId)).toBe(false);
  });

  it("counts again from one after a failure of another build", async () => {
    const home = await tempFolder();
    await mkdir(join(home, "versions"));
    await recordUpdateFailure(home, buildId);
    await recordUpdateFailure(home, buildId);

    await recordUpdateFailure(home, "b".repeat(64));

    expect(await canTryBuild(home, "b".repeat(64))).toBe(true);
  });

  it("deletes each version but the kept ones and old stage folders", async () => {
    const home = await tempFolder();
    for (const name of ["0.0.1-old", "0.0.2-previous", "0.0.3-new", ".stage-x"]) {
      await mkdir(join(home, "versions", name), { recursive: true });
    }
    const hoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(join(home, "versions", ".stage-x"), hoursAgo, hoursAgo);
    await recordUpdateFailure(home, buildId);
    await switchCurrent(home, "0.0.3-new");

    await deleteOtherVersions(home, ["0.0.3-new", "0.0.2-previous"]);

    expect((await readdir(join(home, "versions"))).toSorted()).toEqual([
      "0.0.2-previous",
      "0.0.3-new",
      "current",
      "update-failures.json",
    ]);
  });

  it("keeps a young stage folder of another install", async () => {
    const home = await tempFolder();
    await mkdir(join(home, "versions", ".stage-y"), { recursive: true });

    await deleteOtherVersions(home, []);

    expect(await readdir(join(home, "versions"))).toEqual([".stage-y"]);
  });

  it("replaces the current version", async () => {
    const home = await tempFolder();
    await mkdir(join(home, "versions"));
    await switchCurrent(home, "0.0.1-aaaaaaaaaaaa");

    await switchCurrent(home, "0.0.2-bbbbbbbbbbbb");

    expect(await readlink(join(home, "versions", "current"))).toBe("0.0.2-bbbbbbbbbbbb");
  });
});
