# A secret for the server without a login

Without the login variables, every request acts as an Admin, and the server checks only the `Host` header
([overview.md](../architecture/overview.md#auth-and-roles)). Another OS user on the machine can open `127.0.0.1:7070`,
read the folders of the owner, start runs on the owner's runner, and approve a runner of its own that then gets the team
agent keys. This matters when `halinka start` runs on a machine with other users, or with a container on the host
network.

## Nice to have

- At each start, write a random token to a `0600` file in `HALINKA_HOME`. `/api/*` and the runner socket refuse a
  request without it.
- The CLI reads the file. The runner of `halinka start` gets the token in the process.
- The portal gets the token once: `halinka start` prints a URL with a one-time code, and the server answers with an
  `HttpOnly` cookie. Decide how `halinka open` gives that URL again.
- Rejected: a Unix socket with a peer check (a browser cannot open it).
