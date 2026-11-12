import type { ApiOutputs } from "@halinka/server/client";

type Agent = ApiOutputs["agents"]["list"][number];

export type AgentTestRow = {
  scope: "team" | "mine";
  label: string;
  tests: Agent["tests"];
  canTest: boolean;
};

// As for a run, an unreadable own key also selects the own keys.
export const agentTestRowsOf = (
  agent: Pick<Agent, "tests" | "mine">,
  isAdmin: boolean,
): AgentTestRow[] => {
  const { mine } = agent;
  const hasOwnKey = mine?.credentials.some(({ state }) => state !== "not_set") ?? false;
  const team = { scope: "team" as const, tests: agent.tests, canTest: isAdmin };
  if (!mine || !hasOwnKey) {
    return team.canTest || team.tests.length > 0 ? [{ ...team, label: "Test" }] : [];
  }
  const own = { scope: "mine" as const, tests: mine.tests, canTest: true };
  return isAdmin
    ? [
        { ...own, label: "Your test" },
        { ...team, label: "Team test" },
      ]
    : [{ ...own, label: "Test" }];
};
