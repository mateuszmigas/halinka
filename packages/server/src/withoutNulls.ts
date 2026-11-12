export type WithoutNulls<T> = {
  [K in keyof T]: null extends T[K] ? Exclude<T[K], null> | undefined : T[K];
};

// Only the top-level fields: a `jsonb` value keeps the nulls of its shape.
export const withoutNulls = <T extends object>(row: T): WithoutNulls<T> =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, value ?? undefined]),
  ) as WithoutNulls<T>;
