# Docker inside the container

Docker inside the container is built ([sandbox.md](../architecture/sandbox.md#docker-inside-the-container)). The tests
ran on Ubuntu 24.04 arm64 with Sysbox 0.7.1 and Docker 29.9.

## Checks

- A Compose project whose devcontainer service gets `runtime: sysbox-runc`. The Docker tests use an image config.
- amd64 and Ubuntu 26.04. The install of Sysbox restarts Docker, so a test on a shared host needs a time when no
  container runs.

## Nice to have

- Network for an inner container: an inner container does not resolve `halinka-proxy` (the inner daemon drops the
  resolver `127.0.0.11`), and has no token. An option: the client config `proxies` of the remote user with the address
  of the proxy and the token of the command.
- An inner service that stays after `setup.run` for the steps. Today the runner removes all inner containers after each
  command of the remote user.
