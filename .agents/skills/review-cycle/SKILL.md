---
name: review-cycle
description: Review a finished implementation in two rounds. Cleanup reviewers report, you apply what is right, then Codex and Fable review the result. Use after you implement a change and before you report it as done.
---

Review the current changes in two rounds. Claude only: it needs subagents, the Codex plugin, and the Fable model. Do not commit or push.

## 1. Collect the diff

1. Write `git diff HEAD` to a file in the scratchpad. Add each untracked source file with `git diff --no-index /dev/null <file>`. Ignore `migrations/meta/*_snapshot.json`.
2. Write a short context note for the reviewers: what the change does, which decisions are deliberate, and which items are deferred.

## 2. Cleanup round

1. In one message, start seven read-only `Explore` subagents. Give each the diff path, the context note, and one angle:
   - **Reuse:** code that repeats a helper from the codebase or a dependency. Name the helper.
   - **Simplification:** redundant state, copy-paste, deep nesting, dead code, wrappers that only forward. Name the simpler form.
   - **Efficiency:** extra queries or round trips, work that can run in parallel, allocations in hot paths, missing indexes, browser bundle weight. Name the cheaper form.
   - **Altitude:** fixes at the wrong depth or in the wrong package, special cases on shared code. Read `.agents/guides/architecture.md`. Name the general change.
   - **Architecture:** whether the architecture could be better, seen through this diff: package boundaries, the server and runner split, the engine ports, the protocol between server and runner, where state lives. Read `AGENTS.md`, `.agents/guides/architecture.md`, `docs/architecture/` with its Decisions sections, and the tasks in `docs/tasks/`. Report only a change that fixes a problem the diff shows or that the next tasks will run into. Name the problem, the change, and its trade-off. Do not propose an option that a Decisions section rejected unless the diff shows that decision causes a problem. No style points, no "consider", no speculation: return "none" when nothing qualifies.
   - **Tests:** whether each new or changed test is useful and follows `.agents/guides/testing.md` and the Tests section of `.agents/guides/server-conventions.md`. Report a test that cannot fail, tests a dependency or a pass-through, checks more than one behavior, sleeps for a fixed time, copies a helper, or mocks what a fake can replace. Report a new rule or failure path in the diff that has no test. Name the test to delete, rewrite, or add.
   - **Comments:** every comment that the diff adds or changes. `AGENTS.md` allows a comment only when the code cannot show the reason, for example a non-obvious constraint, in one short line. Report each comment to delete, and each comment to shorten with the shorter text. Report also a name that would make a comment unnecessary.
2. Tell each subagent: do not edit files, do not look for bugs, return findings as file, line, summary, and cost.
3. Do not apply findings automatically. Decide for each one:
   - Apply it when it makes the code simpler or more correct and keeps the intended behavior.
   - Skip it when it is a false positive, changes intended behavior, belongs to a later item, or needs changes far outside the diff. Record the reason.
   - Do not apply or skip an Architecture finding that needs changes far outside the diff. Keep it for the report.
4. Run `pnpm validate:fix`. Fix the failures that your edits caused.

## 3. Second-opinion round

1. Write the diff again, as in step 1.
2. In one message, start two background subagents:
   - `codex:codex-rescue`: a read-only Codex review.
   - `general-purpose` with `model: fable`: a read-only review. It may run tests and write scratch files in the scratchpad only.
3. Give both the same prompt, with no opinion of the other reviewer and no recommendation of yours:
   - The repository rules to read: `AGENTS.md`, `.agents/guides/architecture.md`, and the parts of `docs/architecture/` (with their Decisions sections) and the task file that the change touches.
   - The diff path and the context note, with the deliberate decisions and the deferred items.
   - Three to five concrete questions: correctness of the risky parts, soundness of the design, and what the next item needs to change now.
   - Rules: do not edit files, do not change git state, return a short verdict with findings as file:line, most severe first.
4. Tell the user that both reviews run. Do not predict their results.
5. If a Codex report contains only its progress log, send it a message to get the verdict.

## 4. Report

When both reviews are back:

1. Compare them: findings both agree on, findings from one reviewer only, and disagreements. For a disagreement, say which evidence is stronger.
   Add the Architecture findings that you kept from the cleanup round.
2. For each finding, decide: apply now, defer to a named later item, or skip.
   - Apply a fix that the current step needs. Do not ask the user first. Run `pnpm validate:fix` again.
   - Write a deferred finding in the file of its later task in `docs/tasks/`, or in a new task file.
   - Ask the user only about an architecture or product choice.
3. Report what you applied, deferred and skipped, with the reason for each.
