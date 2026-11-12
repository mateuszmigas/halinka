# Add a runner

A runner is a machine that executes runs. It connects to the server, and it needs no open port.

## What a runner needs

- Node 24.20 or later with npm, and git.
- Docker, for runs in a devcontainer. See [devcontainers.md](devcontainers.md).
- On Linux, systemd for the service. On another system, run the runner in a terminal.

## Install as a service (Linux)

```sh
npx halinka runner install --server https://halinka.example.com
```

Run it as the user of the runner, in a terminal of a normal login (not `su` or `sudo`). It:

1. Downloads the package of the server, checks its sha512 and installs it in `$HALINKA_HOME/versions`. The server
   must run from its Docker image, which holds that package.
2. Enrolls the runner in this terminal (see Register below).
3. Writes the systemd user unit `halinka-runner-<id>`, turns on linger, so that the runner starts after a reboot with
   no login, and starts it.
4. Writes `~/.local/bin/halinka`, the command of the installed version, for `halinka ssh` and `halinka agent login`.

The unit copies only the `PATH` and the Docker variables of the install shell; it also gets the environment of the
systemd user manager. Put agent keys on the server, and set a proxy for the user manager:
`systemctl --user set-environment HTTPS_PROXY=...`. Run `install` again to install the current build of the server,
to change the flags, or after an install that failed (the old unit stays stopped).

```sh
halinka runner status      # the unit, its version and its last log lines
halinka runner uninstall   # stops and deletes the unit; keeps runner.json and the versions
journalctl --user -u halinka-runner-<id> -f
```

When the server refuses the runner for good (revoked, another server, not enrolled, another protocol version), the
unit stops and does not start again. Repair the cause, then run `install` again.

## Update

A runner of the service installs the build of its server by itself, at its start:

- **Update** on the Runners page: the runner takes no new runs, waits for the runs it holds (also the runs that wait
  for a person), then starts again with the build of the server. **Interrupt and update** stops its runs at once: they
  go back to the queue, an approval stays open, and an agent question closes and the agent asks again.
- **Auto-update** on the Runners page: the same, each time the server has another build. **Cancel update** ends a
  request and turns auto-update off.
- After an update of the server to another protocol version, the runner updates at its next start.

The Runners page shows the version of each runner, "out of date", "updating" with the runs it waits for, and the reason
of a failed update. After two failed tries of one build, the runner keeps its version: run `install` again. To keep
a machine from running new code by itself, install it with `--no-self-update`, and run `install` for each update.

## Run in a terminal

`halinka runner` runs the runner in this terminal, until Ctrl+C. It does not update itself: after the server changes
its protocol version, it stops with exit code 75, and you install the version of the server.

## Register

```sh
halinka runner --server https://halinka.example.com
```

The first start shows a code and a link. An Admin opens the link, sets the name, the labels and the allowed agents, and
approves. Approve only a code that your own terminal shows. Later starts use the saved key in `$HALINKA_HOME/runner.json`.
Without a person at the portal, give a one-time token from Settings → Runners in `HALINKA_ENROLL_TOKEN` or with
`--enroll-stdin`.

Use the exact address of `HALINKA_PUBLIC_URL`. The server refuses a runner that connects with another address, such as an
internal one.

The flags (`--runs-in`, `--capacity`, `--reach`, `--trust-features`, `--docker-in-container`, `--memory`, `--cpus`,
`--root`) are in [cli.md](../architecture/cli.md#halinka-runner).

## Docker in the container

For repos with `setup.docker: true` ([devcontainers.md](devcontainers.md#docker-in-the-container)):

1. On a Linux host with rootful Docker and systemd, install the `.deb` of [Sysbox](https://github.com/nestybox/sysbox/releases).
   Its install restarts Docker, which stops all containers.
2. Check that `docker info` lists the runtime `sysbox-runc`.
3. Start the runner with `--docker-in-container`.

Docker Desktop and rootless Docker have no Sysbox. Without the runtime, the runner prints a warning, and the runs that ask
for Docker wait.

## Docker networks

A running sandbox holds at least 2 Docker networks, and a stopped sandbox holds none. The default settings of Docker give
about 30 networks, so about 14 runs at one time fill them. A new run then fails with
`all predefined address pools have been fully subnetted`.

On a runner with many runs at one time, give Docker more networks in `/etc/docker/daemon.json`, with a range that your
network does not use:

```json
{ "default-address-pools": [{ "base": "10.200.0.0/16", "size": 24 }] }
```

Then run `sudo systemctl restart docker`. The restart stops the running containers, so do it when no run is active.

## Logins of agents

A runner keeps its logins in `$HALINKA_HOME/logins`. Keep that folder on the runner, and do not delete it.

`halinka agent login codex` needs the `codex` command on the runner. The container runs the Codex that its adapter holds,
not the Codex of the runner.

## Files of an old server

`halinka runner` and `halinka start` print the id of the server. The runner keeps the files of that server in
`workspaces/<id>` and `github/<id>` of `$HALINKA_HOME`. A new database has a new id, and the folders of the old id stay.
Do not delete the folders of a server that you still use. Two servers that use one checkout need different `branch.name`
values in their workflows.

The names of Docker resources hold a hash of the real path of the workspaces folder. To find what an old server left,
and then remove it (use your `$HALINKA_HOME` if you set one):

```
hash=$(printf %s "$(realpath "$HOME/.halinka/workspaces/<id>")" | shasum -a 256 | cut -c1-12)
docker ps -a --filter "name=halinka-run-$hash"
docker network ls --filter "name=halinka-run-$hash"
```

## `halinka ssh`

Install the package globally if you use `halinka ssh`:

```sh
npm install --global halinka
```

`halinka ssh config` writes the path of the running file. With `npx`, that path is in a cache that npm can remove.
