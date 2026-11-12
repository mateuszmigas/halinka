import { cronInputs } from "@halinka/workflow";

import type { Repositories } from "../db/repositories";
import type { DbWorkflowSchedule } from "../db/schema";
import { nextFireAfter, type RepoService, type WorkflowRead } from "./repoService";
import type { RunService } from "./runService";
import { loggedFailureText } from "./serviceError";

const retryMs = 5 * 60_000;

export class ScheduleService {
  constructor(
    private readonly repositories: Repositories,
    private readonly repo: RepoService,
    private readonly run: RunService,
  ) {}

  async fireDue(now = new Date()) {
    for (const due of await this.repositories.workflowSchedule.findDue(now)) {
      try {
        await this.fire(due, now);
      } catch (error) {
        console.error(error);
      }
    }
  }

  private async fire(due: DbWorkflowSchedule, now: Date) {
    const { workflowSchedule } = this.repositories;
    // From `now`: one run after downtime. A crash after this write loses the fire.
    const next = nextFireAfter(due.schedule, now);
    const claimed = await workflowSchedule.moveNextFire(due, next);
    if (!claimed) return;
    let reads: WorkflowRead[];
    try {
      reads = await this.repo.syncSchedules(due.repoId, now);
    } catch (error) {
      const retryAt = new Date(Math.min(now.getTime() + retryMs, next.getTime()));
      await workflowSchedule.moveNextFire(claimed, retryAt);
      await workflowSchedule.record(due.id, loggedFailureText(error));
      return;
    }
    const read = reads.find(({ path }) => path === due.path);
    await workflowSchedule.record(due.id, await this.start(due, read));
  }

  // The result of a removed schedule goes nowhere: the rewrite deleted its row.
  private async start({ repoId, schedule }: DbWorkflowSchedule, read: WorkflowRead | undefined) {
    if (read && !read.workflow) return "The workflow is not valid.";
    if (read?.workflow?.on?.cron?.schedule !== schedule) return "The tip has another schedule.";
    try {
      const run = await this.run.createFrom(repoId, read, {
        inputs: cronInputs(read.workflow.on),
        isUntrusted: true,
        isSkippedWhenQueued: true,
      });
      return `The run ${run.id} started.`;
    } catch (error) {
      return loggedFailureText(error);
    }
  }
}
