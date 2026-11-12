import { type BranchPush, conflict, type RunnerCommands } from "@halinka/protocol";
import { describe, expect, it } from "vitest";

import { LentValues } from "./lentValues";
import { maskingCommands } from "./maskingCommands";

const refusedPush = () => {
  const lent = new LentValues();
  lent.add("GITHUB_TOKEN", "gho-secret-1");
  const pushBranch = async () => {
    throw conflict("remote: https://x:gho-secret-1@github.com refused");
  };
  const commands = maskingCommands(
    { pushBranch } as Partial<RunnerCommands> as RunnerCommands,
    lent,
  );
  return commands.pushBranch({} as BranchPush);
};

describe("maskingCommands", () => {
  it("masks the lent values in the error of a command", async () => {
    await expect(refusedPush()).rejects.toMatchObject({
      message: "remote: https://x:***@github.com refused",
    });
  });

  it("keeps the code of a masked command error", async () => {
    await expect(refusedPush()).rejects.toMatchObject({ code: "conflict" });
  });

  it("masks the message of a command error that has no code", async () => {
    const lent = new LentValues();
    lent.add("GITHUB_TOKEN", "gho-secret-1");
    const pushBranch = async () => {
      throw new Error("fetch failed for gho-secret-1");
    };
    const commands = maskingCommands(
      { pushBranch } as Partial<RunnerCommands> as RunnerCommands,
      lent,
    );

    await expect(commands.pushBranch({} as BranchPush)).rejects.toThrow("fetch failed for ***");
  });
});
