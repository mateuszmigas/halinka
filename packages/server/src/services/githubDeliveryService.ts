import { gitHubEventSchema } from "@halinka/workflow";
import { z } from "zod";

import type { Repositories } from "../db/repositories";
import type { DbGitHubDelivery } from "../db/schema";
import type { GitHubAppService } from "./githubAppService";
import type { RepoService } from "./repoService";
import { failureText } from "./serviceError";
import type { TriggerService } from "./triggerService";

// GitHub "Redeliver" repeats the work of a row that a crash left with no result.
const staleMinutes = 10;

const installationEvents = new Set(["installation", "installation_repositories"]);

const triggerEvents = new Set(["issues", "issue_comment", "pull_request"]);

const pushEventSchema = z.object({
  ref: z.string(),
  repository: z.object({ id: z.number(), default_branch: z.string() }),
});

type GitHubDeliveryServiceOptions = {
  repositories: Repositories;
  gitHubApp: GitHubAppService;
  repo: RepoService;
  trigger: TriggerService;
};

export class GitHubDeliveryService {
  private readonly working = new Set<Promise<void>>();

  constructor(private readonly options: GitHubDeliveryServiceOptions) {}

  // The work continues after the return: GitHub waits 10 s for the answer.
  async receive(deliveryId: string, event: string, body: unknown) {
    const delivery = await this.options.repositories.gitHubDelivery.claim(
      deliveryId,
      event,
      staleMinutes,
    );
    if (!delivery) return;
    const work = this.process(delivery, body)
      .catch((error: unknown) => console.error(error))
      .finally(() => this.working.delete(work));
    this.working.add(work);
  }

  async idle() {
    await Promise.all(this.working);
  }

  private async process({ id, event }: DbGitHubDelivery, body: unknown) {
    await this.options.repositories.gitHubDelivery.finish(id, await this.resultOf(event, body));
  }

  private async resultOf(event: string, body: unknown) {
    try {
      return await this.work(event, body);
    } catch (error) {
      console.error(error);
      return failureText(error);
    }
  }

  private async work(event: string, body: unknown) {
    if (installationEvents.has(event)) {
      await this.options.gitHubApp.refresh();
      return "The server read the installations.";
    }
    if (event === "push") return this.readPush(body);
    if (!triggerEvents.has(event)) return "The server does not use this event.";
    const parsed = gitHubEventSchema.safeParse({ name: event, data: body });
    if (!parsed.success) return "The payload of this event is not valid.";
    return this.options.trigger.start(parsed.data);
  }

  private async readPush(body: unknown) {
    const parsed = pushEventSchema.safeParse(body);
    if (!parsed.success) return "The payload of this event is not valid.";
    const { ref, repository } = parsed.data;
    if (ref !== `refs/heads/${repository.default_branch}`) {
      return "The push is not to the default branch.";
    }
    const repo = await this.options.repositories.repo.findByGitHubRepoId(repository.id);
    if (!repo) return "The server has no GitHub repo with this id.";
    await this.options.repo.syncSchedules(repo.id);
    return "The server read the schedules.";
  }
}
