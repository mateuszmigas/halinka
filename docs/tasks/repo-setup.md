# Repo setup

Problems that the first real setup of a GitHub repo found (`npx halinka setup` with a coding agent, on a team server).
The text of `setup` is `apps/cli/src/setupInstructions.ts`; the person guide is [setup.md](../user/setup.md).

## To do

- "Use only the fields in the examples" blocks fields that a normal workflow needs. The example workflow has no shell
  step, no `network`, and no `cron`, so an agent that obeys the rule cannot write a workflow that updates packages on a
  schedule. Add these to the examples (for example one gate with `network`), or change the rule.
- Step 3 of `setup` says: run `setup.run`, then each gate. It does not say to run the lifecycle commands first
  (`postCreateCommand` and the others), but they also use `setup.network`.
- The error of an identifier does not name the field or the value: `issue-to-pr.yml:42:13 Start with a letter…` for the
  gate name `unit-tests` (`identifierHint` in `packages/workflow/src/identifier.ts`). Name the field and the value.
  Allowing `-` is an owner decision: the built-in gate `non-empty-diff` uses it, so a gate of the file could take that
  name.
- A local server with a GitHub repo is not described. Step 1 of `setup` allows it, but steps 4 and 5 assume "local"
  means a repo on this machine and a team server means GitHub. [setup.md](../user/setup.md) says that a server on a
  local host gets an App with no webhook.
- `init --server local` for a GitHub repo tries to register the repo at the local server. Its next step ("Start Halinka
  in this repo. This registers the repo") and a warning when a local server runs and refuses do not apply to a GitHub
  repo. The owner selects an option, for example a flag `--source github` that skips the registration and prints the
  steps of a GitHub repo.
- After it registers the repo, `start` prints what the first run still needs: a key of the agent of `smoke` (for a
  devcontainer runner), then the link of the smoke workflow. The next steps of `init` name the real agent and variable,
  not `<agent> <variable>`.

## Nice to have

- `halinka check --run`: build the devcontainer, run the lifecycle commands and `setup.run` with the network allowlist
  of the sandbox, run the gates offline, and list the refused hosts. The agent did this by hand with Docker, and it was
  the largest part of the setup, with only an approximate result.
- `init` proposes `setup.run` from the lockfile and the CI files.
- `init` or `check` warns about a devcontainer image with no tag (for example `javascript-node`, which is `latest`).
