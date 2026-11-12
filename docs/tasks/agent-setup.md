# Agent setup

`halinka setup` and `halinka check` are built ([cli.md](../architecture/cli.md#set-up-a-repo)). The first real run on
a GitHub repo passed.

## To do

- Decide if the example review prompt asks for copies and side effects. It says "Report only blocking issues", so a
  review can approve copied code and side effects.
- Decide if the implement prompt asks for a summary that a person reads in a pull request (what changed and why). The
  pull request body is `steps.implement.summary`.
- Decide if `halinka init --server <url>` warns, or if the URL moves to the settings of the machine (`halinka use`
  exists). It writes the URL in a committed file, and `server` selects a server only for the CLI.
- A guide in `docs/user` for the whole path. The GitHub App, keys and workflows have no user guide.

## Checks

- A Codex run with a ChatGPT login after the change to exact credential paths, at the pinned codex-acp version (it uses
  Codex `^0.159.1`; the paths come from Codex 0.167). A missing path shows as 403 "Halinka lends no credential". Check
  the Codex log for the config bundle: Codex 0.167 names three forms of its path, and it retries a failed fetch until a
  timeout.
- A run that the label `halinka` starts.

## Nice to have

- A run of a `github` repo from the CLI. `halinka run` finds only a local repo on this runner, and `--repo` is a path,
  so a name needs another flag. Fable wants this so that the agent can see the result; Codex keeps the portal.
- `status`: `--json`, and output when one section fails. It stops at the first failure, and a server behind Cloudflare
  Access gives a parse error, not a hint.
- A "Set up repo" button for a `github` repo: a sandboxed run that ends in a pull request. It needs a definition from
  Halinka and not from the repo, so it needs a decision on core rule 1. The repo page of a `github` repo has no way to
  add its first workflow.
- `check` reads `.halinka/` with its own `readdir`. The server read also has limits of size and count, and drops a link
  that points outside. Share that read if a real setup passes `check` and then fails on it.
- The allowlist of the devcontainer in `check`, if a refused setting costs a real setup a cycle. A refusal shows only
  after the merge. `devcontainer read-configuration` runs `docker ps` first, so it cannot run offline. Parse the file as
  JSONC, and run `checkDevcontainer` on it: this misses image metadata and Features, which stay a refusal at run time.
- A root command has the `HOME` of the remote user (`start` in `packages/sandbox/src/devcontainer.ts`). A `prefix=` in
  the `~/.npmrc` of that user puts an agent adapter where the agent user cannot run it, and each start installs it
  again. Give root its own `HOME` in addition to `--cache /root/.npm`. The flag stays, because it also wins over
  `NPM_CONFIG_CACHE` from `remoteEnv`.
