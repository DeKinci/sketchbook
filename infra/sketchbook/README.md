# Sketchbook on Coolify — a static SPA at `draw.mar.so`

[`apps/sketchbook`](../../apps/sketchbook/AGENTS.md) published as a static site on Coolify.
This bundle is a **Dockerfile** + an **nginx config** + this runbook; everything Coolify
needs is committed here, so the deployment can be reproduced or moved without
reconstructing it from someone's browser history.

| | |
| --- | --- |
| build pack | **Dockerfile** |
| base directory | **`/`** — the repo root (§ Why the root) |
| what runs | nginx serving static files |
| auth / state / secrets | **none** — sketchbook persists to the visitor's `localStorage` |
| container port | **`80`** |
| updating | Redeploy rebuilds from the repo |

## Why the build context is the repo root

`markup-board` (`packages/draw-board`) is a `workspace:*` dependency imported as
**out-of-root source** — inside this repo its `package.json` exports `./src/index.ts`
directly (only the *published* package points at `dist/`).

So the app **cannot be built from `apps/sketchbook` alone.** A build pack whose base
directory is `/apps/sketchbook` has no workspace root, no lockfile and no lib; it fails to
resolve the package. The [`Dockerfile`](Dockerfile) therefore takes the repo root as its
context, runs a root `pnpm install`, and selects the app with `--filter`:

```
pnpm install --frozen-lockfile --prod=false --filter 'sketchbook...'
pnpm --filter sketchbook build
```

The trailing `...` on the filter means *this package and its workspace dependencies*, so
the install pulls in `packages/draw-board` and skips the root's release tooling.

`vite.config.ts` sets **no `base`**, so assets resolve at `/` — correct for a dedicated
domain — and its dev-server `port`/`allowedHosts` block is absent from `vite build`.

## Prerequisites

- A Coolify server with its Traefik proxy running.
- A DNS record for `draw.mar.so` pointing at that server (it already resolves through the
  `*.mar.so` wildcard on the current server — setting the Domains field is the whole of
  the DNS work).
- This repository. It is **public**, so Coolify's *Public Repository* source needs no
  GitHub App or deploy key. No registry login, no environment variables, no secrets.

## Runbook

**1. Create (or repoint) the resource.** In the Coolify project: **+ New** → **Application**
→ **Public Repository** → `https://github.com/DeKinci/sketchbook`, branch `develop`, with
the **Dockerfile** build pack:

| field | value |
| --- | --- |
| Build Pack | `Dockerfile` |
| Base Directory | `/` |
| Dockerfile Location | `/infra/sketchbook/Dockerfile` |
| Ports Exposes | `80` |

> **Base Directory is `/` and that is the load-bearing field.** `/apps/sketchbook` is the
> intuitive value and the one that breaks the build — see § Why the build context is the
> repo root. If a build fails with `markup-board` unresolved, this is why.

**2. Set the domain.** Configuration → **Domains**: `https://draw.mar.so`. Coolify generates
the Traefik router and the Let's Encrypt certificate from this field; no domain means no
router, hence no ingress. The container listens on `80`, Coolify's default, so no `:port`
suffix is needed.

**3. Environment variables: none.** Leave the section empty.

**4. Deploy.** A root `pnpm install` plus a vite build — a couple of minutes cold. Then run
§ Verifying against the live domain.

**Branch.** `develop` is this repo's trunk. Coolify only sees what is pushed to GitHub, so a
deploy reflects the last *push* of `develop`, not the last local commit.

## As deployed

| | |
| --- | --- |
| Coolify | `https://app.coolify.io` (Coolify Cloud) |
| server | `hetzner-eu-01` — `s4o00cck4wok4cw8c04gs8os` |
| project / environment | `SmallThings` / `production` |
| application uuid | `numsgjfpde754ydg8xa9jr40` |

None of these values is a secret — the API token is, and it never enters git.

**Trigger a deploy with `POST`, not `GET`.** Coolify answers `GET /api/v1/deploy` with
`{"message":"This endpoint has changed to a POST request."}` — a 200-shaped refusal that
does nothing.

```bash
curl -sX POST "https://app.coolify.io/api/v1/deploy?uuid=numsgjfpde754ydg8xa9jr40" \
  -H "Authorization: Bearer $COOLIFY_TOKEN"
```

## Verifying

```bash
D=draw.mar.so

# 1. TLS is real and the site serves — the known positive for everything below.
curl -sI "https://$D/" | head -1                          # → HTTP/2 200

# 2. THE STALENESS CHECK — the deployed bundle is the CURRENT one. vite content-hashes
#    every asset filename, so the hash in index.html cannot claim to be a build it isn't.
#    Build the same tree locally and require the two to AGREE:
pnpm --filter sketchbook build
ls apps/sketchbook/dist/assets/                            # → index-<hash>.js
curl -s "https://$D/" | grep -o '/assets/index-[A-Za-z0-9_-]*\.js'

# 3. Provenance, human-readable. `commit` reads "unknown" on a Coolify build — Coolify
#    passes COOLIFY_BRANCH but never a commit sha, and an absent input must read as absent.
#    Check #2 is the authority; `builtAt` is the freshness signal here.
curl -s "https://$D/build-info.json"
#    → {"app":"sketchbook","commit":"unknown","branch":"develop","builtAt":"<iso>"}

# 4. localStorage works on this origin — a browser check by construction: create a
#    drawing, draw a stroke, reload; it must still be there.
```

## No SPA fallback — verified, not assumed

There is **no** `try_files $uri /index.html` in [`nginx.conf`](nginx.conf), deliberately.

Sketchbook has no client-side router and never touches the History API: its only
`window.location` read is `featuresFromUrl()` in `apps/sketchbook/src/App.tsx`, which reads
the **query string** once at load. Every real URL is `/` plus a query, served from
`index.html` by `try_files $uri` unchanged.

| request | result |
| --- | --- |
| `/` | `200` |
| `/?palette=6&fills=0` | `200` |
| `/assets/index-<hash>.js` | `200`, `Cache-Control: public, max-age=31536000, immutable` |
| `/build-info.json` | `200`, `Cache-Control: no-cache` |
| `/no-such-route` | `404` |

Adding a history fallback would turn that last `404` into a `200` serving the app, which
hides broken asset references rather than fixing anything. If sketchbook ever gains
routing, add the fallback then and update this section — not speculatively.

## Do not co-host anything else under `draw.mar.so`

Sketchbook's `localStorage` keys (`sketchbook:drawings`, `sketchbook:library`) are
**unscoped**. Anything served from the same origin shares them; give another app another
name.

## Tests

```bash
infra/sketchbook/sketchbook.test.sh          # this bundle's shape; static, no daemon
infra/sketchbook/sketchbook.test.sh --docker # additionally builds the image and probes it
```

CI runs both (`.github/workflows/ci.yml`, jobs `check` and `docker`). The static half pins
the claims whose failure mode is silent: the build stays rooted at the repo root with a
`--filter` selection (including in the runbook table a human copies into Coolify), no SPA
fallback appears without this document changing with it, and no secret is introduced.
