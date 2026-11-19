import { setImmediate } from "node:timers/promises";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import { describe, expect, test, vi } from "vitest";

import { createApiClient } from "./client";

setFlagsFromString("--expose-gc");
const collectGarbage = runInNewContext("gc") as () => void;

describe("createApiClient", () => {
  test("aborts the fetch after a garbage collection", async () => {
    const caller = new AbortController();
    let sent: AbortSignal | undefined;
    const api = createApiClient("http://halinka.test", {
      fetch: async (request, init) => {
        sent = init.signal ?? request.signal;
        return new Response(new ReadableStream(), {
          headers: { "content-type": "application/json" },
        });
      },
    });
    api.runs.get({ id: 1 }, { signal: caller.signal }).catch(() => undefined);
    await vi.waitFor(() => expect(sent).toBeDefined());
    await setImmediate();
    collectGarbage();

    caller.abort();

    expect(sent?.aborted).toBe(true);
  });
});
