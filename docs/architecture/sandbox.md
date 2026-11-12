# Sandbox

Where a run executes: the worktree and devcontainer sandboxes, the egress proxy, the masks and the checkpoint commits.
Read [runners.md](runners.md) first; the agent inside the sandbox is in [agents.md](agents.md).

A run executes in a sandbox: a devcontainer (Docker, isolated) or a worktree on the host (no isolation, as the user).
The runner selects the kind with `--runs-in` ([cli.md](cli.md#halinka-runner)), not the repo. A run keeps its
`sandbox_kind` until its sandbox is removed, so only a runner of that kind claims it ([runners.md](runners.md#desired-state)).
`Sandbox` (`packages/sandbox/src/sandbox.ts`) has `exec`, `spawn` and `assignWorkspace`. All git goes through `Git`
(`@halinka/utils/git`) over a sandbox: on the host the runner, the CLI and e2e use a `HostSandbox` (`hostGit` in
`@halinka/sandbox/host`), and a git call that can change the checkout of a run gets the groups file of the run.

## Calls into the sandbox

- When the main process of a command exits, the sandbox stops the processes that it left (TERM, then KILL after 2 s)
  and ends stdout and stderr. A `HostSandbox` without a groups file (git of the CLI, `gh`) is the exception: its
  command stays in the process group of the caller, so a Ctrl-C of the terminal reaches it, and a stop ends only it.
- Each call sets its own time limit in `ExecOptions.timeoutMs`: 5 min for a git call and for the root scripts of the
  workspace owner, 30 s for the report channel and the short docker calls, 10 min for the container setup,
  `setup.run` and the checkpoint bundle, 30 min for the start of a run's container. At a limit, `exec` rejects with an `Error`, not an `AbortError`, so the
  engine does not read it as a stop. A caller without `timeoutMs` has no limit.
- `ExecOptions.maxOutputChars` limits stdout and stderr together, in characters; at the limit the error has the `code`
  `output_limit`. `isOutputKept: false` keeps no stdout and only the last 4096 characters of stderr; `onOutput` still
  gets all output.
- `network` names the hosts of a command (`true` for all). A command that names no host and no credential gets no
  proxy token. The host sandbox ignores `network`, `credentialNames` and `user`.
- The engine keeps the first and the last 256 Ki characters of the output of each shell step and gate (`OutputLimit`)
  and emits one `output_cut` event between them; agent updates have no cap. The run page has no paging.

## Worktree sandbox

- A git worktree of the checkout per run, on the run branch, in `$HALINKA_HOME/workspaces/<serverId>/run-<id>`.
  Commands run as the user with the user's environment, each in its own detached process group.
- `HostSandbox` records each process group in `run-<id>.groups`, also for the runner's git calls under the workspace
  lock. Before a worktree or clone is prepared, at each sandbox apply and after the engine returned, the runner stops
  the recorded groups that still run. A group whose first process started more than 1 s after its record has a reused
  pid and stays.
- The give-back removes the locks that a stopped git left in the worktree only when no recorded group runs: the agent
  runs as the host user, so a lock can be of its live git. With a live group the give-back fails.
- No isolation: the agent can read `runner.json`, the database folder and `~/.ssh`, and can call the local API. The
  runner prints a warning. A worktree run gets no proxy, no resource limits and no `setup.run`, and a worktree runner
  takes no run that names a setup secret.

## Devcontainer sandbox

### Workspace and build input

- Workspace: `git clone --template= --local --no-hardlinks --no-checkout --single-branch` of the checkout into
  `run-<id>`; the runner removes `origin` and checks out the base files (the files of the base commit) on the host
  before the lifecycle commands run, and keeps a copy of the new clone's `.git/config` next to it. A mark next to the
  new clone stays until `restoreClone` checks out the run branch in the container, after `setup.run`. Before a new
  clone, the runner removes the container of the run, with its volumes. Host git in the new clone reads no global,
  system or environment config. The base commit of a pull request run is the head of the pull request, and its
  `.gitattributes` can select a filter of the host config. Host git never runs a working-tree command in an existing
  clone and never reads it: the container can change every file of it.
- Host git never verifies a signature, so a commit cannot start a verifier of the host. The tree export archives the
  tree of the commit: `export-subst` of a commit can ask for its signature.
- Build input: the tree of `definition_sha`, exported with `git archive` into `run-<id>.tree`. The agent cannot change
  what builds its container. For a GitHub repo, `git archive` reads no global, system or environment config: a person
  with push access who is not a Member can write the default branch. For a local repo, `git archive` uses the host
  config: `definition_sha` is the `HEAD` of the checkout of the owner. The devcontainer path comes from the `config.yml`
  of the snapshot, and the devcontainer file is read at the definition commit ([workflows.md](workflows.md#snapshot)).
- Names: `halinka-run-<hash of the workspaces folder>-<run id>` for the id label, the Compose project, the networks and
  the proxy, because two homes or two servers can share one Docker daemon, and each server numbers its runs from 1.

### Checks before `up`

`upDevcontainer` runs `@devcontainers/cli` (exact version, `--no-lockfile`, `--gpu-availability none`,
`--mount-workspace-git-root=false`, `--oci-auth-hardening`) with a minimal environment and an empty temporary `HOME`.
The CLI gets no `GITHUB_TOKEN` or `DEVCONTAINERS_OCI_AUTH`: `${localEnv:...}` would put them into the container. The
checks (`devcontainerCheck.ts`, `composeCheck.ts`) are allowlists: an unknown key, flag or value is refused by name,
nothing is stripped, and all problems come in one error. Paths are compared by real path, so a symlink cannot leave the
tree.

Step 1, before the CLI fetches anything (`read-configuration` without include flags):

- Each Feature id, lowercased and with the namespace that the CLI fetches from, must start with
  `ghcr.io/devcontainers/features/` or a `--trust-features` prefix.
- A `--trust-features` value is a registry with a dot in its name and a path that ends in `/`; `localhost`, `127.*`
  and `0.0.0.0` are refused.
- The Compose files and a `.env` next to the first file must be in the tree, without `include`, `extends.file` or a
  name with the `halinka` prefix.

Step 2, on the effective config (the merged configuration and `docker compose config --profile '*'
--no-env-resolution`); Features of a trusted publisher are fetched and extracted first:

- Each Feature set, `dependsOn` included, must be an OCI Feature of a trusted publisher; a refusal names the
  `--trust-features` value to add.
- Refused in devcontainer.json: `initializeCommand`, `privileged`, security options, capabilities other than
  `SYS_PTRACE`, `runArgs` other than `--init` and a few value flags, `host-gateway`, a mount other than a bind inside
  the workspace or a `tmpfs`, a reserved label.
- Refused in Compose: `ports`, `devices`, the host's `pid`, `ipc` or `network_mode`, external or `driver_opts`
  resources, a named volume outside the project, a file or build path outside the tree, and names, aliases, links and
  `extra_hosts` with the `halinka` prefix (they could answer for the egress proxy).

Before step 2, Halinka tags the image of `image`, or of the devcontainer service of a Compose config, as
`halinka-pin.invalid/<name>:checked`. It pulls the image first, for the platform of the config, when the image is not
local. The registry host `.invalid` does not resolve, so a pull of the tag fails, and the Compose service gets
`pull_policy: never`. Step 2 and `up` both use that tag, so `up` reads the metadata that the check read. An image ID, a
digest, or an `image` next to a `build` gets no tag. After `up`, the check refuses and removes each container of the run
that is privileged or has a capability other than `SYS_PTRACE`, a security option, a device, a host namespace mode, a
shared bind propagation, or a bind outside the workspace and the tree (Compose mounts a file secret from the tree).
Then Halinka removes the tag; the containers keep the image.

A Compose project gets an override for every service: each bind under the tree moves to the same path in the
workspace, every project network becomes `internal` with an isolated gateway, each service joins the run network, gets
`restart: "no"` and the resource limits.

### Start and commands

- Before `up`, the runner restarts a kept container (running, paused or stopped): TERM to the agent user's processes
  (the agent CLI saves its session cost at exit), then `docker stop` of all containers of the run. This ends a VS Code
  server and every process of a person or an earlier runner before the setup token and the agent come. When a file has
  another owner (a crash during a turn), a container of the proxy image gives the workspace to the host user.
- The lifecycle commands of `up` get a setup token with `setup.network` of `.halinka/config.yml`, from the snapshot.
  After `up`, the runner sets the resource limits again and connects a kept container to the new networks.
- A start (`up`, the environment read, the setup and the git config restore) stops at an abort of the run, the agent
  test or the runner, and a run's start also after 30 min. An interrupted `up` stops the CLI process, then removes a new
  container or stops a kept one. A failure or an interrupt after `up` stops the container, so the next start runs the
  setup again.
  An agent test removes its container by name, also when its folder is gone.
- A run checks the devcontainer path and exports the tree once, before the clone and the run branch. A sandbox apply
  prepares the tree itself.
- Setup after `up`, as root, with only `registry.npmjs.org` open: git is required, `safe.directory '*'`; for a run with
  agents also node, the agent user `halinka-agent` and `npm install --global` of the missing agent adapters at the
  presets' versions, with the npm cache of root, so that the cache of the remote user stays writable for `setup.run`.
  Then the runner restores the git config.
- Commands run with `docker exec --interactive --user <remoteUser> --workdir <workspace>`, with the environment that
  `devcontainer exec` gave once after the start, through `--env-file` and a bash process substitution, because `ps`
  shows `-e` values. A `setsid` wrapper writes the process group to a pid file in `/tmp`, so an abort runs a root
  script that ends the whole group. The image needs `sh`, `setsid`, `kill` and a writable `/tmp`.
- `setup.run` of `.halinka/config.yml` runs after `up` and before the runner restores the checkpoint, as the remote
  user, on the base files, once per workspace (a mark next to the clone; a failure leaves no mark). It alone gets the
  values of `setup.secrets`, with `setup.network`. The runner reads the values before each start of the
  container and adds them to the masks. A lifecycle command gets no secret: the CLI gives it its environment as
  `docker exec -e`, which `ps` shows. A removed or unreadable secret fails a run only when the command must run. A
  failure keeps the base files, so the next start also runs the lifecycle commands on them. `setup.run` refuses a
  workspace whose HEAD is not the base commit.

### Agent user and workspace owner

- The agent runs as `halinka-agent` without `sudo`, with its own `HOME`. After its command ended, `kill -1` as that
  user stops all its processes. The agent cannot install system packages: the image, the lifecycle commands or
  `setup.run` supply them.
- Root makes the agent user the owner of all workspace files for the turns of an attempt (`assignWorkspace("agent")`),
  and the host user again after them and while the run waits for the answer to a question. The engine closes the agent
  session first. The give-back stops the agent user's processes, checks in `/proc` that none remains (else it fails),
  locks the workspace folder and `.git`, refuses a `.git` that is a link or not a folder, gives all files to the host
  user without write access for others, writes the runner's copy in place of `.git/config`, and removes the locks that
  a stopped git left.
- Each container start runs the same restore of the git config without the recursive `chown`, because a crash during a
  turn leaves the config of the agent. Git calls into the sandbox set `--git-dir` and `--work-tree`, so git uses no
  other repository. The restore closes only the path through the git config: lifecycle commands run before it, and
  gates run code of the agent as the remote user.

### Resource limits and lifetime

- Each container of a run gets at most 4096 processes, and the memory (without swap) and CPUs of the runner flags
  ([cli.md](cli.md#halinka-runner)), for an image config and for each Compose service. They replace the limits of the
  repo. A Dockerfile cache mount is shared by all builds on the runner.
- A finished or expired run's containers stop (10 s grace period, whatever `stop_grace_period` says) but stay until the
  workspace TTL, so a reopened step can load its session. A stopped sandbox holds no Docker network: a stop removes the
  networks of the run and of the project, each apply of a stopped spec removes them again, and a start makes them
  again, because the default address pools give about 30 networks.
- Removal removes the containers, networks and volumes of the project, the clone, the tree and the git config copy.
  Images stay.
- "Open in VS Code": for a run without a lease whose container runs, on the server's local runner, the portal shows an
  `attached-container` link from `sandbox_attach` ([runners.md](runners.md#desired-state)). The container then holds
  the person's git config and credential sockets of the remote user, which the agent user cannot read; the next claim
  restarts the container. A remote runner uses `halinka ssh` ([runners.md](runners.md#relay)).

### Docker inside the container

- `setup.docker: true` in `.halinka/config.yml` asks for Docker in the container. A runner with
  `--docker-in-container` whose Docker lists the `sysbox-runc` runtime reports `hasSysbox`; a run that asks for Docker
  waits for such a runner. Sysbox runs Docker in the container without `privileged`: root in the container is an
  unprivileged host user, and the workspace bind keeps the host UIDs (an ID-mapped mount).
- Only the devcontainer container gets `--runtime=sysbox-runc` (an image config: `runArgs`; Compose: `runtime` of its
  service). A repo cannot set a runtime. The check after `up` refuses the container when its runtime is another.
- At each start, before the setup, the sandbox starts `dockerd` as root with `--group <gid of the remote user>` and the
  inner networks in `100.64.0.0/15`. The start refuses an image without `dockerd` or `docker`, a daemon that the image
  started, and an outer network in that range. The token of the daemon is only in its environment.
- The token of the daemon reaches hosts only while a command of the repo runs (`setup.run`, a shell step, a gate):
  the hosts of the running commands. A pull outside such a command, and in a lifecycle command, fails. The engine marks
  these commands (`isRepoCode`); git calls of Halinka are not marked.
- Only the remote user can use the socket, so the agent cannot call Docker. After each command of the repo, the
  sandbox removes all inner containers: a container of a gate could write the workspace in the next turn.
- Halinka exec as the agent user by UID and GID: Sysbox finds no user by name that was created after the start.
- An inner container gets no proxy, and does not resolve `halinka-proxy`. The inner image store is in
  `/var/lib/sysbox/docker/<id>` on the host, stays at a stop, and goes when the container is removed.

## Network

- The run network is `internal` (no route out) with an isolated gateway, so the host has no address on it (Docker
  Engine 28 or later). The run's services are reachable; the host and the LAN are not.
- The only way out is the egress proxy sidecar (`egressProxy.mjs` on `node:22-alpine` by digest; read-only, 256
  processes, 256 MiB without swap) on the run network as `halinka-proxy` and on an egress network. Each `up` removes
  the proxy and creates it again, so its script and arguments come from the current runner. It refuses a new
  connection with 503 when 512 are open.
- Each command gets its own token (`HTTPS_PROXY=http://<token>:x@halinka-proxy:3128`, with the lowercase and `HTTP`
  variants, `NO_PROXY` for loopback and the Compose services, `NODE_USE_ENV_PROXY=1`), revoked when the command ends. A
  revoke closes the open tunnels and plain requests of the token within 1 s, and a new grant closes the tunnels to a
  host that it leaves out. Hosts per command: an agent gets its
  provider hosts, the step's `network` and the credentials of its preset; a shell step or a gate its `network`; the
  lifecycle commands and `setup.run` get `setup.network`; the adapter install `registry.npmjs.org`. A refusal says
  where to add the host: 403 for a host outside the list, 407 for a command without a token.
- The proxy resolves a host once (IPv4 first) and connects to the checked address. It refuses loopback, private,
  link-local, CGNAT, unique-local and unspecified addresses, and each address of an interface of the runner host (read
  at each policy write), except the addresses of the runner's `--reach` flags, for all runs of the runner. The refusal
  names `--reach` without an address. `--reach` allows a destination that a command also names; it adds no route.
  Loopback is the proxy container, not the runner host: a host service needs the gateway address of the egress network.
  All ports stay open.
- Credential routes: a plain request to `http://halinka-proxy:3128/<prefix>/...` goes over TLS to the origin of a
  credential that the token has. On an exact path of the credential's list, the proxy replaces the credential header
  when its value is the placeholder. The placeholder on another path gets 403. A request without the placeholder
  goes to the provider with no credential header. No such credential: 404. The credentials
  of a run ([agents.md](agents.md#credentials)) are read at each policy write, so a refreshed login reaches a running
  agent.
- TLS routes: `CONNECT halinka-proxy:443` with a known token gets the same routes over TLS inside the tunnel
  (`https://halinka-proxy/<prefix>/...`), with the token of the CONNECT. The certificate is a self-signed P-256 leaf
  for `halinka-proxy`, made by the runner at its start (own DER code); the policy carries the key. Only an agent that
  gets the certificate trusts it (Codex).
- The policy is `policy.json` in a tmpfs of the proxy, which the proxy reads per request; a missing file refuses all
  tokens. `EgressPolicy` writes it with `docker exec -i` and a rename, one write at a time. Each `up` makes a new
  `EgressPolicy`, whose first write revokes the tokens of earlier instances. A runner keeps the policy of a run only
  while the run holds its workspace lock, so it never writes to a proxy that another runner process started again. A
  failed credential write is tried again with back-off until it succeeds or the run releases its lock. After the run,
  the policy of a container that stays holds only the values of the runner, no stored key.

### Masks

- The runner keeps the plain values that it lent in one `LentValues` record per runner process, which refuses a value
  of fewer than 8 characters and only adds, except the expired access and ID tokens of an earlier Codex login, which a
  new login removes. `runnerPlane` replaces each value with `***` in all arguments of all `ControlPlane` calls, also
  in object keys, for both sandbox kinds; `maskingCommands` masks the message of each error of a `RunnerCommands`
  call. The engine masks each step result before it records it, so a recovered run decides the same.
- Streams: the engine masks shell output per command and stream, and agent text chunks per message, before the output
  limit, the summary tail and the event batches (`MaskedStream`). It holds the end of a chunk that is the start of a
  lent value until the next chunk or the end of the stream.

## Checkpoints

- The runner makes every commit on the run branch, never the agent: one per attempt that changed files, after the
  turns and before the gates, so gates run against a commit. `restoreBranch` attaches `HEAD` to the branch and resets
  (mixed) to the attempt's start, so agent commits fold into it. Shell attempts make one too, also after a failure.
  Changes before an attempt get their own commit, "<step>: changes before attempt <n>", except after an interruption
  when no person opened the workspace since (`workspace_opened`). A read-only attempt discards its changes, but commits
  a person's first. A commit whose gates failed stays on the branch; the retry continues from it.
- `Git` runs with hooks, signing, fsmonitor and submodule recursion off. Nested repositories are excluded: `add`
  excludes each gitlink of `HEAD`, and `status` uses `--ignore-submodules=all`, because git in a nested repository runs
  the filter drivers of that repository's config as the remote user. A new commit in a nested repository goes into no
  checkpoint.
- `restoreBranch` clears the `assume-unchanged` flags, and the `skip-worktree` flags outside a sparse checkout, so the
  agent cannot hide a change. A flagged path or a gitlink whose name is not UTF-8 is refused.
- The commit: `add --all`, the staged file list (more than 10 000 files refuse the checkpoint and fail the step), the
  credential scan, then `write-tree`, `commit-tree` and `update-ref HEAD <new> <old>`. The message is
  `<step>: attempt <n>`, the masked summary, and the trailers `Halinka-Run`, `Halinka-Step`, `Halinka-Attempt`. The
  author is `Halinka <halinka@localhost>`. The attempt stores the two commits and the changed files.
- Credential scan: the runner reads the staged diff (`--text`, at most 64 Mi characters) and refuses a lent value in a
  staged path or in the added lines. The error names the file and the variable. The workspace keeps the files of a
  refused attempt.
- The checkpoint commit is the only durable state. Dependencies, service data and files outside the workspace are made
  again from it.

### Publish and claim

- A worktree run's branch is in the checkout, so publish does nothing. A devcontainer run streams a bundle from the
  container (`git bundle create - refs/halinka/bundle ^<checkout tip>` on `Sandbox.spawn` stdout) into
  `run-<id>.bundle`. The host checks the header (64 KiB; v2, or v3 with `@object-format` only, so no gitfile and no
  `@filter`), fetches the exact commit, and moves the checkout branch with `update-ref <branch> <new> <old>`. Publish
  runs before the server stores the checkpoint.
- The claim creates the run branch in the checkout at `base_sha` for both kinds, and resets the workspace (mixed) to
  the last stored checkpoint, so the files of an interrupted attempt stay. A missing checkpoint, or a branch tip that
  is not the checkpoint or a descendant of it, fails the run. A devcontainer run moves the checkout branch back to the
  last checkpoint only when each commit after it has the trailer `Halinka-Run: <id>`; a commit of the user fails the
  claim. A run branch that a worktree of the checkout has checked out fails the claim and each publish.
- A rewind for a reopen ([workflows.md](workflows.md#chat-and-reopen)) keeps the old tip in
  `refs/halinka/superseded/<serverId>/<run>/<step run>` and resets the branch to the commit before the step, with the
  changes of the step uncommitted. The commit of a person's edits before a rewind skips the checkpoint rules (file
  limit, scan, trailers), so a devcontainer run keeps it in the clone only and never publishes it.
- The runner needs git 2.36 or later and bash.

## Limits

- A global IPv6 address of another host on the LAN is not private, so the proxy does not refuse it. The egress network
  has no IPv6 unless the Docker daemon gives it by default.
- A public address that 1:1 NAT of a cloud gives the runner host is on no interface, so the proxy does not refuse it.
  The firewall of the cloud must protect the services of the host on that address.
- The proxy gets the addresses of the runner host at each policy write (a grant or a revoke). An address that the host
  gets between two writes stays reachable until the next write. A Docker daemon on another machine
  (`DOCKER_HOST`) has addresses that the runner does not know.
- Code that an agent wrote and a gate or a shell step runs can send the source to a host of that command's `network`.
  The agent's processes can use its credential through the proxy while the step runs, but cannot read it.
- Setup installs an adapter only when the image has none, so the image selects the adapter and its version. An image
  with its own npm registry must hold the adapter. A Dockerfile or a Feature builds outside the proxy.
- The agent user cannot write the remote user's home, so tools that install there (`~/.cargo`, `PNPM_HOME`) do not work
  for the agent. A file that `setup.run` writes stays; a token in `~/.npmrc` is readable for the agent when its mode
  allows it. After the workspace TTL, the lifecycle commands and `setup.run` of a reopen install the dependencies of the
  base commit. The agent must install the dependencies of its changes again.
- A failed start can keep the container of a new clone. The next claim replaces its files with the run branch, so a
  person's changes in it are lost.
- A Compose service that mounts the workspace writes as its own user; the give-back does not stop it.
- Docker inside the container: code that the agent wrote and a gate runs is root in the container through the socket,
  as with `sudo`. A root process that it leaves can read the proxy token of the agent in the next turn. Inner containers stop at the end of each command, so `setup.run` cannot leave a service for the
  steps; use a Compose service. A file that an inner container writes as root is host UID 0, and the give-back makes it
  the host user's again. Each run starts with an empty image store. Tested on Ubuntu 24.04 arm64 with Sysbox 0.7.1.
- The memory limit is per container, so several Compose services and several runs can use more than the host has.
- A container gets a new address at each start: a repo that needs a fixed address fails after a restart.
- A VS Code window that stays open attaches again after the restart, and a person who attaches while the run holds a
  lease shares the container with the agent until the next claim.
- Docker Desktop shows root as the owner of each bind-mounted file, so the owner tests run on Linux only
  (`pnpm test:docker`). On Linux the CLI gives the remote user the UID of the host user; a remote user whose home is
  `/` fails that build. Rootless Docker or userns-remap maps the host owner to another host UID.
- A policy write has no time limit and no abort: a write that continues in the proxy after its client stops could
  replace a later write.
- An abort of `up` stops the devcontainer CLI, not the docker clients that it started. A container that such a client
  makes after the cleanup follows the spec of its run.
- A root process from `sudo` in a shell step, a gate or `setup.run`, or a process of theirs that calls `setsid`,
  survives the stop of its command. It gets 407 after the revoke, but during a later `up` it could read the setup
  token of a lifecycle command. In a worktree run, a group whose processes belong to another user reads as empty and
  stays.
- `up` resolves Feature tags again, so a moved tag can add a dependency that the check did not see. Halinka does not
  tag the base image of a `Dockerfile` (`FROM`) or the build of a Compose service: a moved tag there can add
  `privileged`, a capability or a mount. The check after `up` removes such a container, but its entrypoints ran before
  the check. The `installsAfter` ids of a trusted Feature are fetched without a check. A
  private registry whose token service is on another host fails (`--oci-auth-hardening`), and a registry with a private
  CA fails TLS.
- A `$` in the workspace path or in `TMPDIR` breaks `up`: the CLI writes these paths into its Compose file without
  escaping.
- In a sparse checkout, a change to a file outside the patterns stays hidden from the checkpoint.
- Masks: of two lent values that overlap in a text, the mask leaves a part of the second. Encoded forms (base64, URL
  encoding), a value split across lines and the runner's own console log are not masked or scanned. An expired access
  token that a step prints after its removal shows in full; it opens nothing.

## Decisions

### Sandbox kinds and calls

- The runner selects the kind, not the repo: a contributor could turn off isolation on another person's machine.
  Rejected: named `environments` with secrets in `.halinka/config.yml` (not needed for one devcontainer per repo).
- A host run works in a worktree; a devcontainer run in a clone that publishes each checkpoint. A worktree cannot serve
  a container: its `.git` file holds a host path, and a mount of the main `.git` gives the agent the user's config and
  remotes. Rejected:
  - a clone for host runs too: a worktree is cheaper and needs no publish.
  - publish only at the end: a reclaim and an approval need the checkpoint in the checkout.
  - a `+` refspec: overwrites a commit of the user.
  - publish to `refs/halinka/runs/<id>`: the branch is the output that the user expects.
- Each call into the sandbox sets its own time limit. Rejected: one limit for all calls (30 s stops the first `reset`
  on Docker Desktop; 5 min holds a step on a dead report channel); a default limit with an opt-out (a long call
  without it stops at 30 s).
- Output keeps its first and last part. Rejected: paging of events in `runs.get` and the run page (more code, and the
  database still holds all output).
- The host sandbox records its process groups, and the runner stops the leftovers at the next claim or apply.
  Rejected: refuse the claim while a recorded group runs (each crash needs a person); find processes by working folder
  (slow, per platform, a process can change it).
- One executor for git on the host: the host sandbox, with the groups file for each git call that can change the
  checkout of a run, so the runner stops a git that a crashed runner left. Rejected: a second executor with `execFile` in `utils` (it repeats the group
  start, the record and the stop of the host sandbox).

### Devcontainer

- `@devcontainers/cli` at an exact version, with allowlist checks that refuse and never strip. Rejected:
  - an own implementation of the spec: too large.
  - strip a setting: the user would not know why the container differs.
  - `devcontainer exec` per command: 0.3 s against 0.03 s.
  - defer Compose: services on a run network are part of the product.
  - `--mount` for the devcontainer service only: the other services keep their export mounts.
- Features only from trusted publishers, checked before the CLI fetches them, because the CLI writes through a symlink
  of an extracted Feature. Rejected:
  - digest pins: `dependsOn` ids are tags.
  - a server setting per repo: the risk is to the runner host, so an Admin cannot widen it.
  - trust any publisher and check each extracted Feature: an own OCI fetcher.
- Halinka tags the image before the check, and the check reads the containers again after `up`, because `up` reads
  the image metadata again and a privileged container is root on the runner host. Rejected:
  - a check after `up` only: the entrypoints of the metadata run before `up` returns.
  - build first and start the built image: the label holds the lifecycle commands, so each command runs twice unless
    Halinka keeps a list of label keys for each CLI version, and the CLI builds a Compose service again.
  - the image ID in the config: the CLI's Feature build refuses it as a base image.
  - a tag for the life of the sandbox: it has no label, so the sweep of orphan sandboxes cannot find it.
  - rootless Docker or user namespace remapping: it breaks the owner model, and a bind still reads the runner home.
- The env file goes through a bash process substitution. Rejected:
  - an unlinked temp file: the values touch the disk.
  - the environment on stdin for the wrapper: the most code, and stdin changes for `spawn`.
  - `-e NAME` with the value in the client's environment: the container gets `DOCKER_HOST`, `HTTPS_PROXY` and `HOME`
    of the client.
- The agent runs as its own user without `sudo` and owns the workspace only during its turns. Rejected:
  - a stop by cgroup: needs cgroup v2 delegation and more privileges.
  - a shared group with umask 002: tools that set a mode break it.
  - a second name for the remote user's UID: `sudo` checks the UID, and a stop by UID ends the remote user's processes.
  - ACLs or idmapped mounts: packages or Docker features that the CLI does not give.
- Host git in a new clone and in the tree export of a GitHub repo runs with `GIT_CONFIG_GLOBAL=/dev/null`,
  `GIT_CONFIG_NOSYSTEM=1` and no environment config. The clone uses `--template=`. Rejected:
  - `* -filter` in `.git/info/attributes`: blocks only filters, and a crash can keep the file.
  - no host config for all host git: the checkout can need `safe.directory`, a proxy or a CA.
  - `GIT_ATTR_SOURCE` of the empty tree: git 2.36, the minimum of the runner, does not have it.
- The git config of the runner is restored from a copy next to the clone, with the folder locked first. Rejected:
  - a list of denied keys: a filter driver needs its name, and each new key is a gap.
  - checkpoint git as the agent user: `.git` then belongs to the agent.
  - a config from allowed keys: Halinka must know each key that git needs.
  - a copy that the container keeps: a crash during a turn saves the agent's config.
  - a restore on the host before `up`: the host user writes into a folder that the agent can change.
- Memory and CPU limits come from runner flags, with half of the Docker host's memory as the default. Rejected: fixed
  limits (the right values depend on the host); limits from `hostRequirements` with the flags as the maximum (the repo
  would select limits on another person's machine).
- A container start stops at an abort and after a time limit, and a policy write in it has neither. Rejected: no limit
  (a runner stop and an agent test wait for a build); an abort of a policy write (a write that continues in the proxy
  could replace a later write).
- A stopped sandbox holds no Docker network. Rejected: a failure text only when the pools are exhausted; a start with
  no reconnect (`docker start` looks for the old network id).
- A person opens the container of a run without a lease in VS Code, and the next claim restarts all containers of the
  run. Rejected:
  - a link to the host folder: no container toolchain.
  - `halinka code <run>`: the same risks, a worse start.
  - stop only Halinka's groups and the agent user at the claim: a VS Code server of the remote user stays next to the
    agent.
- Repo secrets go to `setup.run` once per workspace, on the base files. A new clone has the base files at `up` (a host
  mark until `restoreClone`), and the runner removes the container of the run before the clone. Rejected:
  - `up --secrets-file`: `ps` shows the values while a hook runs.
  - `remoteEnv`: the CLI copies it to a label and to each command.
  - a first shell step with `secrets`: widens the rule to all shell steps.
  - `setup.run` at each start, or on the last checkpoint of a new clone: a reopen gives the secret to code that the
    agent changed, and a `postinstall` can read it.
  - refuse a reopen after the TTL: the run loses its reopen.
  - the files of the last checkpoint at `up` of a new clone: a lifecycle command runs the agent's code, which can stay
    as a process or as a file in the remote user's home until `setup.run`.
  - the state of the clone from git (a detached HEAD) in place of the host mark: the agent can detach HEAD.
  - remove the container after the new clone: a crash between the two keeps the container.
  - secrets for gates: a gate runs code that the agent wrote.
  - server-wide values: a repo file could name the secret of another repo.

### Network

- An internal network and an egress proxy with a token per command, written to a tmpfs of the proxy. A rule in the
  container can be changed by any process in it, and a proxy that checks only names lets a step reach the host through
  DNS. Rejected: an env file in a folder for the command environment (a crash leaves secrets on disk).
- The proxy refuses the addresses of the runner host's interfaces: from the egress bridge, a public address of the
  host reaches its services. Rejected: a firewall rule on the host (Halinka does not change the host firewall).
- Docker inside the container comes from Sysbox, on a runner flag and a request of the repo. Rejected: the
  `docker-in-docker` Feature and rootless Docker in Docker (both need `privileged`); the socket of the host (root on the
  host); Podman, gVisor or Kata (privileged, or the workspace bind and the run network do not apply); Sysbox for every
  run of the runner (each run pays the start and the owner limits).
- The token of the inner daemon gets the hosts of each running command of the repo, and no hosts between them.
  Rejected: one grant for each container start with `setup.network`, like the setup token (any root process uses the
  hosts at any time, also in the turns of the agent); a default list of registries (see below); the token in
  `daemon.json` (the token touches the disk, and it replaces the file of the image).
- The socket only for the remote user. Rejected: the agent user too (the socket is root in the container, so the agent
  could keep processes past `kill -1` and read the token of a later command).
- A command reaches only the hosts that it names; no network is the default. Rejected:
  - a limit for gates only: a shell step runs the same code.
  - a default list of registries for setup: it guesses, and opens hosts a repo did not ask for.
  - all hosts for setup: lifecycle commands run code that the agent changed.
  - `setup.network` from the exported tree: the code of a later run can come from another commit than its config.
- The runner selects the private addresses with `--reach`, and a refusal names `--reach` without the address.
  Rejected: a list per repo (a contributor could open the LAN of another person's machine); the resolved address in
  the refusal (the step learns what the runner's resolver gives, and a prompt can make Halinka advise `--reach` for an
  address it selects).
- The proxy adds provider credentials on its own routes, over TLS inside a tunnel, with a self-signed leaf per runner
  process. Rejected:
  - TLS interception with a CA per run: certificate code and a trust store in each runtime.
  - the sandbox owns the policy: the runner then cannot refresh a login while the agent runs.
  - a second port for TLS: the requests inside carry no token.
  - `openssl` on the host or `@peculiar/x509`: a new requirement, or four packages for about 70 lines.
- One record of lent values per runner, masked before the limits. Refresh tokens stay, because an earlier one is not
  always dead. Rejected:
  - one record per run: a sandbox report and the run error are sent outside the engine, and a mask of another run's
    value does no harm.
  - a mask per field: a new field stays unmasked.
  - a mask in `EventLog`: the limit cuts before it.
  - keep all tokens: about 45 refreshes a year, checked at each chunk.

### Checkpoints

- One checkpoint commit per attempt, by the runner, with hooks off. Rejected: agent commits as the record (their
  number, messages and branch are not predictable); repo hooks at checkpoint time (checks belong in gates).
- The bundle leaves the container on stdout, and the host checks its header. Rejected: a host fetch from the clone
  (safe only for tested git versions); a bundle file in the clone (the host opens a path that the container controls).
- Nested repositories are excluded. Rejected: refuse a workspace with one (repos with submodules could not run); accept
  the risk (each checkpoint runs a command of the agent as the remote user).
- An attempt stores no diff: the diff of a checkpoint is the commit range `before..after` in the checkout of the
  runner. Rejected: a diff on the attempt (nothing read it, and a diff above 1 Mi characters was not kept).
- More than 10 000 files refuse the checkpoint. Rejected: a retry with a prompt that names the files (a person must
  look at a refused attempt, as at a lent value in a diff).
- The scan reads the staged paths and the added lines for the real lent values; a push scans each outgoing commit
  ([github.md](github.md#push-branch-and-open-pr)). Rejected:
  - scan for the proxy tokens: revoked before the checkpoint, and the record only adds.
  - scan for the placeholders: public strings, this repo holds them.
  - scan all lines: a removed line was in the commit before.
- `restoreBranch` clears the index flags of the agent, except `skip-worktree` in a sparse checkout. Rejected: clear all
  flags (a sparse checkout then shows each file outside its patterns as removed).
- The commit uses `write-tree`, `commit-tree` and `update-ref`, and the reset gives `--no-refresh` on git 2.36 and
  later, because each read of the worktree costs seconds on a large workspace. Rejected: require git 2.36 in the
  container (Ubuntu 22.04 has 2.34).
