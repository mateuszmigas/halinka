import { describe, expect, it } from "vitest";

import { output } from "./docker";

describe("output", () => {
  it("gives the input to the command", async () => {
    const result = await output("cat", [], { input: "policy" });

    expect(result.stdout).toBe("policy");
  });

  it("resolves when the command exits before it reads its input", async () => {
    const result = await output("sh", ["-c", "exit 3"], { input: "x".repeat(1 << 20) });

    expect(result.exitCode).toBe(3);
  });

  it("rejects with an error that is not an AbortError at the time limit", async () => {
    const result = output("sleep", ["5"], { timeoutMs: 100 });

    await expect(result).rejects.toThrow(
      expect.objectContaining({
        name: "Error",
        message: "The sandbox did not end `sleep` in 0.1 s",
      }),
    );
  });
});
