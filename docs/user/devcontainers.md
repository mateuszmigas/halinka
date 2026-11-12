# Devcontainers

A run in a devcontainer builds the devcontainer file that the `devcontainer` path of `.halinka/config.yml` names.
Halinka refuses a setting that can change the machine of the runner, and the refusal names it. The full list is in [sandbox.md](../architecture/sandbox.md#checks-before-up). The common ones:

- In `devcontainer.json`: `initializeCommand`, `privileged`, `runArgs` other than `--init` and the value flags `--env`,
  `--label`, `--hostname`, `--shm-size`, `--ulimit`, `--tmpfs`, `--add-host`, `--cap-drop`, `--user`, `--workdir` and
  `--platform` (a reserved label and an `--add-host` that reaches the host are refused), and a mount that is not a bind
  inside the workspace or a `tmpfs`.
- In a Compose file: `ports`, `devices`, `include`, `extends.file`, the host's `network_mode`, and a named volume
  outside the project.

## What the image needs

- `sh`, `setsid`, `kill`, and a writable `/tmp`
- git
- node 20 or later, for a run with agents. Halinka installs the agent adapters when the image lacks them.

## Network

A command reaches only the hosts that it names: `setup.network` in `.halinka/config.yml` for the setup, `network` on a
step. An agent always reaches its provider. A private address needs `--reach` on the runner
([sandbox.md](../architecture/sandbox.md#network)).

## Docker in the container

A step that needs Docker (Testcontainers, `docker build`, `docker compose` in a test) needs `setup.docker: true` in
`.halinka/config.yml` and a Linux runner with [Sysbox](https://github.com/nestybox/sysbox) and `--docker-in-container`
([runners.md](runners.md#docker-in-the-container)). Until such a runner connects, the run waits.

- The image must hold Docker Engine: `dockerd`, `docker`, `containerd`, `runc` and `iptables`. Do not start a daemon in
  the image or with the `docker-in-docker` Feature, which Halinka refuses: Halinka starts `dockerd`.
- Only the remote user can use Docker: a shell step, a gate and `setup.run`. The agent cannot.
- A pull reaches the hosts of the command that runs it. For Docker Hub, add `registry-1.docker.io`, `auth.docker.io` and
  `production.cloudfront.docker.com` (the layers, on 2026-11-08) to the `network` of the step or to `setup.network`.
  The pull error does not show which host the proxy refused. A lifecycle command cannot pull.
- An inner container has no network out. After each command, Halinka removes all inner containers.

## Features

Halinka accepts Features only from `ghcr.io/devcontainers/features/` and from the publishers of `--trust-features`.

- For a private publisher, run `docker login` as the user of the runner first.
- A registry whose token service is on another host, such as a self-hosted GitLab registry, does not work yet.
- A registry with a private CA does not work yet.

## Build caches

`RUN --mount=type=cache` in a Dockerfile shares a cache across the builds on one runner.

For the runner setup, read [runners.md](runners.md).
