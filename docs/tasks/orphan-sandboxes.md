# Orphan containers and checkouts

A runner keeps the files of each server apart ([overview.md](../architecture/overview.md)). Containers and folders in
`workspaces/<serverId>` without a run on that server stay on the machine: they come from a row deleted without a report
([runners.md](../architecture/runners.md)). Normal deletion and the TTL cover every normal path, and a wrong delete
costs a person's work, so a sweep waits until a person reports leftovers.

Files from before the split stay at `workspaces/run-<id>` and `github/<id>.git`, and containers from before 2026-11-04
keep the name `halinka-run-<id>`. The scope of an old database stays too. A person removes these.

## Nice to have

- A sweep that removes only what is in the scope of the connected server and has no run there. It never touches another
  scope. It needs a protocol addition (the runner asks which run ids exist), and a rule for a run claimed between that
  answer and the delete.
- `deleteClone` needs `repoPath`, and an orphan clone has no row and no `origin`: split it, and let the sweep call only
  its file part.
- Remove the files next to a clone: `run-<id>.tree`, `run-<id>.git-config`, `run-<id>.set-up`, `run-<id>.base-files`
  and `run-<id>.bundle`. A crash can also leave `.bundle` files and temporary tree folders.
- Before an orphan worktree goes, take its workspace lock and stop the groups of `run-<id>.groups`
  ([sandbox.md](../architecture/sandbox.md)), as the `destroyed` apply of `Workspaces` does. An orphan clone has a
  groups file too: take its lock and stop its groups, for example through `Workspaces.deleteClone`.
- List labelled networks with no container too: a removal that fails at a stop leaves one with no report.
- A crash during `bringUp` can leave an image tag `halinka-pin.invalid/<name>:checked` with no label: find it by name.
- Each devcontainer run builds an image `vsc-run-<id>-*-uid`, and the delete of a run leaves it.
- Decide if a sweep removes a mirror `github/<serverId>/<id>.git` with no repo on the server. A new row for that GitHub
  repo uses it again.
