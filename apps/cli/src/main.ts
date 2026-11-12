#!/usr/bin/env node
const usage = `Usage: halinka <command>
       halinka --version

Commands:
  setup   Prints instructions for a coding agent that sets up Halinka
  init    Writes .halinka/ in this repo
  check   Checks .halinka/ in this repo, with no server
  migrate Changes the .halinka/ files of this repo to the current schema_version
  run     Asks the server for a run of this repo, and follows it
  start   Runs the server and a runner on this machine
  server  Runs the server without a runner
  runner  Makes this machine a runner of a server
  agent   Changes the agents of a server, or logs in an agent on this machine
  login   Logs this machine in to a server
  logout  Ends the login of this machine on a server
  use     Selects the server of the next commands
  status  Shows the server, its runners, its agents and the active runs
  open    Opens the portal of the server in the browser
  ssh     Connects ssh to the container of a run, for VS Code`;

type Command = (args: string[]) => Promise<void>;

const commands: Record<string, () => Promise<Command>> = {
  setup: async () => (await import("./setup")).setup,
  init: async () => (await import("./init")).init,
  check: async () => (await import("./check")).check,
  migrate: async () => (await import("./migrate")).migrate,
  run: async () => (await import("./run")).run,
  start: async () => (await import("./start")).start,
  server: async () => (await import("./server")).server,
  runner: async () => (await import("./runner")).runner,
  agent: async () => (await import("./agent")).agent,
  login: async () => (await import("./login")).login,
  logout: async () => (await import("./logout")).logout,
  use: async () => (await import("./use")).use,
  status: async () => (await import("./status")).status,
  open: async () => (await import("./open")).open,
  ssh: async () => (await import("./ssh")).ssh,
};

const [name, ...args] = process.argv.slice(2);
const load = name && Object.hasOwn(commands, name) ? commands[name] : undefined;
if (name === "--version") {
  const [{ readBuild }, { buildLabelOf }] = await Promise.all([
    import("./readBuild"),
    import("@halinka/utils/buildLabel"),
  ]);
  const { version, id } = await readBuild();
  console.log(buildLabelOf(version, id));
} else if (load) {
  const command = await load();
  await command(args);
} else {
  console.error(usage);
  process.exit(name ? 1 : 0);
}

export {};
