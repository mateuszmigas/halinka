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
  - Publish to npm after the image push: the update banner reads the npm `latest` tag, and its `docker compose pull`
    must find the image.
  - Refuse a tag that is not `vX.Y.Z`: the update check compares only `X.Y.Z`.
  - Do the Compose item below before the first publish: the banner tells admins to run `docker compose pull`.
- A Compose file with `image:`, so that an update is `docker compose pull` and `up -d`. Today it has only `build:`.
  Update `docs/user/vps.md`.
- A snapshot stores its `schema_version` ([workflows.md](../architecture/workflows.md#decisions)): a column on
  `workflow_snapshots` with a backfill of 1. The claim fails a run with an older version and reopen refuses it. A
  `schemaVersion` change also changes `protocolVersion`. A test: a stored `resolved` of each released version parses
  with `workflowSchema` (a new zod `.default()` changes `resolved` with no version change). Pages of finished runs read
  only `id`, `type` and loop children of `resolved`.

## Checks

- From an installed build (the e2e suite runs the source): `halinka ssh <run>`, `halinka open` and `scp` against a
  runner (the bundled `ssh2`); `halinka start --runs-in docker` (the copied devcontainer CLI and its `scripts/`); the
  GitHub login of `halinka server`; `halinka runner` from `versions/current`; Postgres with TLS.
- After the first two publishes: `https://registry.npmjs.org/halinka/latest` gives `protocolVersion`, and a server of
  the older version shows the update banner. Until the first publish, each check logs a 404.

## Nice to have

- `removedKeys` of `parseYaml` matches a key by its name only: `base` on a shell step gets the reason of `branch.base`.
  Match by the parent path when a person reports a wrong reason, or delete the reasons of version 0 at a later version.
- At schema version 2: `parseVersioned` gives the "older" problem only for a missing `schema_version`. Give it for a
  version below the current one too, and add the migration from 1 to 2 next to the version 0 rules of
  `migrateDefinition`.
