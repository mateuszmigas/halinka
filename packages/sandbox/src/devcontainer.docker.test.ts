import { randomInt } from "node:crypto";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { pathExists } from "@halinka/utils/fs";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import {
  inspectAttach,
  type DevcontainerOptions,
  inspectDevcontainer,
  inspectDevcontainers,
  deleteDevcontainer,
  stopDevcontainer,
  upDevcontainer,
} from "./devcontainer";
import { hostGit } from "./host";
import { EgressPolicy, runNetworksOf, startRunNetwork } from "./runNetwork";
import { docker, dockerAddressPools, image, startOutsideHost, tempFolderWith } from "./testing";

const imageConfig = { ".devcontainer/devcontainer.json": JSON.stringify({ image }) };

const composeConfig = (devcontainer: object = {}, sideSettings: string[] = []) => ({
  ".devcontainer/devcontainer.json": JSON.stringify({
    dockerComposeFile: "compose.yml",
    service: "app",
    workspaceFolder: "/workspaces/app",
    ...devcontainer,
  }),
  ".devcontainer/compose.yml": [
    "services:",
    "  app:",
    `    image: ${image}`,
    "    command: sleep infinity",
    "    volumes: ['..:/workspaces/app', '../sub:/sub']",
    "  side:",
    ...sideSettings,
    `    image: ${image}`,
    "    command: sleep infinity",
    "    volumes: ['..:/src', 'data:/data']",
    "volumes:",
    "  data:",
  ].join("\n"),
});

const appVolumeConfig = (volume: string) => ({
  ".devcontainer/devcontainer.json": JSON.stringify({
    dockerComposeFile: "compose.yml",
    service: "app",
    workspaceFolder: "/workspaces/app",
  }),
  ".devcontainer/compose.yml": [
    "services:",
    "  app:",
    `    image: ${image}`,
    "    command: sleep infinity",
    `    volumes: ['${volume}']`,
  ].join("\n"),
});

const failingConfig = composeConfig({ postCreateCommand: "exit 1" });

const projectFilter = (name: string) => ["--filter", `label=com.docker.compose.project=${name}`];

const findServiceContainer = (name: string, service: string) =>
  docker(
    "ps",
    "-aq",
    ...projectFilter(name),
    "--filter",
    `label=com.docker.compose.service=${service}`,
  );

const mainContainer = (name: string) =>
  docker("ps", "-q", "--filter", `label=halinka.sandbox=${name}`);

describe("devcontainer", { timeout: 180_000 }, () => {
  const optionsFor = async (config: Record<string, string>): Promise<DevcontainerOptions> => {
    const name = `halinka-test-${process.pid}-${randomInt(1_000_000)}`;
    onTestFinished(() => deleteDevcontainer(name));
    return {
      name,
      workspaceFolder: await tempFolderWith({ marker: "workspace", "sub/marker": "workspace sub" }),
      treeFolder: await tempFolderWith({ ...config, marker: "tree", "sub/marker": "tree sub" }),
      configPath: ".devcontainer/devcontainer.json",
      setupNetwork: [],
      policy: new EgressPolicy(name, { reachable: dockerAddressPools }),
    };
  };

  const abortedUp = async () => {
    const options = await optionsFor(
      composeConfig({ postCreateCommand: "touch /tmp/created && sleep 600" }),
    );
    const controller = new AbortController();
    const started = upDevcontainer(options, controller.signal);
    await vi.waitFor(
      () =>
        expect(
          docker("exec", findServiceContainer(options.name, "app"), "ls", "/tmp/created"),
        ).toBe("/tmp/created"),
      { timeout: 120_000, interval: 1000 },
    );
    controller.abort();
    return { options, started };
  };

  const failedUpAfterStart = async () => {
    const options = await optionsFor(imageConfig);
    await upDevcontainer(options);
    await expect(upDevcontainer({ ...options, limits: { memory: 1 } })).rejects.toThrow();
    return options;
  };

  const startOutside = (name: string) => {
    const outside = startOutsideHost(name);
    onTestFinished(() => {
      outside.delete();
    });
    return outside;
  };

  // An isolated network has no route out and no address of the host.
  const isolatedByNetwork = (container: string) => {
    const networks = Object.keys(
      JSON.parse(docker("inspect", container, "--format", "{{json .NetworkSettings.Networks}}")),
    );
    const mode = '{{.Internal}} {{index .Options "com.docker.network.bridge.gateway_mode_ipv4"}}';
    return Object.fromEntries(
      networks.map((network) => [
        network,
        docker("network", "inspect", network, "--format", mode) === "true isolated",
      ]),
    );
  };

  const inspectPidsLimit = (container: string) =>
    docker("inspect", container, "--format", "{{.HostConfig.PidsLimit}}");

  const limits = { memory: 256 * 1024 ** 2, cpus: 0.5 };

  const inspectLimits = (container: string) =>
    docker(
      "inspect",
      container,
      "--format",
      "{{.HostConfig.Memory}} {{.HostConfig.MemorySwap}} {{.HostConfig.NanoCpus}}",
    );

  it("mounts the workspace for an image config", async () => {
    const { containerId, remoteWorkspaceFolder } = await upDevcontainer(
      await optionsFor(imageConfig),
    );

    expect(docker("exec", containerId, "cat", `${remoteWorkspaceFolder}/marker`)).toBe("workspace");
  });

  it("gives the workspace path that up gives for an attach", async () => {
    const options = await optionsFor(imageConfig);
    const { remoteWorkspaceFolder } = await upDevcontainer(options);

    expect(await inspectAttach(options.name, options.workspaceFolder)).toMatchObject({
      containerFolder: remoteWorkspaceFolder,
    });
  });

  it("gives no attach for a folder that the container does not bind", async () => {
    const options = await optionsFor(imageConfig);
    await upDevcontainer(options);

    expect(await inspectAttach(options.name, await tempFolderWith({}))).toBeUndefined();
  });

  it("puts the container of an image config on the run network only", async () => {
    const options = await optionsFor(imageConfig);

    const { containerId } = await upDevcontainer(options);

    expect(isolatedByNetwork(containerId)).toEqual({
      [runNetworksOf(options.name).internal]: true,
    });
  });

  it("puts each compose service on internal networks and the run network", async () => {
    const options = await optionsFor(composeConfig());

    const { containerId } = await upDevcontainer(options);

    const networks = {
      [`${options.name}_default`]: true,
      [runNetworksOf(options.name).internal]: true,
    };
    expect(
      [containerId, findServiceContainer(options.name, "side")].map(isolatedByNetwork),
    ).toEqual([networks, networks]);
  });

  it("limits the processes of the container of an image config", async () => {
    const { containerId } = await upDevcontainer(await optionsFor(imageConfig));

    expect(inspectPidsLimit(containerId)).toBe("4096");
  });

  it("limits the processes of each compose service, also over its own limit", async () => {
    const options = await optionsFor(composeConfig({}, ["    pids_limit: 50"]));

    const { containerId } = await upDevcontainer(options);

    expect([containerId, findServiceContainer(options.name, "side")].map(inspectPidsLimit)).toEqual(
      ["4096", "4096"],
    );
  });

  it("limits the memory and the CPUs of the container of an image config", async () => {
    const options = await optionsFor(imageConfig);

    const { containerId } = await upDevcontainer({ ...options, limits });

    expect(inspectLimits(containerId)).toBe("268435456 268435456 500000000");
  });

  it("changes the limits of a container that an earlier up made", async () => {
    const options = await optionsFor(imageConfig);
    await upDevcontainer({ ...options, limits });

    const { containerId } = await upDevcontainer({
      ...options,
      limits: { memory: 128 * 1024 ** 2 },
    });

    const hostCpus = Number(docker("info", "--format", "{{.NCPU}}"));
    expect(inspectLimits(containerId)).toBe(`134217728 134217728 ${hostCpus * 1e9}`);
  });

  it("starts the container from an image tag of the run", async () => {
    const options = await optionsFor(imageConfig);

    const { containerId } = await upDevcontainer(options);

    expect(docker("inspect", "--format", "{{.Config.Image}}", containerId)).toBe(
      `halinka-pin.invalid/${options.name}:checked`,
    );
  });

  it("starts the compose service of the container from an image tag of the run", async () => {
    const options = await optionsFor(composeConfig());

    await upDevcontainer(options);

    const app = findServiceContainer(options.name, "app");
    expect(docker("inspect", "--format", "{{.Config.Image}}", app)).toBe(
      `halinka-pin.invalid/${options.name}:checked`,
    );
  });

  it("starts a compose service with a file secret of the repository", async () => {
    const config = composeConfig({}, ["    secrets: [token]"]);
    const options = await optionsFor({
      ...config,
      ".devcontainer/compose.yml": `${config[".devcontainer/compose.yml"]}\nsecrets:\n  token:\n    file: ./token.txt`,
      ".devcontainer/token.txt": "dummy",
    });

    await upDevcontainer(options);

    expect(
      docker("exec", findServiceContainer(options.name, "side"), "cat", "/run/secrets/token"),
    ).toBe("dummy");
  });

  it("starts the compose service of the container when its pull policy is always", async () => {
    const config = composeConfig();
    const pulled = config[".devcontainer/compose.yml"].replace(
      "  app:\n",
      "  app:\n    pull_policy: always\n",
    );
    const options = await optionsFor({ ...config, ".devcontainer/compose.yml": pulled });

    await upDevcontainer(options);

    expect(findServiceContainer(options.name, "app")).not.toBe("");
  });

  it("builds a Dockerfile config that also names an image that is not local", async () => {
    const options = await optionsFor({
      ".devcontainer/devcontainer.json": JSON.stringify({
        image: "halinka-test-absent:1",
        build: { dockerfile: "Dockerfile" },
      }),
      ".devcontainer/Dockerfile": `FROM ${image}\n`,
    });

    const { containerId } = await upDevcontainer(options);

    expect(containerId).not.toBe("");
  });

  it("removes the image tag of the run after up", async () => {
    const options = await optionsFor(imageConfig);

    await upDevcontainer(options);

    expect(docker("image", "ls", "-q", `halinka-pin.invalid/${options.name}:checked`)).toBe("");
  });

  it("refuses a privileged setting in the image metadata before anything runs", async () => {
    const tag = `halinka-test-metadata-${process.pid}-${randomInt(1_000_000)}:1`;
    const metadata = JSON.stringify([{ privileged: true }]);
    const context = await tempFolderWith({
      Dockerfile: `FROM ${image}\nLABEL devcontainer.metadata='${metadata}'\n`,
    });
    docker("build", "--quiet", "--tag", tag, context);
    onTestFinished(() => {
      docker("image", "rm", tag);
    });
    const options = await optionsFor({
      ".devcontainer/devcontainer.json": JSON.stringify({ image: tag }),
    });

    await expect(upDevcontainer(options)).rejects.toThrow("privileged is not allowed");

    expect(await inspectDevcontainer(options.name)).toBe("absent");
  });

  it("removes a privileged container that up keeps", async () => {
    const options = await optionsFor(imageConfig);
    const label = `halinka.sandbox=${options.name}`;
    docker("run", "-d", "--privileged", "--label", label, image, "sleep", "infinity");

    await expect(upDevcontainer(options)).rejects.toThrow("privileged is not allowed");

    expect(docker("ps", "-aq", "--filter", `label=${label}`)).toBe("");
  });

  it("limits the memory and the CPUs of each compose service, also over its own limits", async () => {
    const options = await optionsFor(
      composeConfig({}, [
        "    mem_limit: 1g",
        "    cpus: 2",
        "    deploy: { resources: { limits: { memory: 1g, cpus: '2' } } }",
      ]),
    );

    const { containerId } = await upDevcontainer({ ...options, limits });

    expect([containerId, findServiceContainer(options.name, "side")].map(inspectLimits)).toEqual([
      "268435456 268435456 500000000",
      "268435456 268435456 500000000",
    ]);
  });

  it("changes the limits of each compose service that an earlier up made", async () => {
    const options = await optionsFor(composeConfig());
    await upDevcontainer({ ...options, limits });

    const { containerId } = await upDevcontainer({
      ...options,
      limits: { memory: 128 * 1024 ** 2, cpus: 1 },
    });

    const { proxy } = runNetworksOf(options.name);
    expect(
      [containerId, findServiceContainer(options.name, "side"), proxy].map(inspectLimits),
    ).toEqual([
      "134217728 134217728 1000000000",
      "134217728 134217728 1000000000",
      "268435456 268435456 0",
    ]);
  });

  it("keeps a compose service on the network of the container when up restarts it", async () => {
    const options = await optionsFor(composeConfig({}, ['    network_mode: "service:app"']));
    await upDevcontainer(options);

    const { containerId } = await upDevcontainer(options);

    const readNetworkNamespace = (container: string) =>
      docker("exec", container, "readlink", "/proc/1/ns/net");
    expect(readNetworkNamespace(findServiceContainer(options.name, "side"))).toBe(
      readNetworkNamespace(containerId),
    );
  });

  it("starts a compose service that uses the network of another service", async () => {
    const options = await optionsFor(composeConfig({}, ['    network_mode: "service:app"']));

    const { containerId } = await upDevcontainer(options);

    expect(docker("exec", findServiceContainer(options.name, "side"), "hostname")).toBe(
      docker("exec", containerId, "hostname"),
    );
  });

  it("sets the restart policy no on each compose service", async () => {
    const options = await optionsFor(composeConfig({}, ["    restart: always"]));

    await upDevcontainer(options);

    const side = findServiceContainer(options.name, "side");
    expect(docker("inspect", side, "--format", "{{.HostConfig.RestartPolicy.Name}}")).toBe("no");
  });

  const withLifecycleFetch = async (fetchTail: string) => {
    const options = await optionsFor(imageConfig);
    await startRunNetwork(options.name);
    const outside = startOutside(options.name);
    const postCreateCommand = `wget -q -T 5 -O /tmp/setup ${outside.url} ${fetchTail}`;
    const config = { image, postCreateCommand };
    await writeFile(join(options.treeFolder, options.configPath), JSON.stringify(config));
    return { options, outside };
  };

  it("lets the lifecycle commands reach the hosts of the setup network", async () => {
    const { options, outside } = await withLifecycleFetch("");

    const { containerId } = await upDevcontainer({ ...options, setupNetwork: [outside.host] });

    expect(docker("exec", containerId, "cat", "/tmp/setup")).toBe("outside");
  });

  it("refuses the lifecycle commands a host outside the setup network", async () => {
    const { options } = await withLifecycleFetch("2>/tmp/refusal || true");

    const { containerId } = await upDevcontainer(options);

    expect(docker("exec", containerId, "cat", "/tmp/refusal")).toContain("403");
  });

  it("mounts the workspace folder, not its Git root", async () => {
    const repo = await tempFolderWith({ "repo-file": "repo", "workspace/marker": "workspace" });
    await hostGit(repo).run("init");
    const options = {
      ...(await optionsFor(imageConfig)),
      workspaceFolder: join(repo, "workspace"),
    };

    const { containerId, remoteWorkspaceFolder } = await upDevcontainer(options);

    expect(docker("exec", containerId, "ls", `${remoteWorkspaceFolder}/..`)).not.toContain(
      "repo-file",
    );
  });

  it("mounts the workspace in place of the tree in every compose service", async () => {
    const options = await optionsFor(composeConfig());

    const { containerId } = await upDevcontainer(options);

    const side = findServiceContainer(options.name, "side");
    expect([
      docker("exec", containerId, "cat", "/workspaces/app/marker"),
      docker("exec", containerId, "cat", "/sub/marker"),
      docker("exec", side, "cat", "/src/marker"),
    ]).toEqual(["workspace", "workspace sub", "workspace"]);
  });

  it("keeps the volumes of the compose services", async () => {
    const options = await optionsFor(composeConfig());

    await upDevcontainer(options);

    const mounts = docker(
      "inspect",
      findServiceContainer(options.name, "side"),
      "--format",
      "{{json .Mounts}}",
    );
    expect(JSON.parse(mounts)).toContainEqual(
      expect.objectContaining({ Type: "volume", Destination: "/data" }),
    );
  });

  it("moves the binds of a service in a profile", async () => {
    const options = await optionsFor(
      composeConfig({ runServices: ["app", "side"] }, ["    profiles: [extra]"]),
    );

    await upDevcontainer(options);

    expect(docker("exec", findServiceContainer(options.name, "side"), "cat", "/src/marker")).toBe(
      "workspace",
    );
  });

  it("refuses a host-affecting setting before anything runs", async () => {
    const marker = join(await tempFolderWith({}), "initialized");
    const options = await optionsFor({
      ".devcontainer/devcontainer.json": JSON.stringify({
        image,
        privileged: true,
        initializeCommand: `touch ${marker}`,
      }),
    });

    await expect(upDevcontainer(options)).rejects.toThrow("privileged is not allowed");

    expect(await inspectDevcontainer(options.name)).toBe("absent");
    expect(await pathExists(marker)).toBe(false);
  });

  it("brings up a container with a Feature of the built-in publisher", async () => {
    const feature = "ghcr.io/devcontainers/features/common-utils:2";
    const options = await optionsFor({
      ".devcontainer/devcontainer.json": JSON.stringify({
        image,
        features: { [feature]: { installZsh: false, upgradePackages: false, username: "none" } },
      }),
    });

    const { containerId } = await upDevcontainer(options);

    expect(docker("exec", containerId, "sh", "-c", "command -v bash")).toBe("/bin/bash");
  });

  it("refuses a Feature of another publisher before the CLI fetches it", async () => {
    const id = "localhost:1/acme/features/tool:1";
    const options = await optionsFor({
      ".devcontainer/devcontainer.json": JSON.stringify({ image, features: { [id]: {} } }),
    });

    await expect(upDevcontainer(options)).rejects.toThrow(`features: ${id} is not allowed`);

    expect(await inspectDevcontainer(options.name)).toBe("absent");
  });

  it("refuses an install order entry of another publisher before the CLI fetches it", async () => {
    const id = "localhost:1/acme/features/tool:1";
    const config = { image, overrideFeatureInstallOrder: [id] };
    const options = await optionsFor({ ".devcontainer/devcontainer.json": JSON.stringify(config) });

    await expect(upDevcontainer(options)).rejects.toThrow(`features: ${id} is not allowed`);

    expect(await inspectDevcontainer(options.name)).toBe("absent");
  });

  it("gives the CLI an empty home", async () => {
    const config = { image, containerEnv: { RUNNER_HOME: "${localEnv:HOME}" } };
    const options = await optionsFor({ ".devcontainer/devcontainer.json": JSON.stringify(config) });

    const { containerId } = await upDevcontainer(options);

    expect(docker("exec", containerId, "printenv", "RUNNER_HOME")).toMatch(
      /halinka-devcontainer-[^/]+\/home$/,
    );
  });

  it("makes the home folder when it does not exist", async () => {
    const parent = await tempFolderWith({});
    vi.stubEnv("HALINKA_HOME", join(parent, "new-home"));
    const options = await optionsFor(imageConfig);

    const { containerId } = await upDevcontainer(options);

    expect(containerId).not.toBe("");
  });

  it("hides the runner's environment from the configuration", async () => {
    vi.stubEnv("HALINKA_TEST_SECRET", "secret");
    vi.stubEnv("GITHUB_TOKEN", "ghp_secret");
    vi.stubEnv("DEVCONTAINERS_OCI_AUTH", "ghcr.io|user|secret");
    const config = {
      image,
      containerEnv: {
        SECRET: "${localEnv:HALINKA_TEST_SECRET}",
        TOKEN: "${localEnv:GITHUB_TOKEN}",
        AUTH: "${localEnv:DEVCONTAINERS_OCI_AUTH}",
      },
    };
    const options = await optionsFor({ ".devcontainer/devcontainer.json": JSON.stringify(config) });

    const { containerId } = await upDevcontainer(options);

    expect(docker("exec", containerId, "sh", "-c", 'echo "$SECRET$TOKEN$AUTH"')).toBe("");
  });

  it("refuses a compose config with a published port before anything runs", async () => {
    const options = await optionsFor(composeConfig({}, ["    ports: ['8080:80']"]));

    await expect(upDevcontainer(options)).rejects.toThrow(
      "compose service side: ports is not allowed",
    );

    expect(docker("ps", "-aq", ...projectFilter(options.name))).toBe("");
  });

  it("refuses a compose env file outside the repository", async () => {
    const envFile = join(await tempFolderWith({ "outside.env": "NAME=value" }), "outside.env");
    const options = await optionsFor(composeConfig({}, [`    env_file: ['${envFile}']`]));

    await expect(upDevcontainer(options)).rejects.toThrow(
      /compose service side: env_file: \S*outside\.env is outside the repository/,
    );
  });

  it("refuses a compose config for a workspace folder whose name holds $ before anything runs", async () => {
    const options = await optionsFor(composeConfig());
    const workspaceFolder = join(options.workspaceFolder, "a$b");
    await mkdir(workspaceFolder);

    await expect(upDevcontainer({ ...options, workspaceFolder })).rejects.toThrow(
      "The devcontainer CLI does not escape $ in a Compose file",
    );

    expect(docker("ps", "-aq", ...projectFilter(options.name))).toBe("");
  });

  it("mounts the workspace of an image config whose folder name holds $", async () => {
    const options = await optionsFor(imageConfig);
    const workspaceFolder = join(options.workspaceFolder, "a$b");
    await mkdir(workspaceFolder);
    await writeFile(join(workspaceFolder, "marker"), "dollar");

    const { containerId, remoteWorkspaceFolder } = await upDevcontainer({
      ...options,
      workspaceFolder,
    });

    expect(docker("exec", containerId, "cat", `${remoteWorkspaceFolder}/marker`)).toBe("dollar");
  });

  it("refuses the problems of devcontainer.json and compose in one error", async () => {
    const options = await optionsFor(
      composeConfig({ privileged: true }, ["    ports: ['8080:80']"]),
    );

    await expect(upDevcontainer(options)).rejects.toThrow(
      /privileged is not allowed\n.*compose service side: ports is not allowed/s,
    );
  });

  it("refuses a bind whose name holds $ and reaches a symlink out of the workspace", async () => {
    const options = await optionsFor(appVolumeConfig("../$$escape:/escape"));
    await symlink("/", join(options.workspaceFolder, "$escape"));

    await expect(upDevcontainer(options)).rejects.toThrow("$escape is outside the workspace");
  });

  it("mounts a workspace folder whose name holds $", async () => {
    const options = await optionsFor(appVolumeConfig("../$$dir:/dir"));
    await mkdir(join(options.workspaceFolder, "$dir"));
    await writeFile(join(options.workspaceFolder, "$dir/marker"), "dollar");

    const { containerId } = await upDevcontainer(options);

    expect(docker("exec", containerId, "cat", "/dir/marker")).toBe("dollar");
  });

  it("accepts folders given through symlinks", async () => {
    const options = await optionsFor(composeConfig());
    const links = await tempFolderWith({});
    await symlink(options.treeFolder, join(links, "tree"));
    await symlink(options.workspaceFolder, join(links, "workspace"));

    const { containerId } = await upDevcontainer({
      ...options,
      treeFolder: join(links, "tree"),
      workspaceFolder: join(links, "workspace"),
    });

    expect(docker("exec", containerId, "cat", "/workspaces/app/marker")).toBe("workspace");
  });

  it("gives each name its own compose project", async () => {
    const first = await optionsFor(composeConfig());
    const second = { ...(await optionsFor(composeConfig())), treeFolder: first.treeFolder };
    await upDevcontainer(first);

    await upDevcontainer(second);

    expect(await inspectDevcontainer(first.name)).toBe("running");
  });

  it("reports a running sandbox", async () => {
    const options = await optionsFor(imageConfig);
    await upDevcontainer(options);

    expect(await inspectDevcontainer(options.name)).toBe("running");
  });

  it("reports a stopped sandbox", async () => {
    const options = await optionsFor(imageConfig);
    await upDevcontainer(options);

    await stopDevcontainer(options.name);

    expect(await inspectDevcontainer(options.name)).toBe("stopped");
  });

  it("reports the state of each sandbox in one call", async () => {
    const running = await optionsFor(imageConfig);
    const stopped = await optionsFor(imageConfig);
    await upDevcontainer(running);
    await upDevcontainer(stopped);
    await stopDevcontainer(stopped.name);

    const states = await inspectDevcontainers();

    expect([states.get(running.name), states.get(stopped.name)]).toEqual([
      { main: "running", isActive: true },
      { main: "stopped", isActive: false },
    ]);
  });

  it("reports a sandbox whose service runs without its main container as active", async () => {
    const options = await optionsFor(composeConfig());
    await upDevcontainer(options);

    docker("stop", "--timeout", "0", findServiceContainer(options.name, "app"));

    expect((await inspectDevcontainers()).get(options.name)).toEqual({
      main: "stopped",
      isActive: true,
    });
  });

  it("reports a paused sandbox as active, not as running", async () => {
    const options = await optionsFor(imageConfig);
    await upDevcontainer(options);

    docker("pause", mainContainer(options.name));

    expect((await inspectDevcontainers()).get(options.name)).toEqual({
      main: "stopped",
      isActive: true,
    });
  });

  it("stops a paused sandbox", async () => {
    const options = await optionsFor(imageConfig);
    await upDevcontainer(options);
    docker("pause", mainContainer(options.name));

    await stopDevcontainer(options.name);

    expect((await inspectDevcontainers()).get(options.name)?.isActive).toBe(false);
  });

  it("starts a paused sandbox again", async () => {
    const options = await optionsFor(imageConfig);
    await upDevcontainer(options);
    docker("pause", mainContainer(options.name));

    await upDevcontainer(options);

    expect(await inspectDevcontainer(options.name)).toBe("running");
  });

  it("reports a sandbox that does not exist as absent", async () => {
    expect(await inspectDevcontainer(`halinka-test-${process.pid}-none`)).toBe("absent");
  });

  it("reports a sandbox with only its run network as absent", async () => {
    const { name } = await optionsFor(imageConfig);

    await startRunNetwork(name);

    expect(await inspectDevcontainer(name)).toBe("absent");
  });

  it("stops every container of the sandbox", async () => {
    const options = await optionsFor(composeConfig());
    await upDevcontainer(options);

    await stopDevcontainer(options.name);

    expect(docker("ps", "-q", ...projectFilter(options.name))).toBe("");
  });

  it("starts a stopped sandbox again in the same container", async () => {
    const options = await optionsFor(composeConfig());
    const { containerId } = await upDevcontainer(options);
    await stopDevcontainer(options.name);

    const started = await upDevcontainer(options);

    expect(started.containerId).toBe(containerId);
    expect(await inspectDevcontainer(options.name)).toBe("running");
  });

  const findNetworks = (name: string) =>
    [
      ...docker("network", "ls", "-q", ...projectFilter(name)).split("\n"),
      ...docker("network", "ls", "-q", "--filter", `label=halinka.network=${name}`).split("\n"),
    ].filter(Boolean);

  it("holds no Docker network while a compose sandbox is stopped", async () => {
    const options = await optionsFor(composeConfig());
    await upDevcontainer(options);

    await stopDevcontainer(options.name);

    expect(findNetworks(options.name)).toEqual([]);
  });

  it("gives a stopped compose sandbox isolated networks again", async () => {
    const options = await optionsFor(composeConfig());
    const { containerId } = await upDevcontainer(options);
    await stopDevcontainer(options.name);

    await upDevcontainer(options);

    const networks = {
      [`${options.name}_default`]: true,
      [runNetworksOf(options.name).internal]: true,
    };
    expect(isolatedByNetwork(containerId)).toEqual(networks);
    expect(isolatedByNetwork(findServiceContainer(options.name, "side"))).toEqual(networks);
  });

  it("finds the services and the proxy by name after a second stop", async () => {
    const options = await optionsFor(composeConfig());
    const { containerId } = await upDevcontainer(options);
    await stopDevcontainer(options.name);
    await upDevcontainer(options);
    await stopDevcontainer(options.name);

    await upDevcontainer(options);

    expect(docker("exec", containerId, "getent", "hosts", "side")).not.toBe("");
    expect(docker("exec", containerId, "getent", "hosts", "halinka-proxy")).not.toBe("");
  });

  it("starts a stopped sandbox again with a service that it never built", async () => {
    const options = await optionsFor({
      ".devcontainer/devcontainer.json": JSON.stringify({
        dockerComposeFile: "compose.yml",
        service: "app",
        runServices: ["app"],
        workspaceFolder: "/workspaces/app",
      }),
      ".devcontainer/compose.yml": [
        "services:",
        "  app:",
        `    image: ${image}`,
        "    command: sleep infinity",
        "    volumes: ['..:/workspaces/app']",
        "  unbuilt:",
        "    build: .",
      ].join("\n"),
    });
    const { containerId } = await upDevcontainer(options);
    await stopDevcontainer(options.name);

    const started = await upDevcontainer(options);

    expect(started.containerId).toBe(containerId);
    expect(findServiceContainer(options.name, "unbuilt")).toBe("");
  });

  it("starts a compose sandbox that stopped with its networks kept", async () => {
    const options = await optionsFor(composeConfig());
    const { containerId } = await upDevcontainer(options);
    docker("stop", "--timeout", "0", containerId, findServiceContainer(options.name, "side"));

    await upDevcontainer(options);

    expect(docker("exec", containerId, "getent", "hosts", "side")).not.toBe("");
  });

  it("starts a sandbox again when a stop cannot remove a network in use", async () => {
    const options = await optionsFor(imageConfig);
    const { containerId } = await upDevcontainer(options);
    startOutside(options.name);
    await stopDevcontainer(options.name);

    await upDevcontainer(options);

    expect(docker("inspect", "--format", "{{.State.Running}}", containerId)).toBe("true");
  });

  it("starts a stopped image config again in the same container", async () => {
    const options = await optionsFor(imageConfig);
    const { containerId } = await upDevcontainer(options);
    await stopDevcontainer(options.name);

    const started = await upDevcontainer(options);

    expect(started.containerId).toBe(containerId);
    expect(await inspectDevcontainer(options.name)).toBe("running");
  });

  it("removes the container of an image config", async () => {
    const options = await optionsFor(imageConfig);
    await upDevcontainer(options);

    await deleteDevcontainer(options.name);

    expect(await inspectDevcontainer(options.name)).toBe("absent");
  });

  it("removes the containers, networks and volumes of a compose config", async () => {
    const options = await optionsFor(composeConfig());
    await upDevcontainer(options);

    await deleteDevcontainer(options.name);

    const filter = projectFilter(options.name);
    expect([
      docker("ps", "-aq", ...filter),
      docker("network", "ls", "-q", ...filter),
      docker("volume", "ls", "-q", ...filter),
    ]).toEqual(["", "", ""]);
  });

  it("removes the run networks and the proxy", async () => {
    const options = await optionsFor(imageConfig);
    await upDevcontainer(options);

    await deleteDevcontainer(options.name);

    const filter = ["--filter", `label=halinka.network=${options.name}`];
    expect([docker("ps", "-aq", ...filter), docker("network", "ls", "-q", ...filter)]).toEqual([
      "",
      "",
    ]);
  });

  it("removes what a failed up made", async () => {
    const options = await optionsFor(failingConfig);

    await expect(upDevcontainer(options)).rejects.toThrow("postCreateCommand");

    expect(docker("ps", "-aq", ...projectFilter(options.name))).toBe("");
  });

  it("stops up at an abort", async () => {
    const { started } = await abortedUp();

    await expect(started).rejects.toMatchObject({ name: "AbortError" });
  });

  it("removes what up made at an abort", async () => {
    const { options, started } = await abortedUp();

    await started.catch(() => {});

    expect(docker("ps", "-aq", ...projectFilter(options.name))).toBe("");
  });

  it("stops a kept sandbox when up fails after its start", async () => {
    const options = await failedUpAfterStart();

    expect(await inspectDevcontainer(options.name)).toBe("stopped");
  });

  it("frees the networks of a kept sandbox when up fails after its start", async () => {
    const options = await failedUpAfterStart();

    expect(findNetworks(options.name)).toEqual([]);
  });

  it("keeps an existing sandbox stopped when up fails", async () => {
    const options = await optionsFor(imageConfig);
    await upDevcontainer(options);

    await expect(upDevcontainer({ ...options, configPath: "missing.json" })).rejects.toThrow();

    expect(await inspectDevcontainer(options.name)).toBe("stopped");
  });
});
