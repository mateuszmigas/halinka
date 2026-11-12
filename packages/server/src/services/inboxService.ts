import {
  type AgentAnswer,
  answerProblem,
  type DecisionItemDecision,
  isDecisionOf,
  kindDecisions,
} from "@halinka/protocol";

import type { WakeRunner } from "../connectedRunners";
import type { Db } from "../db/client";
import type { Repositories } from "../db/repositories";
import type { DbInboxItem } from "../db/schema";
import { inRunTransaction, type RunBus } from "../runBus";
import { withoutNulls } from "../withoutNulls";
import { ServiceError } from "./serviceError";

export type InboxResolution =
  | { decision: DecisionItemDecision; note?: string }
  | { answer: AgentAnswer };

const refusal = (message: string) => new ServiceError("BAD_REQUEST", message);

const storedResolution = (item: DbInboxItem, input: InboxResolution) => {
  const { id } = item;
  if (item.kind === "question") {
    if (!("answer" in input)) throw refusal(`Inbox item ${id} takes an answer, not a decision`);
    const problem = answerProblem(item.questions, input.answer);
    if (problem) throw refusal(problem);
    return { decision: "answered" as const, note: null, answer: input.answer };
  }
  if ("answer" in input) throw refusal(`Inbox item ${id} takes a decision, not an answer`);
  if (!isDecisionOf(item.kind, input.decision)) {
    const allowed = kindDecisions[item.kind].join(", ");
    throw refusal(`Inbox item ${id} takes one of these decisions: ${allowed}`);
  }
  return { decision: input.decision, note: input.note ?? null, answer: null };
};

type InboxServiceOptions = {
  db: Db;
  repositories: Repositories;
  wakeRunner: WakeRunner;
  bus: RunBus;
};

export class InboxService {
  constructor(private readonly options: InboxServiceOptions) {}

  async listPending() {
    return (await this.options.repositories.inboxItem.listPending()).map(withoutNulls);
  }

  async resolve(id: number, input: InboxResolution, author: string) {
    const found = await this.options.repositories.inboxItem.findById(id);
    if (!found) throw new ServiceError("NOT_FOUND", `There is no inbox item ${id}`);
    const resolution = storedResolution(found, input);
    const { workflowRunId } = found;
    const item = await inRunTransaction(
      this.options.db,
      this.options.bus,
      async (repositories, changed) => {
        const { workflowRun, inboxItem, agentMessage } = repositories;
        await workflowRun.lockById(workflowRunId);
        // The agent takes the message instead of the answer.
        if (found.kind === "question" && (await agentMessage.hasUndelivered(found.stepRunId))) {
          throw new ServiceError(
            "CONFLICT",
            `A message to the step replaces the answer to item ${id}`,
          );
        }
        const resolved = await inboxItem.resolve(id, { ...resolution, resolvedBy: author });
        if (!resolved) throw new ServiceError("CONFLICT", `Inbox item ${id} is already resolved`);
        // A message keeps the note through a limit or a crash before the next prompt.
        const { decision, note } = resolution;
        if (note && (decision === "retry" || decision === "continue")) {
          await agentMessage.create({
            workflowRunId,
            stepRunId: found.stepRunId,
            text: note,
            author,
          });
        }
        await workflowRun.resume(workflowRunId);
        changed(workflowRunId, "state");
        return resolved;
      },
    );
    await this.options.wakeRunner(workflowRunId);
    return withoutNulls(item);
  }
}
