# Testing

> Rules for unit tests, server tests, and e2e tests. `server-conventions.md` adds the rules for the database and the HTTP API. Update this file only when the task includes a rule change.

## Tools and files

- Vitest for unit and server tests. Playwright for e2e tests in `e2e/tests`.
- Put a unit test in `{name}.test.ts` next to its source. Name an e2e file after the command or the page it tests.
- Put a test that needs Docker in `{name}.docker.test.ts`. `pnpm test:docker` runs it; `pnpm validate` does not.
- One `describe` per file, named after the unit under test. No nesting.
- An API test (`packages/server/src/api/*Api.test.ts`, `controlPlane.test.ts`) has one `describe` per procedure: an HTTP route as the contract writes it (`GET /api/runs/{id}`), or a `ControlPlane` method (`sync`). No nesting. Put a test under the procedure whose answer or effect it asserts.
- Put the test helpers of a package in one `testing.ts`, or in a `testing/` folder when one file is too large. Export it as the `./testing` subpath when another package needs it. Do not copy a helper between test files.
- Set `restoreMocks: true` in the vitest config of each package. Do not restore mocks in a test.

## What to test

- Test the engine, the supervisor, workflow parsing and expressions, server logic, sandboxes with real processes, and data transformations.
- Do not test pass-through code, rendering, types, or the behavior of a framework or a dependency.
- Test through the public API of the unit. Do not export a function only for a test.
- Every test must be able to fail. Assert the result or the side effect that a bug would change, not only that a call did not throw.
- Add a test for each new rule or failure path, for example a retry, an abort, or a refused write.

## Test shape

- Give each test a name that states one behavior in the present tense: "stores failed when the engine throws".
- Check one behavior per test. A name with "and" is two tests. Separate setup, action, and assertions with one blank line.
- Put the setup of a file in one `setUp()` function that returns the fixture. No `beforeEach` with `let` variables.
- Use the shared fixtures instead of copies: `leaseOf(1)` from `@halinka/protocol/testing`, `claimedRun(1)` and `fakePlane(overrides)` from `@halinka/runner/testing`, `tempFolder()`, `writeFiles(folder, files)` and `fakeTimers()` from `@halinka/utils/testing`, and the workflow factories. The engine has its own `claimedRun(scripts)` in its `testing/`: its steps and checkpoint differ.
- Assert a coded error by its `code`. For a plain `Error`, assert its type, and its message only when the text is the behavior.

## Fakes and mocks

- A fake is a `Fake<Type>` class in the testing module: `FakeControlPlane`, `FakeSandbox`. A method that the test does not provide throws.
- Use fakes of the `protocol`, `sandbox`, and `agents` types. Do not mock unless the dependency has side effects that the test cannot control, or is slow.
- A `vi.fn` stub may return a value and records calls; a stand-in that keeps state is a `Fake<Type>` class. Spy on `console.error` only in a test that expects an error log, and assert the log. A test of a failure may also assert the log of that failure.

## Time and cleanup

- Wait for asynchronous state with `vi.waitFor` or `expect.poll`. Do not sleep for a fixed time. Fake the timers with `fakeTimers` from `@halinka/utils/testing`: it gives the real timers back when the test finishes.
- Keep a test under one second. A test that must wait for a deadline is the exception.
- A helper that makes a per-test resource (a temporary folder, a process, a started unit) registers its cleanup with `onTestFinished`. A file-scoped resource, such as the one database of a server test file, stops in `afterAll`. A Playwright fixture stops what it starts in its teardown. A test does not clean up in its body or in `afterEach`.

## E2e tests

- Use the `halinka` fixture and `TestRepo` from `e2e/tests/utils`. A fixture starts and stops the servers; a test does not stop them.
- Put a shared YAML fixture in `e2e/tests/utils` as a factory that returns the YAML text, such as `shellWorkflow`.
- Drive the CLI and the HTTP API as a user does. Assert what a user sees: output, HTTP answers, and files.
- Test the portal through the page objects in `e2e/tests/utils/pages`. A test calls page object methods and never a locator. A UX change edits the page objects, not the tests.
- In a page object, an action or an `expect*` method returns `this`, and a navigation method returns the next page object. Keep the locator getters private, at the bottom of the class.
- In a page object, find elements by role and label. Add a `data-testid` only to a repeated item that has no role or name to tell it apart.
- Test regular user flows in the browser. Test failure paths (recovery, limits, leases, races) in unit and server tests: a browser test of a race is slow and fragile.
- A test that waits for a lease, for example a crash of a runner, shortens the lease and the sweep with `TestHalinka.shortenLeases` (`HALINKA_LEASE_SECONDS`, `HALINKA_SWEEP_SECONDS`). Do not lengthen the test timeout. Keep the lease longer than the sync interval of a runner (5 s), or the runs of a live runner go back to the queue.
- The chat shows the first prompt, which holds the script of the fake agent. Check agent text with `ChatPanel.expectAgentText`, not with a text match on the whole chat. To check what the agent got, give it an `echo` turn.
- A reopened step loads its session, so the agent does not get the first prompt again. Put the script of the fake agent in the reopen message.
