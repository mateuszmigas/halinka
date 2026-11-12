import { type ApiOutputs, ORPCError } from "@halinka/server/client";
import { fakeTimers } from "@halinka/utils/testing";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { RunFollower } from "./runFollower";
import { RunPrinter } from "./runPrinter";

type RunDetail = ApiOutputs["runs"]["get"];

type StoredEvent = ApiOutputs["runs"]["events"][number];

type Answer = RunDetail | Error | Promise<RunDetail> | "no answer";

type Change = { type: "state" } | { type: "events"; events: StoredEvent[] } | Error;

const runUrl = "http://server/runs/7";

const runIn = (status: string, waitReason?: string, error: string | null = null) =>
  ({ status, waitReason, error }) as RunDetail;

const outputEvent = (seq: number, text: string): StoredEvent => ({
  seq,
  createdAt: "",
  event: { kind: "output", payload: { stepId: "build", attemptId: 1, stream: "stdout", text } },
});

const unanswered = (signal: AbortSignal) =>
  new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("The read stopped")));
  });

type SetUp = {
  answers: Answer[];
  stream?: Change[];
  lastEvents?: StoredEvent[] | Error;
  pollMs?: number;
  readTimeoutMs?: number;
};

const setUp = (options: SetUp) => {
  const { answers, stream = [], lastEvents = [], pollMs = 1, readTimeoutMs = 1000 } = options;
  const lines: string[] = [];
  const printed = { write: (text: string) => lines.push(text) };
  const eventInputs: unknown[] = [];
  let reads = 0;
  let readSignal: AbortSignal | undefined;
  const api = {
    runs: {
      get: async (_input: unknown, { signal }: { signal: AbortSignal }) => {
        reads += 1;
        readSignal = signal;
        const answer = answers.length > 1 ? answers.shift()! : answers[0]!;
        if (answer === "no answer") return unanswered(signal);
        if (answer instanceof Error) throw answer;
        return answer;
      },
      events: async (input: unknown, _options: unknown) => {
        eventInputs.push(input);
        if (lastEvents instanceof Error) throw lastEvents;
        return lastEvents;
      },
      watch: async (_input: unknown, { signal }: { signal: AbortSignal }) =>
        (async function* () {
          for (const change of stream) {
            if (change instanceof Error) throw change;
            yield change;
          }
          if (!signal.aborted) {
            await new Promise((done) => signal.addEventListener("abort", done));
          }
        })(),
    },
  } as never;
  const abort = new AbortController();
  onTestFinished(() => abort.abort());
  const follower = new RunFollower({
    api,
    workflowRunId: 7,
    runUrl,
    printer: new RunPrinter(printed, printed),
    pollMs,
    readTimeoutMs,
  });
  return {
    follower,
    abort,
    eventInputs,
    reads: () => reads,
    readSignal: () => readSignal,
    output: () => lines.join(""),
  };
};

describe("RunFollower", () => {
  it("gives the run when it ends", async () => {
    const { follower, abort } = setUp({
      answers: [runIn("running"), runIn("failed", undefined, "Boom")],
    });

    const run = await follower.follow(abort.signal);

    expect(run).toMatchObject({ status: "failed", error: "Boom" });
  });

  it("gives the run when it expires", async () => {
    const { follower, abort } = setUp({ answers: [runIn("expired")] });

    const run = await follower.follow(abort.signal);

    expect(run).toMatchObject({ status: "expired" });
  });

  it("prints each new wait reason once", async () => {
    const { follower, abort, output } = setUp({
      answers: [
        runIn("queued", "The runner is not connected"),
        runIn("queued", "The runner is not connected"),
        runIn("queued", "No Docker"),
        runIn("succeeded"),
      ],
    });

    await follower.follow(abort.signal);

    expect(output()).toBe("Waiting: The runner is not connected\nWaiting: No Docker\n");
  });

  it("prints the link once each time the run starts to wait for a person", async () => {
    const { follower, abort, output } = setUp({
      answers: [
        runIn("waiting_input"),
        runIn("waiting_input"),
        runIn("running"),
        runIn("waiting_input"),
        runIn("succeeded"),
      ],
    });

    await follower.follow(abort.signal);

    const line = `The run waits for a person: ${runUrl}\n`;
    expect(output()).toBe(line + line);
  });

  it("reads the run again at the interval", async () => {
    fakeTimers();
    const { follower, abort, reads } = setUp({
      answers: [runIn("queued")],
      pollMs: 1000,
    });

    void follower.follow(abort.signal);
    await vi.advanceTimersByTimeAsync(999);
    expect(reads()).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(reads()).toBe(2);
  });

  it("reads the run again after a state change during a read", async () => {
    const first = Promise.withResolvers<RunDetail>();
    const { follower, abort } = setUp({
      answers: [first.promise, runIn("succeeded")],
      stream: [{ type: "state" }],
      pollMs: 60_000,
    });

    const following = follower.follow(abort.signal);
    await new Promise(setImmediate);
    first.resolve(runIn("running"));

    await expect(following).resolves.toMatchObject({ status: "succeeded" });
  });

  const followedStreamAndEnd = async () => {
    const first = Promise.withResolvers<RunDetail>();
    const fixture = setUp({
      answers: [first.promise],
      stream: [{ type: "events", events: [outputEvent(4, "first\n")] }],
      lastEvents: [outputEvent(5, "last\n")],
    });
    const following = fixture.follower.follow(fixture.abort.signal);
    await new Promise(setImmediate);
    first.resolve(runIn("succeeded"));
    await following;
    return fixture;
  };

  it("prints each event of the stream once", async () => {
    const { output } = await followedStreamAndEnd();

    expect(output()).toBe("first\nlast\n");
  });

  it("reads only the events after the stream at the end", async () => {
    const { eventInputs } = await followedStreamAndEnd();

    expect(eventInputs).toEqual([{ id: 7, after: 4 }]);
  });

  const lastOutputFails = () =>
    setUp({ answers: [runIn("succeeded")], lastEvents: new Error("fetch failed") });

  it("prints that it did not read the last output", async () => {
    const { follower, abort, output } = lastOutputFails();

    await follower.follow(abort.signal);

    expect(output()).toBe("Halinka did not read the last output: fetch failed.\n");
  });

  it("gives the run when it did not read the last output", async () => {
    const { follower, abort } = lastOutputFails();

    expect(await follower.follow(abort.signal)).toMatchObject({ status: "succeeded" });
  });

  it("gives no run after an abort", async () => {
    const { follower, abort } = setUp({ answers: [runIn("running")] });

    const following = follower.follow(abort.signal);
    abort.abort();

    await expect(following).resolves.toBeUndefined();
  });

  it("does not read the last events after an abort", async () => {
    const { follower, abort, eventInputs } = setUp({ answers: [runIn("running")] });

    const following = follower.follow(abort.signal);
    abort.abort();
    await following;

    expect(eventInputs).toEqual([]);
  });

  it("reads again after a read that gets no answer", async () => {
    const { follower, abort } = setUp({
      answers: ["no answer", runIn("succeeded")],
      readTimeoutMs: 1,
    });

    await expect(follower.follow(abort.signal)).resolves.toMatchObject({ status: "succeeded" });
  });

  it("stops the read in flight at an abort", async () => {
    const { follower, abort, readSignal, output } = setUp({ answers: ["no answer"] });

    const following = follower.follow(abort.signal);
    abort.abort();
    await following;

    expect(readSignal()?.aborted).toBe(true);
    expect(output()).toBe("");
  });

  it("continues when the server does not answer", async () => {
    const { follower, abort } = setUp({
      answers: [new Error("fetch failed"), runIn("succeeded")],
    });

    await expect(follower.follow(abort.signal)).resolves.toMatchObject({ status: "succeeded" });
  });

  it("prints once that the server does not answer", async () => {
    const down = new Error("fetch failed");
    const { follower, abort, output } = setUp({ answers: [down, down, runIn("succeeded")] });

    await follower.follow(abort.signal);

    expect(output()).toBe("The server did not answer: fetch failed. Halinka tries again.\n");
  });

  it("prints again at a new outage", async () => {
    const down = new Error("fetch failed");
    const { follower, abort, output } = setUp({
      answers: [down, runIn("running"), down, runIn("succeeded")],
    });

    await follower.follow(abort.signal);

    const line = "The server did not answer: fetch failed. Halinka tries again.\n";
    expect(output()).toBe(line + line);
  });

  it("rejects when the server does not know the run", async () => {
    const gone = new ORPCError("NOT_FOUND", { defined: true, message: "There is no run 7" });
    const { follower, abort } = setUp({ answers: [gone] });

    await expect(follower.follow(abort.signal)).rejects.toThrow("There is no run 7");
  });

  it("rejects when the stream ends with an error of the contract", async () => {
    const gone = new ORPCError("NOT_FOUND", { defined: true, message: "There is no run 7" });
    const { follower, abort } = setUp({ answers: [runIn("running")], stream: [gone] });

    await expect(follower.follow(abort.signal)).rejects.toThrow("There is no run 7");
  });
});
