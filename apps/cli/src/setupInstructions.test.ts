import { agentPresets } from "@halinka/presets";
import { parseRepoConfig, parseWorkflow } from "@halinka/workflow";
import { describe, expect, it } from "vitest";

import { setupInstructions } from "./setupInstructions";

const [config = "", workflow = ""] = [...setupInstructions.matchAll(/```yaml\n(.*?)```/gs)].map(
  (block) => block[1],
);

describe("setupInstructions", () => {
  it("has a config example that the parser accepts", () => {
    expect(parseRepoConfig(config)).toMatchObject({ ok: true });
  });

  it("has a workflow example that the parser accepts", () => {
    expect(parseWorkflow(workflow, { agents: agentPresets })).toMatchObject({ ok: true });
  });
});
