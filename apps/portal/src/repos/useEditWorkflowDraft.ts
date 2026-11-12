import { useEffect, useEffectEvent, useState } from "react";

import type { ExternalEdit } from "../codeEditor";
import {
  deleteOldDrafts,
  type WorkflowDraft,
  type WorkflowFile,
  WorkflowDraftStore,
} from "./workflowDraftStore";

export const useEditWorkflowDraft = (repoId: number, path: string, file: WorkflowFile) => {
  const [drafts] = useState(() => {
    deleteOldDrafts();
    return new WorkflowDraftStore(repoId, path);
  });
  const [restored, setRestored] = useState(() => drafts.read(file));
  const [base, setBase] = useState(file);
  const [source, setSource] = useState(restored?.source ?? file.source);
  const [baseHash, setBaseHash] = useState(restored?.baseHash ?? file.hash);
  const [lastFileHash, setLastFileHash] = useState(file.hash);
  const [external, setExternal] = useState<ExternalEdit>({ revision: 0 });
  const [isStored, setIsStored] = useState(true);
  const isStale = baseHash !== base.hash;
  const isSaved = !isStale && source === base.source;

  const replaced = (edit: Omit<ExternalEdit, "revision"> = {}) =>
    setExternal((current) => ({ ...edit, revision: current.revision + 1 }));

  if (lastFileHash !== file.hash) {
    setLastFileHash(file.hash);
    setBase(file);
    if (isSaved || source === file.source) {
      if (!isSaved) setIsStored(drafts.delete());
      setRestored(undefined);
      setSource(file.source);
      setBaseHash(file.hash);
      replaced({ changesBase: true });
    }
  }

  const takeOtherTab = useEffectEvent((other: WorkflowDraft) => {
    setRestored(undefined);
    setSource(other.source);
    setBaseHash(other.baseHash);
    replaced({ changesBase: other.baseHash !== baseHash });
  });

  useEffect(() => {
    const flush = () => drafts.flush();
    const stopWatching = drafts.watchOtherTabs(takeOtherTab);
    window.addEventListener("pagehide", flush);
    return () => {
      stopWatching();
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [drafts]);

  const store = (value: string, hash: string) => {
    drafts.writeSoon({ source: value, baseHash: hash }, base, setIsStored);
  };
  // The editor also reports an edit that came from outside it, with the text that the state holds.
  const change = (value: string) => {
    if (value === source) return;
    setRestored(undefined);
    setSource(value);
    store(value, baseHash);
  };
  const reset = (next: WorkflowFile) => {
    setRestored(undefined);
    setBase(next);
    setBaseHash(next.hash);
    setIsStored(drafts.delete());
  };

  return {
    source,
    fileSource: base.source,
    baseHash,
    external,
    restored,
    isSaved,
    isStale,
    isStored,
    change,
    replace: (value: string, group?: string) => {
      change(value);
      replaced({ group });
    },
    keepMine: () => {
      setBaseHash(base.hash);
      store(source, base.hash);
    },
    discard: () => {
      reset(base);
      setSource(base.source);
      replaced({ changesBase: isStale });
    },
    saved: reset,
  };
};
