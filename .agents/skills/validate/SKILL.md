---
name: validate
description: Validate and review the current changes before a push.
disable-model-invocation: true
---

Validate the current changes. Do not commit or push.

1. Inspect `git status --short`, `git diff`, and `git diff --cached`. Include relevant untracked source files.
2. Review the changed files for correctness, reuse, complexity, and efficiency. In Claude, use `/code-review` when it is available: `medium` effort, `high` for server, database, engine, sandbox, and agent changes.
3. Follow `.agents/guides/scan.md` with the `security` and `architecture` focuses. Delegate them to read-only subagents when the host supports delegation.
4. For changed files under `packages/` or `apps/`, fix violations of `.agents/guides/component-conventions.md`.
5. Run `pnpm validate:fix` after the edits from step 4.

Fix formatting and lint errors. Ask before behavior changes unless the user already authorized those fixes.
If validation fails, correct the cause and rerun only the failed checks and checks affected by the correction.

Report validation results, automatic edits, and review findings. End with one rating:

- **no-go**: List blockers.
- **okish**: List non-blocking concerns.
- **ok**: The changes are ready to merge.

Suggest one concise commit subject that matches recent history.
