# Cron triggers

The `cron` trigger is built ([workflows.md](../architecture/workflows.md)).

## Nice to have

- A portal page for `last_result`, so a person sees a fire that started no run.
- Several schedules per workflow.
- A read of the schedules with no push: an App with no `push` event or no webhook adds a new schedule only at the add of
  a repo or at a fire of that repo.
- A flag for "needs a container" apart from `untrusted`, so the fixed inputs of a cron run have no data blocks.
- A limit on a short schedule, which spends the key of the team.
