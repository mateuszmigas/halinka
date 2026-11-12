import { z } from "zod";

const runnerLabelPattern = /^[a-z0-9][a-z0-9_.-]*$/;

export const runnerLabelHint =
  "Start with a lowercase letter or a digit. Use only lowercase letters, digits, _ . and -";

export const isRunnerLabel = (value: string) => runnerLabelPattern.test(value);

export const runnerLabelSchema = z.string().regex(runnerLabelPattern, runnerLabelHint);
