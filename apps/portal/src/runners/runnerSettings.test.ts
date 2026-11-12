import { describe, expect, it } from "vitest";

import { settingsOf, settingsValuesOf } from "./runnerSettings";

describe("runner settings", () => {
  it("reads labels that commas or spaces separate", () => {
    expect(settingsOf({ labels: " gpu, linux  arm64,", allowedAgents: null }).labels).toEqual([
      "gpu",
      "linux",
      "arm64",
    ]);
  });

  it("gives the labels of a runner as one text", () => {
    expect(settingsValuesOf({ labels: ["gpu", "linux"], allowedAgents: ["codex"] })).toEqual({
      labels: "gpu, linux",
      allowedAgents: ["codex"],
    });
  });
});
