#!/usr/bin/env node
// Publish markup-board if its current version is not on npm yet; otherwise no-op.
//
// Why not `changeset publish`: npm trusted publishing (OIDC, no stored token) needs the
// npm CLI ≥ 11.5.1, so the publish step itself is `npm publish`. But only pnpm's pack
// applies `publishConfig.exports` (src/ → dist/), so pnpm packs and npm publishes the
// tarball. Changesets still owns the version bump (see .changeset/README.md).
//
// After publishing it tags the commit `markup-board@<version>` and pushes the tag.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PKG_DIR = "packages/draw-board";
const { name, version } = JSON.parse(readFileSync(path.join(PKG_DIR, "package.json"), "utf8"));
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });

function published() {
  try {
    const out = execFileSync("npm", ["view", `${name}@${version}`, "version"], { encoding: "utf8" });
    return out.trim() === version;
  } catch (err) {
    // E404: the package (or this version) does not exist yet. Anything else is a real error.
    if (String(err.stderr ?? "").includes("E404")) return false;
    throw err;
  }
}

if (published()) {
  console.log(`${name}@${version} is already on npm — nothing to publish.`);
  process.exit(0);
}

const out = mkdtempSync(path.join(tmpdir(), "markup-board-"));
run("pnpm", ["pack", "--pack-destination", out], { cwd: PKG_DIR });
const tgz = readdirSync(out).find((f) => f.endsWith(".tgz"));
if (!tgz) throw new Error(`pnpm pack produced no tarball in ${out}`);

const dryRun = process.argv.includes("--dry-run");
run("npm", ["publish", path.join(out, tgz), "--access", "public", ...(dryRun ? ["--dry-run"] : ["--provenance"])]);
if (dryRun) process.exit(0);

const tag = `${name}@${version}`;
run("git", ["tag", tag]);
run("git", ["push", "origin", tag]);
console.log(`Published ${tag}.`);
