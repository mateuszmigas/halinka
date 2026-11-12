import { fakeTimers } from "@halinka/utils/testing";
import { describe, expect, it, vi } from "vitest";

import { FakeBlockedStorage, FakeStorage } from "../testing";
import { type DraftStorage, deleteOldDrafts, WorkflowDraftStore } from "./workflowDraftStore";

const file = { source: "name: Build\n", hash: "hash-1" };

const draft = (source = "name: Test\n", baseHash = "hash-1") => ({ source, baseHash });

const setUp = (storage: DraftStorage = new FakeStorage()) => ({
  storage,
  drafts: new WorkflowDraftStore(1, "a.yml", storage),
  reopen: () => new WorkflowDraftStore(1, "a.yml", storage),
});

const key = "halinka.workflowDraft:1:a.yml";

const recordOf = (fields: object) => JSON.stringify({ version: 1, ...fields });

const recordAt = (updatedAt: string) =>
  recordOf({ draft: { source: "s", baseHash: "h", updatedAt } });

const started = () => {
  fakeTimers();
  const context = setUp();
  const onWritten = vi.fn();
  return { ...context, onWritten };
};

const now = Date.parse("2026-11-04T00:00:00Z");

const storageOf = (items: Record<string, string>) => {
  const map = new Map(Object.entries(items));
  return {
    map,
    get length() {
      return map.size;
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    removeItem: (key: string) => void map.delete(key),
  };
};

const watched = () => {
  fakeTimers();
  const context = setUp();
  const target = new EventTarget();
  const onChange = vi.fn();
  const stop = context.drafts.watchOtherTabs(onChange, target as unknown as Window);
  const send = (eventKey: string, newValue: string | null) =>
    target.dispatchEvent(Object.assign(new Event("storage"), { key: eventKey, newValue }));
  return { ...context, onChange, stop, send };
};

const other = { source: "name: Other\n", baseHash: "hash-1", updatedAt: "2026-11-04T00:00:00Z" };

describe("WorkflowDraftStore", () => {
  it("restores a draft in a new store for the same file", () => {
    const { drafts, reopen } = setUp();

    drafts.write(draft(), file);

    expect(reopen().read(file)).toMatchObject(draft());
  });

  it("keeps the drafts of other files apart", () => {
    const { drafts, storage } = setUp();

    drafts.write(draft(), file);

    expect(new WorkflowDraftStore(1, "b.yml", storage).read(file)).toBeUndefined();
  });

  it("removes the draft when its text and base equal the file", () => {
    const { drafts, reopen } = setUp();
    drafts.write(draft(), file);

    drafts.write(draft(file.source), file);

    expect(reopen().read(file)).toBeUndefined();
  });

  it("reads no draft from a malformed record", () => {
    const storage = new FakeStorage();
    storage.setItem(key, recordOf({ draft: "text" }));

    expect(setUp(storage).drafts.read(file)).toBeUndefined();
  });

  it("reads no draft from a record of another version", () => {
    const storage = new FakeStorage();
    const stored = {
      source: "name: Test\n",
      baseHash: "hash-1",
      updatedAt: "2026-11-04T00:00:00Z",
    };
    storage.setItem(key, JSON.stringify({ version: 0, draft: stored }));

    expect(setUp(storage).drafts.read(file)).toBeUndefined();
  });

  it("reads no draft when the storage throws", () => {
    const { drafts } = setUp(new FakeBlockedStorage());

    expect(drafts.read(file)).toBeUndefined();
  });

  it("removes the stored draft when the storage refuses writes", () => {
    const storage = new FakeStorage();
    new WorkflowDraftStore(1, "a.yml", storage).write(draft(), file);
    storage.isFull = true;
    const { drafts, reopen } = setUp(storage);

    drafts.delete();

    expect(reopen().read(file)).toBeUndefined();
  });

  it("returns false when the storage refuses the write", () => {
    const { drafts } = setUp(new FakeBlockedStorage());

    expect(drafts.write(draft(), file)).toBe(false);
  });

  it("removes a draft that equals the file, as after a merge", () => {
    const { drafts, reopen, storage } = setUp();
    drafts.write(draft(), file);

    const merged = { source: draft().source, hash: "hash-2" };

    expect(reopen().read(merged)).toBeUndefined();
    expect(storage.getItem(key)).toBeNull();
  });

  it("writes nothing at once after writeSoon", () => {
    const { drafts, reopen, onWritten } = started();

    drafts.writeSoon(draft(), file, onWritten);

    expect(reopen().read(file)).toBeUndefined();
  });

  it("writes only the last text of writeSoon after the delay", () => {
    const { drafts, reopen, onWritten } = started();

    drafts.writeSoon(draft("name: One\n"), file, onWritten);
    drafts.writeSoon(draft("name: Two\n"), file, onWritten);
    vi.advanceTimersByTime(300);

    expect(reopen().read(file)?.source).toBe("name: Two\n");
    expect(onWritten).toHaveBeenCalledOnce();
  });

  it("writes at once on a flush", () => {
    const { drafts, reopen, onWritten } = started();
    drafts.writeSoon(draft(), file, onWritten);

    drafts.flush();

    expect(reopen().read(file)).toMatchObject(draft());
  });

  it("does not write a pending text after a remove", () => {
    const { drafts, reopen, onWritten } = started();
    drafts.writeSoon(draft(), file, onWritten);

    drafts.delete();
    vi.advanceTimersByTime(300);

    expect(reopen().read(file)).toBeUndefined();
  });

  it("removes a draft older than 30 days", () => {
    const storage = storageOf({
      [key]: recordAt("2026-10-01T00:00:00Z"),
    });

    deleteOldDrafts(() => storage, now);

    expect(storage.map.size).toBe(0);
  });

  it("keeps a draft newer than 30 days", () => {
    const storage = storageOf({
      [key]: recordAt("2026-10-20T00:00:00Z"),
    });

    deleteOldDrafts(() => storage, now);

    expect(storage.map.size).toBe(1);
  });

  it("keeps the storage items of others at a clean up", () => {
    const storage = storageOf({ other: recordAt("2020-01-01T00:00:00Z") });

    deleteOldDrafts(() => storage, now);

    expect(storage.map.size).toBe(1);
  });

  it("removes a stored record that it cannot read at a clean up", () => {
    const storage = storageOf({ [key]: "not json" });

    deleteOldDrafts(() => storage, now);

    expect(storage.map.size).toBe(0);
  });

  it("cleans up nothing when the browser blocks the storage", () => {
    const blocked = {
      get length(): number {
        throw new Error("blocked");
      },
      key: () => null,
      getItem: () => null,
      removeItem: () => {},
    };

    expect(() => deleteOldDrafts(() => blocked, now)).not.toThrow();
  });

  it("cleans up nothing when the browser refuses access to the storage", () => {
    const refused = () => {
      throw new Error("blocked");
    };

    expect(() => deleteOldDrafts(refused, now)).not.toThrow();
  });

  it("gives the draft of another tab", () => {
    const { send, onChange } = watched();

    send(key, recordOf({ draft: other }));

    expect(onChange).toHaveBeenCalledWith(other);
  });

  it("ignores a change of another file in another tab", () => {
    const { send, onChange } = watched();

    send("halinka.workflowDraft:1:b.yml", recordOf({ draft: other }));

    expect(onChange).not.toHaveBeenCalled();
  });

  it.each([
    ["a record with no draft", recordOf({})],
    ["a remove", null],
  ])("ignores %s in another tab", (_name, value) => {
    const { send, onChange } = watched();

    send(key, value);

    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps a pending text when another tab removes its draft", () => {
    const { drafts, reopen, send } = watched();
    drafts.writeSoon(draft(), file, () => {});

    send(key, null);
    vi.advanceTimersByTime(300);

    expect(reopen().read(file)).toMatchObject(draft());
  });

  it("drops a pending text when another tab writes later", () => {
    const { drafts, reopen, send, storage } = watched();
    drafts.writeSoon(draft(), file, () => {});
    const record = recordOf({ draft: other });
    storage.setItem(key, record);

    send(key, record);
    vi.advanceTimersByTime(300);

    expect(reopen().read(file)?.source).toBe(other.source);
  });

  it("stops to watch the other tabs at the end", () => {
    const { send, stop, onChange } = watched();

    stop();
    send(key, recordOf({ draft: other }));

    expect(onChange).not.toHaveBeenCalled();
  });
});
