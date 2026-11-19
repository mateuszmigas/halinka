# Pull request outcome

Show the state of the pull request of a run (open, merged, closed) on the run page, the Runs list and Home, so a person
sees which runs delivered merged code. Today the server stores only the URL, in `pushed_branches` per repo and branch
([github.md](../architecture/github.md#push-branch-and-open-pr)).

## Nice to have

- Store the state from the `pull_request` events `closed` and `reopened`. The App already gets `pull_request` events
  ([github.md](../architecture/github.md#webhook-and-triggers)). The `closed` trigger of
  [pr-triggers](pr-triggers.md) uses the same event.
- Decide where the state goes: on `pushed_branches` (one pull request per branch) or on the run. Two runs can push the
  same branch, for example a run from `event.pull_request.head.ref`.
- A server on a local host gets no events. Read the state from the GitHub API when the run page opens, or show no
  state.
- Show the merge rate of each workflow on the workflow page.
