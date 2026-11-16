# Changesets

Versioning for `markup-board` (the app, `sketchbook`, is private and never published).

**Publish-only flow, no version PRs.** Work lands straight on `develop`, so the commit
that changes the lib also bumps its version:

```sh
pnpm changeset            # describe the change, pick patch/minor/major
pnpm version-packages     # apply it: bumps packages/draw-board/package.json + CHANGELOG.md
git add -A .changeset packages/draw-board && git commit
```

CI (`.github/workflows/ci.yml`, job `publish`) publishes any `markup-board` version that
is not yet on npm, once that commit reaches `develop` on GitHub.

## The first publish (once, by hand)

npm can only attach a trusted publisher to a package that already exists, so until
`markup-board` is on npm the CI publish job skips with a warning. The first version is
published from a maintainer's machine:

```sh
pnpm install
cd packages/draw-board
npm login
pnpm publish --access public    # pnpm, not npm: only pnpm applies publishConfig (dist exports)
```

Then on npmjs.com → `markup-board` → **Settings** → **Trusted publishing** → GitHub Actions:
organization/user `DeKinci`, repository `sketchbook`, workflow filename `ci.yml`, no
environment. From then on CI publishes every new version, with provenance, and no token.
