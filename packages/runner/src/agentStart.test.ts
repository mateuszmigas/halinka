import { agentPresets } from "@halinka/presets";
import type { ClaimedRun } from "@halinka/protocol";
import { conflict } from "@halinka/protocol";
import { describe, expect, it, vi } from "vitest";

import { agentPackagesOf, containerAgentStart } from "./agentStart";
import { Credentials } from "./credentials";

const setUp = (values: { variable: string; value: string }[], env = {}) => {
  const scope = new Credentials(env).newScope();
  const readForStart = vi.fn(async () => {});
  const readStored = vi.fn(async (_preset: string) => values);
  const start = containerAgentStart({ scope, codexLogins: { readForStart }, readStored });
  return { scope, readForStart, readStored, start };
};

const openAiKey = { variable: "OPENAI_API_KEY", value: "sk-stored-value" };

const runOf = (agentVersions: Record<string, string>) =>
  ({
    agentVersions,
    workflow: {
      name: "Test",
      steps: [{ id: "a", type: "agent", agent: "codex", prompt: "Fix it" }],
    },
  }) as unknown as ClaimedRun;

describe("agentStart", () => {
  it("reads the stored values at each start", async () => {
    const { readStored, start } = setUp([openAiKey]);

    await start(agentPresets.codex);
    await start(agentPresets.codex);

    expect(readStored).toHaveBeenCalledTimes(2);
    expect(readStored).toHaveBeenCalledWith("codex");
  });

  it("gives the proxy of the scope the stored value", async () => {
    const { scope, start } = setUp([openAiKey]);

    await start(agentPresets.codex);

    expect(scope.forProxy().OPENAI_API_KEY?.value).toBe("Bearer sk-stored-value");
  });

  it("does not read a login when a stored value replaces it", async () => {
    const { readForStart, start } = setUp([openAiKey]);

    await start(agentPresets.codex);

    expect(readForStart).not.toHaveBeenCalled();
  });

  it("reads the login without a stored value", async () => {
    const { readForStart, start } = setUp([]);

    await start(agentPresets.codex);

    expect(readForStart).toHaveBeenCalledOnce();
  });

  it("fails when the server refuses the read", async () => {
    const { readStored, start } = setUp([], { OPENAI_API_KEY: "sk-runner-value" });
    readStored.mockRejectedValue(conflict("Enter the value again"));

    await expect(start(agentPresets.codex)).rejects.toThrow("Enter the value again");
  });

  it("does not launch with a value of the runner when the server refuses the read", async () => {
    const { scope, readStored, start } = setUp([], { OPENAI_API_KEY: "sk-runner-value" });
    readStored.mockRejectedValue(conflict("Enter the value again"));
    const launch = vi.spyOn(scope, "launch");

    await start(agentPresets.codex).catch(() => {});

    expect(launch).not.toHaveBeenCalled();
  });

  it("installs the version of the preset", () => {
    expect(agentPackagesOf(runOf({}))).toEqual([
      {
        command: "codex-acp",
        package: agentPresets.codex.package + `@${agentPresets.codex.version}`,
      },
    ]);
  });

  it("installs the version that an Admin selected", () => {
    expect(agentPackagesOf(runOf({ codex: "1.2.3" }))).toEqual([
      { command: "codex-acp", package: `${agentPresets.codex.package}@1.2.3` },
    ]);
  });
});
