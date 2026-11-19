# Releases and the server update

One version tag gives the npm package and the image, and the server tells admins about a new version. The decisions are
in [overview.md](../architecture/overview.md#decisions).

## Checks

- `v0.1.1` published to npm through OIDC, with provenance. `0.1.0` went to npm by hand. Not checked yet: a rerun after
  a failed npm step uploads the release files again.
- The first publish of a new package made the placeholder version `0.0.0-stage`. It stays in the version list.
- From an installed build (the e2e suite runs the source): the GitHub login of `halinka server`; `halinka runner` from
  `versions/current`. On 2026-11-19, `0.1.0` from npm passed `halinka ssh`, `scp`, a port forward, `halinka open`, a
  run in a devcontainer of `halinka start`, and `halinka server` on Postgres with `sslmode=verify-full`. `0.1.1` from
  npm passed a run of 25 s with `halinka run`, and a `0.1.0` server showed the banner of `0.1.1`.

## Nice to have

- A Postgres certificate that the server refuses stops `halinka server` with only
  `Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"`. Show the cause (`self-signed certificate`) when a person
  reports it. `docs/user/vps.md` does not tell how to use an external Postgres with TLS
  (`sslmode=verify-full&sslrootcert=<file>`).
- `removedKeys` of `parseYaml` matches a key by its name only: `base` on a shell step gets the reason of `branch.base`.
  Match by the parent path when a person reports a wrong reason, or delete the reasons of version 0 at a later version.
- At schema version 2: `sendMessage` and `retryStep` (`runService.ts`) read `locked.workflow` with `isStepOfType` before
  `reopenRefusal`, so an older run whose step changed shape gets "is not an agent step", not the migrate message. Check
  `isOlderSchema` first there, in `messageTarget` and in the inbox answer.
- At schema version 2: `parseVersioned` gives the "older" problem only for a missing `schema_version`. Give it for a
  version below the current one too, and add the migration from 1 to 2 next to the version 0 rules of
  `migrateDefinition`.
