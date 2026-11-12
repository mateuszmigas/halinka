import type { LentValues } from "../checkpoints";

export const keepAll: LentValues = {
  mask: (value) => value,
  find: () => undefined,
  heldLength: () => 0,
};

export const masking = (lentValue: string): LentValues => ({
  find: (text) => (text.includes(lentValue) ? "API_KEY" : undefined),
  mask: <T>(value: T) => JSON.parse(JSON.stringify(value).replaceAll(lentValue, "***")) as T,
  heldLength: (text) => {
    for (let length = lentValue.length - 1; length > 0; length--) {
      if (text.endsWith(lentValue.slice(0, length))) return length;
    }
    return 0;
  },
});
