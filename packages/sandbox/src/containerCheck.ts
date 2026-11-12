import { isRealPathInside } from "@halinka/utils/fs";

import { allowedCapabilities, allowedPropagations, Problems, type RealFolders } from "./checkRules";

export type StartedContainer = {
  name: string;
  hostConfig: {
    Privileged?: boolean;
    CapAdd?: string[] | null;
    SecurityOpt?: string[] | null;
    Devices?: unknown[] | null;
    NetworkMode?: string;
    PidMode?: string;
    IpcMode?: string;
    UTSMode?: string;
    UsernsMode?: string;
    Runtime?: string;
  };
  mounts: { Type: string; Source: string; Propagation?: string }[];
};

const hostModes = ["NetworkMode", "PidMode", "IpcMode", "UTSMode", "UsernsMode"] as const;

// Docker Desktop shows a bind source as /host_mnt/<host path>.
const hostPathOf = (source: string) => source.replace(/^\/host_mnt(?=\/)/, "");

// Compose mounts a file secret or config from the tree.
const isAllowedSource = async (source: string, { treeFolder, workspaceFolder }: RealFolders) =>
  (await isRealPathInside(source, workspaceFolder)) || (await isRealPathInside(source, treeFolder));

export const checkStartedContainer = async (
  { name, hostConfig, mounts }: StartedContainer,
  folders: RealFolders,
  expectedRuntime?: string,
) => {
  const problems = new Problems();
  if (expectedRuntime && hostConfig.Runtime !== expectedRuntime) {
    problems.add(`${name}: runtime ${hostConfig.Runtime} is not ${expectedRuntime}`);
  }
  if (hostConfig.Privileged) problems.add(`${name}: privileged is not allowed`);
  problems.valuesOf(`${name}: capability`, hostConfig.CapAdd, (value) =>
    allowedCapabilities.has(value.replace(/^CAP_/, "")),
  );
  problems.valuesOf(`${name}: security option`, hostConfig.SecurityOpt, () => false);
  if ((hostConfig.Devices ?? []).length > 0) problems.add(`${name}: devices are not allowed`);
  for (const mode of hostModes) {
    if (hostConfig[mode] === "host") problems.add(`${name}: ${mode} host is not allowed`);
  }
  const binds = mounts.filter(({ Type }) => Type === "bind");
  for (const { Propagation = "" } of binds) {
    if (Propagation && !allowedPropagations.has(Propagation)) {
      problems.add(`${name}: bind propagation ${Propagation} is not allowed`);
    }
  }
  const outside = await Promise.all(
    binds.map(async ({ Source }) => {
      const source = hostPathOf(Source);
      return (await isAllowedSource(source, folders))
        ? undefined
        : `${name}: bind: ${source} is outside the workspace and the repository`;
    }),
  );
  return [...(await problems.all()), ...outside.filter((problem) => problem !== undefined)];
};
