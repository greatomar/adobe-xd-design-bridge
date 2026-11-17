/**
 * Prototype flow manifest: schema, validation and resolution.
 *
 * XD's public UXP API is READ-ONLY for prototype wiring: no documented call
 * creates, edits or deletes a wire. This module therefore never claims to wire
 * anything. It turns an intent manifest (semantic names or GUIDs) into the
 * resolved edges that `prototype_prepare_connection`, `prototype_verify_connection`
 * and `validate_prototype` need, so the human does the minimum manual work and
 * the bridge proves the result afterwards.
 */
import type { XdLink } from "./xd-link.ts";

export const PROTOTYPE_TRIGGERS = ["tap", "drag", "time", "voice", "keys"] as const;
export const PROTOTYPE_ACTIONS = ["goToArtboard", "overlay"] as const;

export type PrototypeTrigger = (typeof PROTOTYPE_TRIGGERS)[number];
export type PrototypeAction = (typeof PROTOTYPE_ACTIONS)[number];

export interface PrototypeTransition {
  type?: string;
  duration?: number;
  easing?: string;
}

export interface PrototypeOverlay {
  x?: number;
  y?: number;
}

/** One intended navigation edge. `source`/`target` accept a GUID or an exact name. */
export interface ManifestEdge {
  source: string;
  target: string;
  sourceRole?: string;
  trigger?: PrototypeTrigger;
  action?: PrototypeAction;
  transition?: PrototypeTransition;
  overlay?: PrototypeOverlay;
  preserveScrollPosition?: boolean;
  note?: string;
}

export interface FlowManifest {
  name?: string;
  home?: string;
  edges: ManifestEdge[];
}

export interface ManifestProblem {
  edge: number;
  field: string;
  code: string;
  message: string;
}

const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function label(v: unknown, path: string, max = 256): string | null {
  if (typeof v !== "string") return `${path} must be a string`;
  if (v.trim().length === 0) return `${path} must be a non-empty string`;
  if (v.length > max) return `${path} exceeds maximum length ${max}`;
  return null;
}

function optLabel(v: unknown, path: string, max = 256): string | null {
  if (v === undefined) return null;
  return label(v, path, max);
}

/**
 * Validate a raw manifest. Returns the normalised manifest or one exact error.
 * Structural only: it never touches XD.
 */
export function validateFlowManifest(raw: unknown): { ok: true; manifest: FlowManifest } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: "flow manifest must be an object {name?, home?, edges[]}" };
  if (raw.name !== undefined) {
    const e = label(raw.name, "manifest.name");
    if (e) return { ok: false, error: e };
  }
  if (raw.home !== undefined) {
    const e = label(raw.home, "manifest.home");
    if (e) return { ok: false, error: e };
  }
  if (!Array.isArray(raw.edges) || raw.edges.length === 0) {
    return { ok: false, error: "manifest.edges must be a non-empty array" };
  }
  if (raw.edges.length > 500) return { ok: false, error: "manifest.edges is limited to 500 entries" };

  const edges: ManifestEdge[] = [];
  for (let i = 0; i < raw.edges.length; i++) {
    const item = raw.edges[i];
    const at = `edges[${i}]`;
    if (!isRecord(item)) return { ok: false, error: `${at} must be an object` };

    const sourceError = label(item.source, `${at}.source`);
    if (sourceError) return { ok: false, error: sourceError };
    const targetError = label(item.target, `${at}.target`);
    if (targetError) return { ok: false, error: targetError };
    const roleError = optLabel(item.sourceRole, `${at}.sourceRole`);
    if (roleError) return { ok: false, error: roleError };
    const noteError = optLabel(item.note, `${at}.note`, 1024);
    if (noteError) return { ok: false, error: noteError };

    let trigger: PrototypeTrigger | undefined;
    if (item.trigger !== undefined) {
      if (typeof item.trigger !== "string" || !PROTOTYPE_TRIGGERS.includes(item.trigger as PrototypeTrigger)) {
        return { ok: false, error: `${at}.trigger must be one of ${PROTOTYPE_TRIGGERS.join(", ")}` };
      }
      trigger = item.trigger as PrototypeTrigger;
    }
    let action: PrototypeAction | undefined;
    if (item.action !== undefined) {
      if (typeof item.action !== "string" || !PROTOTYPE_ACTIONS.includes(item.action as PrototypeAction)) {
        return { ok: false, error: `${at}.action must be one of ${PROTOTYPE_ACTIONS.join(", ")}` };
      }
      action = item.action as PrototypeAction;
    }

    let transition: PrototypeTransition | undefined;
    if (item.transition !== undefined) {
      if (!isRecord(item.transition)) return { ok: false, error: `${at}.transition must be an object` };
      const t = item.transition;
      const typeError = optLabel(t.type, `${at}.transition.type`, 64);
      if (typeError) return { ok: false, error: typeError };
      const easingError = optLabel(t.easing, `${at}.transition.easing`, 64);
      if (easingError) return { ok: false, error: easingError };
      if (t.duration !== undefined && (typeof t.duration !== "number" || !Number.isFinite(t.duration) || t.duration < 0 || t.duration > 10)) {
        return { ok: false, error: `${at}.transition.duration must be a number between 0 and 10` };
      }
      transition = {
        type: t.type as string | undefined,
        duration: t.duration as number | undefined,
        easing: t.easing as string | undefined,
      };
    }

    let overlay: PrototypeOverlay | undefined;
    if (item.overlay !== undefined) {
      if (!isRecord(item.overlay)) return { ok: false, error: `${at}.overlay must be an object {x?, y?}` };
      const o = item.overlay;
      for (const key of ["x", "y"] as const) {
        if (o[key] !== undefined && (typeof o[key] !== "number" || !Number.isFinite(o[key] as number))) {
          return { ok: false, error: `${at}.overlay.${key} must be a finite number` };
        }
      }
      overlay = { x: o.x as number | undefined, y: o.y as number | undefined };
    }

    if (item.preserveScrollPosition !== undefined && typeof item.preserveScrollPosition !== "boolean") {
      return { ok: false, error: `${at}.preserveScrollPosition must be a boolean` };
    }

    edges.push({
      source: item.source as string,
      target: item.target as string,
      sourceRole: item.sourceRole as string | undefined,
      trigger,
      action,
      transition,
      overlay,
      preserveScrollPosition: item.preserveScrollPosition as boolean | undefined,
      note: item.note as string | undefined,
    });
  }

  return {
    ok: true,
    manifest: {
      name: raw.name as string | undefined,
      home: raw.home as string | undefined,
      edges,
    },
  };
}

export interface ResolvedSource {
  input: string;
  guid: string | null;
  name: string | null;
  type: string | null;
  resolvedBy: "guid" | "name" | null;
  candidates?: Array<{ guid: unknown; name: unknown; type: unknown }>;
}

export interface ResolvedTarget {
  input: string;
  guid: string | null;
  name: string | null;
  resolvedBy: "guid" | "name" | null;
}

export interface ResolvedEdge extends ManifestEdge {
  index: number;
  sourceNode: ResolvedSource;
  targetArtboard: ResolvedTarget;
  problems: ManifestProblem[];
  ready: boolean;
}

export interface ResolvedManifest {
  ok: boolean;
  name: string | null;
  home: { input: string; guid: string | null; name: string | null; resolved: boolean } | null;
  edges: ResolvedEdge[];
  problems: ManifestProblem[];
  stats: { edgeCount: number; readyCount: number; blockedCount: number; artboardCount: number };
}

type Board = Record<string, unknown>;

function boardList(result: unknown): Board[] {
  if (!isRecord(result)) return [];
  const boards = result.artboards;
  if (!Array.isArray(boards)) return [];
  return boards.filter(isRecord);
}

function nodesOf(result: unknown): Board[] {
  if (!isRecord(result)) return [];
  const nodes = result.nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes.filter(isRecord);
}

async function resolveSource(link: XdLink, input: string, boards: Board[]): Promise<ResolvedSource> {
  const matchedBoard = boards.find((b) => b.guid === input || b.name === input);
  if (matchedBoard && typeof matchedBoard.guid === "string") {
    return {
      input,
      guid: matchedBoard.guid,
      name: typeof matchedBoard.name === "string" ? matchedBoard.name : null,
      type: "Artboard",
      resolvedBy: GUID_RE.test(input) ? "guid" : "name",
    };
  }

  if (GUID_RE.test(input)) {
    const inspected = await link.execute("inspect_node", { guid: input });
    if (inspected.ok && isRecord(inspected.result)) {
      const node = inspected.result;
      return {
        input,
        guid: typeof node.guid === "string" ? node.guid : input,
        name: typeof node.name === "string" ? node.name : null,
        type: typeof node.type === "string" ? node.type : null,
        resolvedBy: "guid",
      };
    }
    return { input, guid: null, name: null, type: null, resolvedBy: null };
  }

  const searched = await link.execute("search_nodes", { query: input, limit: 50 });
  const exact = nodesOf(searched.result).filter((n) => n.name === input);
  if (exact.length === 1) {
    return {
      input,
      guid: typeof exact[0].guid === "string" ? exact[0].guid : null,
      name: input,
      type: typeof exact[0].type === "string" ? exact[0].type : null,
      resolvedBy: "name",
    };
  }
  if (exact.length > 1) {
    return {
      input,
      guid: null,
      name: input,
      type: null,
      resolvedBy: null,
      candidates: exact.map((n) => ({ guid: n.guid, name: n.name, type: n.type })),
    };
  }
  return { input, guid: null, name: null, type: null, resolvedBy: null };
}

function resolveTarget(board: Board | undefined, input: string): ResolvedTarget {
  if (!board || typeof board.guid !== "string") {
    return { input, guid: null, name: null, resolvedBy: null };
  }
  return {
    input,
    guid: board.guid,
    name: typeof board.name === "string" ? board.name : null,
    resolvedBy: GUID_RE.test(input) ? "guid" : "name",
  };
}

/**
 * Resolve a validated manifest against the live document.
 * Read-only: one artboard listing plus a search per semantic source.
 */
export async function resolveFlowManifest(link: XdLink, manifest: FlowManifest): Promise<ResolvedManifest> {
  const boardsResult = await link.execute("get_artboards", {});
  if (!boardsResult.ok) {
    return {
      ok: false,
      name: manifest.name ?? null,
      home: null,
      edges: [],
      problems: [{
        edge: -1,
        field: "document",
        code: "document_unavailable",
        message: boardsResult.error ?? "could not read artboards from XD",
      }],
      stats: { edgeCount: manifest.edges.length, readyCount: 0, blockedCount: manifest.edges.length, artboardCount: 0 },
    };
  }
  const boards = boardList(boardsResult.result);

  let home: ResolvedManifest["home"] = null;
  if (manifest.home !== undefined) {
    const board = boards.find((b) => b.guid === manifest.home || b.name === manifest.home);
    home = {
      input: manifest.home,
      guid: board && typeof board.guid === "string" ? board.guid : null,
      name: board && typeof board.name === "string" ? board.name : null,
      resolved: !!board,
    };
  }

  const edges: ResolvedEdge[] = [];
  for (let i = 0; i < manifest.edges.length; i++) {
    const edge = manifest.edges[i];
    const problems: ManifestProblem[] = [];
    const sourceNode = await resolveSource(link, edge.source, boards);
    const targetBoard = boards.find((b) => b.guid === edge.target || b.name === edge.target);
    const targetArtboard = resolveTarget(targetBoard, edge.target);

    if (!sourceNode.guid) {
      if (sourceNode.candidates && sourceNode.candidates.length > 1) {
        problems.push({
          edge: i,
          field: "source",
          code: "source-ambiguous",
          message: `${sourceNode.candidates.length} nodes are named "${edge.source}"; use a GUID instead`,
        });
      } else {
        problems.push({
          edge: i,
          field: "source",
          code: "source-not-found",
          message: `no node or artboard matches "${edge.source}"`,
        });
      }
    }
    if (!targetArtboard.guid) {
      problems.push({
        edge: i,
        field: "target",
        code: "target-not-found",
        message: `target "${edge.target}" is not an existing artboard name or GUID`,
      });
    }

    edges.push({
      ...edge,
      trigger: edge.trigger ?? "tap",
      action: edge.action ?? "goToArtboard",
      index: i,
      sourceNode,
      targetArtboard,
      problems,
      ready: problems.length === 0,
    });
  }

  const problems = (home && !home.resolved
    ? [{ edge: -1, field: "home", code: "home-not-found", message: `home artboard "${home.input}" was not found` } as ManifestProblem]
    : []).concat(edges.flatMap((e) => e.problems));

  const readyCount = edges.filter((e) => e.ready).length;
  return {
    ok: problems.length === 0,
    name: manifest.name ?? null,
    home,
    edges,
    problems,
    stats: {
      edgeCount: edges.length,
      readyCount,
      blockedCount: edges.length - readyCount,
      artboardCount: boards.length,
    },
  };
}

