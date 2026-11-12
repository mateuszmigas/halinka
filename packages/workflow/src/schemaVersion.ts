import { z } from "zod";

import { type ParseYamlOptions, parseYaml } from "./parseYaml";

export const schemaVersion = 1;

// `olderMessage`: the problem of a file without `schema_version`
export type ParseVersionedOptions = ParseYamlOptions & { olderMessage: string };

const versionedSchemaOf = (olderMessage: string) =>
  z
    .looseObject({
      schema_version: z
        .int({ error: ({ input }) => (input === undefined ? olderMessage : undefined) })
        .min(1, "Use 1 or more")
        .max(schemaVersion, {
          error: ({ input }) => `Update Halinka to read schema_version ${String(input)}`,
        }),
    })
    .transform((file): unknown =>
      Object.fromEntries(Object.entries(file).filter(([key]) => key !== "schema_version")),
    );

// Reports only the version problem: another version has another schema.
export const parseVersioned = <T>(
  schema: z.ZodType<T>,
  source: string,
  { olderMessage, ...options }: ParseVersionedOptions,
) => parseYaml(versionedSchemaOf(olderMessage).pipe(schema), source, options);
