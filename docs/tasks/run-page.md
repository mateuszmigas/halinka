# Run page

[portal.md](../architecture/portal.md#run-page) gives the page.

## Nice to have

- Between two iterations of a loop, the loop step run is the last running one, so the page shows the loop for one
  refresh. Skip a running step run with no attempts when the page selects the current step.
- The events of a new attempt show only after `runs.get` gives the attempt: the tabs and the newest attempt come from
  `run.attempts`. If the wait is visible, add the attempts of the `attempt_started` events to that list.
- When a person selects another step, the message form of the current step does not show. Mark the step that takes a
  message in the step list, or show a short line in "Needs attention".
- The step rows show no duration and no cost: a duration format for the portal, and the cost of the attempts of each
  step run.
