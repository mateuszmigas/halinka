import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { checkStartedContainer, type StartedContainer } from "./containerCheck";
import { checkFolders } from "./testing";

const setUp = async () => {
  const folders = await checkFolders();
  const workspace = (path: string) => join(folders.workspaceFolder, path);
  const tree = (path: string) => join(folders.treeFolder, path);
  const container = (changes: Partial<StartedContainer> = {}): StartedContainer => ({
    name: "app",
    hostConfig: { CapAdd: ["CAP_SYS_PTRACE"], SecurityOpt: null, NetworkMode: "halinka-run" },
    mounts: [
      { Type: "bind", Source: workspace("") },
      { Type: "volume", Source: "/var/lib/docker/volumes/data" },
    ],
    ...changes,
  });
  const check = (changes?: Partial<StartedContainer>, expectedRuntime?: string) =>
    checkStartedContainer(container(changes), folders, expectedRuntime);
  return { container, check, workspace, tree };
};

describe("containerCheck", () => {
  it("allows a container with the allowed settings", async () => {
    const { check } = await setUp();

    expect(await check()).toEqual([]);
  });

  it("refuses a container without the runtime that Halinka gave it", async () => {
    const { container, check } = await setUp();
    const hostConfig = { ...container().hostConfig, Runtime: "runc" };

    expect(await check({ hostConfig }, "sysbox-runc")).toEqual([
      "app: runtime runc is not sysbox-runc",
    ]);
  });

  it("allows a container with the runtime that Halinka gave it", async () => {
    const { container, check } = await setUp();
    const hostConfig = { ...container().hostConfig, Runtime: "sysbox-runc" };

    expect(await check({ hostConfig }, "sysbox-runc")).toEqual([]);
  });

  it.each<[string, Partial<StartedContainer["hostConfig"]>, string]>([
    ["privileged", { Privileged: true }, "app: privileged is not allowed"],
    [
      "another capability",
      { CapAdd: ["CAP_SYS_ADMIN"] },
      "app: capability: CAP_SYS_ADMIN is not allowed",
    ],
    [
      "a security option",
      { SecurityOpt: ["seccomp=unconfined"] },
      "app: security option: seccomp=unconfined is not allowed",
    ],
    ["a device", { Devices: [{ PathOnHost: "/dev/kvm" }] }, "app: devices are not allowed"],
    ["the host network", { NetworkMode: "host" }, "app: NetworkMode host is not allowed"],
    ["the host PID namespace", { PidMode: "host" }, "app: PidMode host is not allowed"],
    ["the host IPC namespace", { IpcMode: "host" }, "app: IpcMode host is not allowed"],
    ["the host UTS namespace", { UTSMode: "host" }, "app: UTSMode host is not allowed"],
    ["the host user namespace", { UsernsMode: "host" }, "app: UsernsMode host is not allowed"],
  ])("refuses a container with %s", async (_, hostConfig, problem) => {
    const { check, container } = await setUp();

    const problems = await check({ hostConfig: { ...container().hostConfig, ...hostConfig } });

    expect(problems).toEqual([problem]);
  });

  it.each<
    [string, (folder: Record<"workspace" | "tree", (path: string) => string>) => string, string[]]
  >([
    [
      "in the workspace that Docker Desktop shows under /host_mnt",
      ({ workspace }) => `/host_mnt${workspace("data")}`,
      [],
    ],
    ["of a Compose secret in the tree", ({ tree }) => tree("secret.txt"), []],
    [
      "outside the workspace",
      () => "/etc",
      ["app: bind: /etc is outside the workspace and the repository"],
    ],
    [
      "under /host_mnt outside the workspace",
      () => "/host_mnt/etc",
      ["app: bind: /etc is outside the workspace and the repository"],
    ],
  ])("checks a bind %s", async (_, sourceOf, problems) => {
    const { check, workspace, tree } = await setUp();

    const source = sourceOf({ workspace, tree });

    expect(await check({ mounts: [{ Type: "bind", Source: source }] })).toEqual(problems);
  });

  it("refuses a bind with shared propagation", async () => {
    const { check, workspace } = await setUp();
    const mounts = [{ Type: "bind", Source: workspace(""), Propagation: "rshared" }];

    expect(await check({ mounts })).toEqual(["app: bind propagation rshared is not allowed"]);
  });
});
