import { errorMessage } from "@halinka/utils/errors";
import type { editor } from "monaco-editor";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { editorChange } from "./editorChange";

export type EditorProblem = {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  message: string;
};
export type EditorLocation = { line: number; column: number };
export type EditorHistory = {
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
};
export type ExternalEdit = { revision: number; group?: string; changesBase?: boolean };

export type CodeEditorProps = {
  source: string;
  uri: string;
  external: ExternalEdit;
  problems: EditorProblem[];
  readOnly: boolean;
  reveal?: EditorLocation;
  onChange: (source: string) => void;
  onSave: () => void;
  onHistoryChange: (history: EditorHistory | undefined) => void;
};

export const CodeEditor = (props: CodeEditorProps) => {
  const { uri, external, problems, readOnly, reveal } = props;
  const container = useRef<HTMLDivElement>(null);
  const instance = useRef<editor.IStandaloneCodeEditor>(undefined);
  const lastExternal = useRef<{ group?: string; versionId: number }>(undefined);
  const reportHistory = useRef<() => void>(undefined);
  const current = useEffectEvent(() => props);
  const [loadedUri, setLoadedUri] = useState<string>();
  const [failure, setFailure] = useState<{ uri: string; message: string }>();
  const isReady = loadedUri === uri;
  const loadError = failure?.uri === uri ? failure.message : undefined;

  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;
    void import("./monaco")
      .then(({ monaco, editorOptions }) => {
        if (disposed || !container.current) return;
        const model = monaco.editor.createModel(current().source, "yaml", monaco.Uri.parse(uri));
        const editor = monaco.editor.create(container.current, {
          ...editorOptions,
          model,
          ariaLabel: "Workflow source",
          readOnly: current().readOnly,
          padding: { top: 16, bottom: 16 },
          tabSize: 2,
          insertSpaces: true,
          renderValidationDecorations: "on",
          quickSuggestions: { other: "on", strings: "on", comments: "off" },
          wordBasedSuggestions: "off",
          acceptSuggestionOnEnter: "smart",
        });
        instance.current = editor;
        // model.undo works without focus; an empty entry fires no content event, so report here.
        const undo = () => {
          if (!current().readOnly) void model.undo();
          reportHistory.current?.();
        };
        const redo = () => {
          if (!current().readOnly) void model.redo();
          reportHistory.current?.();
        };
        let history: EditorHistory | undefined;
        reportHistory.current = () => {
          const canUndo = !current().readOnly && model.canUndo();
          const canRedo = !current().readOnly && model.canRedo();
          if (history?.canUndo === canUndo && history.canRedo === canRedo) return;
          history = { canUndo, canRedo, undo, redo };
          current().onHistoryChange(history);
        };
        const subscription = model.onDidChangeContent(() => {
          current().onChange(model.getValue());
          reportHistory.current?.();
        });
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => current().onSave());
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyZ, undo);
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyZ, redo);
        cleanup = () => {
          instance.current = undefined;
          reportHistory.current = undefined;
          subscription.dispose();
          editor.dispose();
          model.dispose();
          current().onHistoryChange(undefined);
        };
        reportHistory.current();
        setLoadedUri(uri);
      })
      .catch((error: unknown) => {
        if (!disposed)
          setFailure({
            uri,
            message: errorMessage(error),
          });
      });
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [uri]);

  useEffect(() => {
    const editor = instance.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    const { source } = current();
    const change = editorChange(model.getValue(), source);
    if (!change && !external.changesBase) return;
    const selection = editor.getSelections();
    const view = editor.saveViewState();
    // Undo must not go back to a text that was based on another file hash.
    if (external.changesBase) model.setValue(source);
    else if (change) {
      const start = model.getPositionAt(change.start);
      const end = model.getPositionAt(change.end);
      const extendsLastEdit =
        external.group !== undefined &&
        lastExternal.current?.group === external.group &&
        lastExternal.current.versionId === model.getAlternativeVersionId();
      if (extendsLastEdit) editor.popUndoStop();
      else editor.pushUndoStop();
      editor.executeEdits("workflow", [
        {
          range: {
            startLineNumber: start.lineNumber,
            startColumn: start.column,
            endLineNumber: end.lineNumber,
            endColumn: end.column,
          },
          text: change.text,
        },
      ]);
      editor.pushUndoStop();
    }
    lastExternal.current = { group: external.group, versionId: model.getAlternativeVersionId() };
    if (view) editor.restoreViewState(view);
    if (selection) editor.setSelections(selection);
  }, [external, isReady]);

  useEffect(() => {
    instance.current?.updateOptions({ readOnly });
    reportHistory.current?.();
  }, [readOnly, isReady]);

  useEffect(() => {
    const model = instance.current?.getModel();
    if (!model) return;
    void import("./monaco").then(({ monaco }) => {
      if (model.isDisposed()) return;
      monaco.editor.setModelMarkers(
        model,
        "workflow",
        problems.map((problem) => {
          const start = model.validatePosition({
            lineNumber: problem.line,
            column: problem.column,
          });
          const end = model.validatePosition({
            lineNumber: problem.endLine,
            column: problem.endColumn,
          });
          return {
            severity: monaco.MarkerSeverity.Error,
            message: problem.message,
            startLineNumber: start.lineNumber,
            startColumn: start.column,
            endLineNumber: end.lineNumber,
            endColumn: start.equals(end)
              ? Math.min(start.column + 1, model.getLineMaxColumn(start.lineNumber))
              : end.column,
          };
        }),
      );
    });
  }, [problems, isReady]);

  useEffect(() => {
    const editor = instance.current;
    const model = editor?.getModel();
    if (!editor || !model || !reveal) return;
    const position = model.validatePosition({ lineNumber: reveal.line, column: reveal.column });
    editor.setPosition(position);
    editor.revealPositionInCenter(position);
    editor.focus();
  }, [reveal, isReady]);

  return (
    <div className="relative h-full min-h-80" aria-busy={!isReady && !loadError}>
      <div ref={container} className="absolute inset-0" />
      {!isReady && <p className="p-4 text-muted-foreground">{loadError ?? "Loading editor…"}</p>}
    </div>
  );
};
