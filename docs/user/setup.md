# Set up a repo

This guide ends with a run that passed. For a team server, install it first: [Run the server on a VPS](vps.md). For a
server on this machine, this guide tells you when to start it.

## Select a path

| | Repo on this machine | GitHub repo on a team server |
| --- | --- | --- |
| Where the repo is | A checkout on a runner | On GitHub. The server reads it through the GitHub App. |
| Where workflows come from | The working tree of the checkout | The tip of the default branch |
| `server` in `.halinka/config.yml` | `local`, or the URL of the team server | `local` |
| Where a run executes | A devcontainer, or a worktree with no sandbox | A devcontainer. A run that a person starts can also use a worktree. |
| What starts a run | A person, in the portal or with `halinka run` | A person in the portal, or GitHub: a label, a comment or a pull request |

A run in a worktree executes on the runner with no sandbox. Use it only for a repo and a workflow that you trust. A run
that GitHub starts always executes in a devcontainer.

## Get the command

Halinka needs Node.js 24.20 or later. This guide writes `halinka` for `npx halinka`. Install the package globally
(`npm install -g halinka`) if you use `halinka ssh` ([runners.md](runners.md#halinka-ssh)).

## Write the files

The files are in `.halinka/`. Commit them with the repo. Select one of the two ways:

- **With a coding agent.** Tell your coding agent: "Run `npx halinka setup` and follow it." The agent asks which server
  you use, where the repo is, and if runs may use a container. Then it writes the files, tests them, and stops at each
  step that a person must do. You enter each key. The agent must not see a key.
- **By hand.** In the repo, run `halinka init`. It writes `.halinka/config.yml`, `.halinka/workflows/smoke.yml` and,
  with `--devcontainer create`, a devcontainer with a Node image. For a GitHub repo, use `--server local`.

Then change the files for your repo:

- For a run in a devcontainer, add `setup.run` to `config.yml`. It installs the packages before the steps. Use the
  commands and tool versions of your CI. A run in a worktree does not execute `setup.run`.
- In a devcontainer, a command has no network unless it names its hosts in `network`. `setup.network` applies to
  `setup.run`.
- Give each workflow gates that run the tests of your repo, for example `pnpm test`.

Run `halinka check` after each change. It checks the files with the parsers of the installed version. It does not check
keys, runners or secrets. Read [devcontainers.md](devcontainers.md) for what the image needs.

## Give the agents a key

A run in a devcontainer gets the key of its agent from the server. The value never goes into the devcontainer: a proxy
adds it to each request. The smoke workflow uses `claude-code`.

- In the portal, open the Agents page. An Admin adds the key under "Team keys". On a server with a login, each person
  can also add their own key under "Your keys".
- In a terminal: `halinka agent key <agent> <variable> --server <url>`. Add `--mine` for your own key. On a server
  with a login, run `halinka login --server <url>` first. `halinka agent list --server <url>` shows the variables of
  each agent. The command reads the value from stdin, or asks for it. Never write a key in an argument.
- A run uses the keys of the person who started it. If that person has no key of the agent, the run uses the keys of
  the team.
- `claude-code` and `codex` use different keys. A workflow that uses both needs both keys.
- For Codex, a ChatGPT login can replace the key: `halinka agent login codex` on the machine of the runner.
- "Run a test" on the Agents page asks the agent for a one-word reply on a runner. It costs a small amount.

A run in a worktree does not use these keys. Install the command of the agent on the runner, and log in with it.

## Repo on this machine

1. Commit the files. A run reads the devcontainer from a commit, not from the working tree.
2. Keep a server and a runner running, in a second terminal:
   - For `local`: if a server from the README runs on this machine, keep it. Else run `halinka start` in the repo. It
     prints the URL of the portal. This machine can run only one server.
   - For a team server: `halinka login --server <url>`, then `halinka runner --server <url>`. An Admin approves the
     code that the runner shows. Read [runners.md](runners.md).

   If the repo has no devcontainer, start the runner with `--runs-in worktree`.
3. Add a key of the agent, as [Give the agents a key](#give-the-agents-a-key) tells.
4. Run the smoke workflow: `halinka run smoke --server <url>`. Exit code 0 means that the run passed.
   - `halinka run` registers the repo on the server. Only an Admin can register a repo. For a person who is not an
     Admin, an Admin registers it on the Repos page: click "Add repo", open the tab "A folder on a runner", select the
     runner, enter the "Repo path", and click "Register".
   - You can also start a run in the portal: open the repo, open the workflow, and click "Start run".

## GitHub repo on a team server

The server reads `.halinka/` from the default branch. No run can start before the files are on that branch.

1. Put the files on a branch, and open a pull request. Merge it.
2. An Admin connects GitHub on the GitHub page of the portal:
   1. Under "Create the GitHub App", select who owns the App. For an organization, enter its name. You must be an
      owner of that organization.
   2. Click "Create the App on GitHub". GitHub asks you to confirm, then returns you to the portal.
   3. Click "Connect the App". GitHub opens its install page. Select the account and the repos that Halinka may use.
3. On the Repos page, an Admin clicks "Add repo", opens the tab "GitHub", selects the repo under "GitHub repo", and
   clicks "Add GitHub repo".
4. Connect a runner with Docker, and allow the agents of your workflows on it. Read [runners.md](runners.md).
5. Add a key of the agent, as [Give the agents a key](#give-the-agents-a-key) tells.
6. In the portal, open the repo, open the smoke workflow, and click "Start run". The setup is done when this run
   passes.

On a server with a login, each person who starts runs must be a member. An Admin adds people by GitHub name on the
Members page, with "Add member".

A server on a local host (`localhost`, `127.0.0.1`) gets an App with no webhook. GitHub starts no runs on that server:
start each run in the portal.

## Start runs from GitHub

Two examples are ready to copy into `.halinka/workflows/`:

- [issue-to-pr.yml](../examples/issue-to-pr.yml): the label `halinka` on an issue, or a comment on an issue that starts
  with `/halinka`, starts a run. An agent implements the issue, a second agent reviews the diff, a person approves, and
  Halinka opens a pull request.
- [pr-review.yml](../examples/pr-review.yml): each pull request from a branch of this repo into the default branch gets
  a review. A new push cancels the older review.

Change the gate commands to the tests of your repo. [reference.yml](../examples/reference.yml) shows each key of a
workflow.

Only a member can start a run from GitHub. Halinka maps the GitHub user who caused the event to a member: the person
who added the label, wrote the comment, or opened or pushed to the pull request. The run uses the keys of that member,
else the keys of the team. A bot and a person who is not a member start nothing. A pull request from a fork starts
nothing.

A run that GitHub starts is untrusted, because anyone can write the text of an issue or a pull request:

- The run always executes in a devcontainer.
- Halinka marks the text of the event as data in the prompt. The text can still change what the agent does. Read the
  issue before you add the label or write the comment.
- At an approval, read the diff itself. The review of an agent and its notes help, but they do not replace your review.
- Keep `labels` and `starts_with` narrow. A label or a comment spends a key with no further step in Halinka.

## When a run fails

- Open the run in the portal. The run page shows the error of the run, and the summary and the transcript of each
  step.
- Halinka refuses a host that a command needs and does not name. This is normal in the first runs: add the host to
  `network`. Commit the change. For a GitHub repo, merge it into the default branch.
- The refusal of a devcontainer setting names that setting. Read [devcontainers.md](devcontainers.md).
- A run that stays in the queue has a reason on the run. For example: no runner allows the agent, or no runner with a
  devcontainer is connected for a run that GitHub starts.
- Run `halinka check` after each change of the files.
