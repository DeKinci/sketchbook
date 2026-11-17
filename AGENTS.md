# sketchbook repo

pnpm workspace, two packages. **Read the package's own `AGENTS.md` before working in it.**

- `packages/draw-board` — the lib, published to npm as **`markup-board`** (MIT, public). Source-consumed in-repo, built to `dist/` only for publishing.
- `apps/sketchbook` — the drawings app (`sketchbook`, private), deployed to draw.mar.so via `infra/sketchbook/`.

## Laws

- **Nothing reaches outside the repo.** No `../../..` paths; every tool, helper and config lives here.
- **ESM, explicit `.ts`/`.tsx` imports**, `moduleResolution: bundler`. The lib's build rewrites them (`rewriteRelativeImportExtensions`).
- **The lib is public API.** A change to what `markup-board` exports ships with a changeset and the version bump in the same commit (`.changeset/README.md`). Never `npm publish` by hand from the directory — only pnpm's pack applies `publishConfig` (dist exports); CI's `scripts/publish.mjs` does it right.
- **pnpm at the pinned version** (`packageManager`); a different major rewrites the lockfile and breaks CI's / the Docker image's frozen install. `corepack pnpm@<pin>` if your global pnpm differs.

## Commands

- Install `pnpm install` · dev `pnpm dev`
- Typecheck `pnpm typecheck` · unit `pnpm test` · browser `pnpm test:browser` · build `pnpm build`
- Packed-lib shape `node scripts/check-pack.mjs` · deploy bundle `infra/sketchbook/sketchbook.test.sh [--docker]`

## CI / release

`.github/workflows/ci.yml`: checks on push + PR; on `develop` it publishes any unpublished `markup-board` version via npm trusted publishing (OIDC). GitHub only sees what is **pushed** — landing a commit locally publishes nothing.

**The agent pushes, not the owner (owner's standing instruction, 2026-11-17).** Dorodango lands this member repo's commits on the local `develop` but never pushes them, so CI, the npm publish and the draw.mar.so deploy see nothing until a push. When a task's commits have landed (`git -C <live checkout> log develop` shows them), push them yourself: `git -C ~/Dev/sketchbook push origin develop`. It's a plain fast-forward, never `--force`. Then watch the run (`gh run watch -R DeKinci/sketchbook`) and treat a red CI as the task's own failure.
