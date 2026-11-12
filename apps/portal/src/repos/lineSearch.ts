export type LineSearch = { line?: number };

export const parseLineSearch = (search: Record<string, unknown>): LineSearch =>
  typeof search.line === "number" && Number.isInteger(search.line) && search.line > 0
    ? { line: search.line }
    : {};
