import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { checkCompose, checkComposeSources } from "./composeCheck";
import { checkFolders, tempFolderWith } from "./testing";

const project = "run";

const documentWith = (service: object = {}, topLevel: object = {}) => ({
  name: project,
  services: {
    app: {
      image: "alpine:3.22",
      command: null,
      entrypoint: null,
      networks: { default: null },
      ...service,
    },
  },
  networks: { default: { name: `${project}_default`, ipam: {} } },
  volumes: { data: { name: `${project}_data` } },
  ...topLevel,
});

const setUp = async () => {
  const folders = await checkFolders({ ".devcontainer/app.env": "" });
  const check = (document: Record<string, unknown>) => checkCompose(document, folders, project);
  const tree = (path: string) => join(folders.treeFolder, path);
  const workspace = (path: string) => join(folders.workspaceFolder, path);
  return { check, tree, workspace };
};

const checkSources = async (source: string, prepare?: (folder: string) => Promise<void>) => {
  const folder = await tempFolderWith({ "compose.yml": source });
  await prepare?.(folder);
  const file = join(folder, "compose.yml");
  return { folder, file, problems: await checkComposeSources([file], folder) };
};

describe("composeCheck", () => {
  it("allows a project of allowed settings", async () => {
    const { check, tree, workspace } = await setUp();
    const document = documentWith(
      {
        image: undefined,
        build: { context: tree(""), dockerfile: "Dockerfile", args: { A: "1" } },
        env_file: [{ path: tree(".devcontainer/app.env") }, tree(".devcontainer/app.env")],
        cap_add: ["SYS_PTRACE"],
        security_opt: [],
        ipc: "shareable",
        extra_hosts: ["registry=10.0.0.1"],
        labels: { team: "app" },
        deploy: { resources: { limits: { cpus: 1, memory: "1073741824" } }, placement: {} },
        profiles: ["extra"],
        secrets: [{ source: "token", target: "/run/secrets/token" }],
        volumes: [
          { type: "bind", source: tree(""), target: "/workspaces/app", bind: {} },
          {
            type: "bind",
            source: workspace("data"),
            target: "/data",
            bind: { propagation: "rprivate" },
          },
          { type: "volume", source: "data", target: "/cache", volume: {} },
          { type: "volume", target: "/anonymous" },
          { type: "tmpfs", target: "/scratch", tmpfs: { size: 1024 } },
        ],
      },
      {
        secrets: { token: { name: `${project}_token`, file: tree(".devcontainer/app.env") } },
        "x-note": "inert",
      },
    );
    const db = { image: "postgres:17", network_mode: "service:app", ipc: "service:app" };

    expect(await check({ ...document, services: { ...document.services, db } })).toEqual([]);
  });

  it("refuses a bind of the tree that a workspace symlink moves out of the workspace", async () => {
    const { check, tree, workspace } = await setUp();
    const volumes = [{ type: "bind", source: tree("etc"), target: "/host", bind: {} }];

    expect(await check(documentWith({ volumes }))).toEqual([
      `compose service app: volumes.0: ${workspace("etc")} is outside the workspace`,
    ]);
  });

  it.each<{
    name: string;
    document: (tree: (path: string) => string) => Record<string, unknown>;
    problem: string;
  }>([
    {
      name: "published ports",
      document: () => documentWith({ ports: ["8080:8080"] }),
      problem: "compose service app: ports is not allowed",
    },
    {
      name: "a privileged service",
      document: () => documentWith({ privileged: true }),
      problem: "compose service app: privileged is not allowed",
    },
    {
      name: "an image that is not a plain reference",
      document: () => documentWith({ image: "alpine\n    privileged: true" }),
      problem: "compose service app: image: alpine\n    privileged: true is not allowed",
    },
    {
      name: "a build context outside the repository",
      document: () => documentWith({ image: undefined, build: { context: "/" } }),
      problem: "compose service app: build.context: / is outside the repository",
    },
    {
      name: "a Dockerfile outside the repository",
      document: (tree) =>
        documentWith({ image: undefined, build: { context: tree(""), dockerfile: "/etc/hosts" } }),
      problem: "compose service app: build.dockerfile: /etc/hosts is outside the repository",
    },
    {
      name: "a build key that is not allowed",
      document: (tree) =>
        documentWith({ image: undefined, build: { context: tree(""), ssh: ["default"] } }),
      problem: "compose service app: build: ssh is not allowed",
    },
    {
      name: "an env file outside the repository",
      document: () => documentWith({ env_file: [{ path: "/etc/hosts" }] }),
      problem: "compose service app: env_file: /etc/hosts is outside the repository",
    },
    {
      name: "a capability other than SYS_PTRACE",
      document: () => documentWith({ cap_add: ["SYS_ADMIN"] }),
      problem: "compose service app: cap_add: SYS_ADMIN is not allowed",
    },
    {
      name: "a security option",
      document: () => documentWith({ security_opt: ["seccomp:unconfined"] }),
      problem: "compose service app: security_opt: seccomp:unconfined is not allowed",
    },
    {
      name: "a host that resolves to the host gateway",
      document: () => documentWith({ extra_hosts: ["runner=host-gateway"] }),
      problem: "compose service app: extra_hosts: runner=host-gateway is not allowed",
    },
    {
      name: "a host with the reserved prefix",
      document: () => documentWith({ extra_hosts: ["halinka-proxy=10.0.0.1"] }),
      problem: "compose service app: extra_hosts: halinka-proxy=10.0.0.1 is not allowed",
    },
    {
      name: "a link alias with the reserved prefix",
      document: () => documentWith({ links: ["db:halinka-proxy"] }),
      problem: "compose service app: links: db:halinka-proxy is not allowed",
    },
    {
      name: "a network alias with the reserved prefix",
      document: () => documentWith({ networks: { default: { aliases: ["halinka-proxy"] } } }),
      problem: "compose service app: networks.default.aliases: halinka-proxy is not allowed",
    },
    {
      name: "volumes from a container",
      document: () => documentWith({ volumes_from: ["container:other"] }),
      problem: "compose service app: volumes_from: container:other is not allowed",
    },
    {
      name: "the host network",
      document: () => documentWith({ network_mode: "host" }),
      problem: "compose service app: network_mode: host is not allowed",
    },
    {
      name: "the host IPC namespace",
      document: () => documentWith({ ipc: "host" }),
      problem: "compose service app: ipc: host is not allowed",
    },
    {
      name: "a reserved service label",
      document: () => documentWith({ labels: { "halinka.sandbox": "other" } }),
      problem: "compose service app: label halinka.sandbox is reserved",
    },
    {
      name: "a network that is not of the project",
      document: () => documentWith({ networks: { other: null } }),
      problem: "compose service app: network other is not of the project",
    },
    {
      name: "a network setting that is not allowed",
      document: () => documentWith({ networks: { default: { ipv4_address: "10.0.0.2" } } }),
      problem: "compose service app: networks.default: ipv4_address is not allowed",
    },
    {
      name: "devices in a deploy reservation",
      document: () =>
        documentWith({ deploy: { resources: { reservations: { devices: [{ count: 1 }] } } } }),
      problem: "compose service app: deploy.resources.reservations: devices is not allowed",
    },
    {
      name: "a deploy placement",
      document: () => documentWith({ deploy: { placement: { constraints: ["node.role"] } } }),
      problem: "compose service app: deploy.placement: constraints is not allowed",
    },
    {
      name: "a bind outside the workspace",
      document: () =>
        documentWith({
          volumes: [{ type: "bind", source: "/var/run/docker.sock", target: "/sock" }],
        }),
      problem: "compose service app: volumes.0: /var/run/docker.sock is outside the workspace",
    },
    {
      name: "shared bind propagation",
      document: (tree) =>
        documentWith({
          volumes: [
            { type: "bind", source: tree(""), target: "/w", bind: { propagation: "rshared" } },
          ],
        }),
      problem: "compose service app: volumes.0: propagation rshared is not allowed",
    },
    {
      name: "an SELinux relabel of a bind",
      document: (tree) =>
        documentWith({
          volumes: [{ type: "bind", source: tree(""), target: "/w", bind: { selinux: "z" } }],
        }),
      problem: "compose service app: volumes.0: bind: selinux is not allowed",
    },
    {
      name: "a volume type that is not allowed",
      document: () => documentWith({ volumes: [{ type: "image", source: "x", target: "/x" }] }),
      problem: "compose service app: volumes.0: type image is not allowed",
    },
    {
      name: "a volume that is not of the project",
      document: () =>
        documentWith({ volumes: [{ type: "volume", source: "shared", target: "/s", volume: {} }] }),
      problem: "compose service app: volumes.0: shared is not a volume of the project",
    },
    {
      name: "a top-level key that is not allowed",
      document: () => documentWith({}, { models: {} }),
      problem: "compose: models is not allowed",
    },
    {
      name: "an external volume",
      document: () => documentWith({}, { volumes: { data: { name: "run_data", external: true } } }),
      problem: "compose volumes.data: external is not allowed",
    },
    {
      name: "volume driver options",
      document: () =>
        documentWith(
          {},
          { volumes: { data: { name: "run_data", driver_opts: { o: "bind", device: "/" } } } },
        ),
      problem: "compose volumes.data: driver_opts is not allowed",
    },
    {
      name: "a volume name that is not of the project",
      document: () => documentWith({}, { volumes: { data: { name: "shared" } } }),
      problem: "compose volumes.data: name shared is not allowed",
    },
    {
      name: "a volume driver other than local",
      document: () => documentWith({}, { volumes: { data: { name: "run_data", driver: "nfs" } } }),
      problem: "compose volumes.data: driver nfs is not allowed",
    },
    {
      name: "a reserved volume label",
      document: () =>
        documentWith(
          {},
          {
            volumes: { data: { name: "run_data", labels: { "com.docker.compose.project": "x" } } },
          },
        ),
      problem: "compose volumes.data: label com.docker.compose.project is reserved",
    },
    {
      name: "a network driver other than bridge",
      document: () =>
        documentWith({}, { networks: { default: { name: "run_default", driver: "host" } } }),
      problem: "compose networks.default: driver host is not allowed",
    },
    {
      name: "network address settings",
      document: () =>
        documentWith({}, { networks: { default: { name: "run_default", ipam: { driver: "x" } } } }),
      problem: "compose networks.default: ipam: driver is not allowed",
    },
    {
      name: "a secret file outside the repository",
      document: () => documentWith({}, { secrets: { s: { name: "run_s", file: "/etc/hosts" } } }),
      problem: "compose secrets.s: file: /etc/hosts is outside the repository",
    },
    {
      name: "an image name for a build",
      document: (tree) => documentWith({ image: "postgres:17", build: { context: tree("") } }),
      problem: "compose service app: image is not allowed with build",
    },
    {
      name: "a volume named as an inherited property",
      document: () =>
        documentWith({ volumes: [{ type: "volume", source: "constructor", target: "/c" }] }),
      problem: "compose service app: volumes.0: constructor is not a volume of the project",
    },
    {
      name: "a network name that is not of the project",
      document: () => documentWith({}, { networks: { default: { name: "shared" } } }),
      problem: "compose networks.default: name shared is not allowed",
    },
    {
      name: "volumes that are not a list",
      document: () => documentWith({ volumes: "data:/data" }),
      problem: "compose service app: volumes must be a list",
    },
    {
      name: "capabilities that are not strings",
      document: () => documentWith({ cap_add: [1] }),
      problem: "compose service app: cap_add must be a list of strings",
    },
    {
      name: "networks that are not an object",
      document: () => documentWith({ networks: ["default"] }),
      problem: "compose service app: networks must be an object",
    },
    {
      name: "a bind without a source",
      document: () => documentWith({ volumes: [{ type: "bind", target: "/w" }] }),
      problem: "compose service app: volumes.0: a bind needs a source",
    },
  ])("refuses $name", async ({ document, problem }) => {
    const { check, tree } = await setUp();

    expect(await check(document(tree))).toEqual([problem]);
  });

  it("refuses an include, which reads host files", async () => {
    const { file, problems } = await checkSources("include: [../other.yml]\nservices: {}\n");

    expect(problems).toEqual([`${file}: include is not allowed`]);
  });

  it("refuses an extends with a file", async () => {
    const { file, problems } = await checkSources(
      "services:\n  app:\n    extends: { file: /etc/compose.yml, service: x }\n",
    );

    expect(problems).toEqual([`${file}: services.app.extends.file is not allowed`]);
  });

  it("refuses an extends with a file that a merge key carries", async () => {
    const { file, problems } = await checkSources(
      "x-base: &base\n  extends: { file: /etc/compose.yml, service: x }\nservices:\n  app:\n    <<: *base\n",
    );

    expect(problems).toEqual([`${file}: services.app.extends.file is not allowed`]);
  });

  it("refuses the reserved prefix in names, also of a network that no service uses", async () => {
    const { file, problems } = await checkSources(
      "services:\n  halinka_proxy: { image: alpine }\nnetworks:\n  halinka: {}\n",
    );

    expect(problems).toEqual([
      `${file}: services.halinka_proxy: the name is reserved`,
      `${file}: networks.halinka: the name is reserved`,
    ]);
  });

  it("refuses a .env that is a symlink out of the repository", async () => {
    const { folder, problems } = await checkSources("services: {}\n", (folder) =>
      symlink("/etc/hosts", join(folder, ".env")),
    );

    expect(problems).toEqual([`${join(folder, ".env")} is outside the repository`]);
  });

  it("allows a .env inside the repository", async () => {
    const { problems } = await checkSources("services: {}\n", (folder) =>
      writeFile(join(folder, ".env"), "PORT=3000\n"),
    );

    expect(problems).toEqual([]);
  });

  it("allows an extends of a service in the same file", async () => {
    const { problems } = await checkSources(
      "services:\n  base: { image: alpine }\n  app:\n    extends: { service: base }\n",
    );

    expect(problems).toEqual([]);
  });
});
