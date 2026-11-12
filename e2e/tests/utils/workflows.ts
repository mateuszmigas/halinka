// The step ID is the name in lower case.
export const shellWorkflow = (run: string, name = "Build") =>
  [
    "schema_version: 1",
    `name: ${name}`,
    "steps:",
    `  - { id: ${name.toLowerCase()}, type: shell, run: ${JSON.stringify(run)} }`,
    "",
  ].join("\n");

// A workflow of the schema before `schema_version`.
export const legacyWorkflow = (run: string) =>
  `name: Build\nenvironment: default\nsteps:\n  - id: build\n    type: shell\n    run: ${run}\n`;
