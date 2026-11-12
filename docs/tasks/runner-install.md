# Runner install

`halinka runner install`, `status` and `uninstall` are built, with the package route of the server and the behavior
under the unit ([cli.md](../architecture/cli.md#halinka-runner), [runners.md](../architecture/runners.md#decisions)).
Checked on a Linux host: the install, the enrollment, the unit, linger, `status`, a
restart after SIGKILL, a second install with no download, exit 78 after a revoke, `uninstall`.

## To do

- e2e tests through the CLI: `halinka runner --unit <name>` with a key that is not enrolled exits 78, and
  `--enroll-only` enrolls and stops.
- A test that `Runner.closed` resolves after a failed stop, with a fake whose stop throws.

## Checks

- The start limit after 5 failures.
- A stop that takes more than 60 s.
- An install from an fnm or nvm shell.
- A host with an older systemd (no `_SYSTEMD_INVOCATION_ID` in the user journal).
- A folder with its own `.npmrc`.
- Values with spaces, `%`, `$` and quotes in the unit.

## Nice to have

- A stop after a refusal that hangs (an engine that does not end) keeps the process alive, so the unit neither exits
  nor starts again. `TimeoutStopSec` bounds only a stop by systemd. Add a deadline when such a hang occurs.
