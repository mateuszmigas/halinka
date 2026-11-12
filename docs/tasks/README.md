# Tasks

One file per task. Each file has a title, one paragraph (what is built, with links), then the sections that apply, in
this order:

- `## To do`: work to do now.
- `## Checks`: checks on a real machine or a real GitHub, not done yet.
- `## Nice to have`: work to start when a person needs it.

When a task is done, delete its file and its line here. A new task gets a file and a line in its group.

## Release

Do these in this order.

1. [releases](releases.md): the npm package and the image from one tag, and the update banner of the server.
2. [npm-package](npm-package.md): publish the package `halinka`, when the owner says that it is ready.

## Checks

- [runner-install](runner-install.md): `halinka runner install` on other hosts, and its e2e tests.
- [runner-update](runner-update.md): a real update of an installed runner, and the e2e tests of the start path.
- [agent-setup](agent-setup.md): decisions on the example prompts, a Codex run, and the user guide.
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

## Later

- [cloudflare-server](cloudflare-server.md): the server on Cloudflare.
