#!/usr/bin/env node
// Pack markup-board exactly as it would be published and assert the tarball's shape:
// every subpath export resolves to a shipped dist/ .js + .d.ts, nothing from src/ ships,
// and the manifest carries the license and peer deps. Exit non-zero on any miss.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const out = mkdtempSync(path.join(tmpdir(), "markup-board-pack-"));
execFileSync("pnpm", ["pack", "--pack-destination", out], { cwd: "packages/draw-board", stdio: "inherit" });
const tgz = path.join(out, readdirSync(out).find((f) => f.endsWith(".tgz")));
const files = execFileSync("tar", ["tzf", tgz], { encoding: "utf8" }).trim().split("\n").map((f) => f.replace(/^package\//, ""));
const pkg = JSON.parse(execFileSync("tar", ["xzOf", tgz, "package/package.json"], { encoding: "utf8" }));

const problems = [];
const has = (f) => files.includes(f.replace(/^\.\//, ""));
for (const sub of [".", "./theme", "./keymap"]) {
  const e = pkg.exports?.[sub];
  if (!e) { problems.push(`exports is missing "${sub}"`); continue; }
  for (const key of ["types", "default"]) {
    if (!e[key]?.startsWith("./dist/")) problems.push(`exports["${sub}"].${key} = ${e[key]} (expected ./dist/…)`);
    else if (!has(e[key])) problems.push(`exports["${sub}"].${key} → ${e[key]} is not in the tarball`);
  }
}
for (const f of ["README.md", "LICENSE", "package.json"]) if (!has(f)) problems.push(`${f} is not in the tarball`);
const stray = files.filter((f) => !f.startsWith("dist/") && !["README.md", "LICENSE", "package.json"].includes(f));
if (stray.length) problems.push(`unexpected files: ${stray.join(", ")}`);
if (files.some((f) => /\.test\.(js|d\.ts)$/.test(f))) problems.push("test files shipped in dist/");
if (pkg.license !== "MIT") problems.push(`license is ${pkg.license}`);
for (const p of ["react", "react-dom", "konva", "react-konva", "lucide-react"]) {
  if (!pkg.peerDependencies?.[p]) problems.push(`peer dependency ${p} missing`);
}
if (JSON.stringify(pkg).includes("workspace:")) problems.push("manifest still has a workspace: specifier");

if (problems.length) {
  console.error(`✗ ${path.basename(tgz)}:\n  - ${problems.join("\n  - ")}`);
  process.exit(1);
}
console.log(`✓ ${path.basename(tgz)}: ${files.length} files, exports → dist, MIT, peers declared`);
