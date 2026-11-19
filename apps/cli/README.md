# Halinka

Self-hostable agent orchestration for the software development lifecycle. Workflows run coding agents in isolated
workspaces, with gates, an inbox for people, and pull requests as the only way that changes land.

## Start on one machine

Halinka needs Node.js 24.20 or later. In your repo, tell your coding agent: "Run `npx halinka setup` and follow it."

To do the setup by hand:

```sh
npx halinka init
npx halinka start
```

`init` writes `.halinka/` with a first workflow. `start` runs the server, the portal and a runner on
`http://127.0.0.1:7070`.

## Guides

- [Set up a repo](https://github.com/mateuszmigas/halinka/blob/main/docs/user/setup.md)
- [Run the server on a VPS](https://github.com/mateuszmigas/halinka/blob/main/docs/user/vps.md)
- [Add a runner](https://github.com/mateuszmigas/halinka/blob/main/docs/user/runners.md)
- [Example workflows](https://github.com/mateuszmigas/halinka/tree/main/docs/examples)

## License

AGPL-3.0-only. The licenses of the bundled packages are in `dist/THIRD_PARTY_LICENSES.txt`.
