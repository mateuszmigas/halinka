# Runner update

The update request, auto-update, the update at start, the status report, the failure state, the cleanup of versions
and the self-update opt-out are built ([runners.md](../architecture/runners.md#connection)). Checked on a Linux host
with three builds: Update with one restart, auto-update after a server rollback, a failed install. On 2026-11-19, an
installed runner updated itself from `0.0.1` to `0.1.1` after a deploy of the release image, with one restart.

## To do

- e2e tests of the start path of `halinka runner`: `isUpdateRequested`, `update_needed`, the exit codes 75, 78 and 1.
- The build id hashes all of `apps/cli/package.json` (`apps/cli/build.ts`), so a range change of a test tool
  (`vitest`, `tsx`) gives a new id for the same code, and each runner shows "out of date". This conflicts with
  [runners.md](../architecture/runners.md#decisions) ("a change of a test tool keeps the id"). Hash only the fields
  that an install or a run reads: `version`, `type`, `bin`, `engines`.

## Checks

- "Interrupt and update" with a held run.
- A protocol change.
- The second failure of one build.

## Nice to have

- A restart of the server makes the runner log "could not sync with the server" with the full stack of
  `connection_closed`, after its own "Cannot connect" lines. Log no stack for an error that `isTransient` accepts.
- After a failed update during a protocol change, the runner exits 78. If its status report did not reach the server,
  the request stays on the row until the runner syncs on the build of the server; the Runners page shows "update
  needed" anyway. Keep an undelivered report and send it at the next start.
- The files of `$HALINKA_HOME` (`runner.json`, `logins/`) may change only by addition, or an older runner cannot read
  them after a server rollback. `runner.json` has no format version.
- A release signature that the runner checks. The sha512 comes from the
  same server, so it finds corruption, not a bad server.
