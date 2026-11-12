# Secrets for gates

Setup has secrets ([sandbox.md](../architecture/sandbox.md)). A gate has none, and no workflow needs them yet.

## Nice to have

- A gate gets `secrets: [NPM_TOKEN]`, and `runScript` gives the values in `env` of `exec`. A shell step gets none (core
  rule 6).
- `runs.create` checks the names, as for `setup.secrets`. The worktree refusal also covers a gate that names a secret.
- Write this limit in the Decisions section of [sandbox.md](../architecture/sandbox.md): a gate runs code that the agent
  wrote, so the secret reaches that code. The code can send it, encoded, to a host of the gate's `network`, or write it
  to a file. Name only what the gate needs, and use a read-only token.
