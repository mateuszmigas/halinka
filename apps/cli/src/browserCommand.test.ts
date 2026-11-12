import { describe, expect, it } from "vitest";

import { browserCommand } from "./browserCommand";

const url = "http://127.0.0.1:7070";

describe("browserCommand", () => {
  it.each([
    ["darwin", ["open", [url]]],
    ["linux", ["xdg-open", [url]]],
    ["win32", ["rundll32", ["url.dll,FileProtocolHandler", url]]],
  ] as const)("gives the command of %s", (platform, command) => {
    expect(browserCommand(platform, url)).toEqual(command);
  });
});
