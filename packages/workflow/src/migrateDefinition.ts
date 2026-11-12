import {
  isMap,
  isScalar,
  isSeq,
  LineCounter,
  type Pair,
  parseDocument,
  Scalar,
  visit,
  type YAMLMap,
} from "yaml";
import { findPair } from "yaml/util";

import { conditionSourceOf } from "./expressions";
import { isRepoConfig } from "./parseDefinition";
import { nodeRange } from "./parseYaml";

// The rules below migrate the schema before `schema_version` to this version.
const legacyTargetVersion = 1;

const legacyMaxIterations = 5;

const networkNote =
  "A step reaches no network now unless it names the hosts in network. Add network to each step that needs it.";

const templatePattern = /\$\{\{[\s\S]*?\}\}/g;

const stringLiteralPattern = /('[^']*')/;

const blockScalarTypes: (string | undefined)[] = [Scalar.BLOCK_LITERAL, Scalar.BLOCK_FOLDED];

const quotedScalarTypes: (string | undefined)[] = [Scalar.QUOTE_DOUBLE, Scalar.QUOTE_SINGLE];

const pullRequestFields = ["title", "body", "draft"];

export type MigrationChange = { line: number; message: string };

// `changes`: the lines are those of the old source; `notes`: advice for the whole file
export type Migration = { source: string; changes: MigrationChange[]; notes: string[] };

type Edit = { start: number; end: number; text: string; order: number };

type KeyPair = Pair<Scalar, unknown>;

const pairOf = (map: YAMLMap, key: string) =>
  findPair<Scalar, unknown>(map.items as KeyPair[], key);

const renameInExpression = (expression: string) =>
  expression
    .split(stringLiteralPattern)
    .map((part, index) =>
      index % 2 === 1 ? part : part.replace(/\bstartsWith\(/g, "starts_with("),
    )
    .join("");

const renameInTemplate = (text: string) => text.replace(templatePattern, renameInExpression);

const isInside = (edit: Edit, start: number, end: number) =>
  edit.start >= start &&
  edit.end <= end &&
  !(edit.start === edit.end && (edit.start === start || edit.start === end));

// Edits text ranges, so unchanged lines keep their format and comments.
class SourceMigration {
  readonly document;
  readonly newline;
  private readonly lineCounter = new LineCounter();
  private readonly changes: MigrationChange[] = [];
  private edits: Edit[] = [];

  constructor(private readonly source: string) {
    this.document = parseDocument(source, { lineCounter: this.lineCounter });
    this.newline = source.includes("\r\n") ? "\r\n" : "\n";
  }

  change(node: unknown, message: string) {
    this.changes.push({ line: this.lineCounter.linePos(nodeRange(node)[0]).line, message });
  }

  columnOf(node: unknown) {
    return this.lineCounter.linePos(nodeRange(node)[0]).col - 1;
  }

  indentOf(node: unknown) {
    const start = nodeRange(node)[0];
    return " ".repeat(this.source.slice(this.lineStart(start), start).replace("\uFEFF", "").length);
  }

  // The text of the node, with the edits inside it that were added before.
  takeText(node: unknown) {
    const [start, end] = nodeRange(node);
    return this.takeRange(start, end);
  }

  replace(node: unknown, text: string) {
    const [start, end] = nodeRange(node);
    this.addEdit(start, end, text);
  }

  insert(offset: number, text: string) {
    this.addEdit(offset, offset, text);
  }

  insertLineAfter(pair: KeyPair, text: string) {
    this.insert(this.pairLines(pair)[1], `${text}${this.newline}`);
  }

  deletePair(pair: KeyPair) {
    const [start, end] = this.pairLines(pair);
    this.addEdit(start, end + this.joinedIndent(pair, end), "");
  }

  // Writes the pairs of a block map value one level up, in place of the key.
  unwrapPair(pair: KeyPair, children: YAMLMap) {
    const [start, end] = this.pairLines(pair);
    const keyLineEnd = this.lineEnd(nodeRange(pair.key)[1]);
    const extra = this.columnOf(children.items[0]?.key) - this.columnOf(pair.key);
    const body = this.takeRange(keyLineEnd, end).replace(new RegExp(`^ {0,${extra}}`, "gm"), "");
    const text = this.isFirstOnLine(pair) ? body : body.trimStart();
    this.addEdit(start, end, text);
  }

  migratedSource() {
    const fromTheEnd = [...this.edits].sort(
      (a, b) => b.start - a.start || b.end - a.end || b.order - a.order,
    );
    fromTheEnd.forEach((edit, index) => {
      const next = fromTheEnd[index + 1];
      if (next && next.end > edit.start && next.start < edit.start) {
        throw new Error("Two edits of the migration overlap");
      }
    });
    return fromTheEnd.reduce(
      (text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end),
      this.source,
    );
  }

  sortedChanges() {
    return [...this.changes].sort((a, b) => a.line - b.line);
  }

  private addEdit(start: number, end: number, text: string) {
    this.edits.push({ start, end, text, order: this.edits.length });
  }

  private takeRange(start: number, end: number) {
    const inside = this.edits.filter((edit) => isInside(edit, start, end));
    this.edits = this.edits.filter((edit) => !inside.includes(edit));
    return inside
      .sort((a, b) => b.start - a.start || b.end - a.end || b.order - a.order)
      .reduce(
        (text, edit) =>
          text.slice(0, edit.start - start) + edit.text + text.slice(edit.end - start),
        this.source.slice(start, end),
      );
  }

  private lineStart(offset: number) {
    return offset - this.lineCounter.linePos(offset).col + 1;
  }

  private lineEnd(offset: number) {
    const lineEnd = this.source.indexOf("\n", offset);
    return lineEnd === -1 ? this.source.length : lineEnd + 1;
  }

  private isFirstOnLine(pair: KeyPair) {
    const keyStart = nodeRange(pair.key)[0];
    return this.source.slice(this.lineStart(keyStart), keyStart).trim() === "";
  }

  // A pair after `- ` keeps the `- `, and the next line moves up to it.
  private joinedIndent(pair: KeyPair, end: number) {
    if (this.isFirstOnLine(pair)) return 0;
    return /^ */.exec(this.source.slice(end))?.[0].length ?? 0;
  }

  private pairLines(pair: KeyPair): [number, number] {
    const keyStart = nodeRange(pair.key)[0];
    const start = this.isFirstOnLine(pair) ? this.lineStart(keyStart) : keyStart;
    const last = Math.max(nodeRange(pair.key)[1], nodeRange(pair.value)[1]) - 1;
    return [start, this.lineEnd(last)];
  }
}

const wrappedCondition = (node: Scalar, text: string) => {
  if (quotedScalarTypes.includes(node.type)) {
    return `${text.slice(0, 1)}\${{ ${renameInExpression(text.slice(1, -1))} }}${text.slice(-1)}`;
  }
  if (!blockScalarTypes.includes(node.type)) return `\${{ ${renameInExpression(text)} }}`;
  const headerEnd = text.indexOf("\n") + 1;
  const first = headerEnd + (/^\s*/.exec(text.slice(headerEnd))?.[0].length ?? 0);
  const last = text.trimEnd().length;
  const expression = renameInExpression(text.slice(first, last));
  return `${text.slice(0, first)}\${{ ${expression} }}${text.slice(last)}`;
};

const migrateCondition = (step: YAMLMap, key: string, migration: SourceMigration) => {
  const node = step.get(key, true);
  if (!isScalar(node) || typeof node.value !== "string") return;
  if (conditionSourceOf(node.value) !== undefined) return;
  migration.replace(node, wrappedCondition(node, migration.takeText(node)));
  migration.change(node, `Wrote ${key} as \${{ ... }}`);
};

const migrateLoop = (step: YAMLMap, migration: SourceMigration) => {
  migrateCondition(step, "until", migration);
  const type = pairOf(step, "type");
  if (!step.has("max_iterations") && type) {
    const indent = migration.indentOf(type.key);
    migration.insertLineAfter(type, `${indent}max_iterations: ${legacyMaxIterations}`);
    migration.change(step, `Added max_iterations: ${legacyMaxIterations}, the old default`);
  }
  const onExhausted = pairOf(step, "on_exhausted");
  if (onExhausted && isScalar(onExhausted.value) && onExhausted.value.value === "fail") {
    migration.deletePair(onExhausted);
    migration.change(
      onExhausted.key,
      "Deleted on_exhausted: fail. A loop fails at max_iterations.",
    );
  }
};

const migrateGitHubStep = (step: YAMLMap, migration: SourceMigration) => {
  const fields = pairOf(step, "with");
  const values = fields?.value;
  if (!fields || !isMap(values) || values.flow || step.has("title") || step.has("body")) return;
  const pairs = values.items as KeyPair[];
  const draft = pairOf(values, "draft");
  const isMovable =
    pairs.every(({ key }) => pullRequestFields.includes(String(key.value))) &&
    (!draft || (isScalar(draft.value) && draft.value.value === false));
  if (!isMovable || pairs.length === 0) return;
  if (draft) {
    migration.deletePair(draft);
    migration.change(draft.key, "Deleted with.draft: false");
  }
  for (const { key } of pairs) {
    if (key !== draft?.key) migration.change(key, `Moved with.${String(key.value)} to the step`);
  }
  migration.unwrapPair(fields, values);
};

const migrateStep = (step: unknown, migration: SourceMigration) => {
  if (!isMap(step) || step.flow) return;
  migrateCondition(step, "if", migration);
  const type = step.get("type");
  if (type === "github") migrateGitHubStep(step, migration);
  if (type !== "loop") return;
  migrateLoop(step, migration);
  const children = step.get("steps", true);
  if (isSeq(children)) {
    for (const child of children.items) migrateStep(child, migration);
  }
};

const migrateLegacyFunctions = (migration: SourceMigration) => {
  visit(migration.document, {
    Scalar: (_, node) => {
      if (typeof node.value !== "string" || !node.value.includes("${{")) return;
      const text = migration.takeText(node);
      const renamed = renameInTemplate(text);
      if (renamed === text) return;
      migration.replace(node, renamed);
      migration.change(node, "Renamed startsWith to starts_with");
    },
  });
};

const migrateLegacyWorkflow = (root: YAMLMap, migration: SourceMigration) => {
  migrateLegacyFunctions(migration);
  const environment = pairOf(root, "environment");
  if (environment) {
    migration.deletePair(environment);
    migration.change(environment.key, "Deleted environment. config.yml names the devcontainer.");
  }
  const runsOn = root.get("runs-on", true);
  if (isScalar(runsOn) && !blockScalarTypes.includes(runsOn.type)) {
    migration.replace(runsOn, `[${migration.takeText(runsOn)}]`);
    migration.change(runsOn, "Wrote runs-on as a list");
  }
  const steps = root.get("steps", true);
  if (isSeq(steps)) {
    for (const step of steps.items) migrateStep(step, migration);
  }
};

const migrateLegacyConfig = (root: YAMLMap, migration: SourceMigration) => {
  const environments = pairOf(root, "environments");
  if (!environments || !isMap(environments.value) || environments.value.items.length !== 1) {
    return;
  }
  const { key: name, value: environment } = environments.value.items[0] as KeyPair;
  if (!isMap(environment)) return;
  const devcontainer = environment.get("devcontainer", true);
  if (environment.get("sandbox") !== "host" && isScalar(devcontainer)) {
    const indent = migration.indentOf(environments.key);
    migration.insertLineAfter(
      environments,
      `${indent}devcontainer: ${migration.takeText(devcontainer)}`,
    );
    migration.change(
      environments.key,
      `Moved environments.${String(name.value)}.devcontainer to devcontainer`,
    );
  } else {
    migration.change(environments.key, "Deleted environments. The runner selects the sandbox.");
  }
  migration.deletePair(environments);
};

export const migrateDefinition = (path: string, source: string): Migration => {
  const isConfig = isRepoConfig(path);
  const migration = new SourceMigration(source);
  const { document, newline } = migration;
  const root = document.contents;
  const first = isMap(root) ? (root.items[0] as KeyPair | undefined) : undefined;
  if (document.errors.length > 0 || !isMap(root) || !first || root.has("schema_version")) {
    return { source, changes: [], notes: [] };
  }
  const version = `schema_version: ${legacyTargetVersion}`;
  if (root.flow) {
    migration.insert(nodeRange(root)[0] + 1, `${version}, `);
  } else {
    const indent = migration.indentOf(first.key);
    migration.insert(nodeRange(first.key)[0], `${version}${newline}${indent}`);
    if (isConfig) migrateLegacyConfig(root, migration);
    else migrateLegacyWorkflow(root, migration);
  }
  migration.change(first.key, `Added ${version}`);
  const notes = isConfig ? [] : [networkNote];
  return { source: migration.migratedSource(), changes: migration.sortedChanges(), notes };
};
