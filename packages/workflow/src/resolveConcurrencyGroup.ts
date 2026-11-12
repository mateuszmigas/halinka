import { errorMessage } from "@halinka/utils/errors";
import type { Result } from "@halinka/utils/result";

import { interpolate } from "./expressions";
import type { Inputs } from "./inputs";
import type { Workflow } from "./workflow";

// An index on the name holds about 2700 bytes.
const maxNameLength = 200;

export const resolveConcurrencyGroup = (
  { concurrency }: Workflow,
  inputs: Inputs,
): Result<string | undefined> => {
  if (!concurrency) return { ok: true, value: undefined };
  try {
    const name = interpolate(concurrency.group, { inputs, steps: {} });
    if (name.trim() === "") {
      return {
        ok: false,
        problems: ["The concurrency group is empty. Check the inputs of its name."],
      };
    }
    if (name.length > maxNameLength) {
      return {
        ok: false,
        problems: [`Use a concurrency group of ${maxNameLength} characters or less.`],
      };
    }
    return { ok: true, value: name };
  } catch (error) {
    return { ok: false, problems: [`Check the concurrency group: ${errorMessage(error)}`] };
  }
};
