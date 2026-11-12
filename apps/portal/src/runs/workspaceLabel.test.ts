import { describe, expect, it } from "vitest";

import { workspaceLabel } from "./workspaceLabel";

type Sandbox = NonNullable<Parameters<typeof workspaceLabel>[0]>;

const sandbox = (fields: Partial<Sandbox>): Sandbox => ({
  kind: "worktree",
  spec: "stopped",
  observed: "stopped",
  isInUse: false,
  isPending: false,
  ...fields,
});

const container = (fields: Partial<Sandbox>) => sandbox({ kind: "devcontainer", ...fields });

describe("workspaceLabel", () => {
  it("gives no label to a run that never had a workspace", () => {
    expect(workspaceLabel(undefined)).toBeUndefined();
  });

  it("names the workspace of a run that its engine uses in use", () => {
    expect(workspaceLabel(sandbox({ spec: "running", isInUse: true }))).toBe("In use");
  });

  it("names a workspace that the runner still removes", () => {
    expect(workspaceLabel(sandbox({ spec: "destroyed", isPending: true }))).toBe("Removing");
  });

  it("names a removed workspace", () => {
    expect(workspaceLabel(sandbox({ spec: "destroyed", observed: "absent" }))).toBe("Removed");
  });

  it("names a worktree that the runner did not check yet", () => {
    expect(workspaceLabel(sandbox({ isPending: true }))).toBe("Checking");
  });

  it("names a kept worktree", () => {
    expect(workspaceLabel(sandbox({}))).toBe("Kept");
  });

  it("names what the runner found", () => {
    expect(workspaceLabel(sandbox({ observed: "absent" }))).toBe("Missing");
  });

  it("names a container that the runner starts", () => {
    expect(workspaceLabel(container({ spec: "running", isPending: true }))).toBe("Starting");
  });

  it("names a container that the runner stops", () => {
    expect(workspaceLabel(container({ isPending: true }))).toBe("Stopping");
  });

  it("names a started container", () => {
    expect(workspaceLabel(container({ spec: "running", observed: "running" }))).toBe("Started");
  });

  it("names a stopped container", () => {
    expect(workspaceLabel(container({}))).toBe("Stopped");
  });

  it("names a workspace whose spec the runner could not apply", () => {
    expect(workspaceLabel(container({ isPending: true, error: "No Docker" }))).toBe("Failed");
  });
});
