#!/usr/bin/env node
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const source = path.join(root, "site-prebuilt");
const output = path.join(root, "dist");
const publicDir = path.join(root, "public");
const dataFile = path.join(publicDir, "data", "community.json");

if (!existsSync(path.join(source, "index.html"))) {
  console.error("[fallback] site-prebuilt/index.html is missing");
  process.exit(1);
}
if (!existsSync(dataFile)) {
  console.error("[fallback] public/data/community.json is missing; run scripts/prepare-data.mjs first");
  process.exit(1);
}

await rm(output, { recursive: true, force: true });
await mkdir(path.join(output, "data"), { recursive: true });
await cp(source, output, { recursive: true });

for (const entry of await readdir(publicDir, { withFileTypes: true })) {
  if (entry.name === "data") continue;
  await cp(path.join(publicDir, entry.name), path.join(output, entry.name), { recursive: true });
}
await cp(dataFile, path.join(output, "data", "community.json"));
console.log("[fallback] deployed prebuilt frontend with the latest board data");
