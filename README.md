# sketchbook

A drawing board library and the app built on it.

| | |
| --- | --- |
| [`packages/draw-board`](packages/draw-board) | **[`markup-board`](https://www.npmjs.com/package/markup-board)** — the React + Konva drawing/annotation board, published to npm. |
| [`apps/sketchbook`](apps/sketchbook) | **Sketchbook** — a standalone drawings app (named boards in `localStorage`, no server), live at [draw.mar.so](https://draw.mar.so). |

## Develop

Requires Node ≥ 22.13 (pnpm 11's minimum) and pnpm (the version pinned in `package.json` → `packageManager`;
`corepack enable` picks it up).

```sh
pnpm install
pnpm dev            # sketchbook on http://localhost:5199
pnpm typecheck
pnpm test           # unit tests, lib + app
pnpm --filter sketchbook exec playwright install chromium   # once
pnpm test:browser   # the app's real-browser suite
pnpm build          # lib → packages/draw-board/dist, app → apps/sketchbook/dist
```

Inside the repo the app consumes the lib's **source** (`workspace:*`), so lib edits
hot-reload with no build step; only the published package is built.

## Releasing markup-board

Versions are managed with [Changesets](.changeset/README.md) in publish-only mode: the
commit that changes the lib also bumps its version (`pnpm changeset` then
`pnpm version-packages`). CI publishes any version not yet on npm when it reaches `develop`
on GitHub, through npm trusted publishing (no token) with provenance.

## Deploy

`draw.mar.so` is built by Coolify from [`infra/sketchbook/`](infra/sketchbook/README.md).

## License

[MIT](LICENSE)
