import { readdirSync, readFileSync } from "node:fs";

import { agentPresets } from "@halinka/presets";
import { parseWorkflow } from "@halinka/workflow";
import { describe, expect, it } from "vitest";

const examples = new URL("../../../docs/examples/", import.meta.url);

describe("docs/examples", () => {
  it.each(readdirSync(examples))("has a workflow %s that the parser accepts", (file) => {
    const source = readFileSync(new URL(file, examples), "utf8");
    expect(parseWorkflow(source, { agents: agentPresets })).toMatchObject({ ok: true });
  });
});
