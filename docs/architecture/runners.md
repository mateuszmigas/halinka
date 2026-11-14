# Runners

How a machine registers, connects, claims runs and keeps them. Read [overview.md](overview.md) first; the sandbox of a
run is in [sandbox.md](sandbox.md).

A runner is a machine that executes runs. It owns its sandboxes, checkouts and local repos, keeps state between runs,
and connects outbound to the server. A `local` repo is a checkout on one runner (`repos.runner_id`, unique with `path`).
`workflow_runs.runner_id` pins each run to its runner: a run of a `local` repo at its creation, a run of a `github` repo
at the first claim ([github.md](github.md#repos)). The runner keeps the files of each server apart by the server id
([overview.md](overview.md#server-id)). One process per runner: `halinka start` and `halinka runner` take
`$HALINKA_HOME/runner.lock` and refuse to start while a live process holds it.

## Registration

- `halinka runner` creates an Ed25519 key pair in `$HALINKA_HOME/runner.json` (mode `0600`, the name is the host name).
  The server stores only public keys, in `runner_keys`: one `current` and at most one `pending` key per runner.
- Device flow: the runner sends its public key, host name, OS and architecture, signed with the key, every 5 s, and
  shows a code and a link to `/runners/approve?code=`, which opens the approve dialog of the Runners page. An Admin
  sets the name, labels and allowed agents, and approves. Enrollment token: Add runner on the Runners page makes a
  one-time token; the runner reads it from `HALINKA_ENROLL_TOKEN` or
  `--enroll-stdin`. A code and a token expire after 15 minutes.
- Rotation: a token or an approval for an existing runner adds a `pending` key. Its first hello makes it `current`,
  retires the old key and closes the connections of the old key. Revoke closes the connections of the runner at once
  and refuses its key and its writes; its leased runs return when the lease expires. Drain: the runner claims no new
  runs, and keeps the runs that it holds.
- `halinka start` registers its in-process runner by key. A runner keeps the name of its first registration; a host
  name that another runner has makes `start` fail.

## Connection

- One WebSocket per process to `/api/runner/connect`, opened by the runner, so it works behind NAT
  (`packages/protocol/src/webSocket/`). The server sends a 32-byte challenge; the runner answers with a signed hello:
  the protocol version, the process instance id, the public key and the server URL. The server reads only the
  protocol version first and closes the socket with 4001 for another version, so a hello of each later shape gets this
  refusal. It closes with 1008 for another server URL than `HALINKA_PUBLIC_URL`, a bad signature, an unknown key, or no
  hello in 10 s (1013, so the runner connects again). The runner does not connect again after 1008 or a code from 4000
  to 4999; 4001 gives `update_needed`, each other code `refused`. Each later hello must stay a JSON object of at most
  4096 bytes with a number `protocolVersion`, or an older server refuses it with 1008, not 4001. It refuses an upgrade with an `Origin` header, so no web page connects as a runner.
- `halinka runner` sends a signed probe (`POST /api/runner/probe`) at each start: the key, the server URL, the
  protocol version, the build and the time, signed by the runner key. The server answers, in this order:
  `clock_skew` for a time more than 5 min off (the runner tries again), `refused` for another server URL than
  `HALINKA_PUBLIC_URL` or a revoked or retired key (exit 78), `update_needed` for another protocol version, also for an
  unknown key (exit 75), then `accepted` or `unknown`. Only `unknown` enrolls, so a runner of another version never
  calls the enrollment API. For `update_needed` with a known key, the server stores the build and the protocol version
  of the runner: the Runners page shows "update needed" for a runner that cannot connect. Each `sync` stores the
  build otherwise. The probe opens no session, promotes no key and closes no connection. The hello and the probe share
  the server URL check (`wrongServerReason`).
- Update: the server keeps an update request on the runner row (`update_request`: `when_idle` or `now`), set by the
  Update and "Interrupt and update" actions of an Admin, or by auto-update when the build differs (not again for a
  build whose update the runner reported as failed). The runner takes no new runs while it is set. The answer of
  `sync` gives it to a process with `canUpdate`: the supervisor restarts the process when it holds no run, or at once
  for `now` (the runs go back to the queue). `closed` then gives `update_needed`; the CLI installs the build under the
  lock of the home and exits 75, and systemd starts the new build: one start per update, as the unit allows 5 starts in
  10 min. At start, the probe answers `accepted` with `isUpdateRequested`, or `update_needed`, and the start path
  (`runnerSelfUpdate.ts`), under the lock of the home: reads the manifest, installs the package
  (`runnerVersions.ts`), runs `halinka runner --probe-only` of the new build (no lock, at most 3 clock-skew answers),
  points `current` to it, deletes all versions but it and the previous one, and exits 75. A sync on the build of the
  server clears the request, also the failure and its build. A request ends when the process has no `canUpdate` or the
  server has no package; Cancel also turns auto-update off. While a request is set, the runner gets no agent test, and
  `when_idle` waits for a running one. After a failed update, the process reports `canUpdate: false`, so the server asks
  it for no update until its next start. A failure of the server or the network (no manifest, a failed download, a
  probe that does not end) counts no failure of the build; with `update_needed` the process tries the manifest again
  every 30 s with no restart. A server with no package and a counted failure exit 78. A failure sends a signed status (`POST /api/runner/status`, tag
  `halinka-runner-status-v1`), which stores the reason, shows it on the Runners page and clears the request; after two
  failures of one build (`versions/update-failures.json`), the runner tries it again only after `install`.
- `GET /api/runner/manifest` gives the build of the server (version, build id, protocol version, and the sha512 and size
  of its package when it has one) with no login and `Cache-Control: no-store`, outside the versioned protocol.
  `GET /api/runner/package` serves that package, with its own rate limit. The server image packs it at build time as
  `/app/halinka.tgz`, from the same `dist`, so its build id is the build id of the server; a server from npm or from
  source has none. Each version keeps this route and its fields. The Runners page shows the build of each runner
  and "out of date" when its build id is not the build id of the server.
- The server binds one `ControlPlane` to each connection, with its runner and instance. A new connection of the same
  instance replaces the old one. Other instances of the runner (a copied key) can connect too. A `wake` goes to every
  connection of the runner.
- Each side exposes only the methods of its direction: `ControlPlane` (runner to server, the only way a runner reads
  and changes run state) and `RunnerCommands` (server to runner: a wake, repo reads and writes, folder listing, a repo
  setup, a push, a pull request, a relay). A command never waits for a run. A zod schema checks each `ControlPlane`
  input in `Server.acceptRunner` (`checkedPlane`), for both transports. The in-memory transport copies each value
  through JSON, as the network does. On the WebSocket transport a command without an answer in 60 s fails with
  `timeout`, which the API answers as `CONFLICT`.
- Folder roots: the `--root` folders of `halinka runner` ([cli.md](cli.md#halinka-runner)) are the only folders that
  the server can reach. The runner compares real paths, refuses `..`, and refuses each repo command, `listFolders`, a
  claimed run and a sandbox apply outside the roots. `listFolders` gives no parent above a root, and lists at most 1000
  subfolders, without hidden folders. The runner also refuses a path in its own folder (`HALINKA_HOME`, with its key
  and logins) and a repo that holds that folder: a home folder that is a git repo has `.halinka` as its definitions
  folder.
- Each repo command checks an absolute path, a folder and a git repo (`openRepo` in `repoFiles.ts`). Only `readRepo`
  and `writeRepoFile` check that `.halinka/` of the working tree is a folder inside the repo (`openDefinitions`), so
  a bad `.halinka/` does not block `readCommitFile` or `listDevcontainers`.
- The server pings every 10 s and ends a socket without a pong; the runner closes a socket whose call has no answer in
  20 s and connects again with a backoff. A message is at most 16 MiB; `EventLog` sends a batch at 1 MiB and drops an
  event above 4 MiB.
- Errors: `connection_closed` and `unavailable` are transient (`isTransient`); the runner repeats only these, with
  backoff. `runnerPlane` (`packages/runner/src/runnerPlane.ts`) masks the lent values in each argument, gives each
  write its call id, and repeats a call until the run or the runner stops. `sync`, `appendEvents` and `reportSandbox`
  have their own repeat: the supervisor loop, `EventLog` and the next `sync`. A database error that a repeat can fix becomes `unavailable`; any other server error becomes `internal`.
  After a final error `EventLog` logs and drops the batch; the engine goes on, so the run can end `succeeded` with a
  hole in its transcript.

## Leases and fencing

- A claim gives the run a lease token, `lease_holder` (the process instance) and `lease_until = now() + 30 s` on the
  database clock. `sync` renews the leases of the runs that it lists. An expired lease cannot be renewed.
- Every write of the engine about a run carries its lease. `holdLease` checks the token, the status, `lease_until` and
  the authority of the key (not revoked, not retired) in the transaction of the write, so a process that lost a run
  cannot write into it. `appendEvents` locks the run, so the batches of a run commit in `seq` order. `reportSandbox`
  carries no lease: it checks the authority of the key, the runner of the run and the generation, and writes only to a
  run without a lease.
- A server sweep every 10 s queues again each run whose lease expired: running attempts become `lost`, step runs stay
  `running`, and a run with a cancel request becomes `cancelled`. At server start, held leases get one lease length
  more before the first sweep, so live runners keep their runs over a restart.
- Call receipts: each write except `appendEvents` and `reportSandbox` carries a call id, and the server stores the
  result in `run_calls` in the transaction of the write. A repeat with the same id, lease and arguments gets the first
  result, also after `finishRun`; other arguments are refused. A claim deletes the receipts of the run. An event batch
  has its own id; a stored batch is not stored again. A batch that the server refuses for good (not a transient error)
  stops the running attempt and fails the run.
- Two active runs of a repo never share a branch: a partial unique index on `workflow_runs(repo_id, branch)`.

## Dispatch

- `sync` stores the capabilities of the process on the `runners` row with `last_seen_at`. Capabilities
  (`capabilities.ts`): the sandbox kind; the build of the process (version and build id); `canUpdate` (it runs under
  its unit with self-update on); for a devcontainer process
  whether Docker answers, whether it has Sysbox (`--docker-in-container` and the runtime `sysbox-runc`), and the SSH
  host key; for a
  worktree process the presets whose command is on `PATH`. The supervisor checks them at the start and at each 12th
  `sync` (about one minute), and warns when Docker stops or comes back. Without Docker the runner keeps its connection
  and claims no runs.
- The claim takes the oldest queued run that the runner can take. One rule in SQL (`db/repositories/dispatchRule.ts`)
  decides: the settings of the runner (not revoked, the `runs-on` labels, the allowed agents, no disabled agent, not
  draining, no update request); the concurrency group ([workflows.md](workflows.md#concurrency)); the capabilities (an untrusted or test
  run needs a container; the sandbox kind of a run that has a workspace; Docker and a devcontainer path for a
  devcontainer runner, and Sysbox for a run with `setup.docker`; no setup secrets and the agents on `PATH` for a worktree runner).
- `runs.create` refuses a run of a disabled agent for each repo kind, and a run that the settings of the assigned runner
  refuse, but not for a draining or updating runner. A run that the runner cannot take
  now waits in `queued`; `runs.get` gives `waitReason` (`waitReason.ts`), the first of: the settings, a runner that is
  not connected, the capabilities, the run that goes first in its concurrency group. `RunBus.notifyQueuedRuns` sends
  `state` to the queued runs of a runner when it connects or disconnects, when its capabilities or settings change and
  at a revoke, and to all queued runs when an agent is enabled or disabled. The server waits for these signals before
  it closes the database.
- `sync` claims runs while their steps, workflows and inputs fit in 8 MiB of JSON. A run that does not fit waits for the
  next `sync`; a run that alone is larger fails with an error that names its size.

## Supervisor

One supervisor per process (`packages/runner/src/supervisor.ts`) makes the machine match the server for the runs that
the process holds.

- `sync({ held, capacity, capabilities })` every 5 s, after a `wake`, and when an engine ends. One `sync` is in flight.
  `held` lists the leases of the runs with an engine in this process. `capacity` is the free slots: a run whose engine
  waits for a person does not count, and keeps its lease and its container, so for a time more runs than `--capacity`
  can execute. The answer: `keep` (the held runs that the server still wants executed), `claimed` (new runs with their
  lease, snapshot and recorded steps), `answers`, `messages`, `sandboxes` (specs to apply) and an agent test
  ([agents.md](agents.md#agent-test)). A run that this process holds but did not list is queued again, as after a
  crash.
- Results: the supervisor sends `succeeded` or `failed` as the engine gives, `cancelled` for a run that left `keep`,
  `failed` for an engine that threw, and nothing when the runner stops or the lease is lost. It cuts the error to 8000
  characters. A result that the server refuses goes again once as `failed`. When the server refuses `failed` too, the
  run stays held and `failed` goes again, from 5 s to 1 minute apart, so the next `sync` does not queue it again.
- Before the engine, the runner takes the workspace lock, finds the repo (the checkout, or the mirror of a `github`
  repo) and prepares the sandbox (`runExecutor.ts`). One module per sandbox kind prepares a run and runs an agent test:
  `worktreeRuns.ts` and `containerRuns.ts`.
- The engine continues an interrupted step in a new attempt ([agents.md](agents.md#recovery-of-an-interrupted-step)).
  On abort it stops the step's process, sends its last batch and returns without a step result.
- Stop: SIGINT, SIGTERM and SIGHUP. The supervisor aborts each engine, also during the start of its container, waits,
  then gives the runs back with `sync({ held: [], capacity: 0 })`. After the server closed the connection, the runner
  sends no last `sync`: the call cannot reach the server. The stop also aborts the sandbox applies and the
  agent test; an aborted apply reports nothing, so its spec stays unapplied.
- The end of a run, on every path (`runEnd.ts`): its running step runs get the run's result, its running attempts become
  `cancelled` for a cancelled run, else `lost`, its pending inbox items close, and its sandbox spec becomes `stopped`.
  The server refuses `succeeded` while a step run runs.

## Workspace locks

- An engine first takes `workspaces/<serverId>/run-<id>.lock` (`FileLocks` in `@halinka/utils`: pid, instance id and
  process start time, made with exclusive create). It waits while a live process holds it and releases it after the
  engine returned, which is after the process groups of its agents and commands ended.
- A lock is stale when its pid is gone, or when the start time of the pid differs; a failed `ps` is no proof. A taker
  removes a stale lock only while it holds `run-<id>.lock.takeover`.
- The sandbox apply takes the same lock without a wait, so it never runs next to an engine. A push waits up to 3 s for
  it ([github.md](github.md#push-branch-and-open-pr)).

## Desired state

The sandbox of each run (container and checkout) is stored on the server, and the runner applies it. Columns on
`workflow_runs`:

- `sandbox`: `running`, `stopped` or `destroyed`; null before the first claim. A claim sets `running`; the end or the
  expiry of a run sets `stopped`. `sandbox_kind` is set at the claim. `sandbox_generation` goes up at each change. The
  runner reports `sandbox_observed` (`running`, `stopped`, `absent`), its generation and `sandbox_error`, and for a
  running container its name and workspace folder (`sandbox_attach`,
  [sandbox.md](sandbox.md#resource-limits-and-lifetime)).
- `sync` lists the runs without a lease whose generation is not applied. The supervisor applies a spec only to runs
  without an engine, at most 2 at a time, with a backoff from 5 s to 5 minutes after a failure. Each apply reports its
  observation; the server ignores one that changes nothing.
- Sweep: every 5 minutes one `sync` lists all sandboxes, and one `docker ps -a` gives the state of all containers, by
  the labels that a stop uses. The runner applies only a spec that differs from its containers and each `destroyed`
  spec: a running spec whose main container does not run (also a paused one), a stopped spec with any container of the
  sandbox that has processes (the main one, a service, the proxy, also paused). A stopped spec accepts a removed
  container. Each worktree run gets an apply in the sweep, without the limit: the apply checks only files and stops
  the leftover process groups of the run. A run whose workspace lock another holder has takes no slot. When more
  containers differ than slots are free, the next `sync` with a free slot sweeps again. A new generation whose
  container already matches goes in the next `sync` without a sweep.
- `destroyed`: a worktree run removes the worktree and its refs; a devcontainer run removes the containers, the
  networks and the volumes of its project, and the clone.
- The portal starts, stops and removes the sandbox of a finished run, and starts and stops the container of an expired
  run; `CONFLICT` for an active run, because the engine owns that sandbox.
- Workspace TTL: the server sweep sets `destroyed` 24 h after `sandbox_kept_at`: the end or the expiry of the run, a
  start of its sandbox, or the open of a relay. A run with a lease is not reached.
- Expiry: the server sweep sets `expired` for a `waiting_input` or `queued` run whose inbox item is open for more than
  24 h, except with a cancel request or an undelivered message. It ends the lease, marks the running attempts `lost`,
  closes their questions and sets the spec `stopped`. `expired` is an active status: a decision on an open item, a
  message to the running agent step, or a reopen sets the run `queued`, and the claim starts the sandbox again. The
  gates do not run again. Cancel ends an expired run at once.
- Deletion: `DELETE /runs/{id}` and `DELETE /repos/{id}` set `deleting_at` (`CONFLICT` for an active run). A run without
  a sandbox, with a removed one, or on a revoked runner is deleted at once. Else the spec becomes `destroyed`, and the
  `absent` report deletes the row. A repo is deleted with its last run; its secrets, snapshots, schedules and
  pushed branches go by cascade. The branch: [github.md](github.md#branch-delete). The repo delete locks the runs of
  the repo before it checks them, so a reopen at the same time waits and then sees `deleting_at`. A run that another
  transaction holds gives `CONFLICT`. A claim skips a run with `deleting_at`.

## Relay

`halinka ssh <run>` connects the `ssh` of a person to the container of a run ([cli.md](cli.md#halinka-status-open-and-ssh)).

- `/api/runs/{id}/ssh` is a WebSocket with the CLI token. The server checks the login and the rules of the run under
  its row lock (ended or expired, a container observed running, no pending spec), marks the workspace opened, then sends
  `openRelay` to the newest process of the runner. That process opens `/api/runner/relay` with a signed hello that
  carries the relay id, and the server pipes the two sockets. The server moves bytes only and logs who opened which run.
- A run has at most 4 relays, a person at most 8. A claim that commits after the check, a `state` change of the run, a
  check every 30 s (a removed member, an ended token) and the end of the connection of the runner process close a
  relay.
- `RunRelays` (`packages/runner/src/runRelays.ts`) runs an SSH server without a port for each relay (`ssh2`), with the
  key of `$HALINKA_HOME/ssh_host_key`, whose public part goes with the capabilities. It refuses a run that the
  supervisor holds, and a claim ends the relays of its run before the engine starts. A relay never holds the workspace
  lock. Channels run `docker exec` as the remote user of the devcontainer metadata, never the agent user, up to 64
  processes per relay. SSH auth is `none`: the WebSocket login is the auth.
- A port forward reaches only `127.0.0.1` of the container; a remote forward is refused; SFTP is only the write of a
  whole file.

## Limits

- A run delete holds the run and then deletes the repo when it was its last run; a repo delete at the same time can
  deadlock with it, and Postgres then ends one of the two with an error.
- `now()` is the transaction start, so a write or a renewal that waits for a row lock can pass a lease that expired
  during the wait. A runner that cannot reach the server for 30 s loses its runs while its agents still work.
- When a taker stops during its takeover, a race of three takers can give two holders of one lock, or leave a takeover
  file that blocks other takers until that process ends.
- A lock whose runner pid is dead counts as free while the process group of the agent can still run; the sandbox stops
  these groups before the worktree is used again ([sandbox.md](sandbox.md#worktree-sandbox)). A git that a stop ended
  can leave `index.lock` or a ref lock in the checkout of the user; Halinka does not remove it.
- A key copied to another machine connects a second process. The two overwrite the capabilities of each other, so one
  can claim a run that only the other can execute. A capability check can be one minute old.
- A machine runs one sandbox kind for all its repos. A repo without a devcontainer waits on a devcontainer runner.
- One git repo registered twice (a linked worktree, a subfolder with its own `.halinka/`) passes the unique index.
- A revoked runner reports nothing, so a delete of its runs leaves its machine as it is. Containers and checkouts
  without a run are not removed.
- The pinned host key trusts the first answer of the server. The TTL can remove a container under an open session.
- A run cannot move to another runner.

## Decisions

- The folder roots refuse the folder of the runner and a repo that holds it, also inside a root. Rejected: a default
  runner folder with another name than `.halinka` (an existing runner loses its key and logins).

- The repo delete locks the rows of the runs of the repo (`FOR UPDATE NOWAIT`) before its check for an active run: a
  reopen locks the run row only. A held row gives `CONFLICT`, because a leased write holds a run and then the repo, and
  a wait there can deadlock. A claim skips a run with `deleting_at` as a second guard. Rejected:
  - a lock of the repo row at each reopen: each run action then needs the repo lock first.
  - a wait for the run rows: it deadlocks with a leased write.
- Ed25519 keys with a challenge per socket ([above](#registration)). Rejected: a runner token stored as a hash (the
  secret goes over the network at each connect); a `next_public_key` column for rotation (a key table gives a pending
  key its own state).
- One WebSocket per runner process with one `ControlPlane` per connection ([above](#connection)). Rejected: one plane
  for all connections (one connection could requeue the runs of another process); a listener composed by the CLI (the
  server owns enrollment, revoke and auth).
- One process per runner, capabilities in each `sync`, one SQL rule for the claim ([above](#dispatch)). Rejected:
  - a table with one row per process: two processes of one runner are not allowed.
  - the server refuses a second connection of a runner from another process: a restart after a crash then waits until
    the server drops the old socket.
  - capabilities in server memory: a second copy of the rule in TypeScript, lost at a restart.
  - a sandbox kind per repo with a runner that runs both kinds: not needed while a machine runs one kind.
  - `runs.create` refuses what the runner cannot take now: an offline runner refuses work it can do later.
  - a devcontainer runner that refuses to start without Docker: nothing reports that Docker came back.
  - a timer of its own for the capability check: the `sync` loop already runs.
- A lease on the database clock, checked in the transaction of each write ([above](#leases-and-fencing)). Rejected:
  - pg-boss: a `setInterval` is enough.
  - release of all runs at server start: it takes runs from live runners; the start extends the leases once instead.
  - self-fencing in the runner, which stops work when its own timer says the lease is gone: the server check is enough.
- A repeated write gets its first result through a call receipt. Rejected: no receipts, a lost answer is a lost lease
  (each network drop restarts the step and its agent session); an idempotency rule per method (each new method needs
  its own).
- The runner repeats only transient errors. Rejected: repeat all errors but `lease_lost` (a refused write never ends);
  queue the run again when its result cannot be stored (the same result fails the same way).
- A refused `failed` result keeps the run held, and goes again. Rejected: drop the run (the next `sync` queues it
  again, and it executes again).
- The server checks the `ControlPlane` inputs in `acceptRunner`, and the in-memory transport copies values through
  JSON. Rejected: the checks in the WebSocket transport only (`halinka start` did not check); references in the
  in-memory transport (a value that JSON cannot carry worked only in `halinka start`).
- A run that waits for a person keeps its lease and container and uses no capacity. Rejected: a capacity of 1 (one
  approval blocks the runner); release the lease or stop the container during a wait (the answer must reach the same
  session).
- A server sweep expires a run that waits more than 24 h, and `expired` is an active status. Rejected:
  - a time limit in the engine: runner clock, only while the runner is up, and it closes the open items.
  - `expired` as a run result: a run that expired at an approval could not continue.
  - keep an agent question open across an expiry: an answer reaches only a running attempt.
  - run the gates again at recovery: the commit is the same.
- `sync` claims within a byte budget of half the message limit. Rejected: one claimed run per `sync` with the steps in
  a separate call (a protocol change, and one run can still be too large); a limit on each field at its source (the
  sum stays unbounded).
- The server sends `state` to the queued runs of a runner at a change of the runner. Rejected: a read every 2 s in
  `halinka run` (each queued run loads the server); `state` to all open streams (each open run page reads at each
  change of any runner).
- Sandboxes are desired state, level-triggered, with a sweep that compares one `docker ps` with the specs and applies
  only what differs ([above](#desired-state)). Rejected:
  - a stop at the end of a run and a sweep of containers by label: a reopen has no container to start, and an offline
    runner misses the change.
  - commands for start, stop and remove: they fail while the runner is offline.
  - a queue of the targets of one list: a queued spec can be old.
  - an apply of each sandbox in turns over several lists: a docker call per run in each sweep, and the turns need their
    own state.
  - a cache of the reported observations on the runner: the server already ignores an observation that changes nothing.
- One lock file per run workspace with the pid and its start time ([above](#workspace-locks)). Rejected: a lock that
  the OS holds (`flock`, proper-lockfile: a package, and the pid rules stay own code); move, compare and put back a
  stale lock (three takers could give two holders).
- A repo row has the real path that the runner gives. Rejected: resolve the path in `listFolders` (another caller still
  gives a second row); merge an existing symlink row into the real row (rows own runs and workspaces).
- A remote runner lets the server reach only the folders that its owner gives. Rejected: no limit with only Admins on
  the routes (the runner then fully trusts the server).
- `halinka ssh` relays SSH to an SSH server in the runner, with a pinned host key that the runner reports
  ([above](#relay)). Rejected:
  - a static SSH server in the container: a binary per CPU, no SFTP.
  - an SSH server in JS in the container: a run without agents has no node.
  - Dev Containers over a filtered Docker API: a global `docker.host` per run and an allowlist of undocumented calls.
  - bytes on the control plane socket: shared congestion, and a stalled reader starves the leases.
  - author-only access or a runner opt-in: a Member can already run code there.
  - a new host key at each start of the runner: it shows no change of the other end.
  - the `known_hosts` file of the person: each run has its own host name, so the first use of each run accepts any key.
- A runner updates to the build of its own server: the server serves its packed tarball, and the runner checks its
  sha512 ([runner-update](../tasks/runner-update.md)). The server then publishes code to its runners, which changes
  the folder-roots decision above: a bad server can remove that limit. A runner setting turns self-update off. Rejected:
  - the latest version on npm: a runner must match its server, not be the newest.
  - npm with the version of the server: it needs a publish first, and the server can name a version that npm does not
    have yet.
  - a release signature now: it needs key management.
- systemd starts a runner again after its update; `halinka runner install` enrolls in the terminal, installs, and starts
  a user unit ([runner-install](../tasks/runner-install.md)). Linux only. A plain `halinka runner` updates by hand.
  Rejected: a launcher process inside `halinka runner` (a second process); the OS supervisor on macOS and Windows (only
  Linux runners are a target).
- The target build is desired state on the server, and the runner updates only at start, before it connects. The Update
  button drains the runner and restarts it. Rejected: an update inside the running process (it holds runs and a
  connection).
- An update drain waits for all held runs, also for runs that wait for a person, with no deadline. The Runners page
  shows what blocks it, and "Interrupt and update". Rejected: a deadline for auto-update, then an interrupt (a forgotten
  approval blocks the runner for up to 24 h, but the owner selected that a person decides).
- The bootstrap of an update is outside the versioned protocol: a public GET for the manifest and the tarball, and a
  POST signed with the runner key for status and the probe ([above](#connection)).
  Rejected: all calls signed (the manifest holds no secret); a probe through the WebSocket hello (a hello promotes a
  pending key, closes other connections and registers a session).
- Before the switch, the new version runs the probe; no automatic fallback after it. Rejected: `--version` as the check
  (it does not load the runner code); an `OnFailure=` unit that links the previous version (it needs its own health
  and loop rules, and after a protocol change the old version is refused).
- A build has a version and a build id: the sha256 of the files of `dist` and `apps/cli/package.json`, written to
  `dist/build.json` by the build. `dist` holds all npm code, so the lockfile adds nothing; a change of the website or a test tool keeps the id. A rebuild of the same code gives the same id. Code run from
  source has the id `source`. Rejected: the sha512 of the packed tarball as the id (the tarball holds the build, so it
  cannot hold its own hash); the version only (each build from a checkout is `0.0.1`); only the files of `dist` (`package.json` sets `type`, `bin` and
  `engines`); `pnpm-lock.yaml` in the hash (a change of the website or a test tool marks each runner "out of
  date", and the runner does not install by it).
- A runner reports its build in the capabilities of each `sync`. Rejected: a field of the hello (a change of the signed
  hello, and the hello must stay readable by each version); a field of the sync request (each test that calls `sync`
  changes, instead of the shared capability fixtures).
- Another protocol version is its own close code (4001) and error code (`update_needed`); the CLI exits with 75 for it
  and 78 for each other refusal (the sysexits codes `EX_TEMPFAIL` and `EX_CONFIG`). Each close code from 4000 to 4999
  is final, so a later version can add a refusal that an older runner still ends on. A runner from before protocol
  19 reads 4001 as a lost connection and tries again until a person starts it with the build of the server. Rejected: a structured close
  reason in the 123 bytes of 1008 (an old runner reads it as free text); the required build as data in the refusal
  (the runner reads it from the manifest).
- The probe is an API route with a signature over a fixed list of its fields, as the registration. Each version keeps
  its route, its input with its limits, its results, and the tag `halinka-runner-probe-v1` with its field list: a new
  input field stays outside that signature. A server answers a probe of another protocol version only with
  `clock_skew`, `refused`, `update_needed` or `BAD_REQUEST`; a new result goes only to a runner of its own version. Each
  version keeps the route, and the runner sends it before the enrollment, so a later change of the enrollment
  API still reaches an old runner as `update_needed`. Rejected: a signature over the raw body (the oRPC route then
  needs its own body reader); a probe through the hello (it promotes a pending key, closes other connections and
  registers a session); "refused" only from the hello (the version check runs before the signature, so it proves no
  key).
- `halinka runner install` runs `npm install` of the package of the server: `dist` holds all npm code
  ([overview.md](overview.md#decisions)), so the install fetches nothing. No `--offline`: a rollback to a build from
  before this rule still needs the registry. Rejected: a tarball with
  `node_modules` from the image (it ties the OS and CPU of each runner to the image).
- The unit of a runner gets only `PATH` (without the folders of one shell session), `HALINKA_HOME` and the Docker
  variables of the install shell. Agent keys stay with the server or the subscription login of the machine. Rejected:
  a copy of the agent key variables into an `EnvironmentFile` (a second place that holds secrets).
- The build that `install` downloads runs the enrollment (`halinka runner --enroll-only`), not the CLI that runs
  `install`: the enrollment API can differ between versions, and the manifest and package routes cannot. The unit
  marks its process with `--unit <name>`, not with a variable, which the agents and commands of a run would get too.
  `~/.local/bin/halinka` is a script that names the absolute `node` and `HALINKA_HOME`, so a shell of ssh without the
  `PATH` of nvm finds both; `install` does not change such a file of another home. Rejected: a symlink to `main.js`
  (it needs `node` on `PATH`); `INVOCATION_ID` as the mark (systemd sets it for each unit).
- `halinka runner status` and `halinka runner uninstall` manage the unit. `uninstall` keeps `runner.json` and the
  installed versions, and does not revoke the runner. Rejected: only the `systemctl --user` commands in the docs.
- The update request is a column of the runner, not the Admin drain (`state`): the end of an update must not resume a
  runner that an Admin drained. Rejected: `state: "draining"` for the update.
- A runner reports `canUpdate`, and the server sends the update only to such a process; `--no-self-update` turns it
  off on the machine. Rejected: a server setting alone (the owner of the machine decides if it runs new code).
- The probe of the new build runs as a child of the process that holds the lock of the home, and takes no lock
  itself. Rejected: a release of the lock for the child (a second process could start between).
- The unit has `Restart=always` with `RestartPreventExitStatus=78`: a SIGTERM from outside systemd ends the runner
  with exit 0, and it must start again; only a final refusal and `systemctl stop` keep it stopped. Rejected:
  `Restart=on-failure` (a runner that a stray SIGTERM stopped stays stopped until a reboot).
- The protocol match stays exact. Rejected: a range of N and N-1 (each bump keeps the old shapes on both sides; lease
  recovery covers the gap).
