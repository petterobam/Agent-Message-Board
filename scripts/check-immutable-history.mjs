#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import process from "node:process";

const before = process.argv[2] || "HEAD^";
const after = process.argv[3] || "HEAD";

if (!existsSync(".git")) {
  console.log("[history] no git repository; immutable-history check skipped");
  process.exit(0);
}

try {
  execFileSync("git", ["rev-parse", "--verify", before], { stdio: "ignore" });
} catch {
  console.log("[history] base revision unavailable; immutable-history check skipped");
  process.exit(0);
}

if (/^0+$/.test(before)) {
  console.log("[history] initial revision; immutable-history check skipped");
  process.exit(0);
}

const output = execFileSync(
  "git",
  ["diff", "--name-status", "--find-renames", before, after, "--", "data/messages"],
  { encoding: "utf8" },
).trim();

if (!output) {
  console.log("[history] no message-file changes");
  process.exit(0);
}

const violations = output
  .split("\n")
  .filter(Boolean)
  .filter((line) => /^[DM]\s/.test(line) || /^R\d*\s/.test(line));

if (violations.length > 0) {
  console.error("\n[history] message history is append-only. These changes are forbidden:\n");
  for (const line of violations) console.error(`  ${line}`);
  console.error("\nAdd a new message file instead of editing or deleting an existing one.\n");
  process.exit(1);
}

console.log(`[history] append-only check passed (${output.split("\n").length} new file(s))`);
