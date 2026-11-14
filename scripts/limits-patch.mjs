#!/usr/bin/env node
/**
 * Optional "limits patch" for the Claude Accounts plugin.
 *
 * Claude reports the real subscription limits (5-hour session, 7-day windows) together with its
 * answers. Paperclip's Claude bridge (@agentclientprotocol/claude-agent-acp) receives them but
 * Paperclip does not store them. This script adds one small block to that bridge so every such
 * report is appended to a local file, which the plugin then reads.
 *
 * It changes a file that belongs to Paperclip's dependencies, so:
 *   - it is opt-in and reversible (`revert`), and keeps a backup next to the file;
 *   - it never lets its own failure break an agent run (the write is wrapped in try/catch);
 *   - a Paperclip update or reinstall removes it — run `apply` again afterwards.
 *
 * Usage:
 *   node scripts/limits-patch.mjs status
 *   node scripts/limits-patch.mjs apply   [--file <path to acp-agent.js>] [--dir <data dir>]
 *   node scripts/limits-patch.mjs revert  [--file <path to acp-agent.js>]
 */
import { execFileSync, execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const START = "/* claude-accounts-limits:start */";
const END = "/* claude-accounts-limits:end */";
const ANCHOR = 'case "rate_limit_event": {';
const BRIDGE = path.join("@agentclientprotocol", "claude-agent-acp", "dist", "acp-agent.js");
const BACKUP_SUFFIX = ".claude-accounts.bak";

const args = process.argv.slice(2);
const command = args[0];
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dataDir = path.resolve(option("--dir") ?? process.env.CLAUDE_ACCOUNTS_DIR ?? path.join(os.homedir(), ".paperclip", "claude-accounts"));
const logFile = path.join(dataDir, "limits.jsonl");

function findBridges() {
  const explicit = option("--file");
  if (explicit) return [path.resolve(explicit)];
  const roots = new Set();
  // 1. `npx paperclipai ...` keeps Paperclip in npm's npx cache.
  try {
    const cache = execSync("npm config get cache", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const npx = path.join(cache, "_npx");
    for (const entry of existsSync(npx) ? readdirSync(npx) : []) roots.add(path.join(npx, entry, "node_modules"));
  } catch {
    /* npm not on PATH */
  }
  // 2. A global install: `npm install -g paperclipai`.
  try {
    const globalRoot = execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    roots.add(globalRoot);
    roots.add(path.join(globalRoot, "paperclipai", "node_modules"));
  } catch {
    /* ignore */
  }
  // 3. A local install in the current folder.
  roots.add(path.join(process.cwd(), "node_modules"));
  return [...roots].map((root) => path.join(root, BRIDGE)).filter((file) => existsSync(file));
}

function block() {
  // The bridge runs with the agent's environment, where HOME may point elsewhere, so the path is
  // written in full. JSON.stringify gives a correctly escaped string literal.
  return [
    START,
    "                        try {",
    `                            (await import("node:fs")).appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ at: new Date().toISOString(), runId: process.env.PAPERCLIP_RUN_ID ?? null, agentId: process.env.PAPERCLIP_AGENT_ID ?? null, info: message.rate_limit_info }) + "\\n");`,
    "                        }",
    "                        catch { }",
    "                        " + END,
  ].join("\n");
}

function strip(source) {
  const from = source.indexOf(START);
  const to = source.indexOf(END);
  if (from < 0 || to < 0) return source;
  // also remove the indentation before START and the newline after END
  const lineStart = source.lastIndexOf("\n", from) + 1;
  const afterEnd = source.indexOf("\n", to);
  return source.slice(0, lineStart) + source.slice(afterEnd < 0 ? source.length : afterEnd + 1);
}

function describe(file) {
  const source = readFileSync(file, "utf8");
  if (source.includes(START)) return "patched";
  if (source.split(ANCHOR).length - 1 !== 1) return "incompatible";
  return "clean";
}

function apply(file) {
  const state = describe(file);
  if (state === "incompatible") {
    console.log(`✗ ${file}\n  This version of the Claude bridge looks different; the patch was not applied.`);
    return false;
  }
  let source = readFileSync(file, "utf8");
  if (state === "patched") source = strip(source); // re-apply, e.g. after changing --dir
  else if (!existsSync(file + BACKUP_SUFFIX)) copyFileSync(file, file + BACKUP_SUFFIX);
  const patched = source.replace(ANCHOR, `${ANCHOR}\n                        ${block()}`);
  writeFileSync(file, patched, "utf8");
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "ignore" });
  } catch {
    writeFileSync(file, source, "utf8");
    console.log(`✗ ${file}\n  The patched file did not pass a syntax check; the original was put back.`);
    return false;
  }
  console.log(`✓ patched ${file}`);
  return true;
}

function revert(file) {
  if (describe(file) !== "patched") {
    console.log(`- ${file}: not patched`);
    return;
  }
  writeFileSync(file, strip(readFileSync(file, "utf8")), "utf8");
  rmSync(file + BACKUP_SUFFIX, { force: true });
  console.log(`✓ reverted ${file}`);
}

const files = findBridges();
if (!["status", "apply", "revert"].includes(command)) {
  console.log("Usage: node scripts/limits-patch.mjs <status|apply|revert> [--file <acp-agent.js>] [--dir <data dir>]");
  process.exit(command ? 1 : 0);
}
if (files.length === 0) {
  console.log(
    "Could not find Paperclip's Claude bridge (@agentclientprotocol/claude-agent-acp).\n" +
      "Pass its location explicitly:  --file /path/to/node_modules/" + BRIDGE.split(path.sep).join("/"),
  );
  process.exit(1);
}

if (command === "status") {
  for (const file of files) console.log(`${describe(file).padEnd(12)} ${file}`);
  console.log(`limits file: ${logFile} (${existsSync(logFile) ? "exists" : "not written yet"})`);
} else if (command === "apply") {
  mkdirSync(dataDir, { recursive: true });
  const ok = files.map(apply).some(Boolean);
  if (ok) {
    console.log(`\nLimits will be written to ${logFile}`);
    console.log("No restart is needed: the next agent run uses the patched bridge.");
    console.log("After a Paperclip update or reinstall, run this command again.");
  }
  process.exit(ok ? 0 : 1);
} else {
  files.forEach(revert);
}
