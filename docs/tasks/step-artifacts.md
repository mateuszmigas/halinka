# Step artifacts

A step declares files of its workspace (a test report, screenshots, a plan) that the run keeps after the workspace TTL
of 24 h ([runners.md](../architecture/runners.md#desired-state)). A person downloads them from the run page and from an
approval item.

## Nice to have

- YAML: `artifacts` on an agent or shell step, with paths or globs in the workspace. A new shape of `resolved` needs a
  new fixture and a new `protocolVersion` ([workflows.md](../architecture/workflows.md#decisions)).
- The runner collects the files after each attempt, with limits: the number of files, the size of one file, the size
  of all files of a run. Decide the transfer: over the runner connection or a separate HTTP upload.
- Decide the storage on the server: the database or the file system. The choice affects
  [cloudflare-server](cloudflare-server.md).
- Serve each file as a download only (`Content-Disposition: attachment`), never rendered on the portal origin: an
  untrusted run can write HTML or SVG (core rule 5 in [overview.md](../architecture/overview.md#core-rules)).
- The files go with the run when the run is deleted. Decide whether they also go after a retention period.
- A draft test run keeps its files too.
