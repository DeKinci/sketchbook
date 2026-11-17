#!/usr/bin/env node
// Publish markup-board if its current version is not on npm yet; otherwise no-op.
//
// Why not `changeset publish`: npm trusted publishing (OIDC, no stored token) needs the
// npm CLI ≥ 11.5.1, so the publish step itself is `npm publish`. But only pnpm's pack
// applies `publishConfig.exports` (src/ → dist/), so pnpm packs and npm publishes the
// tarball. Changesets still owns the version bump (see .changeset/README.md).
//
// After a publish it tags HEAD (the commit just published) `markup-board@<version>` and
// pushes the tag. A version already on npm is never tagged here — HEAD may be a later
// commit than the one that shipped — but a missing tag is reported as a warning so a
// failed tag push can't go unnoticed (tag the published commit by hand).
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

const tagOnOrigin = () =>
  execFileSync("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`], { encoding: "utf8" }).trim() !== "";

// npm only lets a trusted publisher be configured on a package that already exists, so
// CI cannot make the very first publish — that one was manual (.changeset/README.md § Trusted publishing).
// Skip loudly rather than fail on an auth error nobody can fix from CI.
if (!dryRun && view(name) === null) {
  console.log(`::warning::${name} is not on npm yet — the first publish is manual (see .changeset/README.md). Skipping.`);
  process.exit(0);
}
if (view(tag) === version) {
  console.log(`${tag} is already on npm — nothing to publish.`);
  if (!dryRun && !tagOnOrigin()) {
    console.log(
      `::warning::${tag} is published but origin has no such tag. Tag the commit it was built from ` +
        `(its npm provenance names it — npmjs.com → ${name} → Versions → ${version}), never HEAD.`
    );
  }
  process.exit(0);
}

const out = mkdtempSync(path.join(tmpdir(), "markup-board-"));
run("pnpm", ["pack", "--pack-destination", out], { cwd: PKG_DIR });
const tgz = readdirSync(out).find((f) => f.endsWith(".tgz"));
if (!tgz) throw new Error(`pnpm pack produced no tarball in ${out}`);

run("npm", ["publish", path.join(out, tgz), "--access", "public", ...(dryRun ? ["--dry-run"] : ["--provenance"])]);
if (dryRun) process.exit(0);

run("git", ["tag", tag]);
run("git", ["push", "origin", `refs/tags/${tag}`]);
console.log(`Published ${tag}.`);
