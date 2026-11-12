# CLI

The commands of `halinka` and their rules. Read [overview.md](overview.md#configuration) first.

The `halinka` command (`apps/cli`) is the only Node entry. `main.ts` lists the commands and their usage. Repo
configuration (`.halinka/`, committed) and instance configuration (`$HALINKA_HOME`, per machine) are separate: `init`
writes only the first; `start`, `server` and `runner` write only the second.

## Rules

- `parseArgs` from `node:util` with `strict: true`, so an unknown flag is an error. `main.ts` maps a command name to a
  handler with a dynamic import.
- A secret is never a flag value, because shell history and `ps` show flags. Read it from stdin or a hidden prompt.
- A flag overrides its environment variable. Each prompt has a flag, so scripts need no terminal (`--yes`).
- One resolver (`serverChoice.ts`) gives the server of each command. `run`, `agent`, `status`, `open`, `ssh` and
  `logout`: `--server`, then `HALINKA_SERVER_URL`, then `halinka use`, then the fallback of the command (the repo for
  `run`, this machine for `agent`, `status` and `open`, none for `ssh` and `logout`). `init` takes its flag, a prompt or
  `local`. `login` and `runner` need `--server`; `runner` also takes `ws` and `wss`. `local` is the URL in
  `$HALINKA_HOME/server.json`, or `http://127.0.0.1:7070` without that file.
- Each command that sends something (a token, a login, a key, a path, a run) refuses `http` to a host that is not
  loopback: all commands but `open` and `use`, and `runner` only without `--insecure`.
- `halinka` uses the current folder. The root scripts `pnpm start` and `pnpm halinka` run the CLI from the root of the
  checkout.
- `safeText` removes control characters from the text of the server or a run.

## Set up a repo

- `setup` prints instructions for a coding agent that sets up Halinka, and changes nothing: it writes no skill or
  rules file in the repo. The text is in the package, so it agrees with the installed version. A test parses its
  examples.
- `init` works in a git repo without `.halinka/`. It writes `.halinka/config.yml`, `.halinka/workflows/smoke.yml` and,
  with `--devcontainer create`, `.devcontainer/devcontainer.json`. It writes all files or none. The portal writes the
  same files (`@halinka/runner/repoSetup`). `init` registers the repo when this machine has a runner key and the server
  answers. It prints the reason of a refusal; without a key, the next steps say how to make the machine a runner. It
  never creates a key or starts a process.
- `check` parses `.halinka/` with the parsers and presets of the installed CLI, and checks that the devcontainer file
  exists. It needs no server. A parser problem prints as `path:line:column message`. Any problem gives exit code 1.
- `migrate` uses `migrateDefinition` ([workflows.md](workflows.md#files)) to change the `.halinka/` files that have no
  `schema_version`. It prints each change as `path:line message`, with the lines of the old file, and each note of the
  migration once. Without `--write` it writes nothing. It parses the new text with the parsers and presets of `check`
  and prints the problems that stay, with the lines of the new file. It does not change a symbolic link, and it does
  not write a file that changed after it read the file; each such file, and each file that it could not write, is a
  problem. Each file keeps its mode. A problem gives exit code 1. To migrate a GitHub repo, run `migrate --write` in a
  clone, then commit and push.

## `halinka run`

- Asks the server for a run of the repo and follows it. The CLI is not a runner: the runner of the repo executes the run.
- Server fallback: `server` in `.halinka/config.yml`. A remote server that only the repo selects needs a login first.
- This machine must be a runner of the server. `run` registers the repo when `repos.list` does not show it for this
  runner.
- Prints the start and end of each step attempt, each gate result, command output (stderr to stderr) and agent text.
  No prompts, thoughts or tool calls.
- Reads the run at each `state` of the stream and every 30 s (`watchRun`, which the portal also uses), because a stream
  can stop without an error. One read runs at a time, and at most one waits. Prints each new
  wait reason, and the portal link each time the run starts to wait for a person.
- Exit code: 0 for `succeeded`, 1 for other results and refusals, 130 for Ctrl+C. Ctrl+C leaves the run running.

## `halinka start` and `halinka server`

- `start` runs the server, the portal and a runner in one process. The runner uses the in-memory transport and its key
  in `runner.json`. `server` runs no runner; it listens on `127.0.0.1`, or on `--host` only with a login.
- Database: PGlite in `$HALINKA_HOME/db`, or Postgres from `DATABASE_URL`. The portal comes from `portal/` next to the
  package code, or from `apps/portal/dist` in a checkout.
- Both take `$HALINKA_HOME/server.lock` before they open the database, and write their URL to `server.json`. A stop
  removes the file; after a crash it stays until the next start.
- `start` inside a repo with `server: local` registers that repo. `start` prints the problems of a
  `.halinka/config.yml` that is not valid, as `check` does, and does not register the repo.
- Ctrl+C, SIGTERM and SIGHUP stop gracefully ([runners.md](runners.md#supervisor)).
- Login: set all of `HALINKA_PUBLIC_URL`, `HALINKA_AUTH_SECRET`, `HALINKA_GITHUB_CLIENT_ID`,
  `HALINKA_GITHUB_CLIENT_SECRET` and `HALINKA_ADMIN_GITHUB`, or none. `start` never has a login. A runner must connect
  with `HALINKA_PUBLIC_URL`. `HALINKA_TRUSTED_PROXY` holds the address of the proxy in front of the server.

## `halinka runner`

- Makes this machine a runner of the server: the device flow or an enrollment token at the first start, the saved key
  later ([runners.md](runners.md#registration)).
- Takes the lock of the runner home, sends the signed probe, then enrolls only an unknown key. Under its unit with
  self-update on, an update request or another protocol version installs the build of the server first
  ([runners.md](runners.md#connection)); `--no-self-update` turns this off, and `--probe-only` is the check of a new
  build
  ([runners.md](runners.md#connection)). `--enroll-only` stops after the enrollment. `--unit <name>` says that the
  systemd unit of `install` runs it: there an unknown key and another protocol version exit 78, as a start does not
  update yet.
- `halinka runner install` (Linux): downloads and checks the package of the server and installs it in a stage folder
  (`runnerVersions.ts`) while the old unit still runs, then stops the unit, lets the installed build enroll in the
  terminal (it starts the old unit again when that fails), points `versions/current` to it, writes the
  user unit (`runnerUnit.ts`: absolute `node`, `Restart=always`, `RestartPreventExitStatus=78`, `KillMode=mixed`,
  `TimeoutStopSec=300`, a start limit of 5 in 10 min), turns on linger, starts the unit, writes the wrapper
  `~/.local/bin/halinka`, and waits for "connected" in the log of that start. `status` and `uninstall` manage the
  unit (`userSystemd.ts` calls `systemctl --user`).
- Tries again on network errors. Ends with the reason when the server ends the connection for good (revoke, rotation).
  The exit code is 75 when the server uses another protocol version (install the version of the server) and 78 for
  another refusal, so that a service manager starts the runner again only after 75.
- `--root <path>` (the home folder by default, repeatable) gives the only folders that the server can reach
  ([runners.md](runners.md#connection)). `start` has no limit, because the server is the same process.

Flags of `start` and `runner`:

| Flag | Default | Purpose |
| --- | --- | --- |
| `--runs-in <devcontainer\|worktree>` | `devcontainer` | Where runs execute ([sandbox.md](sandbox.md)). `worktree` has no isolation and uses the user's own agent login. |
| `--capacity <number>` | 4 | Runs that execute at one time. A run that waits for a person does not count. |
| `--reach <address\|cidr>` | none | A private address that devcontainer steps can reach through the egress proxy. Repeatable. |
| `--trust-features <registry/path/>` | none | A devcontainer Feature publisher to trust besides `ghcr.io/devcontainers/features/`: a registry with a dot in its name and a path that ends in `/`. Repeatable. Registry auth: `docker login` as the runner user. |
| `--docker-in-container` | off | Give Docker to the container of a run whose repo has `setup.docker: true`, with Sysbox ([sandbox.md](sandbox.md#docker-inside-the-container)). Linux only. |
| `--memory <size>` | half of the Docker host memory | Memory of each run container, without swap. On Docker Desktop the Docker host is the VM. |
| `--cpus <number>` | no limit | CPUs of each run container. |

## `halinka login`, `logout` and `use`

- `login --server <url>` shows a code and a link. A member who is logged in to the portal approves the code, and the CLI
  gets a token that acts as that member for 90 days. The token stays in `$HALINKA_HOME/logins.json` (0600) and goes only
  to the exact URL of its login. The server keeps hashes only.
- Approve only a code that your own terminal shows: anyone can start a request, and the member who approves it makes
  that CLI act as the member. The CLI prints the member name.
- `use <url>` selects a server that has a login for the next commands; `use repo` ends the choice.
- `logout` ends the token of this machine. When the server does not answer, the token stays, so the person can try
  again. The Terminals page of the portal ends any token of its member.
- `login`, `logout` and `use` change `logins.json` under a lock, from the latest file, with no network call in the
  lock. `logout` deletes only the token that it ended: a new login of another command stays.

## `halinka agent`

- `list`, `enable`, `disable`, `version`, `model`, `key`, `test`: the API of the Agents page. One table gives the
  arguments and flags of each action, and the usage; a flag of another action is an unknown flag. Server fallback: the server
  on this machine. `key` reads stdin or a hidden prompt; `--mine` sets the person's own key. `test` waits for the result
  and exits with 1 when the test fails.
- `agent login codex [--device-auth]` runs `codex login` with a temporary `CODEX_HOME` and the file store, so Halinka
  gets its own refresh chain and `~/.codex` keeps working. It keeps only the ChatGPT tokens, writes
  `$HALINKA_HOME/logins/codex.json` (0600), and needs `codex` on `PATH`.

## `halinka status`, `open` and `ssh`

- `status` prints the server, its runners, its agents and the active runs. It exits with 1 when the server does not
  answer or asks for a login. Server fallback: the server on this machine.
- `open` prints the portal address and gives it to `open`, `xdg-open` or `rundll32`, with no shell. It sends no token,
  so `http` is allowed.
- `ssh <run>` is an ssh `ProxyCommand`: it pipes stdin and stdout to the relay of the run ([runners.md](runners.md#relay)).
  `ssh config` writes a block for `~/.ssh/config` with the path of the running file; under `npx` that path can go
  away, so install the package globally. `ssh known-hosts <run>` prints the key of the run's runner and saves it at
  the first use. ssh gives the `ProxyCommand` to a shell with the host name as it is, so the block puts the name in
  single quotes, and `halinka ssh` takes only `<prefix><digits>` or the bare id. Use OpenSSH 9.6 or later: it refuses
  a host name with shell characters, also a `'`, that a link or a submodule URL can give.

## Decisions

- One server resolver for all commands. Rejected: a server check in each command (six variants; `init` and `logout`
  sent a path and a token over `http` with no check).
- The CLI reads the current folder, and the root scripts run `node --import tsx apps/cli/src/main.ts`, so the root has
  `tsx`. Rejected: `INIT_CWD` of `pnpm --filter` (the script runs in the package folder, and other processes inherit
  the variable).
- No `halinka dev`. Rejected: `halinka dev` with a compose file (a process manager to maintain); `pnpm dev` does the
  same, with `DATABASE_URL` for Postgres.
- One server per `$HALINKA_HOME`. Rejected: `--port` on `init` and `run` (the user gives the port again, and two
  processes can open one database).
- Ctrl+C in `run` leaves the run, and the exit code 130 tells a script that the run has no result yet. Rejected: Ctrl+C
  cancels the run (a closed terminal ends agent work that a person can still use).
- `run` checks `repos.list` before `repos.register`, because a person who may run a repo may not register it.
  Rejected: fail for an unknown repo (one more step for the user).
- A CLI token acts only for itself: it cannot approve a login, or list or end another token, so a leaked token cannot
  renew itself or lock out the other terminals of its member. Rejected: the device plugin of Better Auth (a second
  mechanism with its own tables); the session cookie (it ends at a sign-out of the browser).
- The choice of a person wins over the repo, so a cloned repo cannot send a path or inputs to the server of its author.
  `HALINKA_SERVER_URL` counts as the choice of the person.
- A coding agent sets up Halinka with `setup` and `check`. The agent runs as the person and can read saved tokens, so
  "a person enters each key" is a handling rule, not a technical limit. A `github` repo uses `server: local`, so a
  public repo does not name a private server; its files land through a pull request, and a person starts the first run
  after the merge. Setup is done only when a real run has passed. Rejected:
  - `halinka doctor`: from a laptop most of its lines say "unknown".
  - `--json` on `check`: an agent reads the plain lines, and nothing else reads them.
  - a wizard with its own LLM or an MCP server: neither solves a problem that the CLI does not.
