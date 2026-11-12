import { stringify } from "yaml";

import type { RepoConfig } from "./repoConfig";
import { schemaVersion } from "./schemaVersion";

export const smokePath = ".halinka/workflows/smoke.yml";
export const newDevcontainerPath = ".devcontainer/devcontainer.json";

export const createRepoConfig = (config: RepoConfig) =>
  stringify({ schema_version: schemaVersion, ...config });

// The agents need node.
export const createDevcontainer = () =>
  `${JSON.stringify({ image: "mcr.microsoft.com/devcontainers/javascript-node:22-bookworm" }, null, 2)}\n`;

export const createSmokeWorkflow = () =>
  stringify({
    schema_version: schemaVersion,
    name: "Smoke",
    steps: [
      { id: "shell", type: "shell", run: "git status --short" },
      {
        id: "agent",
        type: "agent",
        agent: "claude-code",
        permissions: { write: false },
        prompt: "Read this repository. Report a summary of the project in one sentence.",
      },
    ],
  });
