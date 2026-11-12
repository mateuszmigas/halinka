# Architecture

> Rules for the packages in `packages/` and the apps that compose them. Read this guide for architecture reviews and improve-code passes. `component-conventions.md` covers names, files, classes, components and hooks; `testing.md` covers tests.

Two principles behind every rule: the server owns state and the runner owns the machine, and the engine depends only on interfaces, so each part can be tested and replaced alone.

## Packages

1. Allowed workspace imports per package. The table covers source imports, not build configuration.
   - `config`: nothing. Build configuration only.
   - `utils`: nothing. A subpath whose dependency tree has no Node dependency (`node:*`, `ws`) is open to every package and to browser code; today `buildLabel`, `errors`, `git`, `isRecord`, `repoFiles`, `result`, `retry`, `serialQueue`, `serverUrl`, `sshHost`. The other subpaths run only on the host: the runner, the CLI, e2e, the server and the `sandbox` implementation subpaths import them; the engine, `workflow`, the portal, the website and the `sandbox` root do not.
   - `workflow`: `utils`.
   - `protocol`: `workflow`.
   - `presets`: `workflow`.
   - `sandbox`: `utils` (`errors`, `fs`, `git`, `halinkaHome`, `hash`, `isRecord`, `serialQueue`).
   - `agents`: `protocol`, `workflow`, `sandbox`, `utils` (`result`).
   - `engine`: `protocol`, `workflow`, `utils`, the roots of `sandbox` and `agents`.
   - `runner`: `protocol`, `workflow`, `presets`, `sandbox`, `agents`, `engine`, `utils`.
   - `server`: `protocol`, `workflow`, `presets`, `utils` (`errors`, `halinkaHome`, `hash`, `repoFiles`).
   - `ui`: nothing.
   - `apps`: any package. No package imports an app. `portal` and `website` import only `ui`, `workflow`, `presets`, the `utils` subpaths with no Node dependency, and the server's API client (`@halinka/server/client`).
   - The API client bundles the server's API contract and the roots of `protocol` and `workflow`. Keep them free of host imports (`node:*`, `ws`): they run in the browser.
2. Import a package through its declared entry points.
3. A package with several implementations of one interface exports only the interface and its types from its root, and each implementation from a subpath: `@halinka/sandbox` and `@halinka/sandbox/host`. Only the runner, the CLI, and tests import the subpaths. One exception: the server imports `@halinka/protocol/webSocket` for its runner listener. `@halinka/protocol/keys` (Ed25519 keys and signatures, `node:crypto`) is for the runner, the server and the CLI, not for browser code. `@halinka/agents/testing`, `@halinka/protocol/testing`, `@halinka/runner/testing`, `@halinka/sandbox/testing` and `@halinka/utils/testing` are test fixtures: only tests and e2e import them.
4. The runner prepares the workspace before the engine starts. The engine's one repository port, `RepoSource`, publishes each checkpoint commit to the repo of the run before the server stores it, opens the pull request of a run, and comments on a pull request.

## Server and runner

5. Only the server touches the database and stores the secrets of users and teams. A runner gets a stored agent key only at an agent start, under the lease of the run or the token of a running agent test, and keeps it for that run or test ([agents.md](../../docs/architecture/agents.md)). It gets the secrets of a repo only under the lease of a run in a container ([sandbox.md](../../docs/architecture/sandbox.md)). Only the runner touches git checkouts, Docker, agents, the host filesystem, and the agent credentials of its machine: its environment and its subscription logins ([agents.md](../../docs/architecture/agents.md)).
6. The server and runners talk only through the `protocol` transport: `ControlPlane` from runner to server, `RunnerCommands` from server to runner. The in-memory transport and the network transport implement the same types.
   - Both are JSON request/response. Arguments and results are plain data. An error keeps its `code` across the transport.
   - Commands are hints, short reads, and short writes to the user's checkout. They answer at once and never wait for a run. The runner's own loop does the work.
   - The transport owns reconnects. The runner's `plane` stays the same across them, and the first `sync` after a reconnect lists the runs the process holds.
7. A change to what Halinka owns on a runner's machine is desired state on the server that the runner reconciles. A read, or a write to the user's checkout, is a command that fails when the runner is offline. One exception: the `destroyed` apply of a deleted run deletes its run branch ([github.md](../../docs/architecture/github.md)).
8. Every `ControlPlane` write about a run's execution carries its lease, and the server refuses a write without a valid one. With the network transport, the server checks the lease in the same transaction as the write. A sandbox report (`reportSandbox`) has no lease: the sandbox generation fences it, and the server accepts it only from the run's runner, for a run without a lease.

## Engine

9. The engine receives its sandbox and agents from the runner. It never imports a concrete implementation.
10. The step walk decides the next action from recorded state. Side effects run in a separate executor, so replay and reopen are testable without a sandbox or an agent.
11. Agents report results only through `report_result`. The engine alone sets step status and decides when a loop stops.
