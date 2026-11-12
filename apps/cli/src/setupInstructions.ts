const exampleConfig = `schema_version: 1
server: local
devcontainer: .devcontainer/devcontainer.json
setup:
  network: [registry.npmjs.org]
  run: pnpm install --frozen-lockfile
`;

const exampleWorkflow = `schema_version: 1
name: Issue to PR

inputs:
  issue_number: { type: number, required: true, description: The issue to implement }
  issue_title: { type: string, default: "" }
  issue_body: { type: string, default: "" }

# Only for a GitHub repo.
on:
  issues:
    types: [labeled]
    labels: [halinka]
    inputs:
      issue_number: \${{ event.issue.number }}
      issue_title: \${{ event.issue.title }}
      issue_body: \${{ event.issue.body ?? '' }}

branch:
  name: halinka/issue-\${{ inputs.issue_number }}

max_cost_usd: 5

steps:
  - id: fix_loop
    type: loop
    max_iterations: 3
    until: \${{ steps.code_review.outcome == 'approve' }}
    steps:
      - id: implement
        type: agent
        agent: claude-code
        prompt: |
          Implement issue #\${{ inputs.issue_number }}.
          Title: \${{ inputs.issue_title }}
          Text: \${{ inputs.issue_body }}
          Review findings: \${{ loop.previous.code_review.summary ?? 'none' }}
        gates:
          - name: tests
            run: pnpm test

      - id: code_review
        type: agent
        agent: claude-code
        permissions: { write: false }
        prompt: Review the branch diff against its base. Report only blocking issues.
        outcomes: [approve, changes_requested]

  - id: approve
    type: approval
    message: Review the diff of issue \${{ inputs.issue_number }}
    reviewers: [code_review]

  # Needs the GitHub App, or a gh login on the runner.
  - id: open_pr
    type: github
    action: open_pull_request
    title: \${{ inputs.issue_title }}
    body: \${{ steps.implement.summary }}
    closes: \${{ inputs.issue_number }}
`;

export const setupInstructions = `# Set up Halinka in this repo

You are a coding agent, and a person asked you to set up Halinka. Follow these steps in order. When a step says "Person", give the person
the exact link or command, stop, and continue when the person says that it is done.

## Rules

- Never read, print, ask for or receive the value of a secret. A person enters each key.
- Never give a key to a command through a pipe, an argument or a file.
- Do not read these files: logins.json, runner.json and master_key in $HALINKA_HOME (default ~/.halinka), the folder $HALINKA_HOME/logins,
  and the .env file of a server.
- These rules are not a technical limit. You run as the person, so you must obey them yourself.
- Do not write the URL of a private server, or another private name, in a file or a pull request of a public repo.
- Do not merge a pull request. Do not push to the default branch unless the person tells you to.
- Use only the fields in the examples below or the fields that the person gives you. Run \`npx halinka check\` after each change.

## 1. Ask the person two questions

1. Which server? "local": a server and a runner on this machine. Or the URL of a team server.
2. Does the repo stay on this machine, or does a team server read it from GitHub?

Then ask if runs may use a container. A run in a devcontainer needs Docker on the runner. A run in a worktree has no sandbox, so only use it
if the person accepts this. A run that GitHub starts always needs a container.

## 2. Write the files

Run \`npx halinka init --server <local|url> --devcontainer <path|create|none> --yes\`. The file with this value is committed, so a URL in it is
public in a public repo. For a GitHub repo, use \`--server local\`: only the CLI reads this value, and the server does not need it. Use the path of the existing devcontainer if the repo
has one. "create" writes a Node image, so for another language write a devcontainer with the tools from the CI of the repo. If you select
"none", the runner needs \`--runs-in worktree\`, or the runs stay in the queue.

Then change the files for this repo:

- Read the CI files and the package scripts. Use the same tool versions and the same test commands as CI. The gates must run in the image.
- In a container, a gate has no network, unless it says so. A command that needs a host must name it in \`network\`. A worktree run has no limit.
- \`setup.network\` applies to \`setup.run\` and to the lifecycle commands. Install scripts that download from other hosts fail. Add the host or
  turn off the scripts, if the gates do not need them.
- Docker inside the container does not work. Do not write a gate that needs it.
- Halinka refuses some devcontainer settings, for example \`privileged\` and the \`ports\` of a Compose file.

Example of .halinka/config.yml:

\`\`\`yaml
${exampleConfig}\`\`\`

Example of a file in .halinka/workflows/:

\`\`\`yaml
${exampleWorkflow}\`\`\`

## 3. Test the files

- Run \`npx halinka check\` until it passes. It checks only the files. It does not check keys, runners or secrets.
- If Docker is here, test in the image of the devcontainer, as the user of that image, because an image often has other tool versions than CI.
  Run \`setup.run\`, then run each gate. If a gate names no \`network\` and no Compose service, first disconnect the network of the container.
  Remove the container after the test.

## 4. Repo that stays on this machine

1. Commit the files after the person agrees. A run reads the devcontainer from a commit, not from the working tree.
2. Person: in a second terminal, keep one of these running. Do not start it yourself: it must continue after your command ends.
   - For the server "local", in this repo: \`npx halinka start\`. It prints its URL. Use that URL as <url> below.
   - For a team server: \`npx halinka login --server <url>\`, then \`npx halinka runner --server <url>\`. An Admin approves the code that it shows.

   Add \`--runs-in worktree\` to the command if you selected "none".
3. Person, for a run in a container: add a key of the agent in the portal, on the Agents page, or in a terminal:
   \`npx halinka agent key <agent> <variable> --server <url>\`, with \`--mine\` for a person who is not an Admin.
   \`npx halinka agent list --server <url>\` shows the variables of each agent.

   Person, for a run in a worktree: a key on the Agents page does not apply. Install the command of the agent on this machine, and log in with it.
4. Run \`npx halinka run smoke --server <url>\`. Exit code 0 means that the run passed. Then run a workflow that you wrote.

## 5. GitHub repo on a team server

The server reads workflows from the default branch, so no run can start before the merge. The next steps that \`init\` prints are for a local repo. Follow these steps in their place.

1. On a branch, commit the files and open a pull request.
2. Person: merge the pull request. Until then, setup is not finished.
3. Person, in the portal: log in, then create and install the GitHub App on the GitHub page (an Admin does this), then add the repo on the
   Repos page. A runner with Docker must be connected on the Runners page. Add a key of the agent on the Agents page.
4. Person: start the Smoke workflow in the portal, and tell you the result. A server behind Cloudflare Access refuses the CLI, so the portal
   is the way for that server.

## 6. Finish

Setup is finished only when a real run has passed. If a run fails, read the error on the run page, change the files and try again. A refused
host is normal in the first runs: add it to \`network\`. Tell the person what you changed, what passed, and what you did not test.
`;
