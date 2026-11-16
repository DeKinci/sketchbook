#!/usr/bin/env bash
#
# Checks for the sketchbook static-site bundle (infra/sketchbook/README.md).
#
# WHY these particular assertions. This deployment has no auth, no state and no secrets, so
# almost nothing about it can go wrong at runtime — but two things can go wrong SILENTLY,
# and they are the two this file exists for:
#
#   1. THE BUILD ROOT. `markup-board` (packages/draw-board) is a workspace dep imported as
#      out-of-root SOURCE, so the build must be rooted at the repo with the app selected by
#      --filter. `/apps/sketchbook` is the intuitive Coolify Base Directory and the one
#      that breaks. The Dockerfile getting it wrong fails loudly; the README getting it
#      wrong does not — a human copies the table into Coolify and the failure surfaces
#      hours later as an unresolved package. So both are pinned.
#   2. THE ABSENT SPA FALLBACK. Adding `try_files $uri /index.html` makes every 404 a 200
#      serving the app. That looks like a fix and hides broken asset paths forever, so it
#      may only land together with an edit to the README section that justifies its
#      absence.
#
# infra/ is deliberately outside the pnpm/vitest workspace, so this is a standalone runner:
# exit 0 all pass, non-zero on any failure. CI runs both halves (.github/workflows/ci.yml).
#
#   infra/sketchbook/sketchbook.test.sh            static only — no daemon, CI-friendly
#   infra/sketchbook/sketchbook.test.sh --docker   also builds the image and probes nginx
#
# The --docker half is opt-in because it needs a working daemon and a few minutes; the
# static half must never depend on one, so a green run of it says nothing about a daemon.
set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(cd ../.. && pwd)"
pass=0 fail=0
ok()  { pass=$((pass + 1)); printf '  \342\234\223 %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  \342\234\227 %s\n' "$1"; }

DOCKERFILE=Dockerfile
NGINX=nginx.conf
README=README.md

# The Dockerfile and nginx.conf are heavily commented, and their comments deliberately NAME
# the things asserted against below (the `/apps/sketchbook` base directory that must not be
# used, the `try_files $uri /index.html` that must not appear). Structural assertions
# therefore run against comment-stripped copies — grepping the raw files would trip on
# their own documentation. Portable mktemp: spell the template out (BSD's `-t prefix` is
# GNU's "too few X's" hard error).
# The Dockerfile also wraps its RUN lines with backslash continuations, so the copy joins
# them first — otherwise a one-line grep for `pnpm install …--filter` reads as absent for a
# purely cosmetic reason, which is a fail-CLOSED instrument.
strip_comments() {
  sed -e 's/[[:space:]]*#.*$//' -e '/^[[:space:]]*$/d' "$1" | sed -e ':a' -e '/\\$/{N;s/\\\n[[:space:]]*/ /;ba' -e '}'
}
DF="$(mktemp "${TMPDIR:-/tmp}/sketchbook-df.XXXXXX")"
NX="$(mktemp "${TMPDIR:-/tmp}/sketchbook-nx.XXXXXX")"
trap 'rm -f "$DF" "$NX"' EXIT
strip_comments "$DOCKERFILE" > "$DF"
strip_comments "$NGINX" > "$NX"

# --- 1. the build is rooted at the monorepo -----------------------------------------------
echo "build root — the repo root, with the app selected by --filter"
grep -qE '^COPY \. /build$' "$DF" \
  && ok "Dockerfile COPYs the whole context (the repo root)" \
  || bad "Dockerfile does not COPY the repo root — markup-board will not resolve"
grep -qE 'pnpm install .*--filter' "$DF" \
  && ok "install selects the app with --filter" \
  || bad "no filtered pnpm install — the root install must select sketchbook"
grep -qE "'?sketchbook\.\.\.'?" "$DF" \
  && ok "the filter carries the trailing ... (pulls in packages/draw-board)" \
  || bad "filter lacks the trailing '...' — markup-board would not be installed"
grep -q -- '--prod=false' "$DF" \
  && ok "--prod=false (vite/tailwind/typescript are devDependencies)" \
  || bad "--prod=false missing — a pruned install cannot run vite"
grep -qE 'COPY .*\bapps/sketchbook\b.*/build' "$DF" \
  && bad "Dockerfile COPYs apps/sketchbook as its own context — the build must be rooted at the repo" \
  || ok "no app-only COPY shortcut"
# The workspace root files the build depends on must actually exist where the Dockerfile
# expects them. A KNOWN POSITIVE for this pair: if either path moved, the grep above would
# still pass while the build broke.
[ -f "$ROOT/pnpm-workspace.yaml" ] && ok "pnpm-workspace.yaml present at the context root" \
  || bad "pnpm-workspace.yaml missing from the repo root"
[ -f "$ROOT/pnpm-lock.yaml" ] && ok "pnpm-lock.yaml present (the install is --frozen-lockfile)" \
  || bad "pnpm-lock.yaml missing from the repo root — the frozen install cannot run"
grep -q 'workspace:\*' "$ROOT/apps/sketchbook/package.json" \
  && ok "sketchbook still depends on markup-board as workspace:*" \
  || bad "sketchbook's markup-board dependency is no longer workspace:* — re-read the build-root reasoning"

# The runbook is what a human copies into Coolify, so its table is as load-bearing as the
# Dockerfile and cannot go stale independently.
echo "runbook — the Coolify fields a human copies"
grep -q 'Dockerfile Location.*infra/sketchbook/Dockerfile' "$README" \
  && ok "README names the Dockerfile location" \
  || bad "README's runbook table does not name /infra/sketchbook/Dockerfile"
grep -qE '^\| Base Directory \| `/` \|' "$README" \
  && ok "README's Base Directory is /" \
  || bad "README's Base Directory is not / — /apps/sketchbook is the documented trap"
grep -qE '^\| Base Directory \| `/apps' "$README" \
  && bad "README's runbook table says /apps/sketchbook — that build cannot resolve markup-board" \
  || ok "the runbook table does not name an app-rooted base directory"

# --- 2. no SPA history fallback -----------------------------------------------------------
echo "serving — static, with NO history fallback"
grep -qE 'try_files[^;]*/index\.html' "$NX" \
  && bad "nginx.conf has an SPA history fallback — sketchbook has no router (README § No SPA fallback)" \
  || ok "no try_files → /index.html fallback"
grep -qE 'try_files \$uri \$uri/ =404;' "$NX" \
  && ok "unknown paths 404" \
  || bad "the root location does not 404 on an unknown path"
grep -q 'No SPA fallback' "$README" \
  && ok "README justifies the absence" \
  || bad "README § No SPA fallback is gone — the fallback's absence must stay documented"
# Caching: the staleness check in the README is only meaningful if index.html is never
# cached and hashed assets always are.
grep -qE 'location = /index\.html' "$NX" && grep -q 'no-cache' "$NX" \
  && ok "index.html is no-cache (it names the current asset hashes)" \
  || bad "index.html is not no-cache — a cached copy IS the stale artifact the check hunts"
grep -q 'immutable' "$NX" \
  && ok "hashed assets are immutable" \
  || bad "hashed assets are not marked immutable"
if grep -qE '^[[:space:]]*expires ' "$NX"; then
  bad 'nginx.conf mixes an `expires` directive with add_header Cache-Control (two Cache-Control lines)'
else
  ok 'no `expires` directive beside add_header Cache-Control'
fi

# --- 3. no secrets, no state --------------------------------------------------------------
echo "posture — no secrets, no state, nothing to authenticate"
for pat in 'coolify-token' 'COOLIFY_TOKEN' 'Bearer ' 'ghcr.io' 'password'; do
  if grep -rqi -- "$pat" "$DOCKERFILE" "$NGINX" 2>/dev/null; then
    bad "a credential-shaped string ($pat) appears in the bundle"
  else
    ok "no $pat in the build files"
  fi
done
ls ./*.env* >/dev/null 2>&1 \
  && bad "an env file lives in this bundle — this resource needs no environment variables" \
  || ok "no env file (README step 3: none required)"
grep -qE '^(VOLUME|ENV DORO_)' "$DF" \
  && bad "the image declares state or harness env — sketchbook persists to localStorage only" \
  || ok "no VOLUME, no DORO_ env"

# --- 4. the live-image probe (opt-in) -----------------------------------------------------
if [ "${1:-}" = "--docker" ]; then
  echo "image — a clean build from the repo root, then nginx probed in-container"
  TAG="sketchbook-test:$$"
  NAME="sketchbook-test-$$"
  cleanup_docker() { docker rm -f "$NAME" >/dev/null 2>&1 || true; docker rmi -f "$TAG" >/dev/null 2>&1 || true; }
  trap 'cleanup_docker; rm -f "$DF" "$NX"' EXIT
  if DOCKER_BUILDKIT=1 docker build -q -f "$ROOT/infra/sketchbook/Dockerfile" -t "$TAG" "$ROOT" >/dev/null; then
    ok "image builds from the repo root"
    docker run -d --name "$NAME" "$TAG" >/dev/null
    # nginx serves within a second; poll rather than sleep so a slow box doesn't false-fail.
    for _ in $(seq 1 30); do
      docker exec "$NAME" wget -q -O /dev/null http://127.0.0.1/ 2>/dev/null && break
      sleep 0.5
    done
    # The probe runs INSIDE the container: this box's docker daemon may be remote, in which
    # case a published port is not reachable from here and every check would read 000 —
    # a false red. In-container asks the same question of the same nginx.
    code() { docker exec "$NAME" wget -S -q -O /dev/null "http://127.0.0.1$1" 2>&1 \
               | grep -m1 -o 'HTTP/1.1 [0-9]*' | cut -d' ' -f2; }
    # KNOWN POSITIVE FIRST. Without it a 404 below cannot be told apart from a container
    # that never served anything — a probe must prove it can fire before a negative means anything.
    [ "$(code /)" = "200" ] && ok "GET / → 200 (the probe can fire)" \
      || { bad "GET / did not return 200 — every check below is unvalidated"; }
    [ "$(code '/?palette=6&fills=0')" = "200" ] && ok "GET /?palette=6&fills=0 → 200 (the URL feature harness)" \
      || bad "a query-string URL did not serve index.html"
    [ "$(code /no-such-route)" = "404" ] && ok "GET /no-such-route → 404 (no SPA fallback, observed)" \
      || bad "an unknown path did not 404 — a history fallback is in effect"
    html="$(docker exec "$NAME" wget -q -O- http://127.0.0.1/)"
    asset="$(printf '%s' "$html" | grep -o '/assets/index-[A-Za-z0-9_-]*\.js' || true)"
    [ -n "$asset" ] && ok "index.html references a content-hashed asset ($asset)" \
      || bad "index.html has no /assets/index-<hash>.js — the staleness check has nothing to read"
    [ -n "$asset" ] && [ "$(code "$asset")" = "200" ] && ok "the hashed asset serves" \
      || bad "the asset index.html names does not serve"
    docker exec "$NAME" wget -q -O- http://127.0.0.1/build-info.json | grep -q '"app":"sketchbook"' \
      && ok "/build-info.json carries the build provenance" \
      || bad "/build-info.json missing or malformed"
  else
    bad "docker build failed"
  fi
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "sketchbook bundle: $pass checks passed"
  exit 0
fi
echo "sketchbook bundle: $fail FAILED, $pass passed" >&2
exit 1
