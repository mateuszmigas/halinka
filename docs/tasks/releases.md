# Releases and the server update

One version tag gives the npm package and the image, and the server tells admins about a new version. The decisions are
in [overview.md](../architecture/overview.md#decisions).

## To do

- A version tag gives `halinka@x.y.z` on npm and the image `ghcr.io/<owner>/halinka:x.y.z` (and `:latest`) from one
  commit. The owner decides when to publish ([npm-package](npm-package.md)).
- Add `protocolVersion` to the published `package.json`, with a test that it equals the constant: the banner reads it
  from the npm registry.
- `npm-shrinkwrap.json` in the package and in the build id (`apps/cli/build.ts`,
  [runners.md](../architecture/runners.md#decisions)), from the pnpm lockfile of the image, not from a new npm resolve.
  It holds the optional packages of all platforms. Today an npm install of the tarball takes the newest version of each
  range (`infrastructure/Dockerfile`), so a runner update can get other versions than the image. `pnpm test:pack`
  checks that the installed versions equal those of the image. How to make it from pnpm is open.
- The image serves its packed tarball for runner updates ([runner-update](runner-update.md)).
- A Compose file with `image:`, so that an update is `docker compose pull` and `up -d`. Today it has only `build:`.
  Update `docs/user/vps.md`.
- The server reads the latest version and its `protocolVersion` from the npm registry. A setting turns this off; it is
  on by default. Admins see a banner with the version and the commands: back up, `docker compose pull`, `up -d`. When
  the protocol changes, the banner says that each runner stops its runs and updates.
- `halinka start`: the same banner, with "Restart with `npx halinka@latest start`". An unpinned `npx halinka` can use a
  cached old version.
- Decide: a run snapshot holds the parsed workflow (`workflow_snapshots.resolved`), and the server reads it with no
  parse (`workflowRunRepository.ts`), so a run that waits across an update runs a workflow of the old schema on the new
  engine. Fail the open runs at an update, or parse the snapshot files again.

## Nice to have

- `removedKeys` of `parseYaml` matches a key by its name only: `base` on a shell step gets the reason of `branch.base`.
  Match by the parent path when a person reports a wrong reason, or delete the reasons of version 0 at a later version.
- At schema version 2: `parseVersioned` gives the "older" problem only for a missing `schema_version`. Give it for a
  version below the current one too, and add the migration from 1 to 2 next to the version 0 rules of
  `migrateDefinition`.
