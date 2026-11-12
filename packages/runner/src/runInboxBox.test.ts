import { getEventListeners } from "node:events";

import { describe, expect, it } from "vitest";

import { RunInboxBox } from "./runInboxBox";

const answer = (itemId: number, decision: "approve" | "reject") => ({
  workflowRunId: 1,
  itemId,
  decision,
  resolvedBy: "local",
});

const message = (messageId: number, text: string) => ({
  workflowRunId: 1,
  messageId,
  stepRunId: 3,
  text,
  author: "local",
});

describe("RunInboxBox", () => {
  it("gives a decision that arrived before the wait", async () => {
    const box = new RunInboxBox();
    box.deliverAnswer(answer(7, "approve"));

    expect(await box.waitForDecision(7, new AbortController().signal)).toEqual({
      decision: "approve",
      resolvedBy: "local",
    });
  });

  it("gives a decision that arrives during the wait", async () => {
    const box = new RunInboxBox();

    const decision = box.waitForDecision(7, new AbortController().signal);
    box.deliverAnswer(answer(8, "approve"));
    box.deliverAnswer(answer(7, "reject"));

    expect(await decision).toEqual({
      decision: "reject",
      resolvedBy: "local",
    });
  });

  it("keeps the first decision of an item", async () => {
    const box = new RunInboxBox();

    box.deliverAnswer(answer(7, "approve"));
    box.deliverAnswer(answer(7, "reject"));

    expect(await box.waitForDecision(7, new AbortController().signal)).toEqual({
      decision: "approve",
      resolvedBy: "local",
    });
  });

  it("stops listening to the signal when the decision arrives", async () => {
    const box = new RunInboxBox();
    const controller = new AbortController();
    box.deliverAnswer(answer(7, "approve"));

    await box.waitForDecision(7, controller.signal);

    expect(getEventListeners(controller.signal, "abort")).toEqual([]);
  });

  it("stops waiting on abort", async () => {
    const box = new RunInboxBox();
    const controller = new AbortController();

    const decision = box.waitForDecision(7, controller.signal);
    controller.abort("stop");

    await expect(decision).rejects.toBe("stop");
  });

  it("stops at once when the signal is already aborted", async () => {
    const box = new RunInboxBox();

    await expect(box.waitForDecision(7, AbortSignal.abort("stop"))).rejects.toBe("stop");
  });

  it("gives the messages in the order of arrival", () => {
    const box = new RunInboxBox();
    box.deliverMessage(message(5, "Use SQLite"));
    box.deliverMessage(message(6, "Add a test"));

    const taken = box.takeMessages(3);

    expect(taken.map(({ text }) => text)).toEqual(["Use SQLite", "Add a test"]);
  });

  it("gives only the messages of its step run", () => {
    const box = new RunInboxBox();
    box.deliverMessage({ ...message(5, "Other step"), stepRunId: 4 });

    expect(box.takeMessages(3)).toEqual([]);
  });

  it("keeps waiting when a message to another step run arrives", async () => {
    const box = new RunInboxBox();
    const controller = new AbortController();
    box.deliverMessage({ ...message(5, "Other step"), stepRunId: 4 });

    const arrived = box.messageArrived(3, controller.signal);
    controller.abort("stop");

    await expect(arrived).rejects.toBe("stop");
  });

  it("gives a message one time when sync sends it again", () => {
    const box = new RunInboxBox();
    box.deliverMessage(message(5, "Use SQLite"));
    box.takeMessages(3);

    box.deliverMessage(message(5, "Use SQLite"));

    expect(box.takeMessages(3)).toEqual([]);
  });

  it("settles the arrival at once when a message waits", async () => {
    const box = new RunInboxBox();
    box.deliverMessage(message(5, "Use SQLite"));

    await expect(box.messageArrived(3, new AbortController().signal)).resolves.toBeUndefined();
  });

  it("settles the arrival when a message arrives during the wait", async () => {
    const box = new RunInboxBox();

    const arrived = box.messageArrived(3, new AbortController().signal);
    box.deliverMessage(message(5, "Use SQLite"));

    await expect(arrived).resolves.toBeUndefined();
  });

  it("waits for the next message after the engine takes the messages", async () => {
    const box = new RunInboxBox();
    const controller = new AbortController();
    box.deliverMessage(message(5, "Use SQLite"));
    box.takeMessages(3);

    const arrived = box.messageArrived(3, controller.signal);
    controller.abort("stop");

    await expect(arrived).rejects.toBe("stop");
  });
});
