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

    // Deterministic prototype fixture: three screens and two wiring sources.
    const protoBoards = [
      { guid: "ab-home", name: "Home", frame: { x: 0, y: 0, width: 390, height: 844 } },
      { guid: "ab-details", name: "Details", frame: { x: 550, y: 0, width: 390, height: 844 } },
      { guid: "ab-booking", name: "Booking", frame: { x: 1100, y: 0, width: 390, height: 844 } },
    ];
    const protoNodes = [
      { guid: "nd-home-cta", name: "Home/PrimaryCTA", type: "Rectangle", frame: { x: 24, y: 700, width: 342, height: 56 }, artboard: "ab-home" },
      { guid: "nd-details-book", name: "Details/BookButton", type: "Rectangle", frame: { x: 24, y: 720, width: 342, height: 56 }, artboard: "ab-details" },
    ];
    // One wire already exists, so prepare/verify can report both states.
    const wires: Array<{ fromGuid: string; toGuid: string | null; trigger: string | null; action: string | null }> = [
      { fromGuid: "nd-home-cta", toGuid: "ab-details", trigger: "tap", action: "goToArtboard" },
    ];
    const nameOf = (g: string | null) => {
      if (!g) return null;
      const n = protoNodes.find((x) => x.guid === g) || protoBoards.find((x) => x.guid === g);
      return n ? n.name : null;
    };
    const classify = (required: { fromGuid: string; toGuid: string; trigger?: string; action?: string }) => {
      const fromEdges = wires.filter((w) => w.fromGuid === required.fromGuid);
      if (fromEdges.length === 0) return { status: "missing", candidates: [] as unknown[] };
      const toEdges = fromEdges.filter((w) => w.toGuid === required.toGuid);
      if (toEdges.length === 0) {
        const noDest = fromEdges.every((w) => !w.toGuid);
        return { status: noDest ? "incomplete" : "wrong-destination", candidates: fromEdges };
      }
      let narrowed = toEdges;
      if (required.trigger) {
        narrowed = toEdges.filter((w) => w.trigger === required.trigger);
        if (narrowed.length === 0) return { status: "wrong-trigger", candidates: toEdges };
      }
      if (required.action) {
        narrowed = narrowed.filter((w) => w.action === required.action);
        if (narrowed.length === 0) return { status: "wrong-action", candidates: toEdges };
      }
      if (narrowed.length > 1) return { status: "ambiguous", candidates: narrowed };
      return { status: "ok", candidates: narrowed };
    };
    const asEdge = (w: { fromGuid: string; toGuid: string | null; trigger: string | null; action: string | null }) => ({
      fromGuid: w.fromGuid,
      fromName: nameOf(w.fromGuid),
      toGuid: w.toGuid,
      toName: nameOf(w.toGuid),
      trigger: w.trigger,
      action: w.action,
      transition: null,
    });

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
          return reply(true, { ok: true, documentName: doc.name, count: protoBoards.length, artboards: protoBoards, mock: true });
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
        case "create_screen": {
          const spec = (p.artboard as Record<string, unknown>) ?? {};
          const created = guid();
          const kids = (p.children as Array<{ op: string; name?: string }>) ?? [];
          doc.artboardCount++;
          doc.nodeCount += kids.length;
          doc.modified = true;
          return reply(true, {
            ok: true,
            guid: created,
            name: String(spec.name ?? "Screen"),
            frame: spec.frame,
            childCount: kids.length,
            aborted: false,
            children: kids.map((k) => ({ op: k.op, name: k.name, ok: true, guid: guid() })),
            mock: true,
          });
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
        case "search_nodes": {
          const q = typeof p.query === "string" ? p.query.toLowerCase() : null;
          const nodes = protoNodes.filter((n) => (!q || n.name.toLowerCase().includes(q)) && (!p.type || n.type === p.type));
          return reply(true, { ok: true, nodes, mock: true });
        }
        case "inspect_node": {
          const node = protoNodes.find((n) => n.guid === p.guid);
          if (!node) return reply(false, undefined, "node not found: " + String(p.guid), "node_not_found");
          return reply(true, {
            ok: true,
            ...node,
            childCount: 0,
            childrenTotal: 0,
            childrenReturned: 0,
            childrenOffset: typeof p.offset === "number" ? p.offset : 0,
            childrenLimit: typeof p.limit === "number" ? p.limit : 100,
            hasMore: false,
            nextOffset: null,
            mock: true,
          });
        }
        case "prototype_focus": {
          const node = protoNodes.find((n) => n.guid === p.guid);
          if (!node) return reply(false, undefined, "node not found: " + String(p.guid), "node_not_found");
          const target = p.targetGuid ? protoBoards.find((b) => b.guid === p.targetGuid) : null;
          if (p.targetGuid && !target) return reply(false, undefined, "target artboard not found: " + String(p.targetGuid), "target_not_found");
          return reply(true, {
            ok: true,
            executed: true,
            executedInEditContext: true,
            createdWire: false,
            authoringSupported: false,
            source: { guid: node.guid, name: node.name, role: node.name, type: node.type, frame: node.frame },
            artboard: { guid: node.artboard, name: nameOf(node.artboard) },
            target: target ? { guid: target.guid, name: target.name } : null,
            focusState: "selection-assigned",
            assignedTo: node.guid,
            selectedInTransaction: true,
            wasSelectedBefore: false,
            selectionError: null,
            confirmationRequired: "read xd_get_selection after execution",
            viewport: {
              scrolled: true,
              code: "viewport_moved",
              evidence: "bounds",
              api: "scrollIntoView",
              before: { bounds: { x: 0, y: 0, width: 2000, height: 2000 }, zoomFactor: 1 },
              after: { bounds: { x: 100, y: 0, width: 2000, height: 2000 }, zoomFactor: 1 },
            },
            nextStep: target ? `Wire "${node.name}" → "${target.name}" in XD Prototype mode.` : "Pick a destination artboard.",
            mock: true,
          });
        }
        case "prototype_prepare_connection": {
          const source = protoNodes.find((n) => n.guid === p.sourceGuid);
          if (!source) return reply(false, undefined, "source node not found: " + String(p.sourceGuid), "node_not_found");
          const target = protoBoards.find((b) => b.guid === p.targetGuid);
          if (!target) return reply(false, undefined, "target artboard not found: " + String(p.targetGuid), "target_not_found");
          const required = { fromGuid: source.guid, toGuid: target.guid, trigger: (p.trigger as string) || "tap", action: (p.action as string) || "goToArtboard" };
          const verdict = classify(required);
          const alreadyWired = verdict.status === "ok";
          return reply(true, {
            ok: true,
            executed: true,
            executedInEditContext: true,
            createdWire: false,
            authoringSupported: false,
            status: alreadyWired ? "already-wired" : verdict.status === "wrong-destination" ? "wrong-wire-present" : verdict.status === "wrong-trigger" ? "wrong-trigger-present" : verdict.status === "wrong-action" ? "wrong-action-present" : "ready",
            connection: { source: { guid: source.guid, name: source.name, type: source.type, artboard: { guid: source.artboard, name: nameOf(source.artboard) } }, target: { guid: target.guid, name: target.name }, trigger: required.trigger, action: required.action, transition: p.transition ?? null },
            verdict: { status: verdict.status, candidates: verdict.candidates },
            focusState: alreadyWired ? "not-attempted" : "selection-assigned",
            assignedTo: alreadyWired ? null : source.guid,
            selectedInTransaction: !alreadyWired,
            wasSelectedBefore: false,
            selectionError: null,
            confirmationRequired: "read xd_get_selection after execution",
            viewport: alreadyWired
              ? { scrolled: false, code: "not-attempted", evidence: "none", api: "scrollIntoView" }
              : { scrolled: true, code: "viewport_moved", evidence: "bounds", api: "scrollIntoView" },
            instruction: alreadyWired ? "This connection already exists." : `Drag the blue connector from "${source.name}" to "${target.name}"; set Trigger = ${required.trigger}, Action = ${required.action}.`,
            checklist: alreadyWired ? [] : ["1. Switch XD to Prototype mode.", "2. Drag the connector.", "3. Set trigger and action.", "4. Verify with xd_prototype_verify."],
            mock: true,
          });
        }
        case "prototype_verify_connection": {
          const source = protoNodes.find((n) => n.guid === p.sourceGuid);
          if (!source) return reply(false, undefined, "source node not found: " + String(p.sourceGuid), "node_not_found");
          const target = protoBoards.find((b) => b.guid === p.targetGuid);
          if (!target) return reply(false, undefined, "target artboard not found: " + String(p.targetGuid), "target_not_found");
          const required = { fromGuid: source.guid, toGuid: target.guid, trigger: (p.trigger as string) || "tap", action: (p.action as string) || "goToArtboard" };
          const verdict = classify(required);
          return reply(true, {
            ok: true,
            verified: verdict.status === "ok",
            status: verdict.status,
            authoringSupported: false,
            createdWire: false,
            required,
            matches: verdict.status === "ok" ? verdict.candidates : [],
            candidates: verdict.candidates,
            guidance: verdict.status === "ok" ? "Verified in the document." : `Connection state: ${verdict.status}.`,
            mock: true,
          });
        }
        case "validate_prototype": {
          const requiredList = (p.requiredConnections as Array<{ fromGuid: string; toGuid: string; trigger?: string; action?: string }>) ?? [];
          const checked = requiredList.map((r) => {
            const verdict = classify(r);
            return { required: r, ok: verdict.status === "ok", problems: verdict.status === "ok" ? [] : ["connection-missing"], status: verdict.status, matches: verdict.status === "ok" ? verdict.candidates : [], candidates: verdict.candidates };
          });
          const missing = checked.filter((x) => x.status === "missing").map((x) => x.required);
          const incorrect = checked.filter((x) => x.status !== "ok" && x.status !== "missing").map((x) => ({ required: x.required, status: x.status, candidates: x.candidates }));
          const extra = wires.filter((w) => !requiredList.some((r) => r.fromGuid === w.fromGuid && r.toGuid === w.toGuid && (!r.trigger || r.trigger === w.trigger) && (!r.action || r.action === w.action))).map(asEdge);
          const okCount = checked.filter((x) => x.ok).length;
          const valid = checked.every((x) => x.ok);
          return reply(true, {
            ok: true,
            valid,
            verdict: valid ? "pass" : "fail",
            authoringSupported: false,
            expected: checked.map((x) => ({ ...x.required, status: x.status, ok: x.ok })),
            detected: wires.map(asEdge),
            missing,
            incorrect,
            extra,
            results: checked,
            summary: { expectedCount: checked.length, detectedCount: wires.length, okCount, missingCount: missing.length, incorrectCount: incorrect.length, extraCount: extra.length, coverage: checked.length ? Number((okCount / checked.length).toFixed(3)) : 0 },
            actualConnectionCount: wires.length,
            mock: true,
          });
        }
        case "validate_document":
        case "inspect_design_consistency":
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
