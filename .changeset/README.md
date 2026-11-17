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

## Trusted publishing

`markup-board` 0.1.0 was published by hand (npm can only attach a trusted publisher to a
package that already exists). Its trusted publisher is GitHub Actions, `DeKinci/sketchbook`,
workflow `ci.yml`, with publish allowed. So CI's `publish` job publishes every later version,
with provenance and no token. If that configuration is ever removed, CI fails at
`npm publish` with an auth error. Re-add it on npmjs.com (`markup-board` → Settings →
Trusted publishing), or run
`npm trust github markup-board --file ci.yml --repository DeKinci/sketchbook --allow-publish`.
