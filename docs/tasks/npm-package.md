# Publish the package

Publish the package `halinka` to npm. This is the last step: publish only when the owner says that it is ready.
[overview.md](../architecture/overview.md) gives the build, and `pnpm test:pack` tests the tarball.

## To do

- Remove `private` from `apps/cli/package.json`, add a repository, and push the first tag
  (`.github/workflows/release.yml`).
  - npmjs.com sets a trusted publisher only on a package that exists, so the first version cannot go through OIDC.
    Publish it once with a token or by hand, from the tarball of the image (`/app/halinka.tgz`). Then add the trusted
    publisher (the repository and `release.yml`) and allow a direct publish. Confirm this on npmjs.com first.
  - Provenance needs `repository.url` equal to the GitHub repository:
    `{ "type": "git", "url": "git+https://github.com/mateuszmigas/halinka.git", "directory": "apps/cli" }`.
  - After the first image push: make the package `halinka` on ghcr public, or `docker compose pull` fails.
- The manifest, the probe and the typed refusals are in; each version keeps them ([runners.md](../architecture/runners.md#decisions)).
- After the publish, add this to the README: tell your coding agent "Run `npx halinka setup` and follow it." Not
  before: until we publish, `npx halinka` runs whatever package has that name.
- Tell people who use `halinka ssh` to install the package globally.

## Checks

- The codicon font of monaco-editor (`codicon.ttf` in the portal) comes from vscode-codicons, whose icons are
  CC-BY-4.0. Neither the LICENSE nor the ThirdPartyNotices.txt of monaco-editor names it. Confirm whether the portal
  notices need its attribution before the publish.
- `npx halinka init` and `start` on a clean machine, from the registry.
