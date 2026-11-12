# The server on Cloudflare

Run the server on Cloudflare after the server on the homelab has run for a while. Runners stay in the homelab and
connect outbound with each option. Codex and Fable compared the options on 2026-11-04 from the code and the Cloudflare
docs, with no deployment, so the sizes are estimates.

| Option | Code | Size | Result |
|---|---|---|---|
| Cloudflare Containers with the image of today | Worker with a `Container` class, a read of the client address, hosted Postgres | 2 to 6 days | The server runs on Cloudflare, about $12 per month on the `basic` instance |
| A normal Linux server behind a named Tunnel | A `cloudflared` service in Compose, no code | 1 to 3 days | Cloudflare gives the host name and TLS, and you keep the machine |
| Workers with one Durable Object | A new runner transport, relays, timers, database client and delivery path | 15 to 30 days | Rejected: a rewrite with no benefit that we can measure |

Codex recommends Containers, because the owner wants the server on Cloudflare. Fable recommends the Tunnel until a need
appears: with all runners in the homelab, a server on Cloudflare keeps only the portal and the webhooks up when the
homelab is down. Fable selects Containers if webhooks must not be lost. Do no preparation in the code before this task: no seam helps either option.

## To do

- The owner selects an option.
- Hosted Postgres 15 or later ([overview.md](../architecture/overview.md)). Use a direct connection if possible. A
  transaction pooler is safe for the locks, because the code uses only transaction locks. Turn off the read cache of
  Hyperdrive: lease checks must not read old rows.
- Move the data: stop the old server (two servers must not run on one database) after the runs finish or are cancelled.
  `pg_dump`, then restore into an empty database, which keeps the server id and the runner keys. Keep
  `HALINKA_MASTER_KEY`, or the stored agent keys, repo secrets and the key of the App become unreadable. Keep the host
  name, or the runner URL, the OAuth callback and the webhook URL of the App change. Each due schedule fires once after
  the start ([workflows.md](../architecture/workflows.md)); a delivery during the outage needs "Redeliver" at GitHub.

## Checks

For Containers:

- A container sleeps when its Durable Object is idle, and the sweep and the schedules then stop. It needs a request
  each minute from a Cron Trigger, or another way to stay up. Test that schedules fire with no connected runner.
- The disk is lost at each restart. With `DATABASE_URL`, the server keeps only its lock and URL on the disk.
- A restart can move the container to another location, so measure the database latency. `sync` runs about 10 to 20
  statements per runner every 5 s, against a lease of 30 s.
- `rateLimiter.ts` needs the address from Cloudflare, because the peer of the container is not a known address.
- `halinka ssh` through `Container.fetch`.
