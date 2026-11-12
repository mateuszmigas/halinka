import { vi } from "vitest";

// `process.exit` throws, so the code after a failure does not run.
export const exitOf = (call: () => unknown) => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`exit ${code}`);
  });
  try {
    call();
  } catch {}
  return { code: exit.mock.calls[0]?.[0], log };
};
