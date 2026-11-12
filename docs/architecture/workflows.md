# Workflows

What a workflow file can say and how a run executes it: steps, expressions, inbox items, chat and reopen, triggers and
schedules. Read [overview.md](overview.md#run-flow) first; the agent inside a step is in [agents.md](agents.md).

`packages/workflow` holds the schema (`workflow.ts`), the parser, the expressions and the trigger mapping. The engine
(`packages/engine`) walks the steps of a run (`nextAction.ts`, `executeRun.ts`) and executes each one
(`execute<Kind>Step.ts`) in one attempt loop (`runAttempts.ts`). The server creates runs (`RunService`), items,
messages and schedules.

## Files

- `.halinka/config.yml` and `.halinka/workflows/<name>.yml` (or `.yaml`), committed. A reference to a workflow is a
  path, a file name or a name (`.yml` before `.yaml`). Portal and API URLs use the file name.
- `.halinka/` has at most 200 files, 1 MiB per file and 4 MiB together (`readRepo` of the runner). Past that, each
  read of the repo fails until the files are fixed on disk.
- Each file has `schema_version` (now 1). A file without it gets only one problem, which names
  `halinka migrate --write` and Apply fixes of the editor. A newer version gets only a problem that asks for a Halinka update. The parse does not
  give `schema_version` in its value.
- `migrateDefinition` (`packages/workflow`) rewrites a file without `schema_version`. It edits the source text, so the
  lines that no rule changes keep their format and comments. It returns the new source and each change. A key that
  an older schema had and that needs a decision of a person stays in the file; the parse gives its reason
  (`removedKeys` of `parseYaml`), not "Unknown key".
- `config.yml`: `server` (`local` or the URL of the server), `devcontainer` (the path of the devcontainer file) and
  `setup`, which needs `devcontainer`: `network` (what the lifecycle commands and `setup.run` reach: `false` by
  default, `true`, or host names), `run` (one command per workspace, in the container) and `secrets` (names of repo
  secrets; only `run` gets them).
- A workflow has `name`, `inputs`, `on`, `branch.name`, `runs-on` (labels that the runner must have), `max_cost_usd`,
  `concurrency` and `steps` of type `shell`, `agent`, `approval`, `github` and `loop`. Each step has `id` and `if`.
  [docs/examples/reference.yml](../examples/reference.yml) shows every key with a short note;
  [issue-to-pr.yml](../examples/issue-to-pr.yml) and [pr-review.yml](../examples/pr-review.yml) are workflows to copy.
- The parse is strict: an unknown key is a problem. `parseYaml` refuses keys that are not strings, aliases that refer to
  themselves, and the key `__proto__`. `parseWorkflow` with `agents` also checks the agent of each step, `tools`
  against the permissions, `shell: false` for an agent that asks no permission (`codex`), and `max_cost_usd` for an
  agent that reports no cost. Run creation, the workflow list and the editor parse with the agents.

## Inputs and branch

- Inputs: `string` (default), `number` or `boolean`, with `required`, `default` and `description`. A blank form value
  takes the default; `required` with `default` is a problem. An input that can have no value must be read with `??`.
- `branch.name` is a template of `inputs`. Without it, the branch is `halinka/run-<id>`; a `github` repo refuses that
  form as a name. A run never takes a branch that another active run of the repo uses; a `github` repo also refuses a
  name that a retained run holds ([github.md](github.md#repos)).

## Expressions

- `${{ }}` holds an expression of a hand-written grammar (`expressions.ts`): paths, literals, `== != && || ! ??`,
  `contains(whole, part)` and `starts_with(whole, part)`. No eval. Allowed in an agent `prompt`, an approval
  `message`, a `github` `body`, `branch.name`, `concurrency.group`, `if`, `until` and `on.<event>.inputs`; never in a
  shell `run` or a gate `run`.
- Roots: `inputs`, `steps` (earlier steps: `status`, `summary`, `outcome`, `outputs`), `loop` (`loop.iteration`,
  `loop.previous.<step>`) inside a loop, and `event` only in `on.<event>.inputs`.
- A missing value is an error unless `??` gives a default. `??` binds looser than `==`: a comparison right of `??`
  needs parentheses.
- Type checks at parse (`expressionChecks.ts`): `!`, `&&`, `||`, `if` and `until` need a boolean; `==` and `!=` need
  two values of one type, and a list or a map compares only with `null`. A status compares only with `succeeded` and
  `skipped`, because a later step sees no other status. An outcome must be one of the step, and not one that fails
  the step. A read of a step with `if` passes at parse and fails at run time when the step is skipped. A child of a
  skipped loop reads as `{ status: "skipped" }`.

## Steps

Every step ends with one result shape (`StepRunResult` in `@halinka/protocol`):

- `status`: `succeeded`, `failed`, `skipped` or `cancelled`. The engine sets it, never an agent. A step run that a
  reopen replaced has the status `superseded`, which is not a result.
- `outcome`: a value of the step's `outcomes`, a list or a map of each outcome to `ok` or `fail`. An outcome mapped to
  `fail` fails the step with `summary` as the reason, so a reviewer that rejects still succeeds.
- `summary`: required for an agent step; the tail of the output of a shell step; the note of an approval.
- `outputs`: the declared typed values: `string`, `number`, `boolean`, an array or a map of fields. Every field is
  required.

An agent reports `summary`, `outcome` and `outputs` with the `report_result` tool, whose JSON schema comes from the step
(`reportSchema` in `stepReport.ts`). Outputs are never read from the transcript
([agents.md](agents.md#report-channel)). Implicit outputs of an agent step: `changed_files` (the first 1000 files,
sorted, that any attempt changed), `changed_file_count` (all of them), `commit`, `session_id`, `cost_usd` (agents that
report cost) and `reviewed_commit` for `write: false`. A declared output cannot use these names.

### Agent steps

- The step holds its whole configuration: `agent`, `model`, `prompt`, `permissions`, `tools`, `mcp_servers`, limits,
  gates, `outcomes` and `outputs`. There are no step profiles. Reuse is a copy, or YAML anchors in one file.
- Permissions: the workspace is always readable. `write` (default true): edits and a checkpoint commit. With
  `write: false` the runner discards a change of the working tree after the step and fails the step. `shell` (default
  true): commands. `network`: `false` (default), `true` or host names; an agent always reaches its provider hosts. A
  shell step and a gate have `network` too ([sandbox.md](sandbox.md#network)). A worktree run has no proxy, so
  `network` has no effect there.
- Gates: after an attempt that gave a result, did not stop at a limit and passed `require_changes`, all gates run in
  order in the sandbox against the checkpoint. A failed gate gives the tail of its output (50 lines, 8000 characters)
  to the same session with `on_fail: retry` (default); `ask_human` opens an item at once (decisions: `retry` with a
  note, `accept`, `fail`); `fail` fails the step. The budget is `max_attempts` (default 3) failed attempts; then
  `on_exhausted` applies: `ask_human` (default) or `fail`.
- `require_changes` (default true for a step that writes; a problem with `write: false`): the step run must have
  changed files, in this or an earlier attempt, by the end of an attempt, else the attempt fails as the gate
  `non-empty-diff`.
- Limits per agent session: `max_turns` (prompt turns, [agents.md](agents.md#session-and-turn-loop)), `timeout`
  (agent time, not time that waits for a person or a gate) and `max_cost_usd`. A step limit stops the agent; the
  attempt is `stopped` and does not use the budget. Then `on_exhausted`: a `limit` item lets a person continue with as
  much again of that limit, or the step fails. A limit of the loop or the run fails the step at once. After a
  recovery, `timeout` and `max_cost_usd` count the recorded usage of the step run; a reopen keeps the full budget.
- `max_reminders` (default 2): when the agent ends its turn with no report, Halinka prompts it again this many times,
  then fails the step. Another stop reason fails the step at once.
- `model`, `tools` and `mcp_servers`: see [agents.md](agents.md#model-tools-and-mcp-servers). An MCP server is a stdio
  command that the agent starts in the sandbox as the agent user, with the `network` of the step; each give-back of the
  workspace stops it. `shell` and `write` do not limit it, and a relative `command` runs the file that the workspace
  holds at that time. The name `halinka` is refused. It gets no environment of its own, so a secret cannot go in the
  YAML.

### Approval steps

- `message` goes to a person as plain text. The item has the decisions `approve` and `reject`, with a note.
- `reviewers` names `write: false` agent steps before the approval. Before the item opens, the engine checks that the
  `reviewed_commit` of each reviewer's last step run is the branch head (`staleReview` in `@halinka/protocol`); else
  the approval step fails.

### GitHub steps

`type: github` with `action: open_pull_request` (output `pull_request_url`), or `comment_on_pull_request` with a
`body` template (output `comment_url`). `open_pull_request` takes optional `title` and `body` templates, and
`closes`: one `${{ }}` of a number, the issue that the merge closes ([github.md](github.md#github-steps)). The default `timeout` is 10 minutes. `comment_on_pull_request` without
`on.pull_request`, and `open_pull_request` with it, are parse problems. The runner does the action outside the sandbox
with a token from the server ([github.md](github.md#github-steps)). "Try again" (`runs.retryStep`) takes the run back
to a failed `github` step, with no message.

### Loops

- Child steps run in order. Each iteration creates new step runs with `iteration`, and a new agent session for each
  agent step. Loops do not nest. The engine alone stops a loop: `until` is checked after each full iteration. Inside
  the loop `steps.x` is the current iteration; after the loop it is the last one.
- `max_iterations` reached fails the loop. A loop `max_cost_usd` or `timeout`
  reached fails the child and the loop, and asks no person. A child gets at most the remainder of the loop.
- Gate retries and loop iterations are separate budgets. A `lost` attempt stores no usage, so a crash undercounts a
  loop. Gate time does not count toward a loop's `timeout`.

## Costs and the run budget

- Each attempt records its cost; the `/costs` page sums the last 30 days per repo and per person. An attempt with no
  cost is counted apart, never as 0. A `running`, `lost` or `cancelled` attempt stores no cost, except the cost of a
  session that it replaced: a later attempt in its session counts the spend. A deleted run leaves the totals.
- `max_cost_usd` at the top of a workflow limits the run. When the recorded steps go past it, no new step starts and
  the run fails; a running agent stops, and its step and the run fail, with no item for a person. A step run that a
  reopen replaced counts in the totals, not in the budget. The budget follows the cost that an agent reports, so the
  last report can go past it; when it is of the last step, the run succeeds.
- The budget and the totals do not count a call that a process of the agent sends through the credential route of
  the proxy: the agent does not report it. The life of the agent command, the step `timeout` and the spend limit of
  the provider key limit that spend. Set a spend limit on a key that runs untrusted triggers.

## Concurrency

- `concurrency: { group, cancel_in_progress }`. `group` is a template of the inputs; the name counts per repo, and has
  200 characters at most. A test run has no group. Do not put `event.pull_request.head.ref` in the group: the author
  of a pull request could select the group of another workflow and cancel its runs. Use the number.
- `lockNextQueued` takes a run of a group only when no run of the group is `running` or `waiting_input`, and no lower
  run is `queued`. A run that waits for a person keeps its slot; an `expired` run frees it, and waits for the slot when
  a person continues it. A queued run that no runner can take holds its whole group; `runs.get` names the run that
  goes first as the wait reason.
- `cancel_in_progress` cancels the earlier runs of the group, also an `expired` one, after the new run commits. A
  refused run cancels nothing. It is a parse problem with `branch`, because the cancelled run holds the branch of the
  new run.

## Triggers

Only a `github` repo starts runs from `on`, for a sender who is a member, who is the author of the run. The delivery is
in [github.md](github.md#webhook-and-triggers). A trigger run is [untrusted](#untrusted-runs). A label or a comment on
GitHub spends the key of the member who made it, with no action in Halinka: keep `labels` and `starts_with` narrow.

- `issues` (`types`: `opened`, `reopened`, `labeled`; `labels`: the added label for `labeled`, else a label of the
  issue), `issue_comment` (`starts_with`: an exact prefix of a new comment on an issue, not on a pull request) and
  `pull_request` (`types`: `opened`, `reopened`, `synchronize`, `labeled`; `labels`;
  [github.md](github.md#pull-request-runs)). `synchronize` needs `concurrency.cancel_in_progress`, because each push
  starts a run.
- `on.<event>.inputs` maps fields of the event (`eventFields.ts`: `event.issue`, `event.comment`,
  `event.pull_request`, `event.sender`) to inputs. A body can be null, so it needs `??`. A value that is one `${{ }}`
  keeps its type; a number or a boolean input allows only that form. Each required input needs a value in the mapping.
- An empty value counts as a blank form field, so it takes the default of the input, and a required input refuses the
  run. Use an optional input with `default: ''` for a body that can be empty.
- With no `branch.name`, each matching event starts a run: an issue created with a label sends `opened` and `labeled`.

## Schedules

- `on.cron: { schedule, inputs }`. One schedule per workflow, five fields in UTC (weekday with 0 as Sunday): numbers,
  `*`, lists, ranges and steps. When day and weekday both have values, either one matches. A date that does not exist
  fails at parse. `inputs` holds fixed values, because a schedule has no event.
- `workflow_schedules` holds one row per workflow file of a `github` repo; the add of a repo and a push to its default
  branch rewrite them. A file that is not valid keeps its row, so its next fire records the problem. A local repo has
  no rows: use a crontab with `halinka run`.
- A fire first moves `next_fire_at` past the current time, then reads the tip and starts a run when the tip has the
  same schedule. After downtime, one run starts for the last missed time. A failed read tries again after 5 minutes.
- A fire starts nothing when a run of its workflow or its concurrency group is `queued`. Without a group, a run starts
  while the last run is active.
- A cron run has no author, so it uses the keys of the team, and it is [untrusted](#untrusted-runs): a person with
  push access who is not a member could run a shell step as the user of a worktree runner. `last_result` of the row
  records the run or the reason; no portal page shows it.

## Snapshot

Run creation reads the definitions once and stores them in `workflow_snapshots`: the workflow file, `config.yml`, the
devcontainer file at the definition commit, the parsed workflow, the setup fields, `runs-on` and the agents. A SHA-256
of the files is unique per repo and path, so an unchanged workflow shares one row. Steps, retries, crash recovery and
chat read only the snapshot.

The code of a run starts from a commit, never from the working tree. A local repo reads `HEAD` and the `.halinka/`
files of the working tree, also uncommitted, so a person can run an edit without a commit. A `github` repo reads the
tip of the default branch (`definition_sha`); a pull request run starts its code from the head of the pull request
(`base_sha`).

## Inbox

A run waits for a person with an `inbox_items` row and the status `waiting_input` (`InboxService`). Four kinds, each
with its own decisions (`kindDecisions` in `@halinka/protocol`): `approval` from an approval step (`approve`, `reject`,
with a note), `ask_human` from failed gates (`retry` with a note, `accept`, `fail`), `limit` from a step limit
(`continue`, `fail`) and `question` from the `ask_human` tool of the agent (an answer; the attempt keeps running,
[agents.md](agents.md#chat)).

- In the API an item is a union on `kind`: a question item has its questions and answer, the other kinds a message,
  a decision and a note. A stored question item has no message. An item is marked `delivered_at` when the write that
  shows the engine took it is stored.
- An approval item has no attempt, so its decision repeats in `sync` until its step finishes. An item open for more
  than 24 h expires the run ([runners.md](runners.md#desired-state)).
- A note on a `retry` or `continue` decision is also a message row, so the next prompt delivers it.

## Chat and reopen

A person sends a message to an agent step run (`runs.sendMessage`). The transcript is the chat; the session side is in
[agents.md](agents.md#chat).

- Each message is one `agent_messages` row of its step run. `sync` lists the undelivered messages of running step runs
  until the server marks them delivered: when it stores the `agent_prompt` event that lists them, it marks them
  delivered, closes the pending questions of that attempt and resumes the run, in one transaction. Delivery is at
  least once: a crash after the prompt can send a message twice. "Delivered" means that the engine sent the prompt,
  not that the agent read it ([agents.md](agents.md#chat)).
- A message to a running step with a pending `ask_human` or `limit` item resolves the item (`retry` or `continue`) in
  the transaction that stores the message; the send button says "Send", "Send and retry" or "Send and continue". A
  message to an `expired` run queues it again.
- A message to a finished step run reopens it, in a live or a finished run: the run goes back to that step, and the
  steps after it run again. The target is an agent step run that is not `running` or `superseded` and has an attempt,
  in a run that is leased without a cancel request, or finished (`runs.get.reopenTargets`). In one transaction the
  server marks the step run and each later step run `superseded` (kept as history, their items closed and their
  running attempts `lost`), starts a new step run with `reopened_step_run_id`, `reopen_before` and `reopen_after`,
  stores the message on it, and sets the run `queued`, so a live engine stops. When another active run has the branch,
  the send is a 409.
- At the claim the runner rewinds the branch ([sandbox.md](sandbox.md#publish-and-claim)), and the new step run loads
  the session of the replaced one ([agents.md](agents.md#reopen)). A loop continues at that iteration and gets back the
  usage of the superseded children. A finished run keeps its sandbox until the TTL, so a reopen can load the session.
- The edits of a person who opened the container of a finished or expired run (`workspace_opened`) are not part of the
  next checkpoint: the next attempt first commits them as "<step>: changes before attempt <n>". Before a rewind that
  discards them, the runner commits them on the old tip, so the superseded ref keeps them until the sandbox goes.

## Test runs

- A Member starts the test of a draft with `runs.test`. The run has `test_run`: it starts from the tip, with the draft
  in its snapshot, and only a container takes it. The file must have the hash that the draft started from.
- A `github` step gets a made-up URL under `https://dry-run.invalid`, with no token and no call. The server refuses the
  token, the store of a push, "Push branch" and "Open PR". A reopen and "Try again" stay.
- The run uses `halinka/run-<id>`, not `branch.name`, and has no concurrency group. It gets no setup secrets, and skips
  `setup.run` when the config names secrets. Agent keys and the network are as for any run, so a test run spends money,
  and a draft with `network: true` can reach the hosts it names.

## Untrusted runs

`workflow_runs.untrusted` marks a run with content from GitHub. Only `TriggerService` and `ScheduleService` set it; the
HTTP API has no field for it. A worktree runner does not take an untrusted run, also when a copy of its key reports
another kind. The run waits in `queued` with a wait reason.

- In a prompt, each string or object of a `${{ }}` goes in its own data block, with a new id per block and a notice to
  treat the text as data. A number, a boolean and null stay in the sentence. The gate failures of a retry, and the
  result that a reopen gives to a new session, also go in data blocks. An approval message and a `github` body go to a
  person: no data block.
- The block is a convention for the agent, not a boundary. The sandbox is the boundary.

## Limits

- `writeRepoFile` checks only the size of one file (1 MiB), not the count of files or the total size of `.halinka/`.
- A fixed `branch.name` holds one retained run in a `github` repo, so a later fire of a schedule is refused until a
  person deletes that run.
- The wait reason of a queued run can be old until the next change of that run.
- A crash after the commit of a new run with `cancel_in_progress` leaves the older runs running; the new run waits.
- A message to the reopened step while the run is `queued` is a 409 until the claim. The branch check of a reopen of a
  finished run reads before the update, so a run that another request creates at the same time gets a 500 from the
  unique index.
- After a reopen that discarded them, the edits of a person are only in the superseded ref of the workspace. A
  worktree run gives no `workspace_opened` signal.
- The spend of a cancelled attempt that no later attempt loads is not in the totals.

## Decisions

- A run executes only from its snapshot. Rejected: read the YAML at each step (a change in the repo would change a run
  in progress); definitions from the head of a pull request (the author would control the gates and the prompts).
- An agent step holds its whole configuration. Rejected: step profiles or agent kinds (the step would not show what it
  does); a separate system prompt field (ACP sends it as prompt text).
- One result shape, reported through a tool. Rejected: outputs parsed from the agent's last message (not reliable).
- `changed_files` is the union of all attempts, cut to the first 1000 names with a count of all. The server is the one
  source of the step facts (usage, commit, session, changed files): `finishStep` and `finishAttempt` return them.
  Rejected:
  - a second sum in the engine: two sources, and a recovered engine counted a file past the cut twice.
  - the net change of the step: a file changed and changed back would not show.
  - complete names with one call per claimed run: a run with many large steps still goes over the receive limit.
  - fail a step whose attempts change more than 10 000 files: a long loop of small changes would fail.
- A small hand-written grammar with type checks at parse, and no code ([overview.md](overview.md#decisions)).
  Rejected: a typed empty value for an optional input or a failure at run time (the parser shows the problem earlier);
  text substitution in shell commands (an injection path).
- The engine alone decides retries, limits and loop ends; only a gate failure retries, and a limit stop does not use
  the budget. Rejected: retries after an agent error or a crash (a crash continues the step in a new attempt); an agent
  tool to end or extend a loop.
- Typed inbox kinds, a union on `kind`. Rejected: fewer kinds, for example one for `ask_human` and `limit` (each kind
  has its own choices); one flat item with nullable fields.
- Chat messages as rows, delivered when the prompt event that lists them is stored. Rejected:
  - a `jsonb` list on `step_runs`: delivery would be a read-modify-write.
  - a `deliverMessages` control-plane call: one more call to make safe for lost answers.
  - a stop 5 s after the cancel as for an abort: a long tool call would fail the attempt.
  - a note on the inbox item: a limit or a crash before the next prompt loses it.
  - delivered when the agent took the prompt: ACP answers a prompt only at the end of the turn, and the SDK does not
    show the write to stdin, so no point marks it. The first agent update of the turn is a guess that delays the
    resume of the run and hides the prompt of a failed turn.
- A message to a finished step reopens it; an approval names its reviewers. Rejected:
  - remove the reopen and start a new run: the agent's context and the later work are lost.
  - a rewind signal to the running engine: one path serves live and finished runs.
  - "each succeeded `write: false` step" as reviewers: it fails a run with a read-only planning step.
- The edits of a person get a commit before the next attempt, and a rewind keeps them in the superseded ref.
  Rejected:
  - a checkpoint kind for the person's edits: a new commit type and unleased server writes.
  - a commit when the person stops the container: a run can continue without a stop.
  - refuse a reopen after the container was opened: the server cannot see the workspace.
  - apply the edits again on the rewound branch: conflicts; a later option.
- One flag, `untrusted`, for a run with content from GitHub. Rejected:
  - `untrusted: true` on a workflow input: an author who forgets it opens a hole.
  - tracking the source of each value: an agent that read the content writes the later outputs.
  - one flag for blocks and one for the sandbox: split it when a trusted mode needs it.
  - a refusal at `runs.create` for a worktree runner: the wait reason names the problem.
  - blocks around the question and answer of a new session: a person read them.
- A test run of a draft, in a container, on the tip, with no GitHub write. `test_run` is apart from `untrusted`: the
  text is from a Member, and data blocks would change the prompts that the person tests. Rejected:
  - a base commit on the draft: add it when a person needs a test on an old commit.
  - a failure for a repo with setup secrets: no repo with `NPM_TOKEN` could have a test run.
  - only the keys of the author: a server with no login has none.
  - no network: each test of a step that installs a package fails.
  - an Admin only: a Member edits drafts.
- Costs per repo and person over 30 days, and a run budget that fails with no item. Rejected:
  - an inbox item at the limit of a run: a person raises only the limit of a step.
  - a failed run when the last report goes past the budget: the money is spent, a failure saves nothing.
  - budgets per repo, person or month: they need a period, a reset and a policy.
  - a login stored on each run: a removed member shows as "No person".
- One run of a concurrency group at a time, with `cancel_in_progress`. Rejected:
  - `max` above 1: no workflow needs it, and the check then counts and orders runs.
  - a limit per repo or server: `--capacity` limits a machine.
  - a refusal when a group is full: a trigger loses the event.
  - a lock of the active runs at a reopen: a claim whose statement started before the reopen still passes.
- Schedules from a table that a push rewrites, one run after downtime, with the keys of the team, in a container.
  Rejected:
  - pg-boss: PGlite has one connection, and it does not catch up.
  - a run for each missed time: a week offline starts hundreds of runs.
  - `cron-parser`: it brings `luxon` for about 70 lines.
  - local repos in the table: a read needs a connected runner.
  - a time zone per schedule: UTC has no repeated or skipped hour.
  - a skip when a run of the group is active: each long run would lose the next fire.
  - a read of each repo at each interval: it spends the rate limit for changes that a push announces.
- Each `.halinka/` file states its schema with an integer `schema_version`. A migration changes a file without it.
  Halinka refuses a version newer than it knows and tells the person to update Halinka. Rejected: no field, with rules that recognize the old structure (a file does not show which schema it
  follows).
- A migration rewrites the files once, at the request of a person, and the parse stays strict: an old file is not
  valid until then. Rejected: a migration at each read (a second, loose schema forever, and the file differs from what
  runs); both (the same cost, and the rewrite is then optional).
- A GitHub repo migrates with `halinka migrate --write` in a clone, then a commit and a push; the editor applies the
  migration to one workflow and publishes it as a draft. Rejected: one pull request from the server with
  `config.yml` and all workflows (a new write path for several files and for `config.yml`).
- The parse gives the reason of each key that an older schema had, in each later read. Rejected: reasons only in the
  output of the migration (after the write, each read gives "Unknown key" again).
