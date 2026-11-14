# Publish the package

Publish the package `halinka` to npm. This is the last step: publish only when the owner says that it is ready.
[overview.md](../architecture/overview.md) gives the build, and `pnpm test:pack` tests the tarball.

## To do

- Remove `private` from `apps/cli/package.json`, add a repository, and push the first tag (the workflow of
  [releases](releases.md)).
- The portal bundle (`apps/portal/dist`) holds npm packages such as React and Radix with no license notices. Write
  them as the CLI build writes `dist/THIRD_PARTY_LICENSES.txt`.
- The manifest, the probe and the typed refusals are in; each version keeps them ([runners.md](../architecture/runners.md#decisions)).
- An unpinned `npx halinka` takes the latest package, and a team server runs its own version, so `halinka check` can
  differ from that server. Before the publish, let the server show its version, and make step 5 of `halinka setup` use
  `npx halinka@<version>`.
- After the publish, add this to the README: tell your coding agent "Run `npx halinka setup` and follow it." Not
  before: until we publish, `npx halinka` runs whatever package has that name.
- Tell people who use `halinka ssh` to install the package globally.

## Checks

- `npx halinka init` and `start` on a clean machine, from the registry.
