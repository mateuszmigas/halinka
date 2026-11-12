import type { ClaimedRun, SetupSecrets } from "@halinka/protocol";
import { leaseOf } from "@halinka/protocol/testing";
import { type Sandbox, maxStderrTailChars } from "@halinka/sandbox";
import { describe, expect, it } from "vitest";

import { lendSetupSecrets, runSetupCommand } from "./setupCommand";
import type { Located } from "./workspaces";

const run = {
  lease: leaseOf(1),
  setupRun: "npm ci",
  setupNetwork: ["registry.npmjs.org"],
} as Located<ClaimedRun>;

const token = { variable: "NPM_TOKEN", value: "npm_made_up_value" };

const noSecrets: SetupSecrets = { values: [], missing: [] };

const setUp = (exitCode = 0, stderr = "npm failed", isOnBaseFiles = true) => {
  const calls: { script?: string; options: unknown }[] = [];
  const sandbox = {
    exec: async (command: string[], options?: unknown) => {
      calls.push({ script: command[2], options });
      return { exitCode, stdout: "", stderr };
    },
  } as unknown as Sandbox;
  const marked = new Set<number>();
  const marks = {
    isSetUp: async (id: number) => marked.has(id),
    markSetUp: async (id: number) => {
      marked.add(id);
    },
    isOnBaseFiles: async () => isOnBaseFiles,
  };
  const start = (secrets = noSecrets, claimed = run) =>
    runSetupCommand(claimed, { secrets, sandbox, workspaces: marks }, new AbortController().signal);
  return { calls, marks, start };
};

const lend = async (claimed: Located<ClaimedRun>, secrets: SetupSecrets) => {
  const lent: string[] = [];
  const reads: unknown[] = [];
  const plane = {
    readSetupSecrets: async (lease: unknown) => {
      reads.push(lease);
      return secrets;
    },
  };
  const add = (_name: string, value: string) => void lent.push(value);
  const given = await lendSetupSecrets(claimed, plane, { add });
  return { lent, reads, given };
};

describe("setupCommand", () => {
  it("adds the setup secrets to the masks", async () => {
    const { lent } = await lend(run, { values: [token], missing: [] });

    expect(lent).toEqual([token.value]);
  });

  it("reads no secret for a run without a setup command", async () => {
    const { lease } = run;

    const { reads } = await lend({ lease } as Located<ClaimedRun>, {
      values: [token],
      missing: [],
    });

    expect(reads).toEqual([]);
  });

  it("gives the command the secrets", async () => {
    const { calls, start } = setUp();

    await start({ values: [token], missing: [] });

    expect(calls).toMatchObject([
      { script: "npm ci", options: { env: { NPM_TOKEN: token.value } } },
    ]);
  });

  it("gives the command the network of setup", async () => {
    const { calls, start } = setUp();

    await start();

    expect(calls).toMatchObject([{ options: { network: ["registry.npmjs.org"] } }]);
  });

  it("runs the setup command once per workspace", async () => {
    const { calls, start } = setUp();

    await start();
    await start();

    expect(calls).toHaveLength(1);
  });

  it("runs the setup command again after a failure", async () => {
    const { calls, start } = setUp(1);

    await expect(start()).rejects.toThrow("npm failed");
    await expect(start()).rejects.toThrow("npm failed");

    expect(calls).toHaveLength(2);
  });

  it("refuses to run the command when the workspace is not on the base files", async () => {
    const { calls, start } = setUp(0, "", false);

    await expect(start({ ...noSecrets }, { ...run, baseSha: "abc1234567" })).rejects.toThrow(
      "setup.run needs the base commit abc1234, but the workspace is at another commit. Remove the workspace of the run.",
    );
    expect(calls).toEqual([]);
  });

  it("names the error of the command", async () => {
    const { start } = setUp(1, "E401 Unauthorized");

    await expect(start()).rejects.toThrow("E401 Unauthorized");
  });

  it("leaves out the first line of a cut stderr, which can hold a part of a value", async () => {
    const cutValue = "npm_cut_value".padStart(maxStderrTailChars - 10, "x");
    const { start } = setUp(1, `${cutValue}\nnpm failed`);

    await expect(start()).rejects.toThrow(/exit code 1: npm failed$/);
  });

  it("leaves out a cut stderr with no line end", async () => {
    const { start } = setUp(1, "x".repeat(maxStderrTailChars));

    await expect(start()).rejects.toThrow(/exit code 1: $/);
  });

  it("runs nothing for a run without a command", async () => {
    const { calls, start } = setUp();
    const { lease } = run;

    await start(noSecrets, { lease } as Located<ClaimedRun>);

    expect(calls).toEqual([]);
  });

  it("refuses to run with a secret that the server cannot give", async () => {
    const { calls, start } = setUp();

    await expect(start({ values: [], missing: ["NPM_TOKEN"] })).rejects.toThrow("NPM_TOKEN");

    expect(calls).toEqual([]);
  });

  it("does not care about a missing secret when the workspace is set up", async () => {
    const { marks, calls, start } = setUp();
    await marks.markSetUp(1);

    await start({ values: [], missing: ["NPM_TOKEN"] });

    expect(calls).toEqual([]);
  });
});
