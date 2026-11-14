# Releases and the server update

One version tag gives the npm package and the image, and the server tells admins about a new version. The decisions are
in [overview.md](../architecture/overview.md#decisions).

## To do

- A push of a tag `vX.Y.Z` publishes `halinka@X.Y.Z` on npm and `ghcr.io/mateuszmigas/halinka:X.Y.Z` (and `:latest`)
  from one build ([overview.md](../architecture/overview.md#decisions)). The workflow fails when the tag differs from
  the version of `apps/cli/package.json`. The owner decides when to push the first tag ([npm-package](npm-package.md)).
  The npm publish needs a token or npm trusted publishing (OIDC) in the repository settings. Build once: publish the
  `/app/halinka.tgz` of the image build, not a second `pnpm pack` on the workflow host (another build can give
  another build id). `dist` has no native code, so a multi-arch image can build its first stage once with
  `--platform=$BUILDPLATFORM`.
- Add `protocolVersion` to the published `package.json`, with a test that it equals the constant: the banner reads it
  from the npm registry. Add it before the build id and the pack.
- A Compose file with `image:`, so that an update is `docker compose pull` and `up -d`. Today it has only `build:`.
  Update `docs/user/vps.md`.
- The server reads the latest version and its `protocolVersion` from the npm registry. A setting turns this off; it is
  on by default. Admins see a banner with the version and the commands: back up, `docker compose pull`, `up -d`. When
  the protocol changes, the banner says that each runner stops its runs and updates.
- `halinka start`: the same banner, with "Restart with `npx halinka@latest start`". An unpinned `npx halinka` can use a
  cached old version.
- A snapshot stores its `schema_version` ([workflows.md](../architecture/workflows.md#decisions)): a column on
  `workflow_snapshots` with a backfill of 1. The claim fails a run with an older version and reopen refuses it. A
  `schemaVersion` change also changes `protocolVersion`. A test: a stored `resolved` of each released version parses
  with `workflowSchema` (a new zod `.default()` changes `resolved` with no version change). Pages of finished runs read
  only `id`, `type` and loop children of `resolved`.
- Server settings in the database ([overview.md](../architecture/overview.md#decisions)), with a page for admins in
  the Settings group of the portal. The first setting is the update check (on by default); `halinka start` reads it.
  - A `server_settings` table with one row and a typed column per setting, with SQL defaults (the one-row pattern of
    `server_identities`). The server loads the row after `openDb` and holds it in one class; the settings service
    writes the row, then sets the class. Range rules go in the zod input schema of the contract. Lease and sweep stay
    environment variables.

## Checks

- From an installed build (the e2e suite runs the source): `halinka ssh <run>`, `halinka open` and `scp` against a
  runner (the bundled `ssh2`); `halinka start --runs-in docker` (the copied devcontainer CLI and its `scripts/`); the
  GitHub login of `halinka server`; `halinka runner` from `versions/current`; Postgres with TLS.

## Nice to have

- `removedKeys` of `parseYaml` matches a key by its name only: `base` on a shell step gets the reason of `branch.base`.
  Match by the parent path when a person reports a wrong reason, or delete the reasons of version 0 at a later version.
- At schema version 2: `parseVersioned` gives the "older" problem only for a missing `schema_version`. Give it for a
  version below the current one too, and add the migration from 1 to 2 next to the version 0 rules of
  `migrateDefinition`.
