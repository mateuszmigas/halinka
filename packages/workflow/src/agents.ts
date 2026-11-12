import type { z } from "zod";

import { leafSteps } from "./leafSteps";
import { stepPermissions, toolNeedChecks, type ToolNeed } from "./permissions";
import type { AgentStep, LeafStep, Workflow } from "./workflow";

export type Agents = Record<
  string,
  { canReportCost: boolean; canAskPermission: boolean; tools?: { needs: Record<string, ToolNeed> } }
>;

const agentOf = (agents: Agents, name: string) =>
  Object.hasOwn(agents, name) ? agents[name] : undefined;

export const reportsNoCost = (agents: Agents, name: string) =>
  agentOf(agents, name)?.canReportCost === false;

export const checkAgents = (workflow: Workflow, context: z.RefinementCtx, agents: Agents) => {
  const addIssue = (path: (string | number)[], message: string) =>
    context.addIssue({ code: "custom", path, message });
  const isCostless = (step: LeafStep): step is AgentStep =>
    step.type === "agent" && reportsNoCost(agents, step.agent);
  const refuseCostLimit = (
    steps: LeafStep[],
    limit: number | undefined,
    path: (string | number)[],
  ) => {
    const step = steps.find(isCostless);
    if (step && limit !== undefined) {
      addIssue(
        [...path, "max_cost_usd"],
        `The agent "${step.agent}" of the step "${step.id}" reports no cost. Remove max_cost_usd`,
      );
    }
  };
  const checkTools = (step: AgentStep, path: (string | number)[]) => {
    const agent = agentOf(agents, step.agent);
    if (!step.tools || !agent) return;
    const needs = agent.tools?.needs;
    if (!needs) {
      addIssue([...path, "tools"], `The agent "${step.agent}" has no list of tools. Remove tools`);
      return;
    }
    const permissions = stepPermissions(step);
    step.tools.forEach((tool, index) => {
      if (!Object.hasOwn(needs, tool)) return;
      const { isAllowed, permission } = toolNeedChecks[needs[tool]!];
      if (!isAllowed(permissions)) {
        addIssue(
          [...path, "tools", index],
          `The tool "${tool}" needs ${permission} in permissions. Remove the tool, or change permissions`,
        );
      }
    });
  };
  const checkStep = (step: LeafStep, path: (string | number)[]) => {
    if (step.type !== "agent") return;
    checkTools(step, path);
    if (!agentOf(agents, step.agent)) {
      const names = Object.keys(agents).join(", ");
      addIssue([...path, "agent"], `There is no agent "${step.agent}". Use ${names}`);
    } else if (reportsNoCost(agents, step.agent) && step.max_cost_usd !== undefined) {
      addIssue(
        [...path, "max_cost_usd"],
        `The agent "${step.agent}" reports no cost. Remove max_cost_usd`,
      );
    }
    if (
      step.permissions?.shell === false &&
      agentOf(agents, step.agent)?.canAskPermission === false
    ) {
      addIssue(
        [...path, "permissions", "shell"],
        `The agent "${step.agent}" runs commands without asking, so Halinka cannot refuse them. Remove shell: false`,
      );
    }
  };
  workflow.steps.forEach((step, index) => {
    if (step.type !== "loop") return checkStep(step, ["steps", index]);
    step.steps.forEach((child, childIndex) =>
      checkStep(child, ["steps", index, "steps", childIndex]),
    );
    refuseCostLimit(step.steps, step.max_cost_usd, ["steps", index]);
  });
  refuseCostLimit(leafSteps(workflow), workflow.max_cost_usd, []);
};
