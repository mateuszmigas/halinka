# Runner update

The update request, auto-update, the update at start, the status report, the failure state, the cleanup of versions
and the self-update opt-out are built ([runners.md](../architecture/runners.md#connection)). Checked on a Linux host
with three builds: Update with one restart, auto-update after a server rollback, a failed install.

## To do

- e2e tests of the start path of `halinka runner`: `isUpdateRequested`, `update_needed`, the exit codes 75, 78 and 1.
- The tarball install must get the dependency versions of the image: ship `npm-shrinkwrap.json`
  ([releases](releases.md)).

## Checks

- The first update of an installed runner from a deploy of the server: the check of a real update.
- "Interrupt and update" with a held run.
- A protocol change.
- The second failure of one build.

## Nice to have

- After a failed update during a protocol change, the runner exits 78. If its status report did not reach the server,
  the request stays on the row until the runner syncs on the build of the server; the Runners page shows "update
  needed" anyway. Keep an undelivered report and send it at the next start.
- The files of `$HALINKA_HOME` (`runner.json`, `logins/`) may change only by addition, or an older runner cannot read
  them after a server rollback. `runner.json` has no format version.
- A release signature that the runner checks. The sha512 comes from the
  same server, so it finds corruption, not a bad server.
