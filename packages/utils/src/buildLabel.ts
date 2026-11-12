export const buildLabelOf = (version: string, buildId: string) =>
  `${version} (build ${buildId.slice(0, 12)})`;
