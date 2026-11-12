import { z } from "zod";

const identifierPattern = /^[a-z][a-z0-9_]*$/;

export const identifierHint =
  "Start with a letter. Use only lowercase letters, digits and underscores";

export const isIdentifier = (value: string) => identifierPattern.test(value);

export const identifierSchema = z.string().regex(identifierPattern, identifierHint);
