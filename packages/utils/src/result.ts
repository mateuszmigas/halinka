export type Result<T, P = string> = { ok: true; value: T } | { ok: false; problems: P[] };
