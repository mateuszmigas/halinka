export type WorkflowFile = { source: string; hash: string };

export type WorkflowDraft = { source: string; baseHash: string; updatedAt: string };

export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

type DraftRecord = { version: typeof recordVersion; draft: WorkflowDraft };

const keyPrefix = "halinka.workflowDraft:";
const recordVersion = 1;
const writeDelayMs = 300;
const maxAgeMs = 30 * 24 * 60 * 60 * 1000;

// Read localStorage on each call, so a write to blocked storage throws.
const browserStorage: DraftStorage = {
  getItem: (key) => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
  removeItem: (key) => localStorage.removeItem(key),
};

const draftOf = (record: string | null): WorkflowDraft | undefined => {
  try {
    const { version, draft } = JSON.parse(record ?? "{}") as Partial<DraftRecord>;
    const isDraft =
      version === recordVersion &&
      typeof draft?.source === "string" &&
      typeof draft.baseHash === "string" &&
      typeof draft.updatedAt === "string" &&
      !Number.isNaN(Date.parse(draft.updatedAt));
    return isDraft ? draft : undefined;
  } catch {
    return undefined;
  }
};

const attempt = (action: () => void) => {
  try {
    action();
    return true;
  } catch {
    return false;
  }
};

// A record with no valid draft goes too.
export const deleteOldDrafts = (
  readStorage: () => Pick<Storage, "length" | "key" | "getItem" | "removeItem"> = () =>
    localStorage,
  now = Date.now(),
) => {
  try {
    const storage = readStorage();
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
    for (const key of keys) {
      if (!key?.startsWith(keyPrefix)) continue;
      const updatedAt = Date.parse(draftOf(storage.getItem(key))?.updatedAt ?? "");
      if (!(now - updatedAt <= maxAgeMs)) storage.removeItem(key);
    }
  } catch {
    return;
  }
};

export class WorkflowDraftStore {
  private readonly storage: DraftStorage;
  private readonly key: string;
  private pendingWrite: { run: () => void; timer: ReturnType<typeof setTimeout> } | undefined;

  constructor(repoId: number, path: string, storage = browserStorage) {
    this.key = `${keyPrefix}${repoId}:${path}`;
    this.storage = storage;
  }

  // Each write serializes the whole file.
  writeSoon(
    draft: Omit<WorkflowDraft, "updatedAt">,
    file: WorkflowFile,
    onWritten: (isStored: boolean) => void,
  ) {
    this.cancelWrite();
    const run = () => {
      this.pendingWrite = undefined;
      onWritten(this.write(draft, file));
    };
    this.pendingWrite = { run, timer: setTimeout(run, writeDelayMs) };
  }

  flush() {
    const pending = this.pendingWrite;
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.run();
  }

  // A remove in another tab leaves this tab as it is: a person can still type here.
  watchOtherTabs(
    onChange: (draft: WorkflowDraft) => void,
    target: Pick<Window, "addEventListener" | "removeEventListener"> = window,
  ) {
    const listener = (event: StorageEvent) => {
      if (event.key !== this.key) return;
      const draft = draftOf(event.newValue);
      if (!draft) return;
      this.cancelWrite();
      onChange(draft);
    };
    target.addEventListener("storage", listener);
    return () => target.removeEventListener("storage", listener);
  }

  // A draft equal to the file is done: its pull request merged, or a person saved the same text.
  read(file: WorkflowFile) {
    const draft = this.readDraft();
    if (!draft || draft.source !== file.source) return draft;
    this.delete();
    return undefined;
  }

  write(draft: Omit<WorkflowDraft, "updatedAt">, file: WorkflowFile) {
    if (draft.source === file.source && draft.baseHash === file.hash) return this.delete();
    const record: DraftRecord = {
      version: recordVersion,
      draft: { ...draft, updatedAt: new Date().toISOString() },
    };
    return attempt(() => this.storage.setItem(this.key, JSON.stringify(record)));
  }

  delete() {
    this.cancelWrite();
    return attempt(() => this.storage.removeItem(this.key));
  }

  private readDraft() {
    try {
      return draftOf(this.storage.getItem(this.key));
    } catch {
      return undefined;
    }
  }

  private cancelWrite() {
    if (this.pendingWrite) clearTimeout(this.pendingWrite.timer);
    this.pendingWrite = undefined;
  }
}
