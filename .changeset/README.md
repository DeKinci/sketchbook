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
