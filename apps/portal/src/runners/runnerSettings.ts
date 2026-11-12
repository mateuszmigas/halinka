// Labels as text; `allowedAgents` null: every agent.
export type RunnerSettingsValues = { labels: string; allowedAgents: string[] | null };

type RunnerSettings = { labels: string[]; allowedAgents: string[] | null };

export const settingsValuesOf = (runner?: {
  labels: string[];
  allowedAgents?: string[];
}): RunnerSettingsValues => ({
  labels: runner?.labels.join(", ") ?? "",
  allowedAgents: runner?.allowedAgents ?? null,
});

export const settingsOf = (values: RunnerSettingsValues): RunnerSettings => ({
  labels: values.labels.split(/[\s,]+/).filter(Boolean),
  allowedAgents: values.allowedAgents,
});
