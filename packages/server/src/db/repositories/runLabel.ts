import { sql } from "drizzle-orm";

import { repos, workflowSnapshots } from "../schema";

// Select it with the joins from the run to its snapshot and its repo.
export const runLabel = {
  repoName: repos.name,
  workflowPath: workflowSnapshots.path,
  workflowName: sql<string>`${workflowSnapshots.resolved}->>'name'`,
};

export type RunLabel = { repoName: string; workflowPath: string; workflowName: string };
