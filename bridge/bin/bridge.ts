#!/usr/bin/env node
/**
 * AdobeXD-DesignBridge entrypoint.
 * - Always: hosts the local WebSocket server (127.0.0.1) for the XD plugin.
 * - Always: runs the MCP stdio server on this process (launched by OpenCode).
 * - --show-token: print the auth token and exit (for pasting into the plugin).
 * - --mock: start an in-process mock plugin for testing without Adobe XD.
 */
import { getOrCreateToken, log, ensureDirs } from "../src/util.ts";
import { XdLink } from "../src/xd-link.ts";
import { startMcp } from "../src/mcp-server.ts";
import { startMockPlugin } from "../src/mock-plugin.ts";

const args = process.argv.slice(2);
const PORT = Number(process.env.XD_BRIDGE_PORT ?? 27183);
const REQUEST_TIMEOUT_MS = Number(process.env.XD_BRIDGE_REQUEST_TIMEOUT_MS ?? 30_000);

ensureDirs();
const token = getOrCreateToken();

if (args.includes("--show-token")) {
  process.stdout.write(token + "\n");
  process.exit(0);
}

const link = new XdLink({ port: PORT, token, requestTimeoutMs: REQUEST_TIMEOUT_MS });

async function main(): Promise<void> {
  await link.start();
  log("info", "bridge starting", { port: PORT, mock: args.includes("--mock") });

  if (args.includes("--mock") || process.env.XD_BRIDGE_MOCK === "1") {
    try {
      await startMockPlugin(PORT, token);
      log("info", "mock plugin connected");
    } catch (e) {
      log("warn", "mock plugin failed to connect (retrying once)", String(e));
      setTimeout(() => startMockPlugin(PORT, token).catch(() => {}), 500);
    }
  }

  startMcp(link, { serverInfo: { name: "adobexd-design-bridge", version: "1.0.0" } });

  process.on("SIGINT", () => {
    link.stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    link.stop();
    process.exit(0);
  });
}

main().catch((e) => {
  log("error", "bridge failed to start", String(e));
  process.exit(1);
});
