# Portal

The pages of the web UI and the workflow editor. Read [overview.md](overview.md) first; the API is in
`packages/server/src/api/contract.ts`.

The portal (`apps/portal`) is a React app that the server serves. `router.tsx` lists the pages. Components come from
shadcn on Base UI (`@halinka/ui`).

## Layout

- `packages/ui/src/styles.css` is the theme of the VS Code preset, as the shadcn CLI writes it: the tokens in light and
  `.dark`, the Inter font and the radius scale. We add only the `success`, `warning` and `link` colors and `color-scheme`; add
  them again when the CLI writes the file again. `packages/ui/src/hooks/use-mobile.ts` is written by hand with
  `useSyncExternalStore` (the generated hook sets state in an effect and is `false` at the first render): write it again
  when the CLI writes the file again. `packages/ui/src/components/table.tsx` has `role` attributes on its parts and one
  `oxlint-disable` line for them: add them again when the CLI writes the file again. `components.json` in `packages/ui` and in `apps/portal` configure the
  CLI; run it from `apps/portal` (`npx shadcn@latest add <name>`).
- `apps/portal/src/index.css` holds only the CSS of the app.
- `layout.tsx` is the shell: the shadcn `Sidebar` (New run, the groups Home, Work, Settings and Team, and the user menu
  with the theme and Log out), and a top bar with the fold button and the breadcrumb. The sidebar folds to icons with
  ⌘B, and keeps that state in the cookie that the component writes. Below 768 px it is a sheet that the fold button
  opens, and each navigation closes it.
- The breadcrumb: `PageHeader` puts the name of the page in the top bar (`PageBreadcrumb`, a portal into the slot of
  the layout). The fixed parents of a detail page are `staticData.crumbs` of its route; a parent with a name from data
  (the repo of a workflow) comes from the page (`parentCrumbs`).
- `Page` and `PageHeader` give each page one width and one header. The workflow editor uses the full width and the
  full height of the window.
- `/` is Home: the inbox items with their forms, the active runs, the recent runs, the totals of the cost period, the
  runners and the setup problems (no repo, no connected runner, a workflow that is not valid). It reads the existing
  list endpoints. The nav starts with Home, then Inbox and Runs.
- Below `md` (a phone), a bottom tab bar (`MobileTabBar`: Home, Inbox, Runs, Menu) replaces the sidebar trigger, and
  Menu opens the sidebar sheet. Below `md`, a `Table` is a list: one CSS block in `index.css` restyles the table parts
  by their `data-slot`. A cell with `data-cell="title"`, `"status"` or `"menu"` is on the first line. A cell with
  `data-cell="meta"` is a muted line. A cell with a `data-label` shows the label before the value. The CSS hides an empty cell and shows each
  other cell as a full-width block. A row has at most one `title`, one `status` and one `menu` cell. A group heading is a `TableRow` with one `TableCell` in the
  `TableBody` of its group, because the CSS hides the `TableHeader` below `md`. These CSS blocks are
  not in a Tailwind layer, so a class on a cell does not change them below `md`. On a touch screen, one
  `@media (pointer: coarse)` rule makes a control at least 44 px high, a button at least 44 px wide, and the text of an
  input 16 px (a smaller text makes iOS zoom the page).
- Below `md`, the run page shows one pane: the step list with Details, or the selected step. A tap on a step pushes
  `?pane=step`, so the Back button of the phone goes to the step list. The Steps button goes back in the history, or
  replaces the URL when the run page is the first page of the tab. The hidden pane stays mounted (`max-md:hidden`),
  so the transcript and the message form keep their state. A switch moves the focus to the pane that opens: the Steps
  button, or the selected step.
- A `Panel` is the one surface of the content of a page: a `Card` with no padding (`data-slot="panel"`), and a 40 px
  header with the title, a count and at most one action. A list page whose page header names the list hides the panel
  header (`hasHeader={false}`); the title stays the name of the region. `isDestructive` gives the red ring and title.
  The body is a table, a list of rows, a `PanelBody` (16 px padding) or one `PanelEmpty` line. No panel goes in a
  panel, and a toolbar (search, filters) or the page header has no box. `index.css` gives a table in a panel 16 px at
  its outer cells, and on a phone 16 px at the sides of each row. The panes of the workflow editor have the same look
  by their classes, because they fill the height of the editor.
- A text link has the class `text-link hover:underline`. `--link` is the primary color in light, and a lighter blue in
  dark.
- A `PanelRow` puts the title and the description on the left and its button on the right, and wraps on a phone. A
  row of settings (Agents) has a fixed action column, so each button of a panel ends at the same right edge.
- A button that adds a thing has a plus icon, a GitHub link has the GitHub mark, and a destructive action has a trash
  icon. The icons come from `lucide-react`; the GitHub mark is our own SVG (`gitHubMark.tsx`), because Lucide has no
  brand icons.
- A destructive action of a page (Delete repo, Disconnect the App) is a `PanelRow` in a `DangerZone`, a
  destructive panel at the end of the page. The actions of a list row are in a `RowMenu` (a "⋯" menu). A row whose main
  action is a popover form (Set or Replace a key) keeps that button, because a popover opens at its button. A
  destructive action in a `DangerZone` or a `RowMenu` opens a `ConfirmDialog`.
- Overlays: a `FormPopover` creates a thing from one or two fields (New run, Add repo, Add member, New workflow, Add
  secret). A dialog holds a result that shows one time or a check before an action: Add runner and New key (the one-time
  command; an outside click does not close them, and Add runner locks its fields after Create the command) and Approve
  a runner. A sheet at the side edits a thing that exists: Edit runner.
- The GitHub page is one Setup panel with three steps: create the App, install it, link the repos. A step is done from
  the status of the server (an App, an installation, a linked repo), and the next step is open.
- Each form field goes through `FieldFrame` (label, description, issues) or `SelectField`. `FieldFrame` gives the `id` and
  `aria-invalid` to its control through a render prop, because the child can be a wrapper of the control. The `id` is
  the field name, with a prefix only when two forms of one page can have the same field name.

## Data

- A list that changes with no action of the person polls every 5 s: runs, runners, and the inbox (`statusPollMs`).
  The Runs page stops its poll after the first page, and `runs.totals` polls every 60 s.
- `runs.list` gives one page (50 runs, newest first) and `nextBeforeId`, the id to give as `beforeId` for the next page;
  `state` gives only the active or only the ended runs. The Runs page loads the pages with `useInfiniteQuery` and shows
  only the rows on screen with TanStack Virtual, measured against the scroll container of the layout
  (`ScrollContainerContext`); the next page loads when the last row comes into view. Home reads the active runs, the
  last 5 ended runs and `runs.totals` (the counts of the last 30 UTC days), not the whole list.
- Home shows two charts: the runs of each day of the period, stacked by result (`runs.totals.perDay`), and a donut of
  the cost by repo (`costs.list`, the 4 most expensive repos and "Other repos", `costSlicesOf`). The period of
  `runs.totals` is the last 30 UTC days, from the start of the oldest day, so its tiles and its bars count the same
  runs. Both charts load lazily, so Recharts is not in the main chunk.
- The run page streams its run with `watchRun`. Each `state` of the stream, and a read every 30 s, refresh the run and
  the inbox. Each run action of the server sends a `state`, so the run actions refresh no query.
- A mutation refreshes, with `useInvalidateQueries`, the queries of its page that no stream carries: for example
  `repos.list` after a delete, `inbox.list` after an answer on the inbox page, `runners.list` after a change of a
  runner. A query of another page loads again when that page opens.
- A form write is a mutation (`useSubmitMutation`), so a 401 ends the session as for each other mutation. The form then
  maps the error to its fields with `apiIssues` of `@halinka/server/client`, which the CLI also uses.
- The transcript of the chat adds each batch of the stream to one `Transcript`. Only the items that a batch changes
  are new objects.

## Repos

- `/repos/$repoId` lists the workflows of a repo. An Admin has "New workflow" on a `local` repo: it writes
  `newWorkflowSource` with no `hash`, so the file must not exist.
- `/workflows` lists the workflows of all repos, with search and a repo filter. A repo error does not hide the other
  results.
- Both lists show the first problem of a workflow and the count of the others (`repos.workflows`, parsed with
  `agentPresets`). The problem links to the editor at its line. `/repos/$repoId` also lists the problems of
  `.halinka/config.yml`, and Home names each repo with a config or workflow that is not valid.
- `repos.register` refuses a folder without `.halinka/config.yml` with `REPO_NOT_SET_UP` and its devcontainers. The
  portal then shows "Init and register": `repos.init` makes the runner write the files of `halinka init`, then registers
  the folder. A local runner gets `server: local`. A remote runner gets `HALINKA_PUBLIC_URL` on a server with a login,
  and the origin of the request otherwise.

## Workflow editor

`/repos/$repoId/workflows/$file` has the step list, the code and the Properties of the selected step. Container queries
in `index.css` select three columns, Steps/Code tabs next to Properties, or Steps/Code above Properties. Code and step
list stay mounted, so the selection and the undo history stay.

- The YAML source is the one document. Monaco edits the text. Properties and the step list edit YAML nodes through
  `editSteps` (`packages/workflow`), so comments and anchors stay. An edit that breaks an alias is refused.
- An external edit (Properties, a refetch) is one text replacement in Monaco's undo history. `external.revision` goes up
  only for those edits, so a late text callback cannot replace newer typing.
- Undo and Redo use Monaco's undo history for the code, the step list and Properties. The top bar has Undo and Redo
  buttons. Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z work on all of the editor page, but a text field outside the steps, the
  code and Properties keeps its own undo. Edits of one Properties field, one after
  another, are one undo entry: `external.group` reopens the last entry when the text did not change after it.
- `parseWorkflow` with `agentPresets` runs in the browser and shows syntax, schema, expression and agent problems as
  markers and in the Problems panel.
- `workflowCompletions` (`packages/workflow`) completes the keys and values that the JSON Schema of the zod schema
  allows at the cursor. The type of a step selects its keys.
- Show changes: a read-only diff of the draft against the file.
- `?line=` opens the Code tab at that line, also when only the line of the URL changes.
- A file without `schema_version` shows "Apply fixes": it puts the text of `migrateDefinition` in the draft. The notes
  of the migration stay until the draft is saved or discarded. The person checks the draft with Show changes, then
  saves or publishes it. The portal does not change `config.yml`: its problem names `halinka migrate --write`.
- Properties shows the fields that `formFieldsOf` (`packages/workflow`) lists for the type of the step. A short list
  per type selects the fields; the JSON Schema of the zod schema gives if a field is optional, a number, or a select
  with its values. Other fields stay in YAML. An empty optional field is removed.
- Step list (`WorkflowStepList`): the rows of the run page (`apps/portal/src/steps/`), with the type, the id, a detail,
  an `if` tag and the problem count. Loop children are indented under the loop. A `+` between two rows, Add step and
  Add child open the type picker in place; inside a loop it has no Loop. When the YAML has no valid structure, the list
  hides and the source stays editable.
- Save sends the base hash (`RunnerCommands.writeRepoFile`). A `CONFLICT` keeps the text. A pending save makes the
  editor read-only. Cmd/Ctrl+S uses the same guard.
- A `github` repo has Publish in place of Save ([github.md](github.md)). A draft that parses and is not stale has
  "Start test run" ([workflows.md](workflows.md#test-runs)).

## Drafts

- `WorkflowDraftStore` keeps one `localStorage` key per file: a JSON record `{ version: 1, draft }`, with the source,
  the base hash and the time of the draft. A record of another version is no draft. A draft equal to the file is
  removed. Drafts stay in the browser that wrote them.
- A reload restores the draft. A draft is stale when `baseHash` differs from the file hash: Discard draft, or Keep my
  draft, which moves `baseHash` to the file hash, so the next Save replaces the file.
- The write waits 300 ms after the last key; a page close writes at once. When the browser refuses the write, the
  editor keeps the text in memory and shows a notice. A draft older than 30 days is removed when the editor opens.
- Two tabs on one file share the key: the last write wins, and up to 300 ms of typing in the other tab can be lost.

## Run page

`/runs/$workflowRunId` shows one step at a time.

- The header has the run status and the run actions: Cancel, Push branch, Open PR, Delete run.
- "Needs attention", above the steps, shows the run error, the workspace error and the open inbox items of the run.
- The left column lists the step runs with the rows of the editor, then the steps that did not start. A status icon
  shows the status, and the row of an item in "Needs attention" has a warning tint. A loop has a tab per iteration,
  and only the shown iteration lists its step runs and the children that did not start. The tabs show the chosen
  iteration until a person selects a step, else the iteration of the selected step run, else the newest iteration
  that a reopen did not supersede (`shownIterationOf`). Under the list are the facts of the run and the workspace
  with its actions.
- The right column shows the selected step run: status, summary, outputs, closed inbox items, and the transcript of
  one attempt. A step run with more than one attempt shows a tab per attempt. With no selected tab, the panel shows
  the newest attempt, so it follows a new attempt. The message form shows under the transcript of the step run that
  takes a message.
- With no selection, the page shows the current step run (`currentStepRunIdOf`): the step run that takes a message,
  else the last running one, else the last failed or cancelled one, else the last one that is not superseded. A click
  on the current step, a reopen and a retry go back to no selection, so the page follows the run again. A selection
  ends when a reopen in another tab supersedes its step run.
- The transcript hides system events (`agent_session` and agent updates that are not text, a tool call or a plan)
  behind "Show system events". A tool call with output folds; it is open while it runs. The prompt folds.

## Packages

`monaco-editor` (source, markers), MIT. Monaco loads in its own chunk. It uses selected ESM features and a local Vite
worker, with no CDN.

`@tanstack/react-virtual`, MIT: the rows of the Runs page. The owner chose it.

`recharts`, MIT, through the shadcn `chart` component of `@halinka/ui` (a peer dependency there, so one copy): the
charts of Home, in a lazy chunk. The owner chose it.

## Limits

- No completion for the keys of a flow map, under `outputs` and `outcomes`, for an agent name, or in `${{ }}`.
- A raw YAML edit keeps the step selection only for step ids that are not ambiguous.
- On a phone, the tables and the padding of the pages do not fit the screen.
- Discard draft of a draft that is not stale is an undo entry, so Undo restores the draft. An edit that changes the base
  hash clears the undo history (`external.changesBase`): a refetch, an edit from another tab with another base hash,
  and Discard draft of a stale draft. Undo then cannot restore a text with a wrong base hash.
- Undo does not restore the step selection. A reload clears the undo history.

## Decisions

- The YAML source is the one document ([above](#workflow-editor)). Rejected:
  - serialize the parsed workflow: it removes comments and anchors.
  - a server endpoint that checks unsaved text: the parser runs in the browser.
  - one view only: users need all three.
  - a form list of all steps: the step list and Properties replace it.
- The editor and the run page list the steps with the same rows, and a loop on the run page has a tab per iteration.
  Rejected: a React Flow canvas (a workflow is a list of steps with loop groups, so a graph adds a package and shows
  nothing more); a vertical timeline, cards and numbered steps (mockups: less dense, or numbers that change on an
  insert); all iterations in the list (a long run makes a long list).
- Undo uses Monaco's undo history for all three views. Rejected: a separate snapshot stack (more code; Monaco's undo
  history already holds every edit).
- An edit that changes the base hash clears the undo history. Rejected: a base hash for each undo state (more code for
  rare edits).
- Undo and Redo call `model.undo()` and `model.redo()`. Rejected: `editor.trigger("undo")` (it acts only on the
  focused editor).
- Completion and the Properties fields from the JSON Schema of the workflow schema. Rejected: `monaco-yaml` (a new
  package, a second YAML worker and a second validator); hand-written key lists and field tables (they drift from the
  schema).
- The portal writes the `.halinka/` files of a folder whose registration is refused. Rejected: no Init for a remote
  runner (the person then needs a terminal on the runner); a flag in the folder list (a typed path still needs a
  request).
- The drafts read and write their JSON record directly. Rejected: `zustand` with `persist` (a package and a store for
  one record per file).
- A list polls, the run page streams, and a mutation refreshes only the queries of its page that no stream carries.
  Rejected: a refresh of the run, the run list and the inbox after each run action (the stream already sends each
  change); no refresh of a polled list after a change on its own page (the change shows up to 5 s late).
- The run page is a timeline: a step list on the left and one selected step on the right. Rejected: a table of steps
  over one transcript of all steps (the owner could not see which events belong to which step, or what to do next); a
  pipeline graph (wide with many steps); chat first (the results and the actions are less visible); a summary dashboard
  (a live agent needs a tab switch); a split view with the files of the workspace (needs a new API).
- A step run with more than one attempt shows one tab per attempt, with the shadcn Tabs of `@halinka/ui`. Rejected:
  one transcript with an "Attempt N" line between the attempts (a retry after a gate failure makes it long, and the
  last attempt is at the end); a duration on the tab (the portal has no duration format yet).
- The components of `@halinka/ui` merge their classes with `cn` (the `cn` package, which replaces `clsx` and
  `tailwind-merge`), so a link styled with `buttonVariants` gets the same classes as `Button`. Rejected: a border color in each variant only (the next class that the base and a variant both
  set breaks the links again).
- GitHub stays in the Settings group of the nav until a second integration comes; then an "Integrations" group holds
  both. Rejected: an "Integrations" group now (one item only); one Integrations page with sections (one section only).
- The portal uses the VS Code preset of shadcn/ui (`b5KIRX8HQ`), installed with the shadcn CLI and used as it is: the
  `base-mira` style on Base UI, zinc, blue, Inter, radius 0. Only `success`, `warning` and `link` are our own, because the
  preset has no status colors and its dark primary is too dark for a text link. Rejected: a lighter primary color for the
  links (the buttons then change too). Rejected: the current styles (each page has its own layout); token values copied by hand, with our
  own contrast fixes (the owner wants the preset as it is); `radix-mira` (the preset's default primitives are Base UI).
- The components in `packages/ui/src/components` are the files that `shadcn add` writes, in its file names and code
  form, so `shadcn add --overwrite` updates them. A change to one is a small addition (the `success` and `warning`
  variants of the badge). Rejected: rename and rewrite them to the conventions of the repo (each update is then a
  manual merge).
- Dark mode is the `.dark` class of the preset. `ThemeStore` sets it from Light, Dark or System (the default), saved
  in `localStorage`, and a script in `index.html` sets it before the first paint. Rejected: only
  `prefers-color-scheme` (no switch).
- The shell is the shadcn `sidebar` component. Rejected: keep the hand-made nav (no fold, no sheet on a phone).
- The breadcrumb takes the fixed parents from `staticData` of the route, and the name of the page from `PageHeader`.
  Rejected: route loaders that load the names (the pages load their data, and loaders are a second way); parent links
  above the title in each page (not the design). A crumb is a path string: a typed `LinkOptions` in `staticData` makes
  a type cycle with the router.
- A Home page is the first page: the items that need the person, the active runs, the recent runs and the totals.
  Rejected: this feed in the Inbox (the Inbox then holds more than the items that wait for a person); a Table and Feed
  switch on Runs (two views of the same data, and the feed repeats the Inbox).
- Runs is one table with status tabs and filters. Rejected: a feed of runs (Home has it).
- The Inbox shows one card per item, with its decision form. Rejected: a list with a detail pane (the owner chose the
  cards).
- The workflow editor stays an outline with Properties, and the run inputs move to the Run dialog. Rejected: a
  vertical flow of step cards (the same reason as the React Flow canvas above).
- Workflows is one table, grouped by repo. Rejected: cards (a different pattern from Runs and Repos).
- The diff of the approval step comes from the runner, as a git diff in the workspace. When the workspace is removed,
  the step says so and links the pull request. Rejected: the compare view of GitHub (no diff for a local repo, or
  before a push).
- Search uses an endpoint on the server over runs, workflows and repos. Rejected: a search in the browser over the
  loaded lists (it misses the runs that are not loaded).
- A page adds an item with a button in the page header (New run, Add runner, Approve a runner, Add repo, Add member).
  `/runners/approve?code=` redirects to `/runners?approve=CODE`, and the URL is the only state of the approve dialog, so
  the link of `halinka runner` keeps working. Rejected: a form under the list (each page puts it in another place); a
  separate page (the approve page).
- The Agents page shows one compact panel per agent, two side by side: a line per setting (keys, version, default
  model, test), and each change opens a popover at its button. Rejected: a card with a section per setting (about
  700 px per agent); one table with an open row; a list of agents with tabs.
- The actions of a list row go in one `RowMenu`. A destructive action of a page goes in a `DangerZone` at the end of
  the page. Both open a plain `ConfirmDialog`. Rejected: buttons in each row (the row is too wide, mostly on a phone);
  a dialog in which the person types the name (one more step, and a self-hosted server has few people); a `RowMenu`
  for the destructive item only, with Edit, New key and Drain as buttons (two patterns in one row).
- A phone shows each `Table` as a list through CSS on the same markup. `table.tsx` has explicit `role` attributes, so
  Safari keeps the table semantics. Rejected: a second list markup on each page (two markups that must agree, and a
  second set of e2e locators); one shared component with a column definition for each page (a later item adds a page
  pattern for lists, and the cells contain forms and popovers).
- A phone shows a bottom tab bar with Home, Inbox, Runs and Menu. Menu opens the sidebar sheet. Rejected: only the
  sidebar sheet (two taps to open the pages that a person uses most).
- Each group of content on a page is a `Panel` with one header shape, and a control shows only when it does a real
  action of its page. The rules and the boards are in the canvas
  "Halinka Portal Unify". Rejected: a mix of cards, plain sections and
  boxed toolbars (each page looked different); a call to action with no real action (for example New run in an empty
  panel).
- The kind of overlay follows the work: a popover creates a thing from one or two fields, a dialog holds a confirm or a
  result that shows one time (the command of Add runner), a sheet at the side edits a thing that exists (Edit runner),
  and a page holds long work. A form never opens inside a table row. Rejected: a popover for every form (an edit with several fields is cramped, and an outside click loses the one-time
  command); a dialog for every edit (it hides the list).
- An agent has one Test row for the keys that the runs of the person use: the own keys when the person has a stored
  key (also an unreadable one, the rule of the server), else the team keys (an Admin only). An Admin with an own key
  gets a second row, Team test, because the members without a key use the team keys (`agentTestRowsOf`). Rejected: a
  Test row and a Your test row for each person (two rows for one question).
- The charts count UTC days. The owner left the choice open. Rejected for now: a time zone setting of the server (a
  setting and a check of the zone name; it is in the task file); the time zone of the browser (each person sees other
  days, and a budget cannot use it).
- The run list has pages on the server, and the Runs page loads them as the person scrolls, with a virtual list.
  Rejected: only a virtual list (each poll still sends every run); only a "Load more" button (more clicks for a
  long history).
- Charts use the shadcn `chart` component (Recharts). Rejected: hand-made SVG charts (more code for axes, tooltips and
  the legend, and a second style).
- On a phone, the open pane of the run page is a search param of the run route (`pane=step`). Rejected: `useState`
  (the Back button of the phone then leaves the run page); the selected step run in `pin` (a tap on the current step
  clears `pin`).
