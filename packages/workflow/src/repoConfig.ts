import { isRepoFilePath } from "@halinka/utils/repoFiles";
import { z } from "zod";

import { networkSchema } from "./permissions";
import { parseVersioned } from "./schemaVersion";

export const definitionsFolder = ".halinka";
export const repoConfigPath = `${definitionsFolder}/config.yml`;

const notEmptySchema = z.string().refine((value) => value.trim() !== "", "Must not be empty");

export const secretNameSchema = z
  .string()
  .max(128)
  .regex(/^[A-Z_][A-Z0-9_]*$/, "Use capital letters, digits and underscores, such as NPM_TOKEN");

const setupSchema = z
  .strictObject({
    // also for the lifecycle commands of the devcontainer
    network: networkSchema.optional(),
    run: notEmptySchema.optional(),
    secrets: z.array(secretNameSchema).optional(),
    // Docker inside the container, on a runner with Sysbox
    docker: z.boolean().optional(),
  })
  .refine(({ run, secrets }) => run !== undefined || !secrets?.length, {
    path: ["secrets"],
    message: "Only setup.run gets secrets. Add run.",
  });

const repoConfigSchema = z
  .strictObject({
    devcontainer: z
      .string()
      .refine(
        isRepoFilePath,
        "Use a path from the repo root, such as .devcontainer/devcontainer.json",
      )
      .optional(),
    setup: setupSchema.optional(),
  })
  .refine(({ devcontainer, setup }) => devcontainer !== undefined || setup === undefined, {
    path: ["setup"],
    message: "Only a devcontainer has setup. Add devcontainer.",
  });

export type RepoConfig = z.infer<typeof repoConfigSchema>;

const removedKeys = new Map([
  ["server", "A repo does not select a server. Delete the server key."],
  [
    "environments",
    "A repo has one devcontainer. Write devcontainer: <path> and delete environments.",
  ],
]);

export const parseRepoConfig = (source: string) =>
  parseVersioned(repoConfigSchema, source, {
    removedKeys,
    olderMessage:
      "This file is from an older Halinka. Run halinka migrate --write in the repo. For a GitHub repo, then commit and push the files.",
  });
