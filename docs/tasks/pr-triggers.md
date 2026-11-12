# Pull request triggers

The `pull_request` trigger is built ([github.md](../architecture/github.md)).

## Nice to have

- A comment on a PR as a trigger. Its event has no fork data, so it needs a read of the PR first.
- `ready_for_review` and `closed`, and a filter for drafts.
- A pull request into a branch that is not the default branch. It needs the commit of that branch on the run.
- `open_pull_request` against the branch of the PR, and a push of fixes to that branch.
- A GitHub comment that goes to a running agent as a message needs a data block, on an issue and on a PR:
  `messagePrompt` trusts its text, because today only a Halinka user writes it.
