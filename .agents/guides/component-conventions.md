# Component Conventions

> Rules for the code in `packages/`, `apps/` and `e2e/`. Config files follow their tool. `server-conventions.md` adds the server rules, `testing.md` the test rules, `architecture.md` the package boundaries. Update this file only when the task includes a rule change.

## Names

- camelCase file names: `controlPlane.ts`, `runPage.tsx`. Name a file of one unit after its export, and a module of several units after its concern (`capabilities.ts`, `repoSetup.ts`). Name a package subpath after its file.
- Named exports, no default exports.
- Name an action with a verb: `openPullRequest`, `pushCommit`.
- Use `xOf(y)` only for a pure value from one input: `codeOf(error)`. Use `toX` for a type conversion: `toEventIterator(stream)`.
- Name a read with I/O `read*`, `find*` or `inspect*`. `require*` throws; `check*` returns problems.
- Use `parse*` for a flag or input value whose parse can fail: `parsePort(value, usage)`. Use `read*` only for I/O.
- Give each boolean name that Halinka defines an `is`, `has` or `can` prefix: `isLoaded`, `hasDocker`. A DOM attribute (`disabled`, `readOnly`), a key that a dependency owns, and `Result.ok` keep their names.
- End a Zod schema in `Schema` and take its type from it: `type LeafStep = z.infer<typeof leafStepSchema>`. No `Dto`.
- Name a limit `max<Thing><Unit>` (`maxOutputChars`) and a time limit `<thing>TimeoutMs`.
- End a regex in `Pattern` and a help text in `Hint`.
- Write a discriminator value in snake_case: `kind: "ask_human"`.
- Name an option bag `<Unit>Options`: `SupervisorOptions`.
- Name a hook `use` + verb + noun: `useWatchRun`.

### Terms

One term per meaning, in identifiers, UI text and docs:

| Use | Not | Meaning |
| --- | --- | --- |
| `folder` | `dir`, `directory` | |
| `command` | `cmd` | |
| `document` | `doc` | no abbreviation in an identifier |
| `workflowRunId` | `runId` | |
| `delete` | `remove` | |
| `GitHub`, `gitHub` | `Github`, `github` | in an identifier; `github` only in a file name and as a literal value such as a step kind |
| `release` | | free a lock or a lease |
| `publish` | | make a change visible outside its workspace: the run branch at a checkpoint, a draft as a pull request |
| `clone` | | the checkout of a run; the bare cache is a `mirror` |
| `start` | | begin the work of a unit: `start()`, `startedAt` |
| `test` | | an automated test or an agent test; a validation is a `check` |
| `refusal` | | a `ServiceError` value; a text is `*Reason` |
| `repo` | `repository` | a git repository, in UI text; `Repository` is a database class |
| `Try again` | `Retry` | UI text |

## Files and layout

- A package exposes code only through the `exports` of its `package.json`. `index.ts` only re-exports.
- One unit per file. A component that another page uses, or that has its own mutation, gets its own file.
- Order in a file: imports, constants, types, then code. oxfmt orders the imports.
- In a class: public members first, then private. No public mutable field.

## Functions and classes

- Write a free function as an arrow function.
- Use a class for a non-React unit whose operations share state or dependencies: `Supervisor`, `EventLog`, `Git`, the repositories and the services of the server. Keep the state private and expose methods.
- Do not write a factory that returns closures over shared state. Write a class. A component or a custom hook stays a function and may return callbacks.
- Do not write a class for one operation. Write a function.
- At most 3 positional parameters, `signal` included. Put the rest, and every boolean, in one options object. Set the defaults when you destructure it.
- `signal: AbortSignal` is the last positional parameter. A `now: Date` parameter goes directly before it.
- Every network call takes a signal with a timeout: `AbortSignal.timeout(ms)` or the signal of the caller joined with one. A poll loop uses `poll` from `@halinka/utils/poll`; do not write a `while` with a sleep.
- No I/O and no side effect in a constructor. Put async setup in `static create`. `start()` begins the work of a unit and `stop()` ends it. A getter is cheap.
- Take a part of a type with `Pick<Type, "a" | "b">`. Write an own type only for a port with several implementations.

## Values

- "No value" is `undefined`. Use `null` only where the database or an external API gives it, and convert it at that edge.
- Write each value set as one `as const` array and take its union type from it: `const runStatuses = [...] as const; type RunStatus = (typeof runStatuses)[number]`.
- Write each repeated literal or message once, as a constant.
- Return "a value or problems" as `Result<T>` from `@halinka/utils/result`: `{ ok: true; value } | { ok: false; problems }`. A problem is a `string`, unless the second type parameter gives another type: `Result<Workflow, Problem>`.

## Errors

- A helper throws `Error`. A `RunnerCommands` path throws a coded protocol error. Server errors: `server-conventions.md`.
- Catch `unknown` and read it with `errorMessage`, `isAbortError` and `errnoCode` from `@halinka/utils/errors`. Make an AbortError with `abortError`. Check for a plain object with `isRecord` from `@halinka/utils/isRecord`.
- Write a message of one sentence with no period. When a message has several sentences, end each with a period. An instruction is its own sentence: "The runner is offline. Start it with `halinka runner`."

## Comments

- Do not write a comment (`AGENTS.md`). When the code cannot show the reason, write one sentence of at most 100 characters, with no reference to a doc, a task or history. Never write the same comment twice.
- A field of a wire type (the protocol, the API contract) may have one short line above it when its name cannot say what it means. Delete a field note that the name or the type says.

## Helpers

- Before you write a helper, look for one in `@halinka/utils`, in the package, and in its dependencies.
- Run tasks one at a time with `SerialQueue` from `@halinka/utils/serialQueue`, and hash with `hashOf` (SHA-256, hex) from `@halinka/utils/hash`.
- Keep the operations on one tool or resource in one module. Git commands go through `Git` in `@halinka/utils/git`, and file checks come from `@halinka/utils/fs`. Do not call `execFile("git", ...)`, `sandbox.exec(["git", ...])`, or write a `pathExists` in a feature file.
- On the host (the runner, the CLI, and e2e), make a `Git` with `hostGit` from `@halinka/sandbox/host`. In the engine, make it over the sandbox, `new Git(sandbox)`, so it also works in a devcontainer.
- A helper of one unit stays private in that unit's file, above its user. A helper that two or more units of one package share goes in a module of that package. A helper that two or more packages or apps share goes in `@halinka/utils`.
- Give each `@halinka/utils` module its own subpath. `architecture.md` says which subpaths browser code imports.

## Portal and UI components

- Use `@halinka/ui` before you write a new component. Import a component from its own entry point: `@halinka/ui/components/button`.
- `packages/ui/src/components` holds the files of the shadcn CLI (`npx shadcn@latest add <name>` from `apps/portal`). Keep their file names and code form; the rules of this guide do not apply to them.
- Arrow function, named export. Wrap in `memo` when props are stable and the parent re-renders often.
- Write `export type XProps` only for an exported component, as a `type` above it. In `ui`, build it from the element: `export type ButtonProps = ComponentProps<"button"> & { ... }`. Destructure props in the body: `const { value, onChange } = props;`.
- Hook order: context, store, state, refs, memo, callbacks, effects.
- Colocate a hook with the feature that uses it. Extract a hook when two or more components share the logic, a component has more than about 8 hooks, or the logic has complex subscriptions.
- Query state: `if (q.data === undefined) return <QueryFallback error={q.error} />;` inside `<Page>`.
- Every form field goes through `FieldFrame` or `SelectField`, with `id={field.name}`, prefixed only when two forms of one page can have the same field name. `FieldFrame` gives `id` and `aria-invalid` to its control through a render prop.
- A button and a form run their call as a mutation with `mutationOptions`. Do not call `api.*.call` outside a mutation. A form validator calls its write through `useSubmitMutation`.
- A button with a mutation is an `ActionButton`; a mutation error shows in `ErrorText`.
- A mutation refreshes the queries that it changes, and that no stream of its page carries, with `useInvalidateQueries`.
- One status map per status kind: `Record<Value, { label, variant }>`.
- One `noValue` constant for a select with no value.
- UI text follows the term table.

## CLI

- A command entry is the one place that calls `fail` or `failWithUsage`, and it ends with `.catch(failWithError)`. The helpers under it throw `Error`.
