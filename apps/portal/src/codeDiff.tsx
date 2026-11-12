import { errorMessage } from "@halinka/utils/errors";
import type { editor } from "monaco-editor";
import { useEffect, useEffectEvent, useRef, useState } from "react";

export type CodeDiffProps = {
  original: string;
  modified: string;
};

export const CodeDiff = (props: CodeDiffProps) => {
  const { original, modified } = props;
  const container = useRef<HTMLDivElement>(null);
  const models = useRef<editor.IDiffEditorModel>(undefined);
  const current = useEffectEvent(() => props);
  const [isReady, setIsReady] = useState(false);
  const [loadError, setLoadError] = useState<string>();

  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;
    void import("./monaco")
      .then(({ monaco, editorOptions }) => {
        if (disposed || !container.current) return;
        const model = {
          original: monaco.editor.createModel(current().original, "yaml"),
          modified: monaco.editor.createModel(current().modified, "yaml"),
        };
        const diff = monaco.editor.createDiffEditor(container.current, {
          ...editorOptions,
          readOnly: true,
        });
        diff.setModel(model);
        models.current = model;
        cleanup = () => {
          models.current = undefined;
          diff.dispose();
          model.original.dispose();
          model.modified.dispose();
        };
        setIsReady(true);
      })
      .catch((error: unknown) => {
        if (!disposed) setLoadError(errorMessage(error));
      });
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, []);

  useEffect(() => {
    models.current?.original.setValue(original);
  }, [original]);

  useEffect(() => {
    models.current?.modified.setValue(modified);
  }, [modified]);

  return (
    <div className="relative h-full min-h-80" aria-busy={!isReady && !loadError}>
      <div ref={container} className="absolute inset-0" />
      {!isReady && <p className="p-4 text-muted-foreground">{loadError ?? "Loading changes…"}</p>}
    </div>
  );
};
