import { type ExpressionContext, interpolate, type InterpolateOptions } from "./expressions";
import type { LeafStep, Step } from "./workflow";

const templateFields = {
  agent: { prompt: "string" },
  approval: { message: "string" },
  github: { title: "string", body: "string", closes: "number" },
} as const;

type TemplateStep = Extract<Step, { type: keyof typeof templateFields }>;

type TemplateField = keyof (typeof templateFields)[TemplateStep["type"]];

const hasTemplate = (step: Step): step is TemplateStep => Object.hasOwn(templateFields, step.type);

export const templatesOf = (step: Step) => {
  if (!hasTemplate(step)) return [];
  const texts = step as Partial<Record<TemplateField, string>>;
  return Object.entries(templateFields[step.type]).flatMap(([field, valueType]) => {
    const text = texts[field as TemplateField];
    return text === undefined ? [] : [{ field, text, valueType }];
  });
};

export const interpolateStep = (
  step: LeafStep,
  context: ExpressionContext,
  { isUntrusted = false }: InterpolateOptions = {},
): LeafStep => {
  // A person reads an approval message or a GitHub text, so only a prompt marks data.
  const options = { isUntrusted: step.type === "agent" && isUntrusted };
  const texts = templatesOf(step).map(({ field, text }) => [
    field,
    interpolate(text, context, options),
  ]);
  return { ...step, ...Object.fromEntries(texts) };
};
