import { execFileSync } from "node:child_process";
import { join } from "node:path";

import type { ClaimedRun } from "@halinka/protocol";
import { pathExists } from "@halinka/utils/fs";
import { tempFolder } from "@halinka/utils/testing";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { ContainerRuns } from "./containerRuns";
import { Containers } from "./containers";
import { Credentials } from "./credentials";
import { claimedRun, commitAll, createRepo, fakePlane, writeDefinition } from "./testing";
import { type Located, Workspaces } from "./workspaces";

const agentTest = { token: "token-1", preset: "claude-code" };

const containersOf = (name: string) =>
  execFileSync("docker", ["ps", "-aq", "--filter", `label=halinka.sandbox=${name}`], {
    encoding: "utf8",
  }).trim();

const setUp = async () => {
  const folder = await tempFolder();
  const workspaces = new Workspaces(folder);
  const containers = await Containers.create(folder, workspaces);
  const credentials = new Credentials({});
  const testFolder = join(folder, "agent-test");
  const runs = new ContainerRuns({
    containers,
    workspaces,
    credentials,
    codexLogins: { readForStart: async () => {} },
    lent: credentials.lent,
    planeOf: () => fakePlane({ readTestCredentials: async () => [] }),
    testFolder,
  });
  return { containers, runs, testFolder };
};

const runThatFailsAtUp = async () => {
  const repoPath = await createRepo();
  const config = JSON.stringify({ image: "halinka-missing.invalid/none:1" });
  await writeDefinition(repoPath, ".devcontainer/devcontainer.json", config);
  const baseSha = await commitAll(repoPath, "devcontainer");
  return claimedRun(1, {
    repoPath,
    baseSha,
    definitionSha: baseSha,
    sandboxKind: "devcontainer",
    devcontainer: ".devcontainer/devcontainer.json",
    lastCheckpoint: baseSha,
  }) as Located<ClaimedRun>;
};

const startLabelledContainer = (name: string) => {
  const label = `halinka.sandbox=${name}`;
  const id = execFileSync(
    "docker",
    ["run", "--detach", "--label", label, "alpine:3.22", "sleep", "600"],
    {
      encoding: "utf8",
    },
  ).trim();
  onTestFinished(() => void execFileSync("docker", ["rm", "--force", id], { stdio: "ignore" }));
};

const abortedTest = async () => {
  const set = await setUp();
  const controller = new AbortController();
  const tested = set.runs.test(agentTest, controller.signal);
  await vi.waitFor(() => expect(containersOf(set.containers.testName)).not.toBe(""), {
    timeout: 120_000,
    interval: 500,
  });
  controller.abort();
  return { ...set, tested };
};

describe("ContainerRuns", { timeout: 180_000 }, () => {
  it("stops an agent test at an abort", async () => {
    const { tested } = await abortedTest();

    await expect(tested).rejects.toMatchObject({ name: "AbortError" });
  });

  it("removes the container and the folder of an agent test at an abort", async () => {
    const { containers, testFolder, tested } = await abortedTest();

    await tested.catch(() => {});

    expect(containersOf(containers.testName)).toBe("");
    expect(await pathExists(testFolder)).toBe(false);
  });

  it("removes the container of a run whose clone is gone", async () => {
    const { containers, runs } = await setUp();
    const run = await runThatFailsAtUp();
    const name = containers.nameOf(1);
    startLabelledContainer(name);
    const plane = fakePlane({ branchCreated: async () => {} });

    await runs.prepare(run, plane, new AbortController().signal).catch(() => {});

    expect(containersOf(name)).toBe("");
  });

  it("removes a test container that has no test folder", async () => {
    const { containers, runs } = await setUp();
    startLabelledContainer(containers.testName);

    await runs.deleteTest();

    expect(containersOf(containers.testName)).toBe("");
  });
});
