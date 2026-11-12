# Scan

Analyze code and report. Do not modify files.

Use the requested scope. Otherwise, review the files from `git diff --name-only` and `git diff --cached --name-only`.

For each finding: severity, location, description, impact, recommendation. Skip what another focus covers, and skip types, lint, and style.

## security

- `packages/server`: each route needs authorization and Zod input validation. Webhooks need signature checks. Database queries must not include user input in raw SQL.
- Secrets and credentials must not reach logs, error messages, run events, or the portal.
- The sandbox gets only what its step needs: workflow secrets reach `setup` and gates only, never the agent. Agent provider credentials reach only the agent's process, for one step. GitHub write credentials never enter the sandbox.
- `packages/agents`, `packages/engine`: untrusted content (issue, pull request, and comment text) goes into prompts only as a delimited data block. Permission requests follow the step's `permissions`.
- `packages/sandbox`, `packages/runner`: the devcontainer backend gives no host access (no host mounts, Docker socket, privileged or host-network runs). The host backend is unsandboxed by design: flag a webhook-triggered run that can reach it. No repository hooks on runner git operations.

## bugs

Bugs that change runtime behavior: logic errors, race conditions, null handling, unhandled edge cases, broken control flow, unawaited promises. Prioritize lost run state, stale writes after a lost lease, and incorrect step results.

## architecture

Read `AGENTS.md`, `docs/architecture/` with its Decisions sections, and `.agents/guides/architecture.md` for the intended architecture, `.agents/guides/component-conventions.md`, and `.agents/guides/server-conventions.md`. Consider each file in relation to its package and neighboring code. Look for package boundary violations, wrong dependency direction, misplaced responsibilities, domain logic in `protocol` or `ui`, and code that deviates from the pattern that similar code nearby uses. Skip intentional variations. Include the better structure in each finding.
