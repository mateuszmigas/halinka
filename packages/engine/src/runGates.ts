import type { AgentStep } from "@halinka/workflow";

import { OutputTail } from "./outputTail";
import type { GateFailure } from "./runAttempts";
import type { StepContext } from "./runDeps";
import { runScript } from "./runScript";

type Gate = NonNullable<AgentStep["gates"]>[number];

// `isUnchanged`: the step requires changes and has none, so it fails as the gate `non-empty-diff`
type GateRun = { step: AgentStep; attemptId: number; isUnchanged: boolean };

// `gateFailure`: unset when a gate with `on_fail: fail` failed
type GatesFailed = { failures: string; gateFailure?: GateFailure };

const maxGateTailLines = 50;
const maxGateTailLength = 8000;

const nonEmptyDiff = "non-empty-diff";

const noChangesFailure = `The gate \`${nonEmptyDiff}\` failed: the attempt changed no files.`;

const gatesFailedPrompt = (failures: string) =>
  `Some gates failed. Correct the problems, then call the \`report_result\` tool again.\n\n${failures}`;

const gateFailureOf = (
  failures: string,
  failed: Pick<Gate, "name" | "on_fail">[],
): GateFailure | undefined => {
  const policies = failed.map(({ on_fail }) => on_fail ?? "retry");
  if (policies.includes("fail")) return undefined;
  const names = failed.map(({ name }) => `\`${name}\``).join(", ");
  return {
    prompt: gatesFailedPrompt(failures),
    message: `These gates failed: ${names}.`,
    isHumanDecisionRequired: policies.includes("ask_human"),
  };
};

const gatesFailed = (
  { asData }: StepContext,
  failures: string,
  failed: Pick<Gate, "name" | "on_fail">[],
): GatesFailed => {
  const gateFailure = gateFailureOf(asData(failures), failed);
  return { failures, ...(gateFailure && { gateFailure }) };
};

export const runGates = async (
  context: StepContext,
  { step, attemptId, isUnchanged }: GateRun,
  signal: AbortSignal,
): Promise<GatesFailed | undefined> => {
  const of = { stepId: step.id, attemptId };
  if (isUnchanged) {
    context.events.emit({ kind: "gate_finished", payload: { ...of, name: nonEmptyDiff } });
    return gatesFailed(context, noChangesFailure, [{ name: nonEmptyDiff }]);
  }
  const failures: string[] = [];
  const failed: Gate[] = [];
  for (const gate of step.gates ?? []) {
    const { name } = gate;
    const tail = new OutputTail(maxGateTailLines, maxGateTailLength);
    const exitCode = await runScript(
      context,
      { script: gate, of: { ...of, gate: name }, tail },
      signal,
    );
    context.events.emit({ kind: "gate_finished", payload: { ...of, name, exitCode } });
    if (exitCode === 0) continue;
    failures.push(`The gate \`${name}\` failed with exit code ${exitCode}:\n${tail.text()}`);
    failed.push(gate);
  }
  return failed.length > 0 ? gatesFailed(context, failures.join("\n\n"), failed) : undefined;
};
