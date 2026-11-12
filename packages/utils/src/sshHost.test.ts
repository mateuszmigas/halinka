import { describe, expect, it } from "vitest";

import { parseSshHostWorkflowRunId, sshHostOf, sshHostPattern } from "./sshHost";

describe("sshHost", () => {
  it.each(["https://halinka.example.com", "http://localhost:7070", "http://[::1]:7070"])(
    "reads the run from the host name of %s",
    (server) => {
      expect(parseSshHostWorkflowRunId(sshHostOf(server, 12), server)).toBe(12);
    },
  );

  it("names a server without a port", () => {
    expect(sshHostOf("https://halinka.example.com", 12)).toBe("halinka-halinka.example.com-12");
  });

  it("puts the port of a server in the name without a colon", () => {
    expect(sshHostPattern("http://localhost:7070")).toBe("halinka-localhost-7070-*");
  });

  it("makes a name without brackets for an IPv6 server", () => {
    expect(sshHostOf("http://[::1]:7070", 12)).toMatch(/^[a-zA-Z0-9.-]+$/);
  });

  it("takes the bare id of a run", () => {
    expect(parseSshHostWorkflowRunId("12", "http://localhost:7070")).toBe(12);
  });

  it.each(["the-run", "halinka-localhost-7070-$(id)-12", "halinka-other-7070-12"])(
    "finds no run in %s",
    (host) => {
      expect(parseSshHostWorkflowRunId(host, "http://localhost:7070")).toBeUndefined();
    },
  );
});
