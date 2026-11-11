/**
 * In-process mock XD plugin for testing the full MCP -> WS -> plugin path
 * without Adobe XD. Enabled with XD_BRIDGE_MOCK=1 or --mock. Implements the
 * same wire protocol a real plugin speaks and returns deterministic data.
 */
import WebSocket from "ws";
import { log } from "./util.ts";

export function startMockPlugin(port: number, token: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let guidSeq = 0;
    const guid = () => `mock-guid-${++guidSeq}`;
    let doc = { name: "MockDocument", modified: false, artboardCount: 0, nodeCount: 0 };
    let artboards: Array<{ guid: string; name: string; frame: Record<string, number> }> = [];

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "hello", token, version: "mock-1.0.0", capabilities: ["mock", "all_ops"] }));
    });
    ws.on("error", reject);
    ws.on("close", () => log("info", "mock plugin disconnected"));
    ws.on("message", (buf) => {
      const msg = JSON.parse(String(buf)) as { type: string; id?: string; op?: string; params?: Record<string, unknown> };
      if (msg.type !== "request") return;
      const reply = (ok: boolean, result?: unknown, error?: string, code?: string) =>
        ws.send(JSON.stringify({ type: "response", id: msg.id, ok, result, error, code }));
      const p = msg.params ?? {};
      switch (msg.op) {
        case "get_document_info":
          return reply(true, { ok: true, document: { ...doc }, mock: true });
        case "get_artboards":
          return reply(true, { ok: true, artboards, mock: true });
        case "get_selection":
          return reply(true, { ok: true, selection: [], mock: true });
        case "create_artboard": {
          const g = guid();
          const ab = { guid: g, name: String(p.name ?? `Artboard ${artboards.length + 1}`), frame: p.frame as Record<string, number> };
          artboards.push(ab);
          doc.artboardCount++;
          doc.modified = true;
          return reply(true, { ok: true, guid: g, name: ab.name, mock: true });
        }
        case "create_rectangle":
        case "create_ellipse":
        case "create_text": {
          const g = guid();
          doc.nodeCount++;
          doc.modified = true;
          return reply(true, { ok: true, guid: g, mock: true });
        }
        case "execute_batch": {
          const ops = (p.operations as Array<{ op: string }>) ?? [];
          const results: unknown[] = [];
          for (const o of ops) results.push({ op: o.op, ok: true, guid: guid() });
          doc.modified = true;
          return reply(true, { ok: true, results, mock: true });
        }
        case "export_artboard": {
          // 1x1 white PNG, base64
          const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
          return reply(true, { ok: true, base64: png, width: 1, height: 1, artboardName: String(p.name ?? "MockArtboard"), mock: true });
        }
        case "validate_document":
        case "inspect_design_consistency":
        case "search_nodes":
          return reply(true, { ok: true, findings: [], nodes: [], mock: true });
        case "create_component":
          return reply(false, undefined, "mock: component creation not implemented", "unsupported");
        default:
          return reply(true, { ok: true, mock: true, note: "mock accepted op" });
      }
    });
    // resolve once authenticated (after ready message)
    ws.on("message", function onceReady(buf: string) {
      const msg = JSON.parse(String(buf)) as { type: string };
      if (msg.type === "ready") {
        ws.off("message", onceReady);
        resolve();
      }
    });
  });
}
