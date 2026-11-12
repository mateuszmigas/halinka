import { errorMessage } from "@halinka/utils/errors";
import type { z } from "zod";

import type { Agents } from "./agents";
import { eventFields, nullableEventPaths } from "./eventFields";
import {
  conditionExpression,
  type Expression,
  expressionLabel,
  expressionsIn,
  hasUnclosedExpression,
  parseExpression,
  pathText,
  singleExpression,
  type StepValues,
} from "./expressions";
import { agentOutputs } from "./implicitOutputs";
import { inputTypeOf, resolveInputs, type WorkflowInput } from "./inputs";
import { leafSteps } from "./leafSteps";
import { canWrite } from "./permissions";
import {
  approvalOutcomes,
  isArrayType,
  isValueType,
  outcomeNames,
  outcomeResult,
  type OutputFields,
  type OutputType,
  type ValueType,
} from "./stepReport";
import { templatesOf } from "./stepTemplates";
import type { LeafStep, Triggers, Step } from "./workflow";

const stepFields = ["status", "outcome", "summary", "outputs"] satisfies (keyof StepValues)[];

// The walk goes on only after these.
export const passedStatuses: readonly string[] = ["succeeded", "skipped"];

const tryParse = (source: () => string) => {
  try {
    return { expression: parseExpression(source()) };
  } catch (error) {
    return { problem: errorMessage(error) };
  }
};

export const checkTemplate = (template: string, context: z.RefinementCtx) => {
  if (hasUnclosedExpression(template)) {
    context.addIssue({ code: "custom", message: "Close each ${{ with }}" });
  }
  for (const source of expressionsIn(template)) {
    const { problem } = tryParse(() => source);
    if (problem) context.addIssue({ code: "custom", message: problem });
  }
};

export const checkCondition = (condition: string, context: z.RefinementCtx) => {
  const { problem } = tryParse(() => conditionExpression(condition));
  if (problem) context.addIssue({ code: "custom", message: problem });
};

// `earlier`: readable as `steps.x`; `loop`: readable as `loop.previous.x`; `event`: the only root
type Scope = {
  inputs?: Record<string, WorkflowInput>;
  agents?: Agents;
  earlier?: Map<string, Step>;
  loop?: Map<string, LeafStep>;
  event?: OutputFields;
};

type Resolved = { type: OutputType; problem?: never } | { type?: never; problem: string };

type SingleType = OutputType | "null";

// `mixed`: a `??` of two types, which only a template accepts
type ExpressionType = SingleType | "mixed";

const stepOutcomes = (step: Step): string[] => {
  if (step.type === "approval") return Object.values(approvalOutcomes);
  return step.type === "agent" && step.outcomes ? outcomeNames(step.outcomes) : [];
};

const failOutcomes = (step: Step): string[] => {
  if (step.type === "approval") return [approvalOutcomes.reject];
  if (step.type !== "agent" || !step.outcomes) return [];
  const { outcomes } = step;
  return outcomeNames(outcomes).filter((name) => outcomeResult(outcomes, name) === "fail");
};

const stepOutputs = (step: Step, agents: Agents | undefined) => {
  if (step.type === "github") {
    return step.action === "comment_on_pull_request"
      ? ({ comment_url: "string" } as const)
      : ({ pull_request_url: "string" } as const);
  }
  return step.type === "agent" ? agentOutputs(step, agents) : undefined;
};

const memberType = (type: OutputType, segments: (string | number)[], read: number): Resolved => {
  let current = type;
  for (let index = read; index < segments.length; index++) {
    const name = `"${pathText(segments.slice(0, index))}"`;
    const segment = segments[index]!;
    if (typeof current === "string") {
      return { problem: `${name} is a ${current}. Remove the rest of the path` };
    }
    if (isArrayType(current)) {
      if (typeof segment !== "number") {
        return { problem: `${name} is a list. Read an item with [number]` };
      }
      current = current.items;
    } else {
      const field = Object.hasOwn(current, segment) ? current[segment] : undefined;
      if (!field) return { problem: `${name} has no field "${segment}"` };
      current = field;
    }
  }
  return { type: current };
};

type StepPathOptions = {
  stepIdIndex: number;
  steps: Map<string, Step>;
  unknownStep: string;
  agents: Agents | undefined;
};

const stepPathType = (
  segments: (string | number)[],
  { stepIdIndex, steps, unknownStep, agents }: StepPathOptions,
): Resolved => {
  const [stepId, field, output] = segments.slice(stepIdIndex);
  if (stepId === undefined) return { problem: `Use ${pathText(segments)}.<step id>.<field>` };
  const step = steps.get(String(stepId));
  if (!step) return { problem: `The step "${stepId}" ${unknownStep}` };
  if (!stepFields.some((name) => name === field)) {
    return { problem: `Use a field of the step: ${stepFields.join(", ")}` };
  }
  if (field === "outcome" && stepOutcomes(step).length === 0) {
    return { problem: `The step "${stepId}" has no outcomes` };
  }
  if (field !== "outputs") return memberType("string", segments, stepIdIndex + 2);
  const outputs = stepOutputs(step, agents);
  if (!outputs) return { problem: `The step "${stepId}" has no outputs` };
  if (output === undefined) return { type: outputs };
  const type = Object.hasOwn(outputs, output) ? outputs[output] : undefined;
  if (!type) return { problem: `The step "${stepId}" has no output "${output}"` };
  return memberType(type, segments, stepIdIndex + 3);
};

const pathType = (
  segments: (string | number)[],
  { inputs, agents, earlier, loop, event }: Scope,
): Resolved => {
  const [root, member] = segments;
  if (root === "event" && event) return memberType(event, segments, 1);
  if (root === "inputs" && inputs) {
    if (member === undefined) return { problem: "Use inputs.<name>" };
    const input = Object.hasOwn(inputs, member) ? inputs[member] : undefined;
    if (!input) return { problem: `The workflow has no input "${member}"` };
    return memberType(inputTypeOf(input), segments, 2);
  }
  if (root === "steps" && earlier) {
    const unknownStep = "does not run before this step";
    return stepPathType(segments, { stepIdIndex: 1, steps: earlier, unknownStep, agents });
  }
  if (root === "loop" && loop) {
    if (member === "iteration") return memberType("number", segments, 2);
    if (member === "previous") {
      const unknownStep = "is not in this loop";
      return stepPathType(segments, { stepIdIndex: 2, steps: loop, unknownStep, agents });
    }
    return { problem: "Use loop.iteration or loop.previous.<step id>.<field>" };
  }
  const roots = [
    ...(inputs ? ["inputs"] : []),
    ...(earlier ? ["steps"] : []),
    ...(loop ? ["loop"] : []),
    ...(event ? ["event"] : []),
  ];
  return { problem: `Unknown name "${root}". Use ${roots.join(", ")}` };
};

// An optional input without a default has no value when the run gets none.
const unsetProblem = (segments: (string | number)[], { inputs }: Scope) => {
  const [root, name] = segments;
  if (root === "event") {
    const path = pathText(segments);
    return nullableEventPaths.includes(path)
      ? `${path} can have no value. Add a default with ??`
      : undefined;
  }
  if (root !== "inputs" || name === undefined || !inputs || !Object.hasOwn(inputs, name)) {
    return undefined;
  }
  const { required, default: fallback } = inputs[name]!;
  if (required || fallback !== undefined) return undefined;
  return `The input "${name}" can have no value. Add a default with ??`;
};

// The steps whose `field` an expression gives: one path, or a `??` chain of them.
const fieldSteps = (
  expression: Expression,
  field: "status" | "outcome",
  scope: Scope,
): (Step | undefined)[] | undefined => {
  if (expression.type === "binary" && expression.operator === "??") {
    const left = fieldSteps(expression.left, field, scope);
    if (expression.right.type === "literal") return left;
    const right = fieldSteps(expression.right, field, scope);
    return left && right && [...left, ...right];
  }
  if (expression.type !== "path") return undefined;
  const { segments } = expression;
  const [root, member] = segments;
  if (segments.length === 3 && root === "steps" && segments[2] === field) {
    return [scope.earlier?.get(String(member))];
  }
  if (segments.length === 4 && root === "loop" && member === "previous") {
    return segments[3] === field ? [scope.loop?.get(String(segments[2]))] : undefined;
  }
  return undefined;
};

const knownSteps = (expression: Expression, field: "status" | "outcome", scope: Scope) => {
  const steps = fieldSteps(expression, field, scope);
  return steps?.every((step): step is Step => step !== undefined) ? steps : undefined;
};

const listItems = (type: ExpressionType | undefined) =>
  typeof type === "object" && isArrayType(type) ? type.items : undefined;

const mixedProblem = "Give ?? two values of the same type";

const sameType = (one: ExpressionType, other: ExpressionType) =>
  JSON.stringify(one) === JSON.stringify(other);

type ExpressionOptions = { isCondition: boolean; valueType?: ValueType | "scalar" };

type CheckValueOptions = { isDefault?: boolean };

// `isDefaulted`: the left side of a ??
type VisitOptions = { isDefaulted?: boolean };

const expressionProblems = (
  expression: Expression,
  scope: Scope,
  { isCondition, valueType }: ExpressionOptions,
) => {
  const problems: string[] = [];
  const checkValue = (
    side: Expression,
    literal: Expression,
    { isDefault = false }: CheckValueOptions = {},
  ) => {
    const value = literal.type === "literal" ? literal.value : undefined;
    if (typeof value !== "string") return;
    if (knownSteps(side, "status", scope) && !passedStatuses.includes(value)) {
      problems.push(`Use ${passedStatuses.join(" or ")}: a later step sees no other status`);
    }
    const steps = knownSteps(side, "outcome", scope);
    if (!steps) return;
    // A `??` default can give the value.
    const [step] = steps;
    if (!isDefault && side.type === "path" && step && failOutcomes(step).includes(value)) {
      problems.push(
        `The outcome "${value}" fails the step "${step.id}", so a later step cannot see it`,
      );
      return;
    }
    if (steps.some((step) => stepOutcomes(step).includes(value))) return;
    const names = steps.map((step) => `"${step.id}"`).join(", ");
    problems.push(
      steps.length === 1
        ? `The step ${names} has no outcome "${value}"`
        : `None of the steps ${names} has the outcome "${value}"`,
    );
  };
  // A node with a reference problem has no type, so it gives no type problem.
  const expectType = (
    node: Expression,
    isAllowed: (type: SingleType) => boolean,
    problem: string,
  ) => {
    const type = visit(node);
    if (type === "mixed") problems.push(mixedProblem);
    else if (type !== undefined && !isAllowed(type)) problems.push(problem);
    return type;
  };
  const expectBoolean = (
    node: Expression,
    problem = `${expressionLabel(node)} is not true or false`,
  ) => expectType(node, (type) => type === "boolean", problem);
  const visit = (
    node: Expression,
    { isDefaulted = false }: VisitOptions = {},
  ): ExpressionType | undefined => {
    switch (node.type) {
      case "literal":
        return node.value === null ? "null" : (typeof node.value as ValueType);
      case "path": {
        const { type, problem } = pathType(node.segments, scope);
        const found = problem ?? (isDefaulted ? undefined : unsetProblem(node.segments, scope));
        if (found) problems.push(found);
        return type;
      }
      case "not":
        expectBoolean(node.operand);
        return "boolean";
      case "call":
        switch (node.name) {
          case "contains": {
            const whole = expectType(
              node.whole,
              (type) => type === "string" || isValueType(listItems(type)),
              "Use a string or a list of strings, numbers or booleans as the first argument of contains",
            );
            const item = whole === "string" ? "string" : listItems(whole);
            if (isValueType(item)) {
              expectType(
                node.part,
                (type) => type === item,
                `Use a ${item} as the second argument of contains`,
              );
            } else visit(node.part);
            break;
          }
          case "starts_with":
            expectType(
              node.whole,
              (type) => type === "string" || listItems(type) === "string",
              "Use a string or a list of strings as the first argument of starts_with",
            );
            expectType(
              node.part,
              (type) => type === "string",
              "Use a string as the second argument of starts_with",
            );
        }
        return "boolean";
      case "binary": {
        const { operator, left, right } = node;
        if (operator === "??") {
          checkValue(left, right, { isDefault: true });
          const leftType = visit(left, { isDefaulted: true });
          const rightType = visit(right, { isDefaulted });
          if (leftType === undefined || rightType === undefined) return undefined;
          if (leftType === "null") return rightType;
          return rightType === "null" || sameType(leftType, rightType) ? leftType : "mixed";
        }
        if (operator === "&&" || operator === "||") {
          expectBoolean(left);
          expectBoolean(right);
          return "boolean";
        }
        checkValue(left, right);
        checkValue(right, left);
        const types = [visit(left), visit(right)];
        const [leftType, rightType] = types;
        if (types.includes("mixed")) problems.push(mixedProblem);
        else if (leftType && rightType && !types.includes("null")) {
          if (!isValueType(leftType) || !isValueType(rightType)) {
            problems.push("Compare a list or a map only with null");
          } else if (leftType !== rightType) {
            problems.push(
              `Compare two values of the same type, not a ${leftType} and a ${rightType}`,
            );
          }
        }
        return "boolean";
      }
    }
  };
  if (isCondition) expectBoolean(expression, "The condition is not true or false");
  else if (valueType === "scalar") {
    expectType(expression, isValueType, "Read a string, a number or a boolean");
  } else if (valueType) {
    expectType(expression, (type) => type === valueType, `Give a ${valueType} to this field`);
  } else visit(expression);
  return problems;
};

function* sourcesOf(step: Step) {
  for (const { field, text, valueType } of templatesOf(step)) {
    const typed = valueType === "string" ? {} : { valueType };
    for (const source of expressionsIn(text)) yield { field, source, ...typed };
  }
  if (step.if !== undefined) yield { field: "if", source: step.if, isCondition: true };
}

const reviewerProblem = (step: Step | undefined, stepId: string) => {
  if (!step) return `The step "${stepId}" is not before this step`;
  if (step.type !== "agent" || canWrite(step)) {
    return `The step "${stepId}" is not an agent step with write: false`;
  }
  return undefined;
};

const referenceFields = ["inputs", "branch", "concurrency", "on", "steps"];

// Other problems do not stop the reference check. A custom problem keeps the shape of the value.
export const canCheckReferences = ({ issues }: z.core.ParsePayload) =>
  issues.every(
    ({ code, path = [] }) =>
      code === "custom" ||
      code === "unrecognized_keys" ||
      (path.length > 0 && !referenceFields.includes(String(path[0]))),
  );

export const checkReferences = (
  {
    inputs = {},
    branch,
    concurrency,
    on,
    steps,
  }: {
    inputs?: Record<string, WorkflowInput>;
    branch?: { name: string };
    concurrency?: { group: string; cancel_in_progress?: boolean };
    on?: Triggers;
    steps: Step[];
  },
  context: z.RefinementCtx,
  agents?: Agents,
) => {
  const check = (
    path: (string | number)[],
    sources: Iterable<{
      field: string;
      source: string;
      isCondition?: boolean;
      valueType?: ValueType | "scalar";
    }>,
    scope: Scope,
  ) => {
    for (const { field, source, isCondition = false, valueType } of sources) {
      const { expression } = tryParse(() => (isCondition ? conditionExpression(source) : source));
      // The field check reports syntax problems.
      if (!expression) continue;
      for (const message of expressionProblems(expression, scope, { isCondition, valueType })) {
        context.addIssue({ code: "custom", path: [...path, field], message });
      }
    }
  };
  if (branch) {
    const sources = expressionsIn(branch.name).map((source) => ({ field: "name", source }));
    check(["branch"], sources, { inputs });
  }
  if (concurrency) {
    const sources = expressionsIn(concurrency.group).map((source) => ({ field: "group", source }));
    check(["concurrency"], sources, { inputs });
    if (concurrency.cancel_in_progress && branch) {
      context.addIssue({
        code: "custom",
        path: ["concurrency", "cancel_in_progress"],
        message:
          "Do not use cancel_in_progress with branch: the run that it cancels holds the branch",
      });
    }
  }
  const checkMapping = (event: keyof typeof eventFields, mapping: Record<string, string> = {}) => {
    const path = ["on", event, "inputs"];
    const scope = { event: eventFields[event] };
    const addIssue = (name: string, message: string) =>
      context.addIssue({ code: "custom", path: [...path, name], message });
    for (const [name, value] of Object.entries(mapping)) {
      const input = Object.hasOwn(inputs, name) ? inputs[name] : undefined;
      if (!input) {
        addIssue(name, `The workflow has no input "${name}"`);
        continue;
      }
      const type = inputTypeOf(input);
      const sources = expressionsIn(value);
      if (sources.length === 0) {
        const resolved = resolveInputs({ [name]: input }, { [name]: value });
        if (!resolved.ok) addIssue(name, resolved.problems[0]!.message);
        continue;
      }
      const isSingle = singleExpression(value) !== undefined;
      if (!isSingle && type !== "string") {
        addIssue(name, `Use one \${{ }} and no other text for a ${type} input`);
      }
      const valueType = isSingle ? type : "scalar";
      check(
        path,
        sources.map((source) => ({ field: name, source, valueType })),
        scope,
      );
    }
    for (const [name, { required }] of Object.entries(inputs)) {
      if (required && !Object.hasOwn(mapping, name)) {
        context.addIssue({
          code: "custom",
          path,
          message: `Give a value to the required input "${name}"`,
        });
      }
    }
  };
  if (on?.issues) checkMapping("issues", on.issues.inputs);
  if (on?.issue_comment) checkMapping("issue_comment", on.issue_comment.inputs);
  if (on?.cron) checkMapping("cron", on.cron.inputs);
  if (!on?.pull_request) {
    for (const step of leafSteps({ steps })) {
      if (step.type === "github" && step.action === "comment_on_pull_request") {
        context.addIssue({
          code: "custom",
          path: ["steps"],
          message: `Add on.pull_request for comment_on_pull_request (step "${step.id}"): only such a run has a pull request`,
        });
      }
    }
  }
  if (on?.pull_request) {
    checkMapping("pull_request", on.pull_request.inputs);
    if (on.pull_request.types.includes("synchronize") && !concurrency?.cancel_in_progress) {
      context.addIssue({
        code: "custom",
        path: ["on", "pull_request", "types"],
        message:
          "Use concurrency with cancel_in_progress with synchronize: each push starts a run, and the older run reviews old code",
      });
    }
    leafSteps({ steps }).forEach((step) => {
      if (step.type === "github" && step.action === "open_pull_request") {
        context.addIssue({
          code: "custom",
          path: ["on", "pull_request"],
          message: `Do not use open_pull_request (step "${step.id}") with on.pull_request: the run starts on the pull request`,
        });
      }
    });
  }
  const earlier = new Map<string, Step>();
  const base = { inputs, agents, earlier };
  const checkReviewers = (path: (string | number)[], step: Step) => {
    if (step.type !== "approval") return;
    step.reviewers?.forEach((stepId, index) => {
      const message = reviewerProblem(earlier.get(stepId), stepId);
      if (message)
        context.addIssue({ code: "custom", path: [...path, "reviewers", index], message });
    });
  };
  steps.forEach((step, index) => {
    const path = ["steps", index];
    check(path, sourcesOf(step), base);
    checkReviewers(path, step);
    if (step.type === "loop") {
      const loop = new Map(step.steps.map((child) => [child.id, child]));
      step.steps.forEach((child, childIndex) => {
        const childPath = [...path, "steps", childIndex];
        check(childPath, sourcesOf(child), { ...base, loop });
        checkReviewers(childPath, child);
        earlier.set(child.id, child);
      });
      const until = [{ field: "until", source: step.until, isCondition: true }];
      check(path, until, { ...base, loop });
    }
    earlier.set(step.id, step);
  });
};
