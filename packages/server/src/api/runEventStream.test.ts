import { describe, expect, it } from "vitest";

import { createRepositories } from "../db/repositories";
import { RunStream } from "../runStream";
import { CountingBus, setUpTestDb } from "../testing";
import { startSeq, toEventIterator } from "./runEventStream";

const testDb = setUpTestDb();

describe("runEventStream", () => {
  it("stops the stream when the client left before the response started", () => {
    const bus = new CountingBus();
    const stream = new RunStream(createRepositories(testDb()).workflowRunEvent, bus, {
      workflowRunId: 1,
      afterSeq: 0,
    });

    toEventIterator(stream, AbortSignal.abort(), async () => {});

    expect(bus.openSubscriptions()).toBe(0);
  });

  it("continues after the after seq when the last event id is negative", () => {
    expect(startSeq("-1", 3)).toBe(3);
  });
});
