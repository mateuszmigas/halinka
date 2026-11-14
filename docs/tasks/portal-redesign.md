# Portal redesign

Apply the design of the canvas "Halinka UI Redesign" to
`apps/portal` and `@halinka/ui`, and add the new features of the mockups. The decisions are in
[portal.md](../architecture/portal.md#decisions). Done: the VS Code preset in `base-mira`, the theme switch, Home, Add
repo, Add runner, Approve a runner, the New run popover, the shell (sidebar, top bar, breadcrumb), the row menus, the
Danger zone, the panels and overlays of the canvas
"Halinka Portal Unify", and the phone layout (390 px). Do one item
per step.

## Nice to have

- A Member who opens an admin page (`/server`, `/github`) sees "Loading…" for about 7 s before "Only an Admin can do
  this". `FORBIDDEN` of the `admin` middleware is not a declared error, so the retry rule of `main.tsx` asks 4 times.
  Do not retry `FORBIDDEN`, as for `UNAUTHORIZED`.

- Run list paging, from the review:
  - The Runs page polls only while one page is loaded, because each poll reads every loaded page again. A person
    who scrolled sees no new runs. Add a `changedSince` input (by `updated_at`) and merge its runs into the loaded
    pages, so all pages stay current with one small request.
  - Status tabs, filters and charts need counts that `runs.totals` cannot give (all time, per status, per day, the
    filter of the list). Give `runs.list` and one counts endpoint one filter schema, and return `{ status, count }`
    rows with an optional group by day (`runs.totals` gives the 30 days of Home only).
  - An e2e test that scrolls past the first page (more than 50 runs). Nobody checked it by hand yet.
  - Home shows the 5 newest ended runs by id and then sorts them by end time, so an older run that ends now can be
    missing from Recent runs. Give `runs.list` an order by end time for `state: "ended"` (a second cursor).
- Charts, from the review:
  - The day of the charts is a UTC day. In another time zone the newest bar shows the next or the previous day for a
    part of the day. Ask the owner: a server setting for the time zone (one day for the team, also for budgets), or
    the time zone of the browser.
  - A chart chunk that fails to load (an open tab after a deploy) goes to the error page of the router and hides all
    of Home. Add an error boundary around the lazy charts.
  - The Cost tile and the cost donut count a rolling 30 × 24 h of attempts (`listCostTotals`); the run tiles count 30
    UTC days. Give the cost the same period, with the Costs page item (7, 30 or 90 days).
- The rest of the panel rule, from the review of the unify pass:
  - The run page: `RunInboxItem` is a card inside the "Selected step" panel and the surface of "Needs attention".
    Give both one panel look.
  - The workflow editor: the stale-draft and migration notices are boxes with the panel classes. Decide on one
    notice part.
  - Agents: the key and test tables are raw `<table>` elements, so the panel and phone rules do not apply.
  - GitHub: the repo-links table in step 3 gets the 16 px outer cells of a panel table inside the step indent.
  - Workflows: the repo heading row is a plain cell; a `th scope="rowgroup"` connects it to its rows (check the
    phone CSS).
  - GitHub: an App whose key is not readable shows step 1 as done; while the repos load the header shows the last
    step for a moment.
  - Runners: check where the focus goes after the sheet or the New key dialog closes (they open from a menu item).
    The approve dialog mounts its panel again as empty during the close animation (`key={code}`).
- JetBrains Mono for code, as a new package.
- The page patterns as components: list, detail, settings section, and a centered confirm card (login, terminal login,
  GitHub App connect). Then move each page to its pattern, one page per step. Give the text link one component:
  12 places repeat `text-link hover:underline`. Write the `data-cell` kinds of the phone lists once,
  as one `as const` array with a typed prop: 11 tables repeat the strings now.
- A link that opens one step of a run (Home, an inbox item, a notification): `?pane=step` does not name the step, so a
  reload or a shared link shows the current step. Put the step run id in the URL. The Steps button goes back in the
  history when it can (`useSwitchPane`), because no link opens `?pane=step` now; such a link must replace the URL
  there instead.
- Home: the step of an active run (it needs `runs.get` for each run), and a relative time format ("4 min ago").
- Runs: one table with status tabs (with counts), search, and repo and workflow filters. On a phone a run row is
  already 6 lines; Duration and Trigger make it 8. Ask the owner: keep the tall rows, put the `meta` cells on one
  wrapping line, or hide some cells on a phone. The Duration and Trigger
  columns: a duration format for the portal, and the trigger of a run in the API (the run list has none). The sidebar
  and the workflow pages also open the New run popover.
- Run page: three panes (steps, the selected step, details). The approval form and the error summary show in the center
  pane. Run again opens the New run popover with the repo, the workflow and the inputs of the run (check that `runs.get`
  gives the inputs). Retry step stays.
- The diff in the approval step: the changed files of the run branch against its base, and the diff of one file with
  `codeDiff.tsx`. The runner gives the diff from the workspace. When the workspace is removed, the step says so and
  links the pull request.
- Inbox: one card per item, with its decision form, and a Done section.
- Workflow editor: the outline and Properties, the run inputs in the Run popover,
  and the draft states (Discard draft, Publish to a draft pull request, a stale draft, Show changes, Apply fixes with
  the notes of the migration). The lists show the first problem of each workflow and the problems of `config.yml`.
- Runners: the update controls.
- Costs: the tiles, a bar chart of the cost per day by repo, and a 7, 30 or 90 day switch. The API must give the cost
  per day. A chart package is its own proposal.
- Search and ⌘K: a Search button in the sidebar, and a command palette for runs, workflows, repos and pages, with a search endpoint on the server. A package
  (for example `cmdk`) is its own proposal.
