import { describe, expect, it } from "vitest";

import { remoteUserOf } from "./containerProcesses";

describe("remoteUserOf", () => {
  it("takes the last remote user of the metadata", () => {
    const label = JSON.stringify([{ remoteUser: "first" }, {}, { remoteUser: "last" }]);

    expect(remoteUserOf(label, "image")).toBe("last");
  });

  it("takes the container user when no entry has a remote user", () => {
    expect(remoteUserOf(JSON.stringify([{ containerUser: "app" }]), "image")).toBe("app");
  });

  it("takes the user of the image without its group", () => {
    expect(remoteUserOf(JSON.stringify({}), "node:staff")).toBe("node");
  });

  it("takes root for an image without a user", () => {
    expect(remoteUserOf(null, "")).toBe("root");
  });

  it("refuses the agent user", () => {
    const label = JSON.stringify([{ remoteUser: "halinka-agent" }]);

    expect(() => remoteUserOf(label, "")).toThrow("is the agent user");
  });
});
