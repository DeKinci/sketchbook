# syntax=docker/dockerfile:1
#
# apps/sketchbook as a STATIC SITE (draw.mar.so). See infra/sketchbook/README.md.
#
# THE BUILD CONTEXT IS THE REPO ROOT — never apps/sketchbook. `markup-board`
# (packages/draw-board) is a `workspace:*` dependency imported as out-of-root SOURCE (its
# package.json `exports` point at `./src/index.ts`; only the PUBLISHED package points at
# dist/), so vite only resolves it through a ROOT pnpm install. A build pack rooted at
# apps/sketchbook has no workspace, no lockfile and no lib, and cannot produce this bundle.
# On Coolify that means Base Directory `/`, not `/apps/sketchbook` — the README's runbook
# table is the load-bearing half of this comment.

FROM node:22-bookworm-slim AS builder
# pnpm at EXACTLY the root package.json's `packageManager` pin, read from the file rather than
# restated here — a restated major drifts silently, and two pnpm majors can write the same
# lockfile differently (a frozen install then dies with ERR_PNPM_LOCKFILE_CONFIG_MISMATCH).
COPY package.json /tmp/pnpm-pin/package.json
RUN npm install -g "$(node -p "require('/tmp/pnpm-pin/package.json').packageManager")" && npm cache clean --force
WORKDIR /build
COPY . /build

# `--filter 'sketchbook...'` (trailing `...` = the package AND its workspace dependencies)
# installs the app + markup-board; the root's release tooling (changesets) is skipped.
# `--prod=false` is load-bearing: vite, tailwind, postcss and typescript are all
# devDependencies, and a pruned install cannot build.
RUN pnpm install --frozen-lockfile --prefer-offline --prod=false \
      --filter 'sketchbook...' --config.confirmModulesPurge=false

# vite build → apps/sketchbook/dist. No `base` is set in vite.config.ts, so assets resolve
# at `/` — correct for a dedicated domain, and deliberately left alone.
RUN pnpm --filter sketchbook build

# Build provenance, served at /build-info.json. The PRIMARY staleness discriminator is
# vite's content-hashed asset filename (dist/assets/index-<hash>.js, read out of
# index.html) — it is derived from the bundle itself, so it cannot claim to be a build it
# isn't. This file is the cheaper human-readable companion.
#
# COOLIFY DOES NOT PASS A COMMIT SHA, measured rather than assumed: the deploy log's build
# command passes exactly --build-arg COOLIFY_URL / COOLIFY_FQDN / COOLIFY_BRANCH /
# COOLIFY_RESOURCE_UUID, and the first live /build-info.json duly read "commit":"unknown".
# That default is deliberate — an absent input must read as absent, never as a fabricated
# sha. SOURCE_COMMIT is still honoured for a local `docker build --build-arg`, and
# COOLIFY_BRANCH records what Coolify actually supplies. `builtAt` is the honest freshness
# signal on a Coolify build.
ARG SOURCE_COMMIT=unknown
ARG COOLIFY_BRANCH=unknown
RUN printf '{"app":"sketchbook","commit":"%s","branch":"%s","builtAt":"%s"}\n' \
      "$SOURCE_COMMIT" "$COOLIFY_BRANCH" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      > /build/apps/sketchbook/dist/build-info.json

# ---------------------------------------------------------------------------
# runtime — nginx serving the static bundle. No node, no server, no state: sketchbook
# persists everything to localStorage (apps/sketchbook/AGENTS.md), so there is nothing
# here to authenticate, connect or back up.
# ---------------------------------------------------------------------------
FROM nginx:1.27-alpine AS runtime
COPY infra/sketchbook/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /build/apps/sketchbook/dist /usr/share/nginx/html
EXPOSE 80
