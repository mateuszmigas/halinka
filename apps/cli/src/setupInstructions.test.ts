import { agentPresets } from "@halinka/presets";
import { parseRepoConfig, parseWorkflow } from "@halinka/workflow";
import { describe, expect, it } from "vitest";

import { setupInstructions } from "./setupInstructions";

const [config = "", ...workflows] = [...setupInstructions.matchAll(/```yaml\n(.*?)```/gs)].map(
  (block) => block[1] ?? "",
);

describe("setupInstructions", () => {
  it("has a config example that the parser accepts", () => {
    expect(parseRepoConfig(config)).toMatchObject({ ok: true });
  });

  it.each(workflows.map((workflow, index) => [index + 1, workflow]))(
    "has a workflow example %i that the parser accepts",
    (_, workflow) => {
      expect(parseWorkflow(workflow, { agents: agentPresets })).toMatchObject({ ok: true });
    },
  );
});
