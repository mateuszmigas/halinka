# Halinka

Self-hostable agent orchestration for the software development lifecycle. Workflows run coding agents in isolated
workspaces, with gates, an inbox for people, and pull requests as the only way that changes land.

## Start on one machine

Halinka needs Node.js 24.20 or later, and one of these for runs:

- Docker: runs execute in a devcontainer (`init` can create one). Add the key of the agent on the Agents page of the
  portal.
- The command of the agent, installed and logged in: runs execute in a worktree with no sandbox
  (`halinka start --runs-in worktree`). Use it only for a repo that you trust.

In your repo, tell your coding agent: "Run `npx halinka setup` and follow it."

To do the setup by hand:

```sh
npx halinka init
npx halinka start
```

`init` writes `.halinka/` with a first workflow. `start` runs the server, the portal and a runner on
`http://127.0.0.1:7070`. The commands are in [cli.md](docs/architecture/cli.md).

To run from a checkout:

```sh
pnpm install
pnpm --filter @halinka/portal build
pnpm start
```

## Guides

- [Set up a repo](docs/user/setup.md)
- [Run the server on a VPS](docs/user/vps.md)
- [Add a runner](docs/user/runners.md)
- [Devcontainers](docs/user/devcontainers.md)
- [Example workflows](docs/examples): copy a workflow to start.

## For contributors

- [docs/architecture](docs/architecture/overview.md): the vision, the core rules, how the system works, and the decisions.
- [docs/tasks](docs/tasks/README.md): the work to do.
- [AGENTS.md](AGENTS.md): how to work in this repository.
