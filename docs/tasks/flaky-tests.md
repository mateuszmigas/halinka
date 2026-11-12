# Flaky tests

Three tests failed once and then passed. Keep the log of the next failure of each. vitest and Playwright count
wall-clock time, so a Mac that sleeps during a run fails the test that is running: compare the time of a failure with
`pmset -g log` first, and use `caffeinate -dimsu` for a long run (`-i` is not sufficient).

## Checks

- A credential-route test of the egress proxy: on 2026-11-02 one test near line 375 of
  `packages/sandbox/src/egressProxy.test.ts` failed once, with no log. The file has a limit of 30 s now, and 36 of 36
  runs passed at a load of 25.
- Portal tests under load: in one full run at a load average of 26, `chat.test.ts:4`, `inbox.test.ts:23` and
  `inbox.test.ts:37` stayed on `/runs` after the start of a run, and `github.test.ts:6` timed out when it closed the
  browser context. All four passed alone. A teardown that times out skips `TestHalinka.dispose`; a hook at the exit of
  the worker stops the processes, and the temp folder stays.
- A teardown of the push tests: on 2026-11-05, `opens no pull request when the store fails` in
  `packages/runner/src/branchPusher.test.ts` failed with `ENOTEMPTY` at the removal of `acme/app.git/objects`. A
  process can still write in the folder at that time.

## Nice to have

- At the next schema change: a factory for the e2e `config.yml` text (about 25 copies in `e2e/tests`), and
  `halinka.startInRepo` in the tests of `e2e/tests/cli/start.test.ts` that write their own config.
