# Agent instructions

`AGENTS.md` contains the shared project instructions.
Read the guide for the task. Do not load all instructions at once.
Resolve repository paths in these instructions from the repository root.

| Location | Purpose |
| --- | --- |
| `.agents/guides/` | Conventions and task procedures. `AGENTS.md` indexes them. |
| `.agents/skills/` | Skills that need host integration: `validate`, which requires explicit invocation, and `review-cycle`, which runs in Claude only. |
| `.claude/skills/` | Links to the shared skills. |
| `.claude/settings.json` | Project plugin configuration for Claude. |
| `.claude/launch.json` | Project start command for Claude. |
| `.claude/settings.local.json` | Personal Claude configuration. Git ignores this file. |

The `validate` skill requires explicit invocation in both Codex and Claude.
Agent prompts must follow the git restrictions in `AGENTS.md`.
