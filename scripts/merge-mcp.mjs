#!/usr/bin/env node
/**
 * Merge the adobe-xd MCP server into an OpenCode config file.
 *
 * Usage:
 *   node scripts/merge-mcp.mjs --config <opencode.json> --node <node.exe>
 *        --bridge <.../bridge/bin/bridge.ts> --cwd <.../bridge>
 *        [--name adobe-xd] [--dry-run]
 *
 * Behaviour:
 *   - creates the file (and parent folder) when missing;
 *   - preserves every other key, server and plugin;
 *   - accepts JSONC (line comments, block comments, trailing commas);
 *   - prints a unified diff of what changed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function parseArgs(argv) {
  const out = { name: "adobe-xd", dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a.startsWith("--")) out[a.slice(2)] = argv[++i];
  }
  return out;
}

/** Remove // and /* *\/ comments and trailing commas without touching strings. */
function stripJsonc(text) {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inLine) {
      if (c === "\n") { inLine = false; out += c; }
      continue;
    }
    if (inBlock) {
      if (c === "*" && n === "/") { inBlock = false; i++; }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") { out += n ?? ""; i++; }
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === "/" && n === "/") { inLine = true; i++; continue; }
    if (c === "/" && n === "*") { inBlock = true; i++; continue; }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function lineDiff(before, after) {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  const setA = new Set(a);
  const setB = new Set(b);
  const lines = [];
  for (const l of a) if (!setB.has(l)) lines.push("  - " + l);
  for (const l of b) if (!setA.has(l)) lines.push("  + " + l);
  return lines.join("\n");
}

const args = parseArgs(process.argv.slice(2));
for (const required of ["config", "node", "bridge", "cwd"]) {
  if (!args[required]) {
    console.error(`missing --${required}`);
    process.exit(2);
  }
}

const configPath = args.config;
let before = "";
let config = {};
if (existsSync(configPath)) {
  before = readFileSync(configPath, "utf8");
  try {
    config = JSON.parse(stripJsonc(before));
  } catch (error) {
    console.error(
      `Could not parse ${configPath} as JSON/JSONC: ${error.message}\n` +
      "Add the server entry manually instead (see INSTALLATION.md).",
    );
    process.exit(3);
  }
}

if (!config.$schema) config.$schema = "https://opencode.ai/config.json";
config.mcp = config.mcp ?? {};
config.mcp.servers = config.mcp.servers ?? {};
config.mcp.servers[args.name] = {
  type: "local",
  command: [args.node, args.bridge],
  cwd: args.cwd,
  environment: { XD_BRIDGE_VERBOSE: "0" },
  timeout: { startup: 30000, catalog: 30000, execution: 600000 },
};

const after = JSON.stringify(config, null, 2) + "\n";
if (args.dryRun) {
  console.log(lineDiff(before, after) || "  (no changes)");
  process.exit(0);
}

mkdirSync(dirname(configPath), { recursive: true });
writeFileSync(configPath, after, "utf8");
console.log(`updated ${configPath}`);
console.log(lineDiff(before, after) || "  (no changes)");
