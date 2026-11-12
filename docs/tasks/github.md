# GitHub push and pull requests

"Push branch", "Open PR" and tokens per action are built ([github.md](../architecture/github.md)). Tests use a fake
GitHub.

## Checks

On a real GitHub account, or in an e2e test:

- A delivery from a sender who is not a member.
- "Redeliver" of a delivery.
- The link of a local repo to a GitHub repo.
- "Push branch".
- The text of an `open_pull_request` step: `Closes #N` closes the issue at the merge, and a `#123` in the title adds no
  "mentioned this" event to issue 123. If it adds one, make `#` and `@` in the title inert.
- The publish of a draft: the commit of the App, the fence in the body, a race of two publishes, a rule of the repo on
  `halinka/*`.
- A pull request run: the actions other than `opened` and `synchronize`, a label on a merged pull request, a fork, and a
  fence in a real comment.
- Cron: a server that restarts after a missed time, a failed read at a fire, and a worktree runner that refuses the run.
- A test run in a real container with a `github` step. Tests cover the server and the runner apart.
- The "Push branch", "Open PR" and publish buttons in e2e: they need GitHub.

## Nice to have

- Revoke a token after its action with `DELETE /installation/token`, when one hour in the runner becomes a problem. A
  failure of this call must keep the result of the action.
- Check the GitHub permission of the Member on the repo ([overview.md](../architecture/overview.md) gives each Member
  the run actions). Find the answer of `GET /repos/{o}/{r}/collaborators/{login}/permission` for a person with no
  access.
- A local branch at the base of the run: `requireValidBranch` in `packages/runner/src/workspaces.ts` takes an existing
  local branch whose tip is `baseSha`, and the checkpoints of the run move it. When the branch is on GitHub and Halinka
  did not push it, the push lease refuses its push, but only at "Push branch", after the steps. Refuse the branch when
  the workspace is made, with a fact that the run created it (a retry also finds the run's own branch at `baseSha`).
- The webhook of a local App: an App that a local server created has no webhook and no events. Its owner turns on both
  at GitHub, and the server sets the secret with `PATCH /app/hook/config`. Do this when a local server gets a public
  URL. The webhook route answers 404 until then.
- A summary in the subject of a checkpoint commit (today "<step id>: attempt <n>", `packages/engine/src/checkpoints.ts`).
  It needs the one-line rule of the title (`oneLine` in `packages/protocol/src/githubText.ts`). Do not put a summary in
  the body: GitHub acts on its issue keywords and mentions when the commit lands on the default branch.
