# GitHub

How Halinka talks to GitHub: the App, its tokens, `github` repos, the webhook, pushes and pull requests. Read
[workflows.md](workflows.md#triggers) first for the YAML of triggers and `github` steps.

Halinka writes to GitHub with short-lived tokens of a GitHub App, one token per action. The App key stays on the
server (`githubAppService.ts`). `githubApi.ts` holds each GitHub REST call of the server, also the user read of a new
member. The runner does each git push and each pull request call on the host, outside the sandbox
(`packages/runner/src/github.ts`, `branchPusher.ts`), with a token that the server puts in the input of the command or
gives under the lease of the run.

## GitHub App

- An Admin creates one App per server on the GitHub page of the portal (`/github`): the portal posts a manifest to
  GitHub, GitHub returns to `/github/created`, and the Admin clicks Connect. An optional organization name selects the
  owner. The App is private, so it installs only on the account that owns it.
- The flow state is a sealed value with the expiry (one hour) and the organization, in a place that names the Admin.
  After the conversion, the server refuses an App whose owner is not the organization of the state or, without one,
  the GitHub user of the Admin. A server without a login checks only the organization.
- `github_apps` holds at most one row. `SecretCipher` seals the private key and the webhook secret, in a place that
  names the App and the secret; the server drops the client secret. `isReadable` on the status says whether the current
  master key opens the private key.
- The manifest asks for `contents`, `issues` and `pull_requests` write, and `metadata` read, and for the events
  `issues`, `issue_comment`, `pull_request` and `push`. It does not ask for `workflows`: a push that changes
  `.github/workflows` fails with an App token. A server on a local host gets an App with no webhook and no events,
  because GitHub cannot reach it and refuses a manifest with events and no webhook; the API cannot turn a webhook on
  later. A change of the permissions or the events is
  a manual step at GitHub, and each owner must approve it again.
- Refresh, a return from the install page, and an `installation` or `installation_repositories` delivery read the
  installations with an App JWT (`node:crypto`, `fetch`, no package), and the repos of each installation with a token
  that reads only metadata. The write updates by GitHub id and deletes what is missing, so a row that stays keeps its
  id. A suspended installation lists no repos.
- Disconnect removes the rows and leaves the App on GitHub: only its owner can delete it there. It is also the way out
  after a lost master key or a wrong owner. A link of a `local` repo stays, and the runner then pushes with `gh`.

## Tokens

`GitHubAppService.findRepoToken(githubRepoId, action)` asks GitHub for an installation token with `repository_ids` of that
repo and the permissions of the action (`actionPermissions`): `read` and `clone` read contents, `push` writes contents,
`openPullRequest` and `publishDraft` write contents and pull requests, `comment` writes pull requests only. The answer
gives the current owner and name, so a rename keeps the link. A repo whose installation is missing from the stored list
fails with a text that names the link. A repo with no link, or a server with no App, gets no token: a `local` repo
then uses `gh`, and a `github` repo has no other path. A token stays valid for its hour, also when nobody uses it. The
runner masks the token in the error of its own command.

## Repos

- A `local` repo is a checkout on one runner. An Admin links it to a repo of the App on the GitHub page
  (`repos.linkGitHub`). The runner refuses a push when the `origin` of the checkout is another repo than the link.
  Without a token (no link, or no App), the runner uses the `gh` login of the runner user (`gh auth token`), which is a
  lent value. An Admin removes the link to use `gh` on purpose.
- A `github` repo (`repos.createGitHub`) is a repo of the App, with no runner and no path. The server reads
  `.halinka/` from the tip of the default branch through the git data API, with a token per read and no cache
  (`readDefinitions`), with the limits of `readRepo` ([workflows.md](workflows.md#files)). Only regular files count: a
  symlink is skipped, and a `.halinka` that is a symlink is refused. A rename on GitHub does not change the name of
  the row.
- Each runner keeps one mirror (a bare repository) per `github` repo, with no remote and no stored token. Before a run
  prepares its workspace, the runner fetches `definitionSha` and `baseSha` when the mirror does not have them, with a
  read token from `ControlPlane.readMirrorAccess(lease)`. A mirror whose config rewrites the GitHub URL refuses the
  fetch. The mirror stays after the repo is deleted.
- One branch name holds one retained run in a `github` repo: `runs.create` refuses a `branch.name` that another run of
  the repo holds, until that run is deleted, a name of the form `halinka/run-<number>`, and a name that is the
  default branch.

## Webhook and triggers

- `POST /api/github/webhook` comes before the login and host checks of the API: the signature (`X-Hub-Signature-256`)
  is its check. 404 without a webhook secret that the server can open, 401 for a bad signature, 400 for a bad body,
  413 above 25 MiB, else 202 at once. The server then does the work in the same process (`GitHubDeliveryService`),
  because GitHub waits 10 s.
- `github_deliveries` has one row per delivery id. A repeated id does nothing, except on a row without a result that
  started more than 10 minutes ago: "Redeliver" at GitHub then does the work again. The result holds the runs or the
  reason per workflow, with no text of the event. Rows go after 7 days.
- `issues`, `issue_comment` and `pull_request` go to `TriggerService`. It stops before any GitHub read when the repo is
  not a `github` repo of this server or the sender maps to no member; a bot maps to nobody. It reads the workflows of
  the tip once, and `triggerInputs` (`packages/workflow/src/triggers.ts`) matches each one. The mapped member is the
  author of the run, and the run is untrusted ([workflows.md](workflows.md#untrusted-runs)). A workflow that fails gets
  a note in the result, and the other workflows go on.
- A `push` to the default branch rewrites `workflow_schedules` ([workflows.md](workflows.md#schedules)). An
  `installation` or `installation_repositories` delivery reads the installations again.

## Push branch and Open PR

- `runs.push` ("Push branch") is for a run that ended or expired, has a runner, is no test run, and has a checkpoint
  after `base_sha`. `runs.openPullRequest` ("Open PR") also needs `succeeded`, no pull request number, and that the
  `reviewers` of the last approval of the run reviewed the commit (`staleReview` in `@halinka/protocol`). `PushService`
  checks under the row lock of the run, asks for a token when the runner is connected, and calls the runner without
  the lock.
- The runner takes the workspace lock of the run (at most 3 s), stops the processes that a crashed push left, and
  pushes the commit that the server checked, not the branch name, with `--force-with-lease`. It has 50 s. Before the
  push it scans the message, the paths and the added lines of each run commit for lent values, up to 1000 commits and
  64 MiB; a hit or a limit refuses the push. The push goes to the https URL of the repo, with the token in a header for
  that host, given to one git process. A `url.*.insteadOf` rule for that URL refuses the push.
- The lease: `pushed_branches` holds the last pushed commit per repo and branch, and the URL of the pull request. The
  runner reads the tip of the branch on GitHub first. No tip: an empty lease, so the branch must not exist. A tip that
  is a run commit, or `base_sha` in "Push branch" of a pull request run: that tip. Any other tip: the stored lease, so
  a change that a person made on GitHub stays. No stored lease refuses the push before git. The server stores the new
  commit only over the value that the push expected.
- "Open PR" sends the title `<workflow name> (Halinka run #<id>)` and a fixed body: step summaries are untrusted text,
  and GitHub acts on mentions, issue keywords and links. The runner finds the open pull request of the branch, or
  opens a draft on the default branch, after a check that the base of the run is on the base branch of the pull
  request. A pull request error after the push is an answer, not an error: the server stores the push and fails the
  action with the reason.

## GitHub steps

- The runner does the action behind a port of the engine (`runPullRequest.ts`, `runComment.ts`). The engine never holds
  the token.
- `open_pull_request`: `ControlPlane.readPushAccess(lease, stepRunId)` gives the commit (the last checkpoint), the
  token and the stored lease. It needs the lease of the run and a running `open_pull_request` step of this run, and
  makes the checks of "Open PR". The runner pushes, stores the push, opens the pull request, and stores the URL. The
  engine makes the text with `pullRequestText` (`@halinka/protocol`): the step `title` on one line, cut at 256
  characters, or the title of "Open PR" when it is empty; the fixed line of "Open PR", the step `body` in a code fence
  as in a comment, and `Closes #<closes>` after the fence. The engine fails the step when `closes` is not a positive
  whole number. A retry keeps the text of the open pull request. The push stays stored when the pull request fails. A retry finds the tip on GitHub and the
  open pull request of the branch.
- `comment_on_pull_request`: `readCommentAccess(lease, stepRunId)` needs a running `comment_on_pull_request` step, and
  gives the number from the run and a `comment` token, or the URL that a first attempt stored on the step run, so a
  repeat posts nothing. The comment is a fixed line and the body in a code fence longer than each run of backticks,
  cut at 20000 characters: content of a pull request makes no mention and no link. A crash after the post and before
  the store posts twice.
- A test run gets no token ([workflows.md](workflows.md#test-runs)).

## Publish a draft

`repos.publishWorkflow` is for a Member on a `github` repo ([portal.md](portal.md#workflow-editor)). It changes one
file that exists at the tip under `.halinka/workflows/`, and refuses a stale `baseHash`, a draft that does not parse,
and a draft equal to the file. With a `publishDraft` token, it writes a tree, a commit with the tip as parent, then the
branch `halinka/draft-<hash of the path, the base hash and the source>`, then a draft pull request. The branch comes
last, so a failure leaves no branch without the file. A branch with that name is this draft, and the open pull request
of the branch is the answer. The title and the commit message are fixed; the body holds the path and the login of the
Member in a code fence.

## Pull request runs

- `on.pull_request` starts a run for a pull request that is open, from this repo, and into the default branch. A fork
  starts nothing, with no setting; a head repo that is gone counts as a fork. A draft starts a run.
- The run has two commits: `baseSha` is the head of the pull request, and `definitionSha` is the tip of the default
  branch, which gives the workflow, the devcontainer and the build. It gets no setup secrets, and skips `setup.run`
  when the config names secrets. The run keeps `pullRequestNumber`.
- The runner finds the merge base of the two commits in its mirror, and a note in the prompt of each agent gives that
  commit, so `git diff <commit>` shows what GitHub shows. An unrelated history gets no note.
- "Open PR" is refused for such a run. "Push branch" stays: a person can merge the run branch into the pull request.
  A `branch.name` from `event.pull_request.head.ref` makes the run branch the branch of the pull request, so "Push
  branch" pushes to it; use the number.

## Branch delete

- A delete of a run or a repo removes the run branch; the workspace TTL never does. The server gives the runner the
  branch only when the run has `created_branch` and no other run of the repo has that branch.
- The runner deletes the branch only when its tip is the last checkpoint and no worktree has it; in a checkout also
  only when another branch, remote-tracking ref or tag holds the tip. Otherwise the branch stays, and the run is
  deleted all the same. A mirror skips the last check: nobody can read the mirror, and a kept name blocks a later
  run.

## Limits

- The stored list of installations is as old as its last refresh. Without a webhook (a server on a local host), a repo
  that joins or leaves the App needs Refresh.
- A crash after the 202 loses that delivery; "Redeliver" at GitHub repeats it. No portal page shows deliveries.
- A comment on a pull request starts nothing: the `issue_comment` event does not say whether the pull request is from
  a fork.
- A push after GitHub deleted a merged branch creates the branch again, and a branch that a person deleted on purpose
  comes back at the next push.
- The `gh` token, and a read token during a full fetch, are in the environment of one git process. An agent of a
  worktree run of the same user on that machine can read it for that time.
- The push scan reads file names from the quoted diff headers, so a value in a file name with a non-ASCII or control
  character passes.
- A `baseSha` that a force push removed between the start and the claim fails the fetch.
- A new workflow file cannot be published: the path must exist at the tip.
- A closed pull request gets a new one at the next "Open PR", publish, or reopen of the step.
- A token that a step gets stays valid for its hour on the runner, for one repo and one action. A runner that holds a
  `comment` token can comment on another pull request of that repo.

## Decisions

- An App from a manifest, with its key sealed in the database and an owner check after the conversion. Rejected:
  - a manual App setup or the key in the environment or a file: many settings to copy.
  - a table or a one-time value for the state: the owner check stops the attack.
  - no stored list with a live read: a `github` repo needs one to select from.
- A token per action, for one repo, in the input of the runner command; an Admin links by hand. Rejected:
  - owner and name read through the runner at register: the runner gives the value, so an Admin does not approve it.
  - a failure for a repo without a link when an App exists: the runner has its `gh` login anyway.
  - `gh` when the installation of a linked repo is missing: an Admin who removes the App to stop pushes still gets
    pushes.
  - a runner-to-server call for a push token with no lease: a runner could ask at any time.
  - a check of the Member's GitHub permission: a new product rule.
- The push and the pull request run on the runner, with the commit that the server checked and a lease in
  `pushed_branches` ([above](#push-branch-and-open-pr)). Rejected:
  - `git push` with the user's credentials and `gh pr create`: a second path for the App.
  - any tip as the lease: it overwrites a change on GitHub.
  - the lease on the run: a later run on the branch starts without it.
  - a push of an active run: the engine can move the branch.
- A tip at `base_sha` is the run's only in "Push branch" of a pull request run, whose branch can be the head of the
  pull request. Any other run starts at the tip of the default branch or of the checkout, so a `branch.name` that
  names a branch on GitHub at that commit (`release/2`) can move it. `BranchPush.pullRequestNumber` tells the runner. The
  `open_pull_request` step never sends it, and the parse refuses that step with `on.pull_request`
  ([workflows.md](workflows.md#github-steps)): an untrusted run must not write to the branch of a person. Rejected:
  - a match of the run branch with the head ref of the pull request: a column for a branch that has the head commit
    and a name that the workflow gave; a person who can make that branch can push it.
  - `pushedCommit = base_sha` for a pull request run: the server stores the push only over that value, and no row
    holds it.
  - a check of the branch on GitHub at `runs.create`: a branch made after the create still moves.
- "Open PR" checks the reviewers of the last approval only. Rejected: every approval (a step after an earlier approval
  moves the head, so the check refuses almost every run).
- A deleted run takes its branch in a checkout only when another ref holds the commits. Rejected:
  - a delete with no check.
  - trust `pushed_branches`: the row can outlive the branch on GitHub.
  - a TTL job: 24 h is too early for a person who has not looked.
  - a kept branch in the mirror: nobody can read it, and the name blocks the next run.
- A `github` repo is read through the API with no cache, each runner keeps one mirror, and a run is pinned at the
  first claim. Rejected:
  - a clone per run: a full fetch per run.
  - the token in the answer of `sync`: a GitHub call inside a 20 s call.
  - a warning in place of the refusal for a used branch name: a second runner overwrites the pushed branch.
  - move a run to another runner: a later item.
- `runs.create` refuses a `branch.name` that is the default branch, so the person gets the reason before the run
  starts, not at "Push branch" after its steps. Rejected:
  - a `halinka/` prefix for each run branch: it breaks a branch from `event.pull_request.head.ref`.
  - a check on the runner: the name is fixed at run creation.
- A delivery is answered at once and done in the same process, with a row that holds the result and no text of the
  event; the mapped actor is the author. Rejected:
  - author null with the key of the team: a person must pay for the main way to start a run.
  - a durable inbox with the payload and a resume after a restart: it stores issue text and needs a worker for a small
    window.
  - a cancel and restart on a repeated trigger: it loses work; a queue belongs to concurrency groups.
  - a cache of the tip: the actor check stops outsiders first.
- A `github` step runs on the runner under the lease, with the checks of "Open PR" and no forced approval: the trusted
  workflow selects where the approval is. Rejected:
  - the server does it with the `pushBranch` command: the command refuses a run that holds the workspace lock, and the
    server cannot hold a call for 50 s.
  - the server opens the pull request after the push: a second GitHub client and a second `gh` path.
  - a table of operations with a marker in the body: a retry happens only after a crash or a reopen.
  - a forced approval for an untrusted run: a new product rule.
- An `open_pull_request` step has `title`, `body` and `closes` templates: the body goes in a fence, and only the
  number of `closes` is outside it. A title can hold untrusted text, because GitHub notifies no mention and closes no
  issue from a title. Rejected:
  - a value of each template in its own fence, and numbers outside it: the interpolation has no types.
  - Markdown with an escape of mentions, issue references and links: GitHub has more forms than a list holds.
  - the step text for "Open PR": the button has no step.
  - an edit of the text of an open pull request on a retry: it removes the edits of a person.
- A comment goes from the runner, with the number from the run and the body in a fence. Rejected:
  - a post from the server: a second home for one step type.
  - a number from an input: a manual run could comment anywhere.
  - a search for a marker before each post: more requests for a small window.
- A draft is published through the git data API, on a branch named by the hash of the draft, with the branch last and
  a parse check. Rejected:
  - the contents API: it needs a branch before the write, and a failure leaves that branch for a retry to take.
  - a check of the tree of an existing branch: a person who pushed there meant it.
  - no parse check: a pull request of a broken workflow helps nobody.
- A pull request run has the code of the head and the definition of the default branch; a fork starts nothing; the
  merge base note comes from the runner. Rejected:
  - a ref for the base in the workspace: an agent can move it.
  - a build from the head: lifecycle commands run as root.
  - a hidden "Push branch": a person can merge the branch into the pull request.
  - a fork setting or a push to the branch of the pull request: no person asked; an untrusted run would write to the
    branch of a person.
  - a protection of the files that a gate or a lifecycle command names: a review must run the code; the sandbox
    limits it.
