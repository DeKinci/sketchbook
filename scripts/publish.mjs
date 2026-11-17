#!/usr/bin/env node
// Publish markup-board if its current version is not on npm yet; otherwise no-op.
//
// Why not `changeset publish`: npm trusted publishing (OIDC, no stored token) needs the
// npm CLI ≥ 11.5.1, so the publish step itself is `npm publish`. But only pnpm's pack
// applies `publishConfig.exports` (src/ → dist/), so pnpm packs and npm publishes the
// tarball. Changesets still owns the version bump (see .changeset/README.md).
//
// It also makes sure the release tag `markup-board@<version>` exists on origin — checked
// separately from npm, so a run whose publish succeeded but whose tag push failed is
// repaired by the next run instead of leaving the version untagged forever.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PKG_DIR = "packages/draw-board";
const { name, version } = JSON.parse(readFileSync(path.join(PKG_DIR, "package.json"), "utf8"));
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });

/** `npm view <spec> version` → the version string, or null on E404 (does not exist). */
function view(spec) {
  try {
    return execFileSync("npm", ["view", spec, "version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() || null;
  } catch (err) {
    if (String(err.stderr ?? "").includes("E404")) return null;
    throw err; // anything but "not found" is a real error
  }
}

const dryRun = process.argv.includes("--dry-run");
const tag = `${name}@${version}`;

/** Create and push `tag` at HEAD unless origin already has it. */
function ensureTag() {
  const remote = execFileSync("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`], { encoding: "utf8" }).trim();
  if (remote) return;
  const local = execFileSync("git", ["tag", "--list", tag], { encoding: "utf8" }).trim();
  if (!local) run("git", ["tag", tag]);
  run("git", ["push", "origin", `refs/tags/${tag}`]);
}

// npm only lets a trusted publisher be configured on a package that already exists, so
// CI cannot make the very first publish — that one was manual (.changeset/README.md § Trusted publishing).
// Skip loudly rather than fail on an auth error nobody can fix from CI.
if (!dryRun && view(name) === null) {
  console.log(`::warning::${name} is not on npm yet — the first publish is manual (see .changeset/README.md). Skipping.`);
  process.exit(0);
}
if (view(tag) === version) {
  console.log(`${tag} is already on npm — nothing to publish.`);
  if (!dryRun) ensureTag();
  process.exit(0);
}

const out = mkdtempSync(path.join(tmpdir(), "markup-board-"));
run("pnpm", ["pack", "--pack-destination", out], { cwd: PKG_DIR });
const tgz = readdirSync(out).find((f) => f.endsWith(".tgz"));
if (!tgz) throw new Error(`pnpm pack produced no tarball in ${out}`);

run("npm", ["publish", path.join(out, tgz), "--access", "public", ...(dryRun ? ["--dry-run"] : ["--provenance"])]);
if (dryRun) process.exit(0);

ensureTag();
console.log(`Published ${tag}.`);
