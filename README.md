# Halinka

Self-hostable agent orchestration for the software development lifecycle. Workflows run coding agents in isolated
workspaces, with gates, an inbox for people, and pull requests as the only way that changes land.

## Start on one machine

The package is not published yet. From a checkout:

```sh
pnpm install
pnpm --filter @halinka/portal build
pnpm start
```

`pnpm start` runs the server, the portal and a runner on `http://127.0.0.1:7070`. In your repo, `halinka init` writes
`.halinka/` with a first workflow, and `halinka setup` prints instructions for a coding agent that does the setup.
Until the package is published, `pnpm --filter halinka build` makes the command: `node <checkout>/apps/cli/dist/main.js`.
The commands are in [cli.md](docs/architecture/cli.md).

## Guides

- [Run the server on a VPS](docs/user/vps.md)
- [Add a runner](docs/user/runners.md)
- [Devcontainers](docs/user/devcontainers.md)
- [Example workflows](docs/examples): copy a workflow to start.

## For contributors

- [docs/architecture](docs/architecture/overview.md): the vision, the core rules, how the system works, and the decisions.
- [docs/tasks](docs/tasks/README.md): the work to do.
- [AGENTS.md](AGENTS.md): how to work in this repository.
