import { z } from "zod";

const identifierPattern = /^[a-z][a-z0-9_]*$/;

const identifierRule =
  "Start with a letter, and use only lowercase letters, digits and underscores";

const suggestIdentifier = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/^[^a-z]+/, "");

export const identifierMessage = (value: string) => {
  const suggestion = suggestIdentifier(value);
  const example = suggestion ? `, for example "${suggestion}"` : "";
  return `"${value}" is not a valid name. ${identifierRule}${example}`;
};

export const isIdentifier = (value: string) => identifierPattern.test(value);

export const identifierSchema = z
  .string()
  .regex(identifierPattern, { error: (issue) => identifierMessage(String(issue.input)) });
