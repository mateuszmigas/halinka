# Budgets beyond one run

The totals and the budget of a run are built ([workflows.md](../architecture/workflows.md#costs-and-the-run-budget)).

## Nice to have

- A budget per repo, per person or per month. Decide the period, the reset, and whether a new run is refused.
- Count the spend through the credential route of the proxy. A process of the agent can call the provider with the
  token of the agent command, and that cost reaches no budget. Options: the proxy reads the usage of each provider
  answer (SSE `message_delta` of Anthropic, `response.completed` of OpenAI) and reports it to the runner, or a token for
  the agent CLI process only (the same user can read `/proc/<pid>/environ`, so this needs another user for the agent
  CLI).
- Keep the costs of a deleted member under their name: the delete of a member clears the author of their runs
  ([agents.md](../architecture/agents.md#stored-keys)).
