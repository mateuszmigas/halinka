import { type RefObject, useEffect, useEffectEvent } from "react";

import type { EditorHistory } from "../codeEditor";

export const useBindUndoKeys = (
  workspace: RefObject<HTMLElement | null>,
  history: EditorHistory | undefined,
) => {
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (!history || event.defaultPrevented || event.altKey) return;
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z") return;
    const target = event.target;
    const isTextField =
      target instanceof HTMLElement &&
      (target.isContentEditable || target.matches("input, textarea"));
    if (isTextField && !workspace.current?.contains(target)) return;
    event.preventDefault();
    if (event.shiftKey) history.redo();
    else history.undo();
  });

  useEffect(() => {
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
};
