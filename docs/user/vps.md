# Run the server on a VPS

This guide runs the server, the portal and Postgres on one machine with Docker Compose. A runner can run on this machine
or on another machine: see [runners.md](runners.md). On one machine, a run that leaves its container can read the secrets
of the server, because a runner needs access to Docker.

## What you need

- A machine with Docker and Docker Compose.
- A host name, and a reverse proxy that serves it with TLS.
- A GitHub OAuth App. Set its callback URL to `https://<your host>/api/auth/callback/github`.

## Install

1. Clone this repository on the machine.
2. Copy `infrastructure/.env.template` to `infrastructure/.env`, and fill it in. The template explains each value.
3. Start the server:

   ```sh
   docker compose -f infrastructure/docker-compose.yml up -d --build
   ```

4. Open your host name, and log in as the GitHub user of `HALINKA_ADMIN_GITHUB`.

Keep a copy of `HALINKA_MASTER_KEY` outside the machine. Without it, the server cannot read the stored keys.

`docker inspect` and `docker compose config` show the password and the keys. Give access to Docker only to people who may
see them.

## The reverse proxy

Compose publishes the server on `127.0.0.1:7070` of the machine (`HALINKA_PORT` changes the port). The proxy must pass
WebSocket upgrades, because runners and `halinka ssh` use them. Caddy does this with no more settings:

```
halinka.example.com {
  reverse_proxy 127.0.0.1:7070
}
```

With nginx, add these lines to the `location`:

```
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
proxy_set_header X-Forwarded-For $remote_addr;
proxy_buffering off;
```

The run page gets live updates through server-sent events, and `proxy_buffering off` stops nginx from holding them.

### The address of the proxy

The server counts the rate limits per client address, and it reads the client address from `X-Forwarded-For` only for
a request from `HALINKA_TRUSTED_PROXY` ([overview.md](../architecture/overview.md#auth-and-roles)). A proxy on the
machine reaches the server through the gateway of the Compose network, and the Compose file fixes that network, so the
template value `172.30.0.1` is correct for such a proxy.

If `172.30.0.0/24` is in use on your machine, change the subnet in `docker-compose.yml` and the value in `.env`. If the
proxy is on another machine or in another container, set the address that the server sees for it.

If this value is wrong, all clients share one limit of 60 requests per minute, and logins and runners then fail with 429.

### A Cloudflare Tunnel in place of a proxy

A named Tunnel needs no open port. A Quick Tunnel does not support server-sent events: the run page then shows a change
only after a refresh.

1. Create a Tunnel in the Cloudflare dashboard, and add the token to `infrastructure/.env` as `TUNNEL_TOKEN`.
2. Start the connector on the machine, with the token from its environment and not on the command line:

   ```sh
   export TUNNEL_TOKEN=$(sed -n 's/^TUNNEL_TOKEN=//p' infrastructure/.env)
   docker run -d --name halinka-tunnel --restart unless-stopped --network host -e TUNNEL_TOKEN \
     cloudflare/cloudflared:latest tunnel --no-autoupdate run
   ```

3. On the **Routes** tab of the Tunnel, add a **Published application**: your host name, with the service URL
   `http://localhost:7070`.

Do not look up the host name before you add the route. A DNS server keeps the answer "no such name" for up to 30 minutes.

### Cloudflare Access in front of the portal

Access asks for a login before a person reaches the portal, so a stranger does not see the server. Keep the GitHub login:
the server uses it to know its members. Make two self-hosted applications:

| Application | Destinations | Policy |
|---|---|---|
| Portal | your host name | Allow: your email |
| Machines | `<host>/api/github/webhook` and `<host>/api/runner/*` | Bypass: everyone |

GitHub and runners cannot log in, so they use the second application. `halinka login`, `halinka run` and `halinka ssh`
from another machine stop at Access.

## Back up

Back up the database, and keep the backup outside the machine:

```sh
docker compose -f infrastructure/docker-compose.yml exec db pg_dump -U halinka halinka > halinka.sql
```

The `home_data` volume holds only the lock of the server and its URL, so it needs no backup.

Use named volumes, as the Compose file does. A folder that you mount at `/data` must belong to user 1000, or the server
cannot start.

## Upgrade

```sh
git pull
docker compose -f infrastructure/docker-compose.yml up -d --build
```

The server applies new database migrations when it starts. Back up the database first.

The Compose file fixes the major version of Postgres. To change that version, restore a dump into a new volume.
