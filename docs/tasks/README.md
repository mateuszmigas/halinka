# Tasks

One file per task. Each file has a title, one paragraph (what is built, with links), then the sections that apply, in
this order:

- `## To do`: work to do now.
- `## Checks`: checks on a real machine or a real GitHub, not done yet.
- `## Nice to have`: work to start when a person needs it.

When a task is done, delete its file and its line here. A new task gets a file and a line in its group.

## Release

- [npm-package](npm-package.md): publish `halinka@0.1.0` from a public repository.

## Checks

- [releases](releases.md): the first release from a real tag, and the update banner after two publishes.
- [runner-install](runner-install.md): `halinka runner install` on other hosts, and its e2e tests.
- [runner-update](runner-update.md): a real update of an installed runner, and the e2e tests of the start path.
- [agent-setup](agent-setup.md): a Codex run, and a run that a label starts.
- [github](github.md): push, pull requests and triggers on a real GitHub.
- [docker-in-container](docker-in-container.md): Compose and amd64.
- [image-locks](image-locks.md): `FileLocks` on a real VPS.
- [flaky-tests](flaky-tests.md): the log of the next failure of three tests.

## Nice to have

- [portal-redesign](portal-redesign.md): the rest of the new design.
- [local-secret](local-secret.md): a secret for the server without a login, on a machine with other users.
- [notifications](notifications.md): a Slack webhook for inbox items.
- [gate-secrets](gate-secrets.md): secrets for gates.
- [pr-triggers](pr-triggers.md): more `pull_request` events and PR comments.
- [cron-triggers](cron-triggers.md): more of `cron` triggers.
- [cost-budgets](cost-budgets.md): budgets beyond one run.
- [run-page](run-page.md): small fixes of the run page.
- [orphan-sandboxes](orphan-sandboxes.md): a sweep of containers and checkouts with no run.
- [pr-outcome](pr-outcome.md): the state of the pull request of a run (open, merged, closed).
- [step-artifacts](step-artifacts.md): files of a step that the run keeps after the workspace TTL.

## Later

- [cloudflare-server](cloudflare-server.md): the server on Cloudflare.
