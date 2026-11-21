# Repo setup

Problems that the first real setup of a GitHub repo found (`npx halinka setup` with a coding agent, on a team server).
The text of `setup` is `apps/cli/src/setupInstructions.ts`; the person guide is [setup.md](../user/setup.md).

## To do

- Allow `-` in an identifier (for example the gate name `unit-tests`): the owner decides. The built-in gate
  `non-empty-diff` uses `-`, so a gate of the file could then take that name.
- A local server with a GitHub repo is not described. Step 1 of `setup` allows it, but steps 4 and 5 assume "local"
  means a repo on this machine and a team server means GitHub. [setup.md](../user/setup.md) says that a server on a
  local host gets an App with no webhook.
- `init --server local` for a GitHub repo tries to register the repo at the local server. Its next step ("Start Halinka
  in this repo. This registers the repo") and a warning when a local server runs and refuses do not apply to a GitHub
  repo. The owner selects an option, for example a flag `--source github` that skips the registration and prints the
  steps of a GitHub repo.

## Nice to have

- The server tells which agents of a workflow have no key, so that the portal and run start can show it. Today only
  `firstRunSteps` of `start` knows it, and it reads the team keys and the environment of its own process.
- One module of portal links for the CLI: `run.ts` and `firstRunSteps.ts` build `/runs/<id>`, `/agents` and
  `/repos/<id>/workflows/<file>` by hand, so a rename of a route in `apps/portal/src/router.tsx` breaks them.

- `halinka check --run`: build the devcontainer, run the lifecycle commands and `setup.run` with the network allowlist
  of the sandbox, run the gates offline, and list the refused hosts. The agent did this by hand with Docker, and it was
  the largest part of the setup, with only an approximate result.
- `init` proposes `setup.run` from the lockfile and the CI files.
- `init` or `check` warns about a devcontainer image with no tag (for example `javascript-node`, which is `latest`).
