Self-hostable SDLC agent orchestration platform. pnpm monorepo: apps in `/apps`, packages in `/packages`. `docs/architecture/overview.md` holds the vision and the core rules.

## Before work

- Read `docs/tasks/README.md` (the tasks by group) and the file of your task. Read the applicable `docs/architecture/<topic>.md` (how the system works now), including its Decisions section (do not propose a rejected option again without a new reason).
- Commit `674b521` holds the old code. A task that names a path in it can read it with `git show 674b521:<path>`. The core rules and the Decisions sections win when they differ. Never paste old code without a review.
- Read the applicable `.agents/guides/<name>.md`: architecture (package boundaries, server and runner split, engine), component-conventions (files, components, hooks, classes, helpers), testing (unit, server and e2e tests), server-conventions (database, repositories, services, HTTP API, server tests), scan (read-only reviews). `.agents/README.md` describes the layout.

## Working with the owner

- The owner decides. For an architecture or product choice, give the options with trade-offs and a recommendation, then wait. Never select an option yourself.
- Do exactly what was asked, then stop.
- Do small, clear items without a proposal, several in one step. Propose first only for an architecture or product choice.
- Keep answers and questions short and concrete: the result, the facts, the next decision. No long text.
- Put all questions to the owner in your last message, as one short block that stands on its own. First write the problem in one or two plain lines: what the owner sees and why it occurs. Then write numbered questions with lettered options of one line each, and mark the recommendation. Never split questions across messages or make the owner find context in earlier messages. Put details in the task file.
- Before you propose to remove or rename code, check whether a later task uses it, and say so in the proposal.
- Do not ask the owner when to fix a problem. Fix a problem that the current step needs, at once. Write a problem that belongs to a later task in that task's file, or in a new task file. Ask the owner only for an architecture or product choice.
- Keep a set of features in one task, and implement all of it. Do not split it into more task files.
- When you notice how the owner likes to work, ask if you can add it to this section. Add the approach, not the details of one task.

## Steps

1. Propose. A short proposal: what changes, which files, what stays out. Write code only after the owner approves it.
   Small, clear items need no proposal (see Working with the owner).
   - A non-obvious architecture decision, for the app or the system: consult Codex and Fable first (the reviewers of the `review-cycle` skill), and give their verdicts in the proposal. Give each reviewer the code and the question, not the opinion of the other reviewer or your recommendation.
   - A new third-party package is its own proposal: why it is necessary, alternatives, license, size.
2. Build. Keep the step small: the owner must be able to read its diff in about 20 minutes. For a repeated pattern (a repository, a route, a test, a step kind), do one, show it, and wait for approval before the rest.
3. Validate. Run `pnpm validate:fix`. It rewrites files (format, lint fixes), then typechecks and runs unit tests.
4. Review. Run the `review-cycle` skill. A refactor needs no full `review-cycle`: Codex checks the diff for changes of behavior.
5. Record. Write each decision when it occurs, as one bullet in the Decisions section of its topic doc in `docs/architecture/`: the choice, the short reason, and "Rejected: <option> (<why>)". Update the doc when the system changes. When a task is done, delete its file and its line in `docs/tasks/README.md`.
6. Report. Summarize the changes, list each comment the step added, and wait.

## Code

- Prefer simplicity. Select the simplest design that satisfies the requirement. Add an abstraction, an option, or a layer only when the current step needs it.
- No temporary code. Build each part where it belongs, in its final shape. If it needs something that does not exist yet, stop and say so.
- Types over interfaces. Arrow functions for free functions, a class for a non-React unit whose operations share state; components and custom hooks stay functions. Shared helpers go in `@halinka/utils` (component-conventions).
- Do not write comments. Write one only when the code cannot show the reason, for example a non-obvious constraint. Keep it to one short line, with no references to bugs, tickets, or history. A field of a type that crosses the wire (the protocol, the API contract) may have one short line when its name cannot say what it means.
- Write English per ASD-STE100 (https://www.asd-ste100.org/) in docs, UI strings, comments, and issue/PR text: one term per meaning, imperative instructions, active voice, no phrasal verbs, short sentences.

## Safety

- Never modify the git index or commit (`git add`, `commit`, `mv`, `rm`, `reset`, `restore --staged`, `stash`). Read-only git is fine. Use plain `mv`/`rm` for files.
- Stop only processes you started. Never kill by name or pattern.
