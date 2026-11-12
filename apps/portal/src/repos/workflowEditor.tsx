import { type AgentPresetId, agentPresets } from "@halinka/presets";
import { Button } from "@halinka/ui/components/button";
import {
  editSteps,
  isAddStep,
  migrateDefinition,
  parseWorkflow,
  type Problem,
  type StepEdit,
} from "@halinka/workflow";
import { useForm, useStore } from "@tanstack/react-form";
import { Redo2Icon, Undo2Icon } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import type { EditorHistory } from "../codeEditor";
import { formatDateTime } from "../formatDateTime";
import { FormIssues } from "../formIssues";
import { FormShell } from "../formShell";
import { useIsAdmin } from "../login/useIsAdmin";
import { RunWorkflowForm } from "../runs/runWorkflowForm";
import { PublishDraftButton } from "./publishDraftButton";
import { useBindUndoKeys } from "./useBindUndoKeys";
import { useEditWorkflowDraft } from "./useEditWorkflowDraft";
import { useWriteWorkflow } from "./useWriteWorkflow";
import { workflowGraph } from "./workflowGraph";
import { WorkflowSourceForm } from "./workflowSourceForm";
import { WorkflowStepList } from "./workflowStepList";
import { WorkflowSteps } from "./workflowSteps";

const defaultAgent: AgentPresetId = "claude-code";
const noProblems: Problem[] = [];
const fieldGroupOf = (edit: StepEdit) =>
  "value" in edit ? JSON.stringify({ ...edit, value: undefined }) : undefined;

const migrationOf = (path: string, source: string) => {
  try {
    const migration = migrateDefinition(path, source);
    return migration.changes.length > 0 ? migration : undefined;
  } catch {
    return undefined;
  }
};

export type WorkflowEditorProps = {
  repoId: number;
  path: string;
  source: string;
  hash: string;
  isOnGitHub: boolean;
  revealLine?: number;
};

export const WorkflowEditor = (props: WorkflowEditorProps) => {
  const { repoId, path, source, hash, isOnGitHub, revealLine } = props;
  const writeWorkflow = useWriteWorkflow(repoId);
  const isAdmin = useIsAdmin();
  const canSave = isAdmin && !isOnGitHub;
  const draft = useEditWorkflowDraft(repoId, path, { source, hash });
  const [graph, setGraph] = useState(() => workflowGraph(draft.source));
  const [selected, setSelected] = useState<string>();
  const [view, setView] = useState<"steps" | "code">(revealLine ? "code" : "steps");
  const [shownLine, setShownLine] = useState(revealLine);
  const [appliedNotes, setAppliedNotes] = useState<string[]>([]);
  const [editIssue, setEditIssue] = useState<string>();
  const [history, setHistory] = useState<EditorHistory>();
  const workspace = useRef<HTMLDivElement>(null);
  const form = useForm({
    validators: {
      onSubmitAsync: async () => {
        const input = { workflow: path, source: draft.source, hash: draft.baseHash };
        const { errors, written } = await writeWorkflow(input, []);
        if (errors) return errors;
        draft.saved({ source: draft.source, hash: written.hash });
        return undefined;
      },
    },
  });
  const isSubmitting = useStore(form.store, (state) => state.isSubmitting);
  const parsed = useMemo(
    () => parseWorkflow(draft.source, { agents: agentPresets }),
    [draft.source],
  );
  const problems = parsed.ok ? noProblems : parsed.problems;
  const hasVersionProblem =
    !parsed.ok && parsed.problems.some(({ path }) => path[0] === "schema_version");
  const migration = useMemo(
    () => (hasVersionProblem ? migrationOf(path, draft.source) : undefined),
    [hasVersionProblem, path, draft.source],
  );
  const lastStep = canSave ? "save it" : isOnGitHub ? "publish it" : "ask an Admin to save it";
  useBindUndoKeys(workspace, history);

  if (graph.source !== draft.source) setGraph(workflowGraph(draft.source, graph));
  if (revealLine !== shownLine) {
    setShownLine(revealLine);
    if (revealLine) setView("code");
  }
  const selection = graph.isReadable
    ? graph.entries.find((entry) => entry.key === selected)
    : undefined;
  const siblingCount = graph.entries.filter((entry) => entry.parent === selection?.parent).length;

  const clearIssues = () => {
    setEditIssue(undefined);
    form.setErrorMap({ onSubmit: undefined });
  };
  const thenClearIssues =
    <Args extends unknown[]>(action: (...args: Args) => void) =>
    (...args: Args) => {
      action(...args);
      clearIssues();
    };
  const changeSteps = (edit: StepEdit) => {
    const result = editSteps(draft.source, edit);
    if (!result.ok) {
      setEditIssue(result.problems.join(" "));
      return;
    }
    const edited =
      "index" in edit
        ? graph.entries.find((entry) => entry.index === edit.index && entry.parent === edit.parent)
        : undefined;
    const identity =
      edited && edit.type !== "delete"
        ? {
            key: edited.key,
            index: edit.type === "move" ? edit.to : edited.index,
            parent: edited.parent,
          }
        : undefined;
    const next = workflowGraph(result.value, graph, identity);
    setGraph(next);
    draft.replace(result.value, fieldGroupOf(edit));
    clearIssues();
    const address = isAddStep(edit)
      ? {
          index: edit.at ?? graph.entries.filter((entry) => entry.parent === edit.parent).length,
          parent: edit.parent,
        }
      : edit.type === "move"
        ? { index: edit.to, parent: edit.parent }
        : undefined;
    const changed = address
      ? next.entries.find(
          (entry) => entry.index === address.index && entry.parent === address.parent,
        )
      : undefined;
    if (changed) setSelected(changed.key);
    if (edit.type === "delete") setSelected(undefined);
  };

  const save = () => {
    if (!canSave || form.state.isSubmitting || draft.isSaved) return;
    void form.handleSubmit();
  };

  return (
    <div className="flex flex-1 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${draft.isSaved ? "bg-success" : "bg-primary"}`} />
          <span className="font-medium">
            {isSubmitting ? "Saving…" : draft.isSaved ? "All changes saved" : "Unsaved changes"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            aria-label="Undo"
            title="Undo"
            onClick={history?.undo}
            disabled={!history?.canUndo}
          >
            <Undo2Icon className="size-4" />
          </Button>
          <Button
            variant="outline"
            aria-label="Redo"
            title="Redo"
            onClick={history?.redo}
            disabled={!history?.canRedo}
          >
            <Redo2Icon className="size-4" />
          </Button>
          {!draft.isStale && parsed.ok && (
            <RunWorkflowForm
              key={`${draft.baseHash}:${JSON.stringify(parsed.value.inputs ?? {})}`}
              repoId={repoId}
              path={path}
              inputs={parsed.value.inputs ?? {}}
              draft={draft.isSaved ? undefined : { source: draft.source, baseHash: draft.baseHash }}
            />
          )}
          {!draft.isSaved && (
            <Button
              variant="outline"
              onClick={thenClearIssues(draft.discard)}
              disabled={isSubmitting}
            >
              Discard draft
            </Button>
          )}
          {isOnGitHub ? (
            !draft.isSaved &&
            !draft.isStale &&
            parsed.ok && (
              <PublishDraftButton
                repoId={repoId}
                path={path}
                source={draft.source}
                baseHash={draft.baseHash}
              />
            )
          ) : isAdmin ? (
            <Button onClick={save} disabled={draft.isSaved || isSubmitting}>
              Save
            </Button>
          ) : (
            <span className="text-muted-foreground">Only an Admin can save a workflow.</span>
          )}
        </div>
      </div>
      {draft.isStale && (
        <div className="flex flex-wrap items-center justify-between gap-3 bg-card px-4 py-3 ring-1 ring-foreground/10">
          <span>
            The file changed after you started this draft.{" "}
            {canSave
              ? "To replace the file with your draft, click Keep my draft, then Save."
              : "To continue with your draft, click Keep my draft."}{" "}
            To use the changed file, click Discard draft.
          </span>
          <Button
            variant="outline"
            onClick={thenClearIssues(draft.keepMine)}
            disabled={isSubmitting}
          >
            Keep my draft
          </Button>
        </div>
      )}
      {migration && (
        <div className="flex flex-wrap items-center justify-between gap-3 bg-card px-4 py-3 ring-1 ring-foreground/10">
          <div>
            <p>
              This file is from an older Halinka. Click Apply fixes to update the draft to the
              current schema. Check it with Show changes on the Code tab, then {lastStep}.
            </p>
            {migration.notes.map((note) => (
              <p key={note} className="text-muted-foreground">
                {note}
              </p>
            ))}
          </div>
          <Button
            variant="outline"
            onClick={thenClearIssues(() => {
              draft.replace(migration.source);
              setAppliedNotes(migration.notes);
            })}
            disabled={isSubmitting}
          >
            Apply fixes
          </Button>
        </div>
      )}
      {!migration && !draft.isSaved && appliedNotes.length > 0 && (
        <div className="bg-card px-4 py-3 ring-1 ring-foreground/10">
          <p>Before you {lastStep}:</p>
          {appliedNotes.map((note) => (
            <p key={note} className="text-muted-foreground">
              {note}
            </p>
          ))}
        </div>
      )}
      {!draft.isStale && draft.restored && !draft.isSaved && (
        <p className="text-muted-foreground">
          The editor shows your draft from {formatDateTime(draft.restored.updatedAt)}.
        </p>
      )}
      {!draft.isStored && !draft.isSaved && (
        <p className="text-destructive">
          The browser cannot store your draft.
          {canSave && " Save the file to keep your draft."}
        </p>
      )}
      <FormShell form={form} canSubmitOnEnter={canSave} className="flex-1">
        {editIssue && <FormIssues issues={[{ message: editIssue }]} />}
        <div ref={workspace} className="workflow-workspace">
          <div className="workflow-view-tabs" role="tablist" aria-label="Workflow view">
            <Button
              role="tab"
              aria-selected={view === "steps"}
              aria-controls="workflow-steps"
              variant={view === "steps" ? "default" : "outline"}
              onClick={() => setView("steps")}
            >
              Steps
            </Button>
            <Button
              role="tab"
              aria-selected={view === "code"}
              aria-controls="workflow-code"
              variant={view === "code" ? "default" : "outline"}
              onClick={() => setView("code")}
            >
              Code
            </Button>
          </div>
          <div className="workflow-workspace-grid">
            <div
              id="workflow-steps"
              className="workflow-steps min-h-0 min-w-0"
              data-active={view === "steps"}
            >
              <WorkflowStepList
                graph={graph}
                selected={selected}
                problems={problems}
                readOnly={isSubmitting}
                onSelect={setSelected}
                onInsert={(type, at, parent) =>
                  changeSteps(
                    type === "agent"
                      ? { type: "add_agent", agent: defaultAgent, at, parent }
                      : { type: `add_${type}`, at, parent },
                  )
                }
              />
            </div>
            <div
              id="workflow-code"
              className="workflow-code min-h-0 min-w-0"
              data-active={view === "code"}
            >
              <WorkflowSourceForm
                source={draft.source}
                fileSource={draft.fileSource}
                external={draft.external}
                uri={`halinka://repos/${repoId}/${encodeURIComponent(path)}`}
                problems={problems}
                readOnly={isSubmitting}
                onChange={thenClearIssues(draft.change)}
                onSave={save}
                onHistoryChange={setHistory}
                revealLine={revealLine}
              />
            </div>
            <div className="workflow-properties min-h-0 min-w-0">
              <WorkflowSteps
                step={selection?.step}
                index={selection?.index ?? 0}
                parent={selection?.parent}
                count={siblingCount}
                problems={problems}
                onChange={changeSteps}
              />
            </div>
          </div>
        </div>
      </FormShell>
    </div>
  );
};
