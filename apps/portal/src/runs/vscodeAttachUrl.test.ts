import { describe, expect, it } from "vitest";

import { vscodeAttachUrl, vscodeSshUrl } from "./vscodeAttachUrl";

describe("vscodeAttachUrl", () => {
  it("gives the attach URI of the container and its workspace path", () => {
    const url = vscodeAttachUrl({
      containerName: "loving_borg",
      containerFolder: "/workspaces/run-1",
    });

    expect(url).toBe(
      "vscode://vscode-remote/attached-container+7b22636f6e7461696e65724e616d65223a222f6c6f76696e675f626f7267227d/workspaces/run-1",
    );
  });

  it("encodes the characters of the workspace path that a URI reserves", () => {
    const url = vscodeAttachUrl({ containerName: "app", containerFolder: "/work spaces/a#b?c%d" });

    expect(url.split("227d")[1]).toBe("/work%20spaces/a%23b%3Fc%25d");
  });

  it("gives the ssh URI of the host of the run in the ssh config, and its workspace path", () => {
    expect(vscodeSshUrl("https://halinka.example.com", 12, "/work spaces/run-12")).toBe(
      "vscode://vscode-remote/ssh-remote+halinka-halinka.example.com-12/work%20spaces/run-12",
    );
  });
});
