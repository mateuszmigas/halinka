import { workflowCompletions } from "@halinka/workflow";
import * as monaco from "monaco-editor/editor/editor.api.js";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import "monaco-editor/editor/browser/coreCommands.js";
import "monaco-editor/editor/contrib/clipboard/browser/clipboard.js";
import "monaco-editor/editor/contrib/wordOperations/browser/wordOperations.js";
import "monaco-editor/editor/contrib/find/browser/findController.js";
import "monaco-editor/editor/contrib/folding/browser/folding.js";
import "monaco-editor/editor/contrib/hover/browser/hoverContribution.js";
import "monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js";
import "monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter.js";
import "monaco-editor/editor/contrib/gotoError/browser/gotoError.js";
import "monaco-editor/editor/contrib/suggest/browser/suggestController.js";
import "monaco-editor/languages/definitions/yaml/register.js";

import { themeStore } from "./theme";

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

const applyTheme = () => monaco.editor.setTheme(themeStore.isDark ? "vs-dark" : "vs");
themeStore.subscribe(applyTheme);
applyTheme();

export const editorOptions = {
  automaticLayout: true,
  fontSize: 13,
  fontFamily: "Menlo, Monaco, monospace",
  lineNumbersMinChars: 3,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  wordWrap: "on",
} satisfies monaco.editor.IEditorOptions;

monaco.languages.registerCompletionItemProvider("yaml", {
  triggerCharacters: [" "],
  provideCompletionItems: (model, position) => {
    const { start, end, items } = workflowCompletions(
      model.getValue(),
      model.getOffsetAt(position),
    );
    const range = monaco.Range.fromPositions(model.getPositionAt(start), model.getPositionAt(end));
    return {
      suggestions: items.map(({ label, insertText, kind }) => ({
        label,
        insertText,
        range,
        kind:
          kind === "key"
            ? monaco.languages.CompletionItemKind.Property
            : monaco.languages.CompletionItemKind.Value,
      })),
    };
  },
});

export { monaco };
