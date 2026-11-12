import type { Problem } from "@halinka/workflow";
import { Link } from "@tanstack/react-router";

import { fileName } from "./fileName";

export type WorkflowProblemLinkProps = {
  repoId: number;
  path: string;
  problems: Pick<Problem, "line" | "message">[];
};

export const WorkflowProblemLink = (props: WorkflowProblemLinkProps) => {
  const { repoId, path, problems } = props;
  const [first] = problems;
  if (!first) return null;

  return (
    <Link
      to="/repos/$repoId/workflows/$file"
      params={{ repoId, file: fileName(path) }}
      search={{ line: first.line }}
      className="block text-destructive hover:underline"
    >
      Line {first.line}: {first.message}
      {problems.length === 2 && " (1 more problem)"}
      {problems.length > 2 && ` (${problems.length - 1} more problems)`}
    </Link>
  );
};
