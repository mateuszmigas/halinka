# Publish the package

Publish `halinka@0.1.0` to npm and the image to ghcr, from a public repository. The decisions are in
[overview.md](../architecture/overview.md#decisions), and `pnpm test:pack` tests the tarball.

## To do

The owner does these steps in this order:

1. Make the repository public.
2. Push the tag `v0.1.0`. `release.yml` pushes the image and creates the GitHub release. Its npm step fails, because
   the package has no trusted publisher yet. Do not run it again: a second run pushes the image again, and its npm
   step fails again.
3. Make the package `halinka` on ghcr public, or `docker compose pull` fails. Step 4 also needs it, or a
   `docker login ghcr.io`.
4. `npm login`, copy `/app/halinka.tgz` from `ghcr.io/mateuszmigas/halinka:0.1.0`, and `npm publish halinka.tgz` with
   the 2FA code. The publish sets the tag `latest`.
5. On npmjs.com, add the trusted publisher (the repository and `release.yml`, no environment). Allow a direct
   `npm publish` for it, because `release.yml` does not stage. Then allow only a trusted publish.

After the publish:

- Add this to the README: tell your coding agent "Run `npx halinka setup` and follow it." Not before: until we
  publish, `npx halinka` runs whatever package has that name.
- Tell people who use `halinka ssh` to install the package globally.
- In `docs/user/setup.md`, replace "Get the command" with `npx halinka`, and remove the note that tells the coding
  agent to use a built command. Change "The package is not published yet" in the README.
- Check the npm page: it shows `apps/cli/README.md`.

## Checks

- `npx halinka init` and `start` on a clean machine, from the registry.
- The next release publishes through OIDC with provenance.
