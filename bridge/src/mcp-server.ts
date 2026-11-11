/**
 * Minimal MCP stdio server (JSON-RPC 2.0, newline-delimited messages).
 * Implements: initialize, notifications/initialized, ping, tools/list, tools/call.
 */
import { buildTools, toolList, type ToolResult, type McpContent } from "./tools.ts";
import { XdLink } from "./xd-link.ts";
import { log } from "./util.ts";

interface RpcReq {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

const PROTOCOL_VERSION = "2025-06-18";

export function startMcp(link: XdLink, opts: { serverInfo?: Record<string, unknown> } = {}): void {
  const tools = buildTools(link);
  let buffer = "";

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line.length > 0) handle(line);
    }
  });
  process.stdin.on("end", () => {
    log("info", "stdin closed; MCP server exiting");
    process.exit(0);
  });

  function send(v: unknown): void {
    process.stdout.write(JSON.stringify(v) + "\n");
  }

  async function handle(line: string): Promise<void> {
    let req: RpcReq;
    try {
      req = JSON.parse(line) as RpcReq;
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    if (!req.method) return;
    if (req.method.startsWith("notifications/")) {
      if (req.method === "notifications/initialized") log("info", "MCP client initialized");
      return;
    }
    const id = req.id ?? null;
    try {
      const result = await dispatch(req);
      send({ jsonrpc: "2.0", id, result });
    } catch (e) {
      log("error", `handler error for ${req.method}`, String(e));
      send({ jsonrpc: "2.0", id, error: { code: -32603, message: `Internal error: ${String(e)}` } });
    }
  }

  async function dispatch(req: RpcReq): Promise<unknown> {
    switch (req.method) {
      case "initialize":
        return {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: opts.serverInfo ?? { name: "adobexd-design-bridge", version: "1.0.0" },
          instructions:
            "Adobe XD design bridge. Call xd_health first to check the XD plugin connection. All xd_* tools are validated operations on the active XD document; unsupported XD capabilities are reported honestly, never simulated.",
        };
      case "ping":
        return {};
      case "tools/list": {
        return { tools: toolList() };
      }
      case "tools/call": {
        const name = req.params?.name as string;
        const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
        const tool = tools[name];
        if (!tool) throw new Error(`unknown tool "${name}"`);
        const r: ToolResult = await tool.handler(args);
        const content = r.content as McpContent[];
        return { content, isError: r.isError === true ? true : undefined };
      }
      default:
        throw Object.assign(new Error(`Method not found: ${req.method}`), { code: -32601 });
    }
  }
}
