/**
 * Production ports: wire the automation adapter to the live DesignBridge link.
 *
 * Everything here is read-only UXP work (resolution, selection read-back,
 * prototype state). The adapter is the only component that drives the XD UI.
 * Resolution never guesses: an ambiguous name is reported with its candidates
 * so the caller can ask for a GUID instead.
 */
import type { XdLink } from "../xd-link.ts";
import type { AuthoringPorts, ResolvedNode, ResolveResult } from "./adapter.ts";
import type { AutomationRunner } from "./worker.ts";
import type { DetectedEdge } from "./protocol.ts";

const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

type Row = Record<string, unknown>;

function asRows(value: unknown, key: string): Row[] {
  if (typeof value !== "object" || value === null) return [];
  const arr = (value as Record<string, unknown>)[key];
  if (!Array.isArray(arr)) return [];
  return arr.filter((v): v is Row => typeof v === "object" && v !== null);
}

function nodeOf(row: Row): ResolvedNode {
  return {
    guid: typeof row.guid === "string" ? row.guid : "",
    name: typeof row.name === "string" ? row.name : null,
    type: typeof row.type === "string" ? row.type : null,
  };
}

function ok(node: ResolvedNode | null): ResolveResult {
  return { node, reason: node ? "ok" : "not_found", candidates: node ? [{ guid: node.guid, name: node.name }] : [] };
}

function ambiguous(nodes: ResolvedNode[]): ResolveResult {
  return { node: null, reason: "ambiguous", candidates: nodes.map((n) => ({ guid: n.guid, name: n.name })) };
}

async function listArtboards(link: XdLink): Promise<ResolvedNode[]> {
  const r = await link.execute("get_artboards", {});
  if (!r.ok) return [];
  return asRows(r.result, "artboards").map((row) => ({ ...nodeOf(row), type: "Artboard" }));
}

export function createXdPorts(link: XdLink, runner: AutomationRunner): AuthoringPorts {
  return {
    async resolveSource(input: string): Promise<ResolveResult> {
      const boards = await listArtboards(link);
      const boardMatches = boards.filter((b) => b.guid === input || b.name === input);
      if (boardMatches.length === 1) return ok(boardMatches[0]);
      if (boardMatches.length > 1) return ambiguous(boardMatches);

      if (GUID_RE.test(input)) {
        const r = await link.execute("inspect_node", { guid: input });
        if (!r.ok) return ok(null);
        // inspect_node replies with { ok, node }; older fakes reply with the node
        // itself. Passing the { ok, node } wrapper straight to nodeOf() produced a
        // source with an empty guid, which collapsed the per-source trigger-slot
        // key (false duplicate_trigger_slot) and made authoring fail with
        // SOURCE_NOT_FOUND.
        const payload = (r.result ?? null) as Row | null;
        const row = payload && typeof payload.node === "object" && payload.node !== null ? (payload.node as Row) : payload;
        return ok(row ? nodeOf(row) : null);
      }

      const r = await link.execute("search_nodes", { query: input, limit: 50 });
      if (!r.ok) return ok(null);
      const exact = asRows(r.result, "nodes").filter((n) => n.name === input);
      if (exact.length === 0) return ok(null);
      if (exact.length > 1) return ambiguous(exact.map(nodeOf));
      return ok(nodeOf(exact[0]));
    },

    async resolveTarget(input: string): Promise<ResolveResult> {
      const boards = await listArtboards(link);
      const matches = boards.filter((b) => b.guid === input || b.name === input);
      if (matches.length === 1) return ok(matches[0]);
      if (matches.length > 1) return ambiguous(matches);
      return ok(null);
    },

    async readSelection(): Promise<ResolvedNode[]> {
      const r = await link.execute("get_selection", {});
      if (!r.ok) return [];
      return asRows(r.result, "selection").map(nodeOf);
    },

    async readEdges(): Promise<DetectedEdge[]> {
      const r = await link.execute("get_prototype_state", {});
      if (!r.ok) throw new Error(`get_prototype_state failed: ${r.error ?? "unknown"}`);
      const edges: DetectedEdge[] = [];
      for (const record of asRows(r.result, "interactions")) {
        const source = (record.triggerNode ?? {}) as Row;
        const list = Array.isArray(record.interactions) ? (record.interactions as Row[]) : [];
        for (const interaction of list) {
          const trigger = (interaction.trigger ?? {}) as Row;
          const action = (interaction.action ?? {}) as Row;
          const destination = (action.destination ?? null) as Row | null;
          const transition = (action.transition ?? {}) as Row;
          edges.push({
            sourceGuid: typeof source.guid === "string" ? source.guid : "",
            sourceName: typeof source.name === "string" ? source.name : null,
            triggerType: typeof trigger.type === "string" ? trigger.type : null,
            actionType: typeof action.type === "string" ? action.type : null,
            destinationGuid: destination && typeof destination.guid === "string" ? destination.guid : null,
            destinationName: destination && typeof destination.name === "string" ? destination.name : null,
            transitionType: typeof transition.type === "string" ? transition.type : null,
            duration: typeof transition.duration === "number" ? transition.duration : null,
          });
        }
      }
      return edges;
    },

    runner,
  };
}
