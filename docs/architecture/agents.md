# Agents

How an agent runs inside a step: the ACP session, the report channel, the permission answers, the credentials. Read
[workflows.md](workflows.md#agent-steps) first for the fields of an agent step; the sandbox and the egress proxy are in
[sandbox.md](sandbox.md).

`packages/agents` is the agent runtime: the ACP client (`acp.ts`), the report channel (`fileReportChannel/`) and the
permission policy (`permissionPolicy.ts`). `packages/presets` holds what every app knows about an agent kind
(`AgentPreset` in `src/agentPresets.ts`): its command, its npm package and version, its credentials, its proxy routes and its
tools. A new agent needs a preset, no code. The ACP SDK is a dependency of `agents` only.

| Preset        | Package                                 | Reports cost | Asks permission | Takes a tool list |
| ------------- | --------------------------------------- | ------------ | --------------- | ----------------- |
| `claude-code` | `@agentclientprotocol/claude-agent-acp` | Yes          | Yes             | Yes               |
| `codex`       | `@agentclientprotocol/codex-acp`        | No           | No              | No                |

## ACP

- The runner starts the preset's command in the sandbox as the `agent` user and is its ACP client over stdio. Halinka
  sends no `fs/*` or `terminal/*` client capability: the agent uses its own tools in the sandbox.
- A devcontainer run installs the package at its selected version when the container lacks the command. A worktree run
  uses the command on `PATH` of the runner, with the login of that machine.
- `AgentEvent` is the ACP `session/update` object as it is. The engine stores each update in `workflow_run_events`,
  except `available_commands_update`; that is the transcript. Readers merge adjacent text chunks with the same
  `messageId` (`mergeChunks` in `protocol`).
- `AcpAgent.open` reads the command and the launch (environment, provider hosts, credential names) at each open, so an
  open uses the credentials of that time.
- `session/cancel` ends a turn. After a cancel for a limit or an abort, the client waits 5 s, then stops the agent. The
  last 4096 characters of stderr go into the error of an exit.

## Session and turn loop

- `Agent.open` gives an `AgentSession`: `session/load` with the session id of the context when the agent has
  `loadSession`, else `session/new`. The request carries the report server and the MCP servers of the step. After each
  open the client selects the model with `session/set_config_option`; a refused name fails the step and the error names
  the models on offer. No turn listens during a load, so replayed updates reach no limit.
- `prompt(text, { signal, interrupt, onEvent })` is one turn: it sends the prompt, then reads the report files. `signal`
  also stops the agent; `interrupt` only cancels the turn.
- `StepSession` (`packages/engine/src/stepSession.ts`) owns the turn loop of one step: a step keeps one session for all
  its attempts, and a loop iteration opens a new one. The first prompt is the step prompt and the report instructions;
  a loaded session gets only "Halinka continued this step after an interruption." and the instructions, because it has
  the task in its history. A new session also gets each message and answer that the agent got before, in order
  (`RecordedStep.told`); the `agent_prompt` event holds a note with their count, not the text.
- After a turn, the first rule that applies wins:
  1. A run abort ends the attempt without a result; the server records it `cancelled`, or `lost` and queues the run
     again.
  2. An interrupting chat message prompts again, unless a limit was reached.
  3. A valid report ends the attempt, also over a limit or a question of the same turn.
  4. A reached limit stops the attempt.
  5. A stop reason other than `end_turn` fails it.
  6. A question waits for a person.
  7. Else a reminder, up to `max_reminders`, which names the problems of an invalid report or invalid questions.
- `max_turns` counts the prompt turns of the step: the first prompt, each reminder, answer, chat or reopen message and
  continue prompt. It stops the next prompt after the last allowed turn, never a turn in progress. After a recovery
  the count starts again. `max_cost_usd` reads the running total of `usage_update` (`claude-code` only).
- The session closes before each give-back of the workspace (at a question and at the end of each attempt), because
  the give-back stops every process of the agent ([sandbox.md](sandbox.md#agent-user-and-workspace-owner)). The next
  prompt loads the live session again, with the same cost baseline. When the load fails, a new session gets the step
  prompt with the interrupted note, and its cost adds to the cost of the session it replaced (`replacedCostUsd` on
  `agent_session`).
- `agent_session` is emitted after the session got a prompt, so a stored session always has the task. The server
  writes its session id to the running attempt at once, so a `lost` attempt keeps it.

## Report channel

- The report MCP server is a stdio script (`reportResultServer.mjs`) that the runner writes into `/tmp/halinka/<id>/`
  in the sandbox, a folder the agent user can write. Its tools write files that the runner reads after the turn:
  `report_result` writes `report.json`, `ask_human` writes `question.json` (1 to 4 questions, each with 2 to 4 options
  or none; "Other" with text is always available). The shape of the step report (the outcome names and the output
  types) goes in an environment variable (64 KiB limit, because Linux limits one variable); the script makes the JSON
  Schema of `report_result` from it. The agent can write the files without the tools; the checks still apply.
- The script imports only Node built-ins and checks a report and the questions with its own copy of the rules of
  `reportSchema` (`packages/workflow`) and `agentQuestionsSchema` (`packages/protocol`); it refuses in the same turn,
  with the first problem and its path. A test runs the same inputs through the script and through the zod schemas,
  and compares the JSON Schema of the script with the one of zod.
- After each turn, also a failed one, one `exec` reads both files and deletes them, so the next turn starts without
  them. The read takes no turn signal: an aborted turn can still give a report. It refuses a link, a path that is not
  a regular file, and a file above 1 MiB. It tries to delete both files; a file that it cannot delete fails the read.
  A failed read ends the session, because the files can remain: the next open gets a new folder. The channel in the
  runner is the final check: an invalid report counts as no report, and the reminder names the problems.

## Permission policy

The sandbox is the boundary. The answers to `session/request_permission` (`checkPermission`) are defense in depth:
Halinka answers each request at once from the step's permissions and never waits for a person. It refuses an edit,
delete or move in a `write: false` step; a command in a `shell: false` step; a git command that changes the history, a
ref or a remote, also with a path to `git`; and a fetch of a host outside the step's `network` list. The git commands:
`commit`, `reset`, `rebase`, `checkout`, `switch`, `push`, `pull`, `fetch`, `merge`, `cherry-pick`, `revert`, `am`,
`remote`, `update-ref`, `fast-import`, `filter-branch`, `filter-repo`, `config`, `bisect`, `gc` and `prune` always;
`branch`, `tag` and `replace` with a name and no list flag (create, delete, move, copy); `stash`, `notes` and `worktree`
other than `list` (and `show`); `reflog expire` and `reflog delete`; `symbolic-ref` with a target or `--delete`; and any
`-c alias.*` or `--config-env alias.*`. The check splits the command text into words with the quotes and backslashes of
a shell, skips the values of options, and also checks the script of `sh -c` (and `bash`, `zsh`, `dash`, `ksh`) and of a
quoted `$(…)`. A command that a script file runs goes past it. `codex` sends no requests, so for `codex` only the
discard check after a `write: false` step applies, and the parse refuses `shell: false` for it.

## Chat

The run-level side (rows, delivery, items) is in [workflows.md](workflows.md#chat-and-reopen). In the session:

- A message during a turn interrupts it with `session/cancel` only, without the 5 s stop; the step `timeout` still
  stops an agent that does not end the turn. A message between turns goes into the next prompt.
- Each prompt appends the pending messages as `Message from <author>:\n<text>`. A message wins over a report or a
  question of the same turn, so the agent reports or asks again. Reminders start again after a message turn. Chat turns
  count toward the step's limits.
- The answer to `ask_human`, from the inbox or the chat, is the next prompt of the same attempt. A question waits only
  while its attempt runs, so an expiry closes it; a message to the step then continues the expired run in a new
  attempt. `inbox.resolve` refuses an answer to a question of a step that has an undelivered message (409): the agent
  takes the message.
- The engine emits the `agent_prompt` event before it sends the prompt, so the server marks the messages delivered
  when the agent can still miss them. A turn that fails after the send fails the step, and the chat shows the error
  after the prompt. A new session gets the messages again from `told`; a loaded session has only what the agent
  stored.

## Reopen

The reopen is in [workflows.md](workflows.md#chat-and-reopen). In the session: the new step run loads the session of
the replaced step run (`RecordedStep.reopened`); a new session gets the step prompt, the earlier result and the earlier
messages and answers (`RecordedStep.told`). The cost of the loaded session before the reopen is subtracted. A reopen
keeps its full limits: its step run has no attempts before the reopen.

## Recovery of an interrupted step

- After a requeue or an expiry, the next attempt loads the last session of the step run's attempts
  (`RecordedStep.sessionId`) and subtracts `sessionCostUsd`, the cost of the run's attempts in that session. The own
  session wins over the session of a reopened step run, because it is newer.
- A `lost` attempt stores no cost, except the cost of a session that it replaced, so its spend counts once, through the
  running total of the loaded session. The Claude Code CLI saves its total at exit, also at TERM; a load continues from
  the last saved total. A loaded session whose total is below the stored cost counts as 0 until it passes it.
- After a recovery, `max_cost_usd` and `timeout` count the recorded usage of the step run.

## Credentials

For each credential of the preset, the agent gets a placeholder and the proxy route as its base URL, and the proxy
adds the real value ([sandbox.md](sandbox.md#network)). Order: a stored key, else a login of the runner, else the
environment of the runner.

### Stored keys

- An Admin stores a key per preset and variable in `agent_credentials`. AES-256-GCM seals it with the master key
  ([overview.md](overview.md#configuration)), and the authenticated data names the preset, the variable and the owner,
  so a value opens only in its own row.
- The runner calls `readAgentCredentials` at each agent start. The server gives the values only for a live lease of
  that runner, a run in a devcontainer, an agent of the workflow and a runner that allows the agent. Only the proxy of
  that run gets them. A stored value that does not open fails the start; it does not fall through to another source.
- On a server with a login, each person stores their own keys ("Your keys", `halinka agent key --mine`). A run gets
  all keys of its author for that agent, else the keys of the team, never a mix. The author is the member who created
  the run (`workflow_runs.author_id`); a message, an approval or a reopen by another person spends the key of the
  author. The delete of a member deletes their keys and tests and clears the author of their runs.

### Subscription logins (Codex)

- `halinka agent login codex` saves the ChatGPT login in `$HALINKA_HOME/logins/codex.json`
  ([cli.md](cli.md#halinka-agent)). `CodexLogins` reads it at the runner start and before each Codex start without a
  stored key, so a new login reaches a runner that runs. The same account keeps its placeholder, so a running step
  keeps working.
- One refresher per runner process serves all its runs, under a lock file in `$HALINKA_HOME/logins/` shared by the
  processes on one home. It refreshes at 80 % of the access token's lifetime, one attempt at a time with back-off; the
  timer checks the time every 10 minutes, because timers stop while the machine sleeps. A refusal (401, or 400
  `invalid_grant`) is logged once and not tried again until a new login. A Codex start with an expired login tries one
  refresh first. A runner stop waits for a refresh request that started (30 s limit).
- With a login, the container gets a placeholder `auth.json` (an unsigned JWT with the account claims and an expiry in
  2100), the HTTPS proxy route as `base_url` and `chatgpt_base_url`, and the proxy certificate through
  `CODEX_CA_CERTIFICATE`. The proxy lends the token only on the exact login paths of the preset. The hosts that
  refresh a login leave the step's network.
- Halinka writes `$CODEX_HOME/config.toml` at each Codex start that lends a credential, with WebSockets off; a file
  that the agent user cannot write stops the start. Without a lent credential, Codex starts with the files of the
  image.

## Agents page

The page and `halinka agent` use one API. An Admin enables or disables each preset, selects its version (an exact
version, because it goes into `npm install`) and its default model, and stores or removes its keys. `agents` holds only
what an Admin changed; no row means enabled, at the version of the preset. A Member reads the same list, which shows
each key as set, not set, or set with another master key; the API never gives a value back. A disabled agent refuses a
new run of a repo that has a runner; a run of a `github` repo waits in `queued`, with the reason on the run. A run that
started keeps running. A removed or changed key takes effect at the next agent start.

## Agent test

- An Admin selects an agent and a connected runner that allows it, or runs `halinka agent test`. The server keeps one
  row per agent, runner and owner; a later request replaces it with a new token. A person tests their own key
  (`testMine`) on a devcontainer runner, after they store it. A test of the team goes before a test of a person.
- A `sync` with `canTest` takes the oldest request. The runner runs one test at a time, outside its capacity, with
  15 minutes for the test (the start of its container included) and 2 minutes for the reply. `finishAgentTest` stores the result, and the token fences it.
- The test opens the agent as a step does, with no write and no shell, in an empty workspace: a stock image behind the
  proxy on a devcontainer runner, the host with its own login on a worktree runner. It records the capabilities of
  `initialize` and asks for a one-word reply, because `initialize` alone never reaches the provider.
- A server sweep fails an open test of a runner that has not synced for one lease length, and a running test after 30
  minutes. A failed test blocks nothing. The page shows the error, and "old" when the version, the default model or a
  stored key changed after a test on a devcontainer runner.

## Model, tools and MCP servers

- Model: `step.model`, else the default model of the Agents page (`ClaimedRun.agentModels`), else the agent's default.
  The test uses the default model.
- Tools: `tools.sessionMeta` of the preset makes the `_meta` of the session request. `claude-code` takes
  `claudeCode.options.tools`; `codex` has no list.
- MCP servers: stdio only, next to the report server in `session/new` and `session/load`, with no environment. A
  server of the step wins over a server of the same name in a config file of the agent, so the `codex` preset sets
  `DISABLE_MCP_CONFIG_FILTERING`. The rules of a server are in [workflows.md](workflows.md#agent-steps).

## Limits

- The paths of a preset come from one version of each agent (Claude Code 2.1, Codex 0.167). A selected version that
  needs another path gets 403 from the proxy there.
- An interrupted turn that reached a limit loses its report to the limit item.
- A save of a refreshed Codex login that fails loses the rotated refresh token: the next attempt sends the earlier
  token, gets a refusal, and the runner needs a new login.
- After a hard kill of the agent (KILL without TERM), the spend since its last clean exit is not counted.
- A process that the agent starts has the proxy token of the agent command, so it can call the provider through the
  credential route. The agent does not report that cost ([workflows.md](workflows.md#costs-and-the-run-budget)).
- A `lost` attempt stores no time, so `timeout` undercounts after a crash.
- A crash before the first event batch of a session loses its session id; the next attempt starts a new session.
- A message in a prompt that the agent did not read (a stopped or blocked agent) is not in its stored session, so a
  reopen or a recovery that loads that session does not give it to the agent.
- The tool list depends on a `_meta` key of the pinned adapter: a version that drops the key gives the agent all its
  tools. The sandbox and the permission answers stay the control.
- An `available_commands_update` is not stored, so chat cannot show the commands of the agent.
- Codex in a step has no ChatGPT plugins: those routes get no token.
- The shape of agent `outcomes` and `permissions` is a first version. A redesign is open: do not build on it before the
  owner decides.

## Decisions

- ACP over stdio, with the update stored as it is. Rejected: a Halinka event union that maps each update (a second
  schema to keep in step, and it drops fields a later reader can need).
- The engine owns the turn loop of one session per step, so gates, reminders, answers and chat share the agent's
  context, and limits count per session. Rejected: one `run` call per attempt that hides the turns.
- `max_turns` counts the prompts that Halinka sends in the step. Rejected: tool calls (the count depends on how an
  agent splits its work, and the limit stops a turn in progress).
- A stdio MCP script that writes files ([above](#report-channel)). Rejected:
  - an HTTP MCP server on the runner: the sandbox has no route to it.
  - a Unix socket or a daemon in the sandbox: more parts, and a socket does not cross every sandbox kind.
  - Zod in the script: the script travels in one environment variable.
  - a JSON Schema check in the script: it depends on the shape of `z.toJSONSchema`.
  - the zod JSON Schema in a second variable: two encodings of one shape.
- The read after each turn deletes the files, also after a failed turn. Rejected: a removal before each turn (one more
  `exec` per turn, and an abort between the removal and the prompt needs a rollback of the prompt state).
  - a summary-only check: each wrong report costs a reminder.
- The sandbox is the boundary; the permission answers are defense in depth. Rejected: answers as the only control (an
  agent that does not ask goes past them); a person who answers each request.
- An interrupted step loads its session from the id that the server stores at the `agent_session` event. Rejected: a
  control-plane call to record the session (a value the event already carries).
- The session closes before each give-back, and the give-back stops every process of the agent. Rejected: freeze the
  agent around the chown (a timer can send SIGCONT); repeat the chown until nothing is left (a process can keep pace).
- A loaded session keeps the cost baseline after a hard kill. Rejected: count from 0 when the total falls (it counts the
  cost before the last clean exit again); store whether each close was clean (too much for a rare case).
- The runner owns the subscription login ([above](#subscription-logins-codex)). Rejected:
  - store the login on the server: a rotating refresh chain needs one owner, and the token opens the ChatGPT
    conversations of the person.
  - a login lease per step.
  - the user's own `~/.codex/auth.json`: two refreshers break one chain.
  - the token on the whole `/backend-api`: it opens the user's conversations.
  - the real access token in the container: code of a step could read it.
  - a refresh by Codex in the container: the refresh token would be there.
- The proxy lends a provider credential only on the exact paths of the preset (`route.paths`, `login.route.paths` in
  `agentPresets.ts`), taken from the source code of the agent. A request with the placeholder on another path gets
  403 from the proxy, with the path in the reason, so a path that a new agent version calls shows in the step error.
  Rejected:
  - a whole subtree: `/v1/messages/batches` and `/backend-api/wham/tasks` hold the data of other work of the account.
  - a list of denied paths: a new path of the provider gets the credential.
  - a refusal of `%2F` in the path: an exact match already lends nothing on it.
  - the request without the credential to the provider: its 401 looks like a bad key, and Codex can try a refresh.
- Provider keys sealed on the server, read at each agent start under the lease ([above](#stored-keys)). Rejected:
  - the value in `ClaimedRun`: a changed key never reaches a run that continues.
  - a push of a changed key to running proxies.
  - a runner value that wins: a key in the portal then has no visible effect.
  - a stored value in a worktree agent: no proxy.
  - a master key always required: it breaks `halinka start`.
  - a master key optional with a login: a public server finds out at a failed run.
  - named agents with custom commands: nothing needs it now.
  - an Admin approval per runner: `allowedAgents` is the limit.
- The author of a run pays with their own keys. Rejected:
  - the person who acts last pays: a message then spends another person's key.
  - a value per variable with the rest from the team: the agent can select the key of the team.
  - a stop of the runs of a removed member until a person selects who pays: a payer policy and a record of past
    members; `cost-budgets` can add it.
- An agent test through `sync`, outside the capacity, with a one-word reply. Rejected:
  - a `RunnerCommands` command: a first test downloads an image.
  - `initialize` alone: a wrong key passes.
  - a test that takes a run slot.
  - a failed test that blocks runs: a provider outage would stop an agent that recovers.
- The model through `session/set_config_option`, the tools through the preset's `_meta`, MCP servers as stdio in the
  session request. Rejected:
  - a model through `_meta` or a config file: code per agent.
  - a model check at run creation: the server does not know the login.
  - portable tool names or a Codex tool list through its config.
  - `env` on an MCP server: a value in the YAML is in the repo.
  - HTTP and SSE servers: their headers need a secret.
- A new session gets the messages and the answers that the agent got, with a note in the event. Rejected: only the
  messages (an answer is a decision too); the transcript of `agent_prompt` events (it holds reminders and retry
  prompts).
