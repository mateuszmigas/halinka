import { errorMessage } from "@halinka/utils/errors";
import { type GitHubEvent, type Inputs, triggerInputs } from "@halinka/workflow";

import type { Repositories } from "../db/repositories";
import type { RepoService, WorkflowRead } from "./repoService";
import type { RunService } from "./runService";
import { loggedFailureText } from "./serviceError";

type StartWorkflowOptions = { repoId: number; event: GitHubEvent; authorId: number };

export class TriggerService {
  constructor(
    private readonly repositories: Repositories,
    private readonly repo: RepoService,
    private readonly run: RunService,
  ) {}

  // The result holds no text of the event.
  async start(event: GitHubEvent) {
    const { member, repo } = this.repositories;
    const found = await repo.findByGitHubRepoId(event.data.repository.id);
    if (!found) return "The server has no GitHub repo with this id.";
    const author = await member.findByGitHubId(String(event.data.sender.id));
    if (!author) return "The sender is not a member.";
    const notes: string[] = [];
    for (const read of await this.repo.readWorkflows(found.id)) {
      const note = await this.startWorkflow(read, { repoId: found.id, event, authorId: author.id });
      if (note) notes.push(`${read.path}: ${note}`);
    }
    return notes.join("\n") || "No workflow starts for this event.";
  }

  private async startWorkflow(
    read: WorkflowRead,
    { repoId, event, authorId }: StartWorkflowOptions,
  ) {
    if (!read.workflow) return "The workflow is not valid.";
    let inputs: Inputs | undefined;
    try {
      inputs = triggerInputs(read.workflow.on, event);
    } catch (error) {
      return errorMessage(error);
    }
    if (!inputs) return undefined;
    try {
      const pullRequest =
        event.name === "pull_request"
          ? { number: event.data.pull_request.number, headSha: event.data.pull_request.head.sha }
          : undefined;
      const run = await this.run.createFrom(repoId, read, {
        inputs,
        authorId,
        isUntrusted: true,
        ...(pullRequest && { pullRequest }),
      });
      return `The run ${run.id} started.`;
    } catch (error) {
      return loggedFailureText(error);
    }
  }
}
