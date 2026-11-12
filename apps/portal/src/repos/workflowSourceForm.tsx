import { Button } from "@halinka/ui/components/button";
import type { Problem } from "@halinka/workflow";
import { useState } from "react";

import { CodeDiff } from "../codeDiff";
import {
  CodeEditor,
  type EditorHistory,
  type EditorLocation,
  type ExternalEdit,
} from "../codeEditor";

export type WorkflowSourceFormProps = {
  source: string;
  fileSource: string;
  uri: string;
  external: ExternalEdit;
  problems: Problem[];
  readOnly: boolean;
  onChange: (source: string) => void;
  onSave: () => void;
  onHistoryChange: (history: EditorHistory | undefined) => void;
  revealLine?: number;
};

export const WorkflowSourceForm = (props: WorkflowSourceFormProps) => {
  const { problems, fileSource, revealLine, ...editor } = props;
  const [reveal, setReveal] = useState<EditorLocation | undefined>(
    revealLine ? { line: revealLine, column: 1 } : undefined,
  );
  const [shownLine, setShownLine] = useState(revealLine);
  const [isShowingChanges, setIsShowingChanges] = useState(false);
  const hasChanges = editor.source !== fileSource;
  if (revealLine !== shownLine) {
    setShownLine(revealLine);
    if (revealLine) setReveal({ line: revealLine, column: 1 });
  }
  if (isShowingChanges && !hasChanges) setIsShowingChanges(false);

  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-card ring-1 ring-foreground/10"
      aria-label="YAML editor"
    >
      <div className="flex items-center justify-between gap-3 min-h-10 border-b px-4 py-1">
        <h2 className="text-sm font-semibold">Workflow source</h2>
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            aria-pressed={isShowingChanges}
            disabled={!hasChanges}
            onClick={() => setIsShowingChanges(!isShowingChanges)}
          >
            {isShowingChanges ? "Hide changes" : "Show changes"}
          </Button>
          <span className="font-mono text-xs text-muted-foreground">YAML</span>
        </div>
      </div>
      <div className={isShowingChanges ? "hidden" : "min-h-80 flex-1"}>
        <CodeEditor key={editor.uri} {...editor} problems={problems} reveal={reveal} />
      </div>
      {isShowingChanges && (
        <div className="min-h-80 flex-1" role="region" aria-label="Changes of the draft">
          <CodeDiff original={fileSource} modified={editor.source} />
        </div>
      )}
      <div
        className="max-h-44 shrink-0 overflow-auto border-t border-border bg-muted/20"
        aria-label="Workflow problems"
        role="region"
      >
        <div className="flex items-center justify-between px-4 py-2.5">
          <span className="font-medium">Problems</span>
          <span className={problems.length ? "text-destructive" : "text-success"}>
            {problems.length
              ? `${problems.length} ${problems.length === 1 ? "error" : "errors"}`
              : "No problems"}
          </span>
        </div>
        {problems.length > 0 && (
          <ul className="px-2 pb-2">
            {problems.map((problem, index) => (
              <li key={index}>
                <Button
                  variant="outline"
                  className="h-auto w-full justify-start gap-3 border-transparent px-2 py-1.5 text-left font-normal whitespace-normal"
                  onClick={() => {
                    setIsShowingChanges(false);
                    setReveal({ line: problem.line, column: problem.column });
                  }}
                >
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">
                    {problem.line}:{problem.column}
                  </span>
                  <span className="text-destructive">{problem.message}</span>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
};
