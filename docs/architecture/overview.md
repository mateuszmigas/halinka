# Overview

Halinka runs agent workflows on repositories: a server keeps the state, runners execute the runs. Read this doc first,
then the topic doc of your part: [runners.md](runners.md), [sandbox.md](sandbox.md), [agents.md](agents.md),
[workflows.md](workflows.md), [github.md](github.md), [portal.md](portal.md), [cli.md](cli.md). The import rules of the
packages are in `.agents/guides/architecture.md`.

## Vision

Halinka is a self-hostable platform that automates the software development lifecycle with coding agents:

- GitHub events, schedules or a person in the portal start workflows.
- Steps run coding agents (any ACP agent) in isolated workspaces, and deterministic gates (tests, lint, e2e) check each
  agent attempt.
- The inbox gets a person when a step needs input or approval.
- Each run is observable: timeline, transcript, diff, cost.

Halinka must never run a workflow that breaks user code. Agents never merge: all changes land as pull requests. It does
not use GitHub Actions: loops, the inbox and a workspace that stays across steps do not fit its model. It borrows the
syntax where the meaning is the same (`${{ }}`, `steps`, `id`, `if`, `with`, `outputs`).

## Core rules

These bind the code. The linked docs give the mechanism.

1. **Workflow YAML is loaded from the trusted default branch**, never from the event's head commit. The run pins the
   commit, captures a workflow snapshot and executes only from it; steps, retries, crash recovery and chat never re-read
   YAML ([workflows.md](workflows.md#snapshot)). A PR author must not be able to change `setup`,
   gates or agent prompts of the run their PR triggers: a container build reads the tree of the definition commit,
   never the code of a pull request ([sandbox.md](sandbox.md#workspace-and-build-input)). Fork PRs
   start nothing. A local repo starts its code from `HEAD`, never the working tree; its uncommitted `.halinka/` files go
   into the snapshot of a manual run.
2. **The agent runs inside the sandbox.** The runner installs the agent adapters at pinned versions when the container
   lacks them, starts the agent inside the sandbox and speaks ACP with it over stdio; no network server runs in the
   sandbox ([agents.md](agents.md#acp)).
3. **No GitHub write credentials inside the sandbox.** Push, PR creation and comments happen outside it: on the runner
   with a short-lived token that the server mints per action (or the runner's own `gh` login until the App is
   installed), or on the server through the GitHub API ([github.md](github.md#tokens)).
4. **Webhook-triggered runs require Docker by default.** A host worktree is an explicit "trusted mode" for local or
   manual use ([workflows.md](workflows.md#untrusted-runs)).
5. **Untrusted content is data, not instructions.** Text from GitHub (issue, PR, comment) goes into an agent prompt in
   a delimited data block with a "treat as data" notice. Mapping the trigger actor to a Halinka user does not make the
   content trustworthy.
6. **Secrets are never in the agent's environment.** Secrets that `.halinka/config.yml` declares reach `setup.run` only.
   In a devcontainer the agent never sees the real provider credential: the egress proxy adds it
   ([sandbox.md](sandbox.md#network)).
7. **Agent and shell steps are not idempotent; they are reconcilable.** The runner process that executes a run holds
   its lease; every execution is a `StepAttempt`; a process whose lease lapsed is fenced out and cannot commit state
   ([runners.md](runners.md#leases-and-fencing)). A GitHub action checks for an existing result
   before it acts: an open PR of the run branch, or the stored comment of the step run.
8. **Every agent attempt ends in a checkpoint commit** on the run branch, made by the runner. The diff per step is a
   commit range. Before approval and before PR creation, the exact base SHA and diff are rechecked. The agent never
   owns history ([sandbox.md](sandbox.md#checkpoints)).
9. **Draft test runs have no real side effects:** `github` steps run in dry-run mode (synthetic outputs), no production
   secrets ([workflows.md](workflows.md#test-runs)).

## Concepts

| Concept | Meaning |
|---|---|
| Repository | Where runs get code and definitions: a local git checkout on a runner (`local`) or a GitHub repo that any runner fetches (`github`) |
| Workflow | YAML in a repo: inputs, triggers, steps |
| Trigger | GitHub event filter / cron / manual. Maps event data → workflow `inputs` |
| Step | `agent` / `shell` / `approval` / `github` / `loop`; has `id`, optional `if`, declared `outputs`, `timeout` |
| Loop | Step group repeated until a condition holds, capped by `max_iterations` |
| Runner | A registered machine that executes runs: owns its sandboxes, checkouts and local repos; keeps state between runs |
| Agent | ACP agent program (`claude-code`, `codex`) that executes `agent` steps inside a sandbox; configured per instance |
| Gate | Command run after each agent attempt; pass/fail + `on_fail` policy |
| Run | One execution of a workflow, pinned to a workflow snapshot, with inputs |
| StepRun / StepAttempt | A step within a run / one attempt of it (retries, crash recovery) |
| Workspace / Sandbox | Isolated checkout for a Run: its devcontainer (one per run, steps `exec` into it) or a git worktree |
| Inbox item | Pending human decision tied to a StepRun |
| Draft | Unpublished workflow edit; runnable in dry-run; publishable as PR |

## Components

| Component | Code | Role |
| --- | --- | --- |
| Server | `packages/server` | Owns the database, the HTTP API, dispatch and the runner connections. Serves the built portal. |
| Runner | `packages/runner` | Owns a machine: sandboxes, git checkouts, agents. Executes runs with the engine. |
| Portal | `apps/portal` | The web UI. Static files that the server serves. |
| CLI | `apps/cli` | The `halinka` binary, the only Node entry. |

```
               HTTP (JSON, SSE)                       WebSocket (outbound from the runner)
 browser ─────────────────────────┐              ┌──────────────────────────── runner ── ACP over stdio ── agent
 CLI ─────────────────────────────┴──→  server ←─┘                                │                    (in the sandbox)
                                          │                                       └── git (host only)
                                       Postgres or PGlite
```

## Server and runner

- Only the server opens the database and the stored secrets. A runner reaches run state only through the
  `ControlPlane` over its connection. One exception: a runner holds and refreshes the Codex login of its machine
  ([agents.md](agents.md#credentials)).
- Only runners touch Docker, git checkouts, agents and the host file system. The server never imports `engine`,
  `agents` or `sandbox`, and never starts an agent.
- `halinka start` runs both roles in one process over the in-memory transport; `halinka runner` uses the WebSocket
  transport. Both carry plain JSON and keep the error `code`.
- The sandbox of a run is desired state that the runner applies, so a change works while the runner is offline
  ([runners.md](runners.md#desired-state)). A read or write of the user's checkout is a runner command that fails with
  `RUNNER_OFFLINE`.
- A `local` repo and its runs stay on the runner that holds the checkout.
- The engine is a library that executes one run against a `ControlPlane`, with the sandbox and the agents that the
  runner gives it. An agent attempt never runs inside an HTTP handler.

## Packages

`apps/cli` (the `halinka` CLI), `apps/portal` (the Vite and React SPA), `apps/website` (a placeholder).
`packages/server` (the Hono HTTP API, the runner connections, the database, the API client `@halinka/server/client`),
`packages/runner` (the supervisor, workspaces, sandboxes, the runner key), `packages/protocol` (what the server and
runners share: `ControlPlane`, `RunnerCommands`, the transports, run events, statuses), `packages/engine` (executes a
run against a `ControlPlane`), `packages/workflow` (the YAML schema, the expressions, step edits and completion),
`packages/presets` (the agent kinds), `packages/agents` (the ACP client, the report channel), `packages/sandbox` (the
host and devcontainer sandboxes), `packages/ui` (shadcn on Base UI), `packages/utils` (shared helpers by subpath),
`packages/config` (build configuration). `e2e` holds the Playwright projects (`.agents/guides/testing.md`).

## Run flow

1. `POST /api/runs` reads the definitions of the repo, parses the workflow with the agent presets, resolves `inputs`,
   `branch.name` and the concurrency group, stores the snapshot and creates the run `queued`
   ([workflows.md](workflows.md#snapshot)).
2. A runner of the repo claims the run in `sync` and holds its lease ([runners.md](runners.md#dispatch)).
3. The engine creates a step attempt for each execution, executes it in the sandbox and sends events. The server stores
   them in `workflow_run_events`.
4. A wait for a person is an inbox item and the status `waiting_input` ([workflows.md](workflows.md#inbox)). A decision
   sets the run `running` and wakes its runner. An item that is open for more than 24 h expires the run
   ([runners.md](runners.md#desired-state)).
5. End states: `succeeded`, `failed`, `cancelled`. Cancel ends a `queued` or `expired` run at once; a leased run gets a
   cancel request, and the runner aborts the engine. A result that the engine returns first stays.
6. A runner that stops gives its runs back. After a crash, the lease expires and the server queues the run again;
   recorded steps replay, the interrupted step continues in a new attempt ([runners.md](runners.md#supervisor)).

## Interfaces

- `ControlPlane` and `RunnerCommands` (`packages/protocol/src/`): the two directions of a runner connection
  ([runners.md](runners.md#connection)). `RunDeps`, `RepoSource` and `RunInbox` (`packages/engine/src/runDeps.ts`):
  what the runner gives the engine for one run. `Sandbox` (`packages/sandbox/src/sandbox.ts`), `Agent` and
  `AgentSession` (`packages/agents/src/agent.ts`), `AgentPreset` (`packages/presets/src/agentPresets.ts`).
- All git goes through `Git` (`@halinka/utils/git`) over a sandbox: the sandbox of a run, or a `HostSandbox` on the host
  (`hostGit` in `@halinka/sandbox/host`).

## Protocols

| Connection | Protocol | Notes |
| --- | --- | --- |
| Browser, CLI → server | HTTP, JSON | One REST API from the oRPC contract (`packages/server/src/api/contract.ts`). |
| Browser, CLI ← server | Server-sent events | `GET /api/runs/{id}/stream`, an oRPC event iterator. A client continues after a reconnect from the event's `seq`. |
| Runner → server, registration | HTTP, JSON | The device flow or an enrollment token ([runners.md](runners.md#registration)). |
| Runner ↔ server | WebSocket, JSON | One connection per runner process, opened by the runner ([runners.md](runners.md#connection)). `/api/runner/relay` carries an SSH session to a run. |
| Runner ↔ agent | ACP (JSON-RPC over stdio) | The runner starts the agent in the sandbox. No network server runs in the sandbox. |
| Agent → Halinka | MCP over stdio | The `report_result` and `ask_human` tools ([agents.md](agents.md#report-channel)). |
| Sandbox → internet | HTTP proxy | Devcontainer runs only ([sandbox.md](sandbox.md#network)). |

## Configuration

- Repo configuration: `.halinka/` in the repository, committed ([workflows.md](workflows.md#files)).
- Instance configuration: environment variables and files in `$HALINKA_HOME` (default `~/.halinka/`), per machine.
  The login variables and `HALINKA_SERVER_URL` are in [cli.md](cli.md).

| Variable | Default | Purpose |
| --- | --- | --- |
| `HALINKA_HOME` | `~/.halinka` | `runner.json`, `server.json`, `logins.json`, `master_key`, the PGlite database `db`, `workspaces/<serverId>/`, `github/<serverId>/`. |
| `DATABASE_URL` | PGlite in `$HALINKA_HOME/db` | The Postgres connection string. Only the server opens it. |
| `HALINKA_MASTER_KEY` | `$HALINKA_HOME/master_key`, made at the first start. A server with a login has no default. | 32 bytes in base64 that seal the stored secrets (agent credentials, repo secrets, the GitHub App). Make one: `openssl rand -base64 32`. |
| `HALINKA_ENROLL_TOKEN` | None | A one-time enrollment token for `halinka runner`. |
| `HALINKA_LEASE_SECONDS`, `HALINKA_SWEEP_SECONDS` | 30, 10 | The lease length and the sweep interval, for tests. A value must be above 0 and at most 86400, else the start fails. A lease must stay longer than the sync interval of a runner (5 s). |

- Do not put a secret in a flag value: shell history and `ps` show it.
- The seal protects a copy of the database, not a runner: a runner reads the keys and secrets of the runs that it
  holds, and a `master_key` next to the PGlite folder protects only a database that leaves without the file.

## Auth and roles

- A server has a login when the five login variables are set ([cli.md](cli.md)). Without them, every request acts as an
  Admin, and the server accepts only local requests: it listens on `127.0.0.1`, `/api/*` refuses a `Host` that is not
  `127.0.0.1`, `localhost` or `[::1]` with its port (403), and an agent in the host sandbox can call the API. Do not put
  a reverse proxy in front of a server without a login. Use a server without a login only on a machine with one user:
  another OS user or a container on the host network that opens the port acts as an Admin too
  ([local-secret](../tasks/local-secret.md)).
- With or without a login, a request to `/api/*` that is not `GET` must have `Content-Type: application/json` (415), so
  a web page form cannot send it. The runner socket refuses a web page too ([runners.md](runners.md#connection)).
- Each HTTP answer has `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`: a page of another
  site on the same domain could frame the approval of a CLI login or a runner and put a decoy over its button.
- Better Auth makes the GitHub OAuth flow, the session rows and the cookie, with account linking off. The server exposes
  four of its routes: `sign-in/social`, `callback/github`, `get-session`, `sign-out`. Halinka keeps no GitHub token of a
  user and calls GitHub for no user.
- `members` is the invite list, by GitHub id: a login without a row fails. `HALINKA_ADMIN_GITHUB` gives the first Admin
  at the first login with that name, while no Admin exists. An Admin adds people by GitHub name; the server finds the
  id. A deleted member loses its sessions at once. The last Admin cannot be deleted.
- A CLI login is a Bearer token ([cli.md](cli.md)). It cannot make or end another token.
- Each route has one level in `api/router.ts`: public (`health`, `session`, the start and the exchange of a CLI login,
  runner registration and enrollment), Member, or Admin. Admin: repo registration, setup and delete, writes to workflow
  files, repo secrets, runner settings, keys and enrollment, agent settings, the GitHub App, members. A Member starts
  and approves runs but cannot change the files of a checkout, because a run executes them.
- Rate limit: 60 per minute per address on `/api/runner/*` and on the WebSocket upgrade, and with a login also on
  `/api/auth/*` and `/api/cli-logins/*`, each with its own count. One `RateLimiter` (`rateLimiter.ts`) counts them,
  in a minute that starts at the first request of the address; a refused HTTP request gets `Retry-After`.
  `HALINKA_TRUSTED_PROXY` names the proxy whose last `X-Forwarded-For` entry gives the address. The limiter of Better
  Auth is off, because it counts all clients behind a proxy as one.

## Server stack

- The API is an oRPC contract (`api/contract.ts`), served as REST routes through Hono on `@hono/node-server`. The zod
  schemas check the input and shape the output. A `ServiceError` code is an error code of the contract. Live streams are
  oRPC event iterators: `RunBus` sends only signals (`events`, `state`) after a commit, and a stream reads the rows
  itself. The rules and the layout of `packages/server/src` are in `.agents/guides/server-conventions.md`.
- `Server` (`server.ts`) opens the database, gets the services from `createServices`, and gives each runner process a
  `ServerControlPlane` with the `GitHubAppService` of the factory.
- A repo row has one discriminator, `kind`: a `local` repo has a runner and a path, a `github` repo a GitHub id
  (`repos_kind_check`). `repoPlaceOf` gives the place that a runner gets from the kind.
- `secrets.ts` seals each stored secret with the master key, in a place that names its row. `open` gives no value when
  the key or the place is another one, and the caller decides what that means.
- Every `HALINKA_SWEEP_SECONDS`, `sweep.ts` releases expired leases, fails lost agent tests, expires runs that wait
  more than 24 h, removes sandboxes kept more than 24 h, deletes gone repos and deletes old rows. Each job has its own
  transaction, so a failed job does not stop the next one.
- The server serves the built portal as static files, with `index.html` for client routes. `POST /api/github/webhook`
  comes before the login and host checks, because the signature is its check
  ([github.md](github.md#webhook-and-triggers)).

## Database

- Postgres 15 or later (a unique constraint uses `NULLS NOT DISTINCT`), through `pg` for a `DATABASE_URL`, or
  PGlite in a folder. PGlite has one connection, so transactions run one at a time.
- Drizzle schema in `packages/server/src/db/schema`, one file per table. drizzle-kit generates the numbered migrations in
  `packages/server/src/db/migrations`; `openDb` applies the pending ones at start, in one transaction. Integer identity
  ids.
- `workflow_runs.branch` is generated from `branch_name` or `halinka/run-<id>`, and a partial unique index holds it for
  runs that have not ended. `workflow_run_events` is append-only, and the run stream reads it after `seq`.
- The sweep deletes the `run_calls` of a run that finished more than 24 h ago, expired `runner_enrollments` and
  `cli_logins` rows, and `github_deliveries` that started more than 7 days ago (GitHub can send a delivery again for 3
  days).

## Server id

`server_identities` holds one row of 12 random hex characters, made at the first start. The accept message of a runner
carries it, and the runner uses `$HALINKA_HOME/workspaces/<id>` and `$HALINKA_HOME/github/<id>`, so the files of two
servers never meet. A reconnect that finds another id ends the connection, and the runner stops. `halinka runner` and
`halinka start` print the id. A database reset gives a new, empty scope: no sweep removes the old one; a person deletes
its folders and containers.

## Package build

- `apps/cli` is the package `halinka`; the root is `halinka-workspace`, because pnpm cannot have two projects with one
  name. `pnpm --filter halinka build` runs esbuild: our packages and the npm packages go in the bundle, one chunk per
  command. PGlite and the devcontainer CLI find their files by path, so the build copies them to `dist/node_modules`,
  where Node finds them next to the chunks; a package with dependencies fails
  the build. `halinka` has no npm dependencies. The build writes
  `dist/THIRD_PARTY_LICENSES.txt` from the license files of the bundled packages, or from `apps/cli/third-party-licenses/` for a
  package that ships none, and fails when a package has neither.
- The build writes `dist/build.json` with the build id ([runners.md](runners.md#decisions)); `halinka --version` prints
  the version and the start of that id.
- Migrations, the portal and the `.mjs` scripts are copied to `dist`; the code reads them with
  `new URL("./x", import.meta.url)`. The egress proxy mounts a copy of its script from `$HALINKA_HOME`, named with a
  hash of its content, because Docker Desktop cannot mount a global npm folder.
- `apps/cli` stays `private` until the owner publishes it. `pnpm test:pack` installs the tarball outside the checkout
  as a runner does (offline, with an empty npm cache), loads each chunk, and runs `init`, `start`, the portal and a
  workflow. The image (`infrastructure/Dockerfile`) unpacks the packed tarball of the build, on `node:24.20.0-bookworm-slim`, runs as `node`, and listens on
  all addresses, so it needs a login. The Compose file
  fixes its subnet, so `HALINKA_TRUSTED_PROXY` stays right.

## Limits

- A run branch is not in the server scope: a local checkout can hold `halinka/run-<id>` from an old database, and a new
  run with that name stops with a message. Two live servers on one checkout need different `branch.name` values.

## Decisions

- Server and runner split ([above](#server-and-runner)). Rejected: agent attempts inside HTTP handlers (a slow agent
  blocks the API); runners with database access (each then needs the credentials and the master key).
- Local requests only without a login ([above](#auth-and-roles)). Rejected: a separate listener for remote runners
  before auth (it exposes the runner routes with no user check); an `Origin` check on the API (the host and
  content-type checks already stop form posts and DNS rebinding).
- No page of the portal shows in a frame. Rejected: `SameSite=Strict` on the session cookie (a link from another
  site to the portal then opens it without a login); a second confirmation on the approval pages (the decoy can
  cover it too).
- One REST API from an oRPC contract ([above](#server-stack)). Rejected:
  - TanStack Start server functions: a second API next to the one the CLI needs.
  - hand-written Hono routes: each needs its own check, error mapping and stream code.
  - tRPC: its RPC URLs are a second API next to REST.
  - UUIDv7 ids: integer ids are enough while one database owns the branches; they come back when a stale branch of a
    discarded database collides often.
- An API output has no `null`: no value is an absent field. An input that changes a value takes `null` to clear it.
  Rejected: `null` in the output too (two values for "no value" in the clients); `undefined` to clear (in a change it
  means "keep").
- A boolean in the protocol, the API and a repository input has an `is`, `has` or `can` name; a database column keeps its
  name. Rejected: renamed columns (a migration only for a name).
- Process groups, file locks, retries, expressions, the rate limit and the runner transport stay own code, because each carries a rule
  of Halinka that a library does not keep. A new library comes only with its own proposal (AGENTS.md). Rejected:
  - execa: it does not stop a process group inside a container.
  - proper-lockfile: no takeover that is safe for three takers, no process start time against a reused pid.
  - p-retry: the rules are which errors to repeat, not how to wait.
  - CEL or `@actions/expressions`: other semantics for `??`, missing values and status types.
  - Socket.IO: the handshake, the key check and the method lists are Halinka's.
  - `hono-rate-limiter`: the WebSocket upgrade needs the same count outside Hono, so one own limiter serves both.
- Login through Better Auth with an invite list ([above](#auth-and-roles)). Rejected:
  - an own OAuth flow: Halinka then owns PKCE, cookies, expiry and revocation.
  - any GitHub user as a Member: a stranger can run code on a runner.
  - the members of one GitHub organization: needs `read:org` and the approval of the organization owner; can come later
    as a second way onto the list.
  - the first person who logs in as Admin: a stranger can take Admin before the first login.
- One esbuild bundle of our code and the npm packages, with PGlite and the devcontainer CLI copied to
  `dist/node_modules` ([above](#package-build)): a runner, the image and a registry install run the same bytes, which
  the build id covers, and an install needs no npm registry. The tarball is about 12 MB, most of it PGlite. Rejected:
  - the two packages as exact npm dependencies: npm takes them from the registry of the runner, with no integrity
    from the lockfile.
  - `bundleDependencies`: pnpm refuses it with `nodeLinker: isolated`.
  - npm packages as dependencies with an `npm-shrinkwrap.json`: npm obeys the shrinkwrap of a dependency only from the
    registry, so a runner that installs the tarball of the server gets the newest version of each range. The runner
    then writes its own lockfile, and a stale shrinkwrap installs with no error.
  - `tsx` at run time: each package ships its source, and each `halinka ssh` transforms TypeScript.
  - one npm package per workspace package: ten versions for one program.
  - `tsdown`: a second layer on rolldown, before 1.0.
- The image unpacks the tarball that it serves to runners, so it runs the same files.
- The server id in the database ([above](#server-id)). Rejected: a file in the home of the server (it survives a
  database reset, so old `run-1` and new `run-1` still meet); a marker file next to each workspace and a container label
  (each path that reuses a workspace must check them).
- AGPL-3.0-only for the repository (`LICENSE`). Rejected: Apache-2.0 and MIT; a source-available license such as FSL
  (not open source).
- The server shows a new version and does not install it: it reads the latest version from the npm registry (a
  setting turns this off), and a banner gives the commands ([releases](../tasks/releases.md)). `halinka start` has no
  update logic; its banner says to restart with `npx halinka@latest start`. Rejected: an Install button through a
  helper container with the Docker socket (root on the host); GitHub releases as the source (npm also gives
  `protocolVersion`).
- A push of a tag `vX.Y.Z` runs one GitHub Actions workflow: it checks that the tag equals the version of
  `apps/cli/package.json`, builds once, and publishes `halinka@X.Y.Z` to npm and `ghcr.io/mateuszmigas/halinka:X.Y.Z`
  and `:latest`. Rejected: a manual run with a version input (git does not show which commit was published); a tag for
  the image and a manual `npm publish` (the two can differ).
- The update check is a server setting in the database, which admins change in the portal; `halinka start` reads the
  same setting. Server settings that an admin changes at run time live there too: a `server_settings` table with one
  row and a typed column per setting, which the server loads at start and keeps in one class. Rejected: an environment
  variable (a change needs a restart and access to the host); a key and a JSON value (defaults and checks in code, for
  a few settings).
- `HALINKA_LEASE_SECONDS` and `HALINKA_SWEEP_SECONDS` stay environment variables for tests. Rejected: admin settings
  (no admin needs them, and a lease near the 5 s sync makes each run expire and go back to the queue).
