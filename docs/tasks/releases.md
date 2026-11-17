# Releases and the server update

One version tag gives the npm package and the image, and the server tells admins about a new version. The decisions are
in [overview.md](../architecture/overview.md#decisions).

## Checks

- The first run of `.github/workflows/release.yml` on a real tag: the two platforms of the image, the tarball from the
  image, the files of the GitHub release, and the npm publish through OIDC. A rerun after a failed npm step uploads
  the release files again.

- From an installed build (the e2e suite runs the source): `halinka ssh <run>`, `halinka open` and `scp` against a
  runner (the bundled `ssh2`); `halinka start --runs-in docker` (the copied devcontainer CLI and its `scripts/`); the
  GitHub login of `halinka server`; `halinka runner` from `versions/current`; Postgres with TLS.
- After the first two publishes: `https://registry.npmjs.org/halinka/latest` gives `protocolVersion`, and a server of
  the older version shows the update banner. Until the first publish, each check logs a 404.

## Nice to have

- `removedKeys` of `parseYaml` matches a key by its name only: `base` on a shell step gets the reason of `branch.base`.
  Match by the parent path when a person reports a wrong reason, or delete the reasons of version 0 at a later version.
- At schema version 2: `sendMessage` and `retryStep` (`runService.ts`) read `locked.workflow` with `isStepOfType` before
  `reopenRefusal`, so an older run whose step changed shape gets "is not an agent step", not the migrate message. Check
  `isOlderSchema` first there, in `messageTarget` and in the inbox answer.
- At schema version 2: `parseVersioned` gives the "older" problem only for a missing `schema_version`. Give it for a
  version below the current one too, and add the migration from 1 to 2 next to the version 0 rules of
  `migrateDefinition`.
