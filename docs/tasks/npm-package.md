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
- The repository is private until the owner makes the open-source decision. Decide this before the publish:
  - The license is `AGPL-3.0-only` (`LICENSE`, both `package.json` files). A publish under it is an open-source
    release: the tarball is public, and the AGPL gives each user the right to the source.
  - With a private repository, people cannot get the files of a GitHub release (`docs/user/vps.md` downloads
    `docker-compose.yml` and `env.template` from it). The links in the update banner (`updateBanner.tsx`) show a 404.
    The website (`apps/website/src/app.tsx`), `repository.url` and the image label `org.opencontainers.image.source`
    also show a 404.
  - npm adds no provenance for a publish from a private repository. Confirm on npmjs.com that a trusted publisher
    works without it.
  - The image on ghcr can be public while the repository is private. `docker compose pull` needs a public image.
- The manifest, the probe and the typed refusals are in; each version keeps them ([runners.md](../architecture/runners.md#decisions)).
- After the publish, add this to the README: tell your coding agent "Run `npx halinka setup` and follow it." Not
  before: until we publish, `npx halinka` runs whatever package has that name.
- Tell people who use `halinka ssh` to install the package globally.
- In `docs/user/setup.md`, replace "Get the command" with `npx halinka`, and remove the note that tells the coding
  agent to use a built command.

## Checks

- The codicon font of monaco-editor (`codicon.ttf` in the portal) comes from vscode-codicons, whose icons are
  CC-BY-4.0. Neither the LICENSE nor the ThirdPartyNotices.txt of monaco-editor names it. Confirm whether the portal
  notices need its attribution before the publish.
- `npx halinka init` and `start` on a clean machine, from the registry.
