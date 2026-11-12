import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { testBuild } from "@halinka/protocol/testing";
import { tempFolder } from "@halinka/utils/testing";
import { describe, expect, it, vi } from "vitest";

import { inspectCapabilities } from "./capabilities";

const sshHostKey = "ssh-ed25519 AAAA";
const options = { build: testBuild, canUpdate: false, sshHostKey, isDockerInContainer: false };

describe("inspectCapabilities", () => {
  it("gives a worktree runner the presets whose command is on PATH", async () => {
    const bin = await tempFolder();
    await writeFile(join(bin, "codex-acp"), "#!/bin/sh\n");
    await chmod(join(bin, "codex-acp"), 0o755);
    vi.stubEnv("PATH", `${bin}:/usr/bin:/bin`);

    expect(await inspectCapabilities("worktree", options)).toEqual({
      sandboxKind: "worktree",
      build: testBuild,
      canUpdate: false,
      agentsOnPath: ["codex"],
    });
  });

  it("gives the SSH key of a devcontainer runner", async () => {
    expect(await inspectCapabilities("devcontainer", options)).toMatchObject({ sshHostKey });
  });

  // A docker that answers `info` with the Sysbox runtime.
  const withSysboxDocker = async () => {
    const bin = await tempFolder();
    const script = `#!/bin/sh\n[ "$1" = info ] && echo '{"runc":{},"sysbox-runc":{}}'\nexit 0\n`;
    await writeFile(join(bin, "docker"), script);
    await chmod(join(bin, "docker"), 0o755);
    vi.stubEnv("PATH", `${bin}:/usr/bin:/bin`);
  };

  it("gives Sysbox to a runner with --docker-in-container whose Docker lists it", async () => {
    await withSysboxDocker();

    expect(
      await inspectCapabilities("devcontainer", { ...options, isDockerInContainer: true }),
    ).toMatchObject({ hasSysbox: true });
  });

  it("gives no Sysbox without --docker-in-container", async () => {
    await withSysboxDocker();

    expect(await inspectCapabilities("devcontainer", options)).toMatchObject({ hasSysbox: false });
  });
});
