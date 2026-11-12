import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  builtInFeaturePublisher,
  checkDevcontainer,
  checkFeatureIds,
  checkFeatureSets,
  type FeatureSet,
  parseFeaturePublisher,
} from "./devcontainerCheck";
import { checkFolders } from "./testing";

const setUp = async () => {
  const real = await checkFolders({ ".devcontainer/compose.yml": "" });
  const folders = { ...real, configFolder: join(real.treeFolder, ".devcontainer") };
  const check = (config: Record<string, unknown>) => checkDevcontainer(config, folders);
  const workspace = (path: string) => join(folders.workspaceFolder, path);
  return { folders, check, workspace };
};

const publishers = [builtInFeaturePublisher, "registry.acme.dev:5000/team/features/"];

const contrib = ["ghcr.io/devcontainers-contrib/features/"];

const refusal = (id: string, publisher?: string, trusted = publishers) =>
  `features: ${id} is not allowed. Use a Feature of ${trusted.join(", ")}${publisher ? `. To allow it, start the runner with --trust-features ${publisher}` : ""}`;

describe("devcontainerCheck", () => {
  it("allows a config of allowed settings", async () => {
    const { check, workspace } = await setUp();
    const config = {
      name: "app",
      image: "alpine",
      build: { dockerfile: "Dockerfile", context: "..", args: { A: "1" } },
      dockerComposeFile: ["compose.yml"],
      features: { "ghcr.io/devcontainers/features/node:1": {} },
      forwardPorts: [3000],
      remoteUser: "node",
      privileged: false,
      init: true,
      capAdd: ["SYS_PTRACE"],
      securityOpt: [],
      hostRequirements: { cpus: 2 },
      postCreateCommands: [],
      runArgs: [
        "--env",
        "A=1",
        "-eB=2",
        "-e=C=3",
        "--label=team=app",
        "--init",
        "--platform",
        "linux/amd64",
        "-u",
        "1000",
      ],
      mounts: [
        `type=bind,source=${workspace("data")},target=/data,bind-propagation=rprivate`,
        { type: "tmpfs", target: "/scratch" },
      ],
      workspaceMount: `type=bind,source=${workspace("")},target=/workspaces/app`,
    };

    expect(await check(config)).toEqual([]);
  });

  it("refuses a bind through a symlink out of the workspace", async () => {
    const { check, workspace } = await setUp();
    const config = { mounts: [`type=bind,source=${workspace("etc")},target=/host`] };

    expect(await check(config)).toEqual([`mounts: ${workspace("etc")} is outside the workspace`]);
  });

  it.each<{
    name: string;
    config: (workspace: (path: string) => string) => Record<string, unknown>;
    problem: string;
  }>([
    {
      name: "initializeCommand",
      config: () => ({ initializeCommand: "touch /tmp/x" }),
      problem: "devcontainer.json: initializeCommand is not allowed",
    },
    {
      name: "appPort",
      config: () => ({ appPort: 8080 }),
      problem: "devcontainer.json: appPort is not allowed",
    },
    {
      name: "privileged",
      config: () => ({ privileged: true }),
      problem: "privileged is not allowed",
    },
    {
      name: "a capability other than SYS_PTRACE",
      config: () => ({ capAdd: ["SYS_ADMIN"] }),
      problem: "capAdd: SYS_ADMIN is not allowed",
    },
    {
      name: "a security option",
      config: () => ({ securityOpt: ["seccomp=unconfined"] }),
      problem: "securityOpt: seccomp=unconfined is not allowed",
    },
    {
      name: "build options",
      config: () => ({ build: { options: ["--output=type=local,dest=/tmp"] } }),
      problem: "build: options is not allowed",
    },
    {
      name: "a runArgs flag that is not allowed",
      config: () => ({ runArgs: ["--privileged"] }),
      problem: "runArgs: --privileged is not allowed",
    },
    {
      name: "a runArgs flag that is not allowed, with its value",
      config: () => ({ runArgs: ["--network=host"] }),
      problem: "runArgs: --network=host is not allowed",
    },
    {
      name: "a runArgs flag as the value of another flag",
      config: () => ({ runArgs: ["--env", "--privileged"] }),
      problem: "runArgs: --env needs a value",
    },
    {
      name: "a runArgs flag without its value",
      config: () => ({ runArgs: ["-e"] }),
      problem: "runArgs: -e needs a value",
    },
    {
      name: "a runArgs argument that is not a flag",
      config: () => ({ runArgs: ["image"] }),
      problem: "runArgs: image is not allowed",
    },
    {
      name: "a short runArgs flag that is not allowed",
      config: () => ({ runArgs: ["-v/:/host"] }),
      problem: "runArgs: -v/:/host is not allowed",
    },
    {
      name: "a runArgs value that starts with a dash",
      config: () => ({ runArgs: ["--env=-x"] }),
      problem: "runArgs: --env=-x needs a value",
    },
    {
      name: "runArgs that are not strings",
      config: () => ({ runArgs: [1] }),
      problem: "runArgs must be a list of strings",
    },
    {
      name: "capabilities that are not strings",
      config: () => ({ capAdd: [1] }),
      problem: "capAdd must be a list of strings",
    },
    {
      name: "a build that is not an object",
      config: () => ({ build: "Dockerfile" }),
      problem: "build must be an object",
    },
    {
      name: "a reserved label",
      config: () => ({ runArgs: ["-l", "halinka.sandbox=other"] }),
      problem: "runArgs: label halinka.sandbox=other is reserved",
    },
    {
      name: "a host that resolves to the host gateway",
      config: () => ({ runArgs: ["--add-host=runner:host-gateway"] }),
      problem: "runArgs: --add-host runner:host-gateway reaches the host",
    },
    {
      name: "a volume mount",
      config: () => ({ mounts: ["source=cache,target=/cache,type=volume"] }),
      problem: "mounts: type volume is not allowed",
    },
    {
      name: "a mount without a type",
      config: () => ({ mounts: ["source=cache,target=/cache"] }),
      problem: "mounts: type volume is not allowed",
    },
    {
      name: "a mount key that is not allowed",
      config: (workspace) => ({
        mounts: [`type=bind,source=${workspace("data")},target=/data,bind-recursive=disabled`],
      }),
      problem: "mounts: bind-recursive is not allowed",
    },
    {
      name: "a mount that gives its source twice",
      config: (workspace) => ({
        mounts: [`type=bind,source=${workspace("data")},src=/etc,target=/data`],
      }),
      problem: "mounts: a key is given more than once",
    },
    {
      name: "a bind whose src is outside the workspace",
      config: () => ({ mounts: ["type=bind,src=/,target=/host"] }),
      problem: "mounts: / is outside the workspace",
    },
    {
      name: "a bind without a source",
      config: () => ({ mounts: ["type=bind,target=/host"] }),
      problem: "mounts: a bind needs an absolute source",
    },
    {
      name: "a mount that is not a string or an object",
      config: () => ({ mounts: [1] }),
      problem: 'mounts must be a string or an object without quotes, line breaks or "$"',
    },
    {
      name: "a field of an object mount that adds a field",
      config: (workspace) => ({
        mounts: [{ type: "bind", source: workspace("data"), target: "/host,src=/" }],
      }),
      problem: "mounts: a key is given more than once",
    },
    {
      name: "a mount with a line break",
      config: (workspace) => ({
        mounts: [`type=bind,target=/host,source=/etc\n${workspace("data")}`],
      }),
      problem: 'mounts must be a string or an object without quotes, line breaks or "$"',
    },
    {
      name: "a mount with a variable",
      config: (workspace) => ({
        mounts: [`type=bind,source=${workspace("${A:-..}")},target=/data`],
      }),
      problem: 'mounts must be a string or an object without quotes, line breaks or "$"',
    },
    {
      name: "a bind with a relative source",
      config: () => ({ mounts: ["type=bind,source=../data,target=/data"] }),
      problem: "mounts: a bind needs an absolute source",
    },
    {
      name: "shared bind propagation",
      config: (workspace) => ({
        mounts: [`type=bind,source=${workspace("data")},target=/data,bind-propagation=rshared`],
      }),
      problem: "mounts: bind-propagation rshared is not allowed",
    },
    {
      name: "a bind of the Docker socket",
      config: () => ({
        mounts: [{ type: "bind", source: "/var/run/docker.sock", target: "/var/run/docker.sock" }],
      }),
      problem: "mounts: /var/run/docker.sock is outside the workspace",
    },
    {
      name: "a workspace mount outside the workspace",
      config: () => ({ workspaceMount: "type=bind,source=/,target=/workspaces/app" }),
      problem: "workspaceMount: / is outside the workspace",
    },
    {
      name: "a compose file through a symlink out of the repository",
      config: () => ({ dockerComposeFile: "etc/compose.yml" }),
      problem: "dockerComposeFile: etc/compose.yml is outside the repository",
    },
    {
      name: "an empty list of compose files",
      config: () => ({ dockerComposeFile: [] }),
      problem: "dockerComposeFile must name one or more files",
    },
    {
      name: "an empty compose file name",
      config: () => ({ dockerComposeFile: "" }),
      problem: "dockerComposeFile must name one or more files",
    },
    {
      name: "a Dockerfile outside the repository",
      config: () => ({ build: { dockerfile: "../../Dockerfile" } }),
      problem: "build.dockerfile: ../../Dockerfile is outside the repository",
    },
    {
      name: "a legacy dockerFile outside the repository",
      config: () => ({ dockerFile: "../../Dockerfile" }),
      problem: "dockerFile: ../../Dockerfile is outside the repository",
    },
    {
      name: "a legacy context outside the repository",
      config: () => ({ context: "../.." }),
      problem: "context: ../.. is outside the repository",
    },
    {
      name: "a build context outside the repository",
      config: () => ({ build: { context: "../.." } }),
      problem: "build.context: ../.. is outside the repository",
    },
    {
      name: "a service name that is not a plain name",
      config: () => ({ service: "app':\n    privileged: true\n  'other" }),
      problem: "service: app':\n    privileged: true\n  'other is not allowed",
    },
    {
      name: "a container user that is not a plain name",
      config: () => ({ containerUser: "root\n    privileged: true" }),
      problem: "containerUser: root\n    privileged: true is not allowed",
    },
    {
      name: "a container variable name that is not a plain name",
      config: () => ({ containerEnv: { "A'\n    privileged: true": "1" } }),
      problem: "containerEnv: A'\n    privileged: true is not allowed",
    },
    {
      name: "an entrypoint with a quote",
      config: () => ({ entrypoints: ['true"]\n    privileged: true'] }),
      problem: 'entrypoints: true"]\n    privileged: true is not allowed',
    },
    {
      name: "a mount value that holds an equals sign",
      config: (workspace) => ({ mounts: [`type=bind,source=${workspace("data")}=x,target=/data`] }),
      problem: 'mounts: the value of source holds "="',
    },
  ])("refuses $name", async ({ config, problem }) => {
    const { check, workspace } = await setUp();

    expect(await check(config(workspace))).toEqual([problem]);
  });

  it.each([
    ["GHCR.io/Acme/features/", "ghcr.io/acme/features/"],
    ["registry.acme.dev:5000/team/", "registry.acme.dev:5000/team/"],
    ["registry.example.com:5000/acme/", "registry.example.com:5000/acme/"],
    ["ghcr.io/devcontainers-contrib/features/", "ghcr.io/devcontainers-extra/features/"],
  ])("reads %s as the namespace that the CLI fetches from", (value, publisher) => {
    expect(parseFeaturePublisher(value)).toBe(publisher);
  });

  it.each([
    "ghcr.io/acme/features",
    "ghcr.io/",
    "https://ghcr.io/acme/",
    "localhost:5000/acme/",
    "127.0.0.1:5000/acme/",
    "0.0.0.0:5000/acme/",
    "ghcr.io/acme/../",
    "acme/features/",
    "registry:5000/acme/",
  ])("refuses %s", (value) => {
    expect(parseFeaturePublisher(value)).toBeUndefined();
  });

  it("allows the Features of the built-in and the trusted publishers, in any case", async () => {
    const features = {
      "ghcr.io/devcontainers/features/node:1": {},
      "GHCR.io/Devcontainers/features/git:1": {},
      "registry.acme.dev:5000/team/features/tool@sha256:abc": {},
    };

    expect(await checkFeatureIds({ features }, publishers)).toEqual([]);
  });

  it.each([
    ["./local", undefined],
    ["ghcr.io/someone/features/tool:1", "ghcr.io/someone/features/"],
    ["https://example.com/feature.tgz", undefined],
    [
      "registry.acme.dev:5000/team/featuresplus/tool:1",
      "registry.acme.dev:5000/team/featuresplus/",
    ],
    ["registry.acme.dev:5000/team/features", "registry.acme.dev:5000/team/"],
    ["ghcr.io/someone/features/tool@sha256:abc", "ghcr.io/someone/features/"],
    ["localhost:5000/acme/features/tool:1", undefined],
  ])("refuses %s and names the publisher to trust, if any", async (id, publisher) => {
    expect(await checkFeatureIds({ features: { [id]: {} } }, publishers)).toEqual([
      refusal(id, publisher),
    ]);
  });

  it("refuses an install order entry of another publisher", async () => {
    const overrideFeatureInstallOrder = ["ghcr.io/someone/features/tool:1"];

    expect(await checkFeatureIds({ overrideFeatureInstallOrder }, publishers)).toEqual([
      refusal("ghcr.io/someone/features/tool:1", "ghcr.io/someone/features/"),
    ]);
  });

  it("judges a devcontainers-contrib Feature by the namespace that the CLI fetches from", async () => {
    const id = "ghcr.io/devcontainers-contrib/features/tool:1";

    expect(await checkFeatureIds({ features: { [id]: {} } }, contrib)).toEqual([
      refusal(id, "ghcr.io/devcontainers-extra/features/", contrib),
    ]);
  });

  it("refuses features that are not an object", async () => {
    const features = ["ghcr.io/devcontainers/features/node:1"];

    expect(await checkFeatureIds({ features }, publishers)).toEqual(["features must be an object"]);
  });

  const oci = (ref: string, userFeatureId: string): FeatureSet => {
    const [registry, ...path] = ref.split("/");
    return {
      sourceInformation: {
        type: "oci",
        userFeatureId,
        featureRef: { registry, path: path.join("/") },
      },
    };
  };

  it("allows OCI Features of the trusted publishers", () => {
    const sets = [
      oci("ghcr.io/devcontainers/features/git", "GHCR.io/Devcontainers/features/git:1"),
      oci(
        "registry.acme.dev:5000/team/features/tool",
        "registry.acme.dev:5000/team/features/tool:2",
      ),
    ];

    expect(checkFeatureSets(sets, publishers)).toEqual([]);
  });

  it("refuses a Feature set of another publisher", () => {
    const sets = [oci("ghcr.io/someone/features/helper", "ghcr.io/someone/features/helper:1")];

    expect(checkFeatureSets(sets, publishers)).toEqual([
      refusal("ghcr.io/someone/features/helper:1", "ghcr.io/someone/features/"),
    ]);
  });

  it("refuses a Feature that is not from an OCI registry", () => {
    const featureRef = { registry: "ghcr.io", path: "devcontainers/features/x" };
    const sets = [{ sourceInformation: { type: "github-repo", featureRef } }];

    expect(checkFeatureSets(sets, publishers)).toEqual([
      refusal("ghcr.io/devcontainers/features/x"),
    ]);
  });

  it("judges a Feature set by the registry and path that the CLI fetches from", () => {
    const sets = [
      oci(
        "ghcr.io/devcontainers-extra/features/tool",
        "ghcr.io/devcontainers-contrib/features/tool:1",
      ),
    ];

    expect(checkFeatureSets(sets, contrib)).toEqual([
      refusal(
        "ghcr.io/devcontainers-contrib/features/tool:1",
        "ghcr.io/devcontainers-extra/features/",
        contrib,
      ),
    ]);
  });

  it("refuses an OCI Feature without a resource", () => {
    const sets = [{ sourceInformation: { type: "oci", userFeatureId: "./local" } }];

    expect(checkFeatureSets(sets, publishers)).toEqual([refusal("./local")]);
  });
});
