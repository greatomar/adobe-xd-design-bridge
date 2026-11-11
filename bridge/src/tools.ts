/**
 * MCP tool definitions and handlers. Tool names match the mission spec; each
 * is implemented through the validated operation registry and the XD link.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BRIDGE_DIR, EXPORT_DIR, contrastRatio, log } from "./util.ts";
import { XdLink } from "./xd-link.ts";
import { OPERATIONS, validateOperation, OP_KEYS, type OpParams } from "./operations.ts";
import { AssetService } from "./assets/service.ts";
import { DesignContextStore } from "./assets/context.ts";
import { parseSvg } from "./assets/svg.ts";
import { transformPathData } from "./assets/pathdata.ts";
import { ASSET_CATEGORIES } from "./assets/types.ts";
import type { AssetCategory, DesignContext, SearchQuery } from "./assets/types.ts";

export interface McpContent {
  type: "text" | "image";
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface ToolResult {
  content: McpContent[];
  isError?: boolean;
}

interface ToolDef {
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

function text(s: string, isError = false): ToolResult {
  return { content: [{ type: "text", text: s }], isError };
}

function json(v: unknown, isError = false): ToolResult {
  return text(JSON.stringify(v, null, 2), isError);
}

async function opCall(link: XdLink, op: string, params: OpParams): Promise<ToolResult> {
  const r = await link.execute(op, params);
  if (r.ok) return json(r.result ?? {});
  return json({ ok: false, code: r.code ?? "error", error: r.error }, true);
}

const frameSchema = {
  type: "object",
  properties: {
    x: { type: "number" }, y: { type: "number" },
    width: { type: "number" }, height: { type: "number" },
  },
  required: ["x", "y", "width", "height"],
};

const gradientSchema = {
  type: "object",
  properties: {
    type: { enum: ["linear", "radial", "angular"] },
    colorStops: {
      type: "array", minItems: 2, maxItems: 32,
      items: { type: "object", properties: { stop: { type: "number", minimum: 0, maximum: 1 }, color: { type: "string" } }, required: ["stop", "color"] },
    },
    startX: { type: "number" }, startY: { type: "number" }, endX: { type: "number" }, endY: { type: "number" },
    centerX: { type: "number" }, centerY: { type: "number" }, endR: { type: "number", minimum: 0 }, rotation: { type: "number" },
  },
  required: ["type", "colorStops"],
};

const styleSchema = {
  type: "object",
  properties: {
    fill: { type: "string", description: "hex color, e.g. #FFFFFF or #0A1B2E1F (8-digit alpha)" },
    gradient: gradientSchema,
    stroke: { type: "string" },
    strokeWidth: { type: "number", minimum: 0 },
    strokePosition: { enum: ["INNER_STROKE", "OUTER_STROKE", "CENTER_STROKE"] },
    strokeEndCaps: { enum: ["STROKE_CAP_NONE", "STROKE_CAP_SQUARE", "STROKE_CAP_ROUND"] },
    strokeJoins: { enum: ["STROKE_JOIN_BEVEL", "STROKE_JOIN_ROUND", "STROKE_JOIN_MITER"] },
    strokeDashArray: { type: "array", maxItems: 64, items: { type: "number", exclusiveMinimum: 0 } },
    strokeDashOffset: { type: "number" },
    cornerRadius: { type: "number", minimum: 0 },
    opacity: { type: "number", minimum: 0, maximum: 1 },
    shadow: {
      type: "object",
      properties: { x: { type: "number" }, y: { type: "number" }, blur: { type: "number", minimum: 0 }, color: { type: "string" } },
      required: ["x", "y", "blur", "color"],
    },
    innerShadow: {
      type: "object",
      properties: { x: { type: "number" }, y: { type: "number" }, blur: { type: "number", minimum: 0 }, color: { type: "string" } },
      required: ["x", "y", "blur", "color"],
    },
    blur: {
      type: "object",
      properties: { blurAmount: { type: "number", minimum: 0, maximum: 500 }, brightnessDelta: { type: "number" } },
      required: ["blurAmount"],
    },
  },
};

function createShapeTool(link: XdLink, op: string): ToolDef {
  return {
    description: OPERATIONS[op].description,
    inputSchema: {
      type: "object",
      properties: {
        parent: { type: "string", description: "parent artboard/group guid (defaults to document root or active artboard)" },
        name: { type: "string" },
        frame: frameSchema,
        style: styleSchema,
      },
      required: ["frame"],
    },
    // `link` is captured from the caller's scope: buildTools(link). A previous
    // version referenced an undefined `link`, so direct rectangle/ellipse calls
    // threw ReferenceError before reaching the plugin queue.
    handler: (a) => opCall(link, op, a),
  };
}

/** Save base64 PNG to exports dir and produce image + path content. */
function exportContent(base64: string, suggestedName: string, meta: Record<string, unknown>): ToolResult {
  const path = join(EXPORT_DIR, `${suggestedName}.png`);
  try {
    writeFileSync(path, Buffer.from(base64, "base64"));
  } catch (e) {
    log("warn", "export save failed", String(e));
  }
  return {
    content: [
      { type: "image", data: base64, mimeType: "image/png" },
      { type: "text", text: JSON.stringify({ ...meta, path }, null, 2) },
    ],
  };
}

let assetService: AssetService | null = null;
let contextStore: DesignContextStore | null = null;

const assetCacheDir = (): string => process.env.XD_ASSET_CACHE_DIR ?? join(BRIDGE_DIR, "asset-cache");

/** Lazily created so a read-only session never touches the cache directory. */
function assets(): AssetService {
  if (!assetService) assetService = new AssetService({ cacheDir: assetCacheDir() });
  return assetService;
}

function designContext(): DesignContextStore {
  if (!contextStore) contextStore = new DesignContextStore(join(assetCacheDir(), "design-context.json"));
  return contextStore;
}

/** Test seam: inject a service with a fake fetcher and an isolated cache dir. */
export function setAssetService(svc: AssetService | null): void {
  assetService = svc;
  // Keep the context store beside the injected cache so tests are isolated
  // and a project can keep all asset state in one directory.
  contextStore = svc ? new DesignContextStore(join(svc.cache.dir, "design-context.json")) : null;
}

/** Compact, reason-friendly shape for tool output — never a raw blob. */
function briefAsset(a: {
  id: string; name: string; category: string; source: string; format: string[]; style: string[];
  recommended_for: string[]; license: { name: string; commercial_use: string; attribution_required: boolean; uncertain?: boolean; url: string };
}) {
  return {
    id: a.id,
    name: a.name,
    category: a.category,
    source: a.source,
    format: a.format,
    style: a.style,
    recommended_for: a.recommended_for,
    license: {
      name: a.license.name,
      commercial_use: a.license.commercial_use,
      attribution_required: a.license.attribution_required,
      uncertain: a.license.uncertain === true,
      url: a.license.url,
    },
  };
}

export function buildTools(link: XdLink): Record<string, ToolDef> {
  const tools: Record<string, ToolDef> = {
    xd_health: {
      description:
        "Bridge and Adobe XD connection health check. Always call this first. Returns bridge status, XD connection state, bridge request depth, and last plugin event. It does not expose the panel's in-memory write queue.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => json({ ok: true, bridge: { version: "1.0.0" }, link: link.status }),
    },

    xd_get_capabilities: {
      description:
        "Capability discovery: bridge operation names and plugin runtime capabilities. Prototype flows/interactions can be inspected, but authoring wires is not exposed by Adobe XD's public plugin API.",
      inputSchema: { type: "object", properties: {} },
      handler: async () =>
        json({
          ok: true,
          xdConnected: link.isConnected(),
          bridgeOperations: OP_KEYS,
          pluginCapabilities: link.pluginInfo.capabilities ?? null,
          note: "XD's interactions module is read-only. Prototype connections can be inspected and validated, but not authored through the documented public plugin API.",
        }),
    },

    xd_get_document_info: {
      description: "Read active XD DocumentInfo metadata (name/guid) and scenegraph counts. XD does not expose path or modified state here.",
      inputSchema: { type: "object", properties: {} },
      handler: () => opCall(link, "get_document_info", {}),
    },

    xd_get_artboards: {
      description: "List all artboards in the active document with frames, names, and guids.",
      inputSchema: { type: "object", properties: {} },
      handler: () => opCall(link, "get_artboards", {}),
    },

    xd_get_selection: {
      description: "Read the current selection in XD: guids, names, node types, frames.",
      inputSchema: { type: "object", properties: {} },
      handler: () => opCall(link, "get_selection", {}),
    },

    xd_get_prototype_state: {
      description: "Read prototype flows and interaction wires. This is inspection only; XD's documented public API cannot author wires.",
      inputSchema: { type: "object", properties: {} },
      handler: () => opCall(link, "get_prototype_state", {}),
    },

    xd_validate_prototype: {
      description: "Compare required navigation edges with existing prototype connections. Read-only; does not create or modify wires.",
      inputSchema: {
        type: "object",
        properties: { requiredConnections: { type: "array", minItems: 1, maxItems: 500, items: { type: "object", properties: { fromGuid: { type: "string" }, toGuid: { type: "string" }, trigger: { enum: ["tap", "drag", "time", "voice"] }, action: { enum: ["goToArtboard", "overlay"] } }, required: ["fromGuid", "toGuid"] } } },
        required: ["requiredConnections"],
      },
      handler: (a) => opCall(link, "validate_prototype", a),
    },

    xd_audit_screen: {
      description: "Check an artboard against a screen-specific semantic role manifest (every listed type is required). Structural verification only; not a visual-quality claim.",
      inputSchema: {
        type: "object",
        properties: {
          guid: { type: "string" },
          requirements: { type: "array", minItems: 1, maxItems: 50, items: { type: "object", properties: { role: { type: "string" }, types: { type: "array", items: { type: "string" } }, requireNonEmptyText: { type: "boolean" } }, required: ["role"] } },
        },
        required: ["guid", "requirements"],
      },
      handler: (a) => opCall(link, "audit_screen", a),
    },

    xd_inspect_node: {
      description: "Inspect one node by guid: full writable properties, style, and children summary.",
      inputSchema: { type: "object", properties: { guid: { type: "string" } }, required: ["guid"] },
      handler: (a) => opCall(link, "inspect_node", { guid: a.guid }),
    },

    xd_search_nodes: {
      description: "Search nodes by name substring (case-insensitive) and/or scene node type (e.g. Text, Rectangle, Artboard, Group).",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" }, type: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 500 } },
      },
      handler: (a) => opCall(link, "search_nodes", a),
    },

    xd_create_artboard: {
      description: OPERATIONS.create_artboard.description,
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" }, frame: frameSchema },
        required: ["frame"],
      },
      handler: (a) => opCall(link, "create_artboard", a),
    },

    xd_create_rectangle: createShapeTool(link, "create_rectangle"),
    xd_create_ellipse: createShapeTool(link, "create_ellipse"),

    xd_create_line: {
      description: OPERATIONS.create_line.description,
      inputSchema: {
        type: "object",
        properties: {
          parent: { type: "string" }, name: { type: "string" },
          start: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] },
          end: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] },
          style: styleSchema,
        },
        required: ["start", "end", "style"],
      },
      handler: (a) => opCall(link, "create_line", a),
    },

    xd_create_polygon: {
      description: OPERATIONS.create_polygon.description,
      inputSchema: {
        type: "object",
        properties: { parent: { type: "string" }, name: { type: "string" }, frame: frameSchema, cornerCount: { type: "integer", minimum: 3, maximum: 100 }, starRatio: { type: "number", minimum: 1, maximum: 100 }, style: styleSchema },
        required: ["frame"],
      },
      handler: (a) => opCall(link, "create_polygon", a),
    },

    xd_create_path: {
      description: OPERATIONS.create_path.description,
      inputSchema: {
        type: "object",
        properties: { parent: { type: "string" }, name: { type: "string" }, pathData: { type: "string" }, x: { type: "number" }, y: { type: "number" }, position: { enum: ["frame", "absolute"], description: "frame (default) places the path's bounding box at x,y; absolute keeps the supplied coordinates as-is" }, style: styleSchema },
        required: ["pathData", "x", "y"],
      },
      handler: (a) => opCall(link, "create_path", a),
    },

    xd_create_image: {
      description: OPERATIONS.create_image.description,
      inputSchema: { type: "object", properties: { parent: { type: "string" }, name: { type: "string" }, frame: frameSchema, scaleBehavior: { enum: ["cover", "stretch"] } }, required: ["parent", "frame"] },
      handler: (a) => opCall(link, "create_image", a),
    },

    xd_replace_image: {
      description: OPERATIONS.replace_image.description,
      inputSchema: { type: "object", properties: { guid: { type: "string" }, scaleBehavior: { enum: ["cover", "stretch"] } }, required: ["guid"] },
      handler: (a) => opCall(link, "replace_image", a),
    },

    xd_import_asset: {
      description: OPERATIONS.import_asset.description,
      inputSchema: { type: "object", properties: { parent: { type: "string", description: "Explicit Artboard guid" }, name: { type: "string" }, x: { type: "number" }, y: { type: "number" } }, required: ["parent"] },
      handler: (a) => opCall(link, "import_asset", a),
    },

    xd_create_text: {
      description: OPERATIONS.create_text.description,
      inputSchema: {
        type: "object",
        properties: {
          parent: { type: "string" },
          name: { type: "string" },
          text: { type: "string" },
          frame: {
            type: "object",
            properties: { x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" } },
            required: ["x", "y"],
          },
          style: { type: "object", properties: { ...styleSchema.properties, fontFamily: { type: "string" }, fontSize: { type: "number" }, fontStyle: { type: "string", description: "Adobe XD Text.styleRanges fontStyle" }, fontWeight: { type: "string", description: "Compatibility alias for fontStyle" }, lineHeight: { type: "number" }, charSpacing: { type: "number" }, textAlign: { enum: ["left", "center", "right"] }, paragraphSpacing: { type: "number" }, textTransform: { enum: ["none", "uppercase", "lowercase", "titlecase"] }, textScript: { enum: ["none", "superscript", "subscript"] }, underline: { type: "boolean" }, strikethrough: { type: "boolean" }, flipY: { type: "boolean" } } },
        },
        required: ["text"],
      },
      handler: (a) => opCall(link, "create_text", a),
    },

    xd_create_group: {
      description: OPERATIONS.create_group.description,
      inputSchema: { type: "object", properties: { guids: { type: "array", items: { type: "string" } }, name: { type: "string" } }, required: ["guids"] },
      handler: (a) => opCall(link, "create_group", a),
    },

    xd_create_mask_group: {
      description: OPERATIONS.create_mask_group.description,
      inputSchema: { type: "object", properties: { guids: { type: "array", items: { type: "string" } } }, required: ["guids"] },
      handler: (a) => opCall(link, "create_mask_group", a),
    },

    xd_ungroup: {
      description: OPERATIONS.ungroup.description,
      inputSchema: { type: "object", properties: { guid: { type: "string" } }, required: ["guid"] },
      handler: (a) => opCall(link, "ungroup", a),
    },

    xd_duplicate_node: {
      description: OPERATIONS.duplicate_node.description,
      inputSchema: { type: "object", properties: { guid: { type: "string" }, name: { type: "string" }, offset: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] } }, required: ["guid"] },
      handler: (a) => opCall(link, "duplicate_node", a),
    },

    xd_delete_node: {
      description: OPERATIONS.delete_node.description,
      inputSchema: { type: "object", properties: { guid: { type: "string" } }, required: ["guid"] },
      handler: (a) => opCall(link, "delete_node", a),
    },

    xd_reparent_node: {
      description: OPERATIONS.reparent_node.description,
      inputSchema: { type: "object", properties: { guid: { type: "string" }, parent: { type: "string" } }, required: ["guid", "parent"] },
      handler: (a) => opCall(link, "reparent_node", a),
    },

    xd_rotate_node: {
      description: OPERATIONS.rotate_node.description,
      inputSchema: { type: "object", properties: { guid: { type: "string" }, angle: { type: "number" } }, required: ["guid", "angle"] },
      handler: (a) => opCall(link, "rotate_node", a),
    },

    xd_arrange_nodes: {
      description: OPERATIONS.arrange_nodes.description,
      inputSchema: { type: "object", properties: { guids: { type: "array", minItems: 1, items: { type: "string" } }, action: { enum: ["bringToFront", "bringForward", "sendToBack", "sendBackward"] } }, required: ["guids", "action"] },
      handler: (a) => opCall(link, "arrange_nodes", a),
    },

    xd_align_nodes: {
      description: OPERATIONS.align_nodes.description,
      inputSchema: { type: "object", properties: { guids: { type: "array", items: { type: "string" } }, action: { enum: ["alignLeft", "alignRight", "alignHorizontalCenter", "alignTop", "alignBottom", "alignVerticalCenter"] } }, required: ["guids", "action"] },
      handler: (a) => opCall(link, "align_nodes", a),
    },

    xd_distribute_nodes: {
      description: OPERATIONS.distribute_nodes.description,
      inputSchema: { type: "object", properties: { guids: { type: "array", items: { type: "string" } }, action: { enum: ["distributeHorizontal", "distributeVertical"] } }, required: ["guids", "action"] },
      handler: (a) => opCall(link, "distribute_nodes", a),
    },

    xd_create_component: {
      description: OPERATIONS.create_component.description,
      inputSchema: { type: "object", properties: { guid: { type: "string" }, name: { type: "string" } }, required: ["guid"] },
      handler: (a) => opCall(link, "create_component", a),
    },

    xd_update_node: {
      description: OPERATIONS.update_node.description,
      inputSchema: {
        type: "object",
        properties: { guid: { type: "string" }, name: { type: "string" }, style: styleSchema, visible: { type: "boolean" }, locked: { type: "boolean" }, blendMode: { type: "string" }, markedForExport: { type: "boolean" }, fixedWhenScrolling: { type: "boolean" } },
        required: ["guid"],
      },
      handler: (a) => opCall(link, "update_node", a),
    },

    xd_move_node: {
      description: OPERATIONS.move_node.description,
      inputSchema: {
        type: "object",
        properties: { guid: { type: "string" }, x: { type: "number" }, y: { type: "number" }, relative: { type: "boolean" } },
        required: ["guid", "x", "y"],
      },
      handler: (a) => opCall(link, "move_node", a),
    },

    xd_resize_node: {
      description: OPERATIONS.resize_node.description,
      inputSchema: {
        type: "object",
        properties: { guid: { type: "string" }, width: { type: "number" }, height: { type: "number" }, relative: { type: "boolean" } },
        required: ["guid"],
      },
      handler: (a) => opCall(link, "resize_node", a),
    },

    xd_apply_style: {
      description: OPERATIONS.apply_style.description,
      inputSchema: { type: "object", properties: { guid: { type: "string" }, guids: { type: "array", items: { type: "string" } }, style: styleSchema }, required: ["style"] },
      handler: (a) => opCall(link, "apply_style", a),
    },

    xd_update_text: {
      description: OPERATIONS.update_text.description,
      inputSchema: {
        type: "object",
        properties: { guid: { type: "string" }, text: { type: "string" }, style: { type: "object", properties: { ...styleSchema.properties, fontFamily: { type: "string" }, fontSize: { type: "number" }, fontStyle: { type: "string" }, fontWeight: { type: "string" }, lineHeight: { type: "number" }, charSpacing: { type: "number" }, textAlign: { enum: ["left", "center", "right"] }, paragraphSpacing: { type: "number" }, textTransform: { enum: ["none", "uppercase", "lowercase", "titlecase"] }, textScript: { enum: ["none", "superscript", "subscript"] }, underline: { type: "boolean" }, strikethrough: { type: "boolean" }, flipY: { type: "boolean" } } } },
        required: ["guid"],
      },
      handler: (a) => opCall(link, "update_text", a),
    },

    xd_apply_design_tokens: {
      description:
        "Validate and record implementation-independent tokens in root.pluginData; this does not create native XD swatches or character styles. Returns a contrast report for text/background token pairs.",
      inputSchema: { type: "object", properties: { tokens: { type: "object" } }, required: ["tokens"] },
      handler: async (a) => {
        const tokens = a.tokens as Record<string, Record<string, { value: string }>>;
        const r = await link.execute("apply_design_tokens", { tokens });
        const contrast: Array<{ fg: string; bg: string; ratio: number | null; passesAAbody: boolean | null }> = [];
        const color = tokens.color ?? {};
        const fgs = Object.entries(color).filter(([k]) => k.startsWith("text/") || k.includes("/on"));
        const bgs = Object.entries(color).filter(([k]) => k.startsWith("bg/"));
        for (const [fk, fv] of fgs) {
          for (const [bk, bv] of bgs) {
            const ratio = contrastRatio(fv.value, bv.value);
            contrast.push({ fg: fk, bg: bk, ratio, passesAAbody: ratio !== null ? ratio >= 4.5 : null });
          }
        }
        if (!r.ok) return json({ ok: false, code: r.code, error: r.error }, true);
        return json({ ...(r.result as object), contrastReport: contrast });
      },
    },

    xd_create_component_variants: {
      description: OPERATIONS.create_component_variants.description,
      inputSchema: {
        type: "object",
        properties: { guid: { type: "string" }, variants: { type: "array", items: { type: "string" } } },
        required: ["guid", "variants"],
      },
      handler: (a) => opCall(link, "create_component_variants", a),
    },

    xd_inspect_design_consistency: {
      description:
        "Audit the document against an optional token set and accessibility floors: off-token colors, font sizes outside the scale, touch targets below 44x44.",
      inputSchema: { type: "object", properties: { tokens: { type: "object" } } },
      handler: (a) => opCall(link, "inspect_design_consistency", a),
    },

    xd_export_artboard: {
      description: "Export an artboard as PNG (2x default). Returns actual image content plus a saved file path.",
      inputSchema: {
        type: "object",
        properties: { guid: { type: "string" }, name: { type: "string" }, scale: { type: "number", minimum: 0.5, maximum: 4 } },
      },
      handler: async (a) => {
        const r = await link.execute("export_artboard", a);
        if (!r.ok) return json({ ok: false, code: r.code, error: r.error }, true);
        const res = r.result as { base64?: string; width?: number; height?: number; artboardName?: string };
        if (!res?.base64) return json(r.result, true);
        const name = (res.artboardName ?? "artboard").replace(/[^A-Za-z0-9_-]+/g, "_");
        return exportContent(res.base64, `${name}_${Date.now()}`, { width: res.width, height: res.height, scale: a.scale ?? 2 });
      },
    },

    xd_capture_design_preview: {
      description: "Convenience wrapper: export the named artboard at preview scale (1x).",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      handler: async (a) => {
        const r = await link.execute("export_artboard", { name: a.name, scale: 1 });
        if (!r.ok) return json({ ok: false, code: r.code, error: r.error }, true);
        const res = r.result as { base64?: string; width?: number; height?: number };
        if (!res?.base64) return json(r.result, true);
        const name2 = String(a.name).replace(/[^A-Za-z0-9_-]+/g, "_");
        return exportContent(res.base64, `preview_${name2}_${Date.now()}`, { width: res.width, height: res.height, scale: 1 });
      },
    },

    xd_export_selection: {
      description: "Export the current selection as PNG; returns image content plus saved path.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const r = await link.execute("export_selection", {});
        if (!r.ok) return json({ ok: false, code: r.code, error: r.error }, true);
        const res = r.result as { base64?: string; width?: number; height?: number };
        if (!res?.base64) return json(r.result, true);
        return exportContent(res.base64, `selection_${Date.now()}`, { width: res.width, height: res.height });
      },
    },

    xd_validate_document: {
      description: "Structural sanity audit of the document: default layer names, empty groups, zero-size nodes.",
      inputSchema: { type: "object", properties: {} },
      handler: () => opCall(link, "validate_document", {}),
    },

    xd_preview_operation: {
      description:
        "Dry-run: validate an operation or a batch and return the computed preview WITHOUT touching the document. Same input shape as xd_execute_batch.",
      inputSchema: {
        type: "object",
        properties: { operations: { type: "array", minItems: 1, maxItems: 100, items: { type: "object" } } },
        required: ["operations"],
      },
      handler: async (a) => {
        const ops = (a.operations as unknown[]) ?? [];
        const previews: unknown[] = [];
        for (const raw of ops) {
          const v = validateOperation(raw);
          if (!v.ok) return json({ ok: false, error: v.error }, true);
          const spec = OPERATIONS[v.op];
          previews.push({ op: v.op, mutating: spec.mutating, preview: spec.preview(v.params), validatedParams: v.params });
        }
        return json({ ok: true, dryRun: true, count: previews.length, previews });
      },
    },

    xd_execute_operation: {
      description: "Execute a single validated operation in XD. Mutating operations are executed by the plugin inside an editDocument batch and return {queued:true} with the result arriving via events; read-only operations return immediately. Prefer xd_execute_batch for multi-step changes.",
      inputSchema: { type: "object", properties: { operation: { type: "object" } }, required: ["operation"] },
      handler: async (a) => {
        const v = validateOperation(a.operation);
        if (!v.ok) return json({ ok: false, error: v.error }, true);
        const r = await link.execute(v.op, v.params);
        return r.ok ? json(r.result ?? {}) : json({ ok: false, code: r.code, error: r.error }, true);
      },
    },

    xd_execute_batch: {
      description:
        "Execute a list of operations after validating all inputs, then run them serially inside ONE editDocument batch (one undo entry). Mutations are not transactional: earlier successful operations remain if a later handler fails, and remaining operations are aborted. The panel execution event contains per-operation results; inspect the document before any retry.",
      inputSchema: {
        type: "object",
        properties: {
          operations: { type: "array", minItems: 1, maxItems: 100, items: { type: "object" } },
          dryRun: { type: "boolean", description: "validate and preview only" },
        },
        required: ["operations"],
      },
      handler: async (a) => {
        const ops = (a.operations as unknown[]) ?? [];
        if (ops.length === 0) return json({ ok: false, error: "operations must not be empty" }, true);
        const validated: Array<{ op: string; params: OpParams }> = [];
        for (const raw of ops) {
          const v = validateOperation(raw);
          if (!v.ok) return json({ ok: false, error: `validation failed before execution: ${v.error}`, failedIndex: validated.length }, true);
          validated.push({ op: v.op, params: v.params });
        }
        if (a.dryRun === true) {
          return json({
            ok: true,
            dryRun: true,
            count: validated.length,
            previews: validated.map((o) => ({ op: o.op, preview: OPERATIONS[o.op].preview(o.params) })),
          });
        }
        const r = await link.execute("execute_batch", { operations: validated });
        return r.ok ? json(r.result ?? {}) : json({ ok: false, code: r.code, error: r.error }, true);
      },
    },

    xd_update_path: {
      description: OPERATIONS.update_path.description,
      inputSchema: { type: "object", properties: { guid: { type: "string" }, pathData: { type: "string" } }, required: ["guid", "pathData"] },
      handler: (a) => opCall(link, "update_path", a),
    },

    xd_convert_to_path: {
      description: OPERATIONS.convert_to_path.description,
      inputSchema: { type: "object", properties: { guids: { type: "array", items: { type: "string" } } }, required: ["guids"] },
      handler: (a) => opCall(link, "convert_to_path", a),
    },

    xd_outline_stroke: {
      description: OPERATIONS.outline_stroke.description,
      inputSchema: { type: "object", properties: { guids: { type: "array", items: { type: "string" } } }, required: ["guids"] },
      handler: (a) => opCall(link, "outline_stroke", a),
    },

    xd_align_to_pixel_grid: {
      description: OPERATIONS.align_to_pixel_grid.description,
      inputSchema: { type: "object", properties: { guids: { type: "array", items: { type: "string" } } }, required: ["guids"] },
      handler: (a) => opCall(link, "align_to_pixel_grid", a),
    },

    xd_reset_3d_transforms: {
      description: OPERATIONS.reset_3d_transforms.description,
      inputSchema: { type: "object", properties: { guids: { type: "array", items: { type: "string" } } }, required: ["guids"] },
      handler: (a) => opCall(link, "reset_3d_transforms", a),
    },

    xd_make_background: {
      description: OPERATIONS.make_background.description,
      inputSchema: { type: "object", properties: { guid: { type: "string" } }, required: ["guid"] },
      handler: (a) => opCall(link, "make_background", a),
    },

    xd_replace_background: {
      description: OPERATIONS.replace_background.description,
      inputSchema: { type: "object", properties: { guid: { type: "string" } }, required: ["guid"] },
      handler: (a) => opCall(link, "replace_background", a),
    },

    xd_set_layout: {
      description: OPERATIONS.set_layout.description,
      inputSchema: {
        type: "object",
        properties: {
          guid: { type: "string" },
          layout: {
            type: "object",
            properties: {
              type: { enum: ["none", "responsive", "padding", "stack"] },
              stack: {
                type: "object",
                properties: {
                  orientation: { enum: ["horizontal", "vertical"] },
                  spacings: { description: "number, or an array of numbers between stack cells" },
                },
                required: ["orientation"],
              },
              padding: { description: "number, or {top,right,bottom,left}" },
              resizeConstraints: {
                type: "object",
                properties: {
                  type: { enum: ["auto", "manual"] },
                  values: { type: "object", properties: { top: { type: "boolean" }, right: { type: "boolean" }, bottom: { type: "boolean" }, left: { type: "boolean" }, width: { type: "boolean" }, height: { type: "boolean" } } },
                },
                required: ["type"],
              },
            },
            required: ["type"],
          },
        },
        required: ["guid", "layout"],
      },
      handler: (a) => opCall(link, "set_layout", a),
    },

    xd_set_constraints: {
      description: OPERATIONS.set_constraints.description,
      inputSchema: {
        type: "object",
        properties: {
          guid: { type: "string" },
          horizontal: { type: "object", properties: { position: { enum: ["left", "right", "both", "proportional"] }, size: { enum: ["fixed", "resizes"] } }, required: ["position", "size"] },
          vertical: { type: "object", properties: { position: { enum: ["top", "bottom", "both", "proportional"] }, size: { enum: ["fixed", "resizes"] } }, required: ["position", "size"] },
          reset: { type: "boolean", description: "reset constraints to auto (resetToAutoConstraints)" },
        },
        required: ["guid"],
      },
      handler: (a) => opCall(link, "set_constraints", a),
    },

    design_asset_list_sources: {
      description: "List design-asset sources with their integration kind (api | api-key | package | download | reference | manual) and license metadata. Use this before assuming a source can be fetched automatically.",
      inputSchema: {
        type: "object",
        properties: { category: { enum: ASSET_CATEGORIES }, kind: { enum: ["api", "api-key", "package", "download", "reference", "manual"] } },
      },
      handler: async (a) =>
        json({
          ok: true,
          count: assets().listSources({ category: a.category as AssetCategory | undefined, kind: a.kind as never }).length,
          sources: assets().listSources({ category: a.category as AssetCategory | undefined, kind: a.kind as never }),
        }),
    },

    design_asset_list_categories: {
      description: "List asset categories with how many sources cover them and the integration note for that category.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => json({ ok: true, categories: assets().listCategories() }),
    },

    design_asset_search: {
      description: "Semantic asset search. Ranks curated registry records and live icon sets (Iconify: lucide, ph, tabler, heroicons, material-symbols, simple-icons) by relevance, style, license and the current design context. Returns compact records with a score and the reasons for it.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          category: { enum: ASSET_CATEGORIES },
          source: { type: "string" },
          style: { type: "string" },
          format: { enum: ["svg", "png", "json", "woff2", "ttf", "lottie", "rive", "unknown"] },
          license: { enum: ["any", "permissive", "commercial"] },
          limit: { type: "integer", minimum: 1, maximum: 50 },
        },
      },
      handler: async (a) => {
        const stored = designContext().get();
        const q: SearchQuery = {
          query: a.query as string | undefined,
          category: a.category as AssetCategory | undefined,
          source: a.source as string | undefined,
          style: a.style as string | undefined,
          format: a.format as never,
          license: (a.license as SearchQuery["license"]) ?? "any",
          limit: (a.limit as number) ?? 10,
          context: stored,
        };
        const { results, degraded } = await assets().search(q);
        return json({
          ok: true,
          count: results.length,
          degraded: degraded ?? null,
          results: results.map((r) => ({ asset: briefAsset(r.asset), score: r.score, reasons: r.reasons })),
        });
      },
    },

    design_asset_inspect: {
      description: "Inspect one asset by id: full metadata, variants, license, recommended and inappropriate uses. No network call.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      handler: async (a) => {
        const record = await assets().inspect(String(a.id));
        if (!record) return json({ ok: false, error: `unknown asset id: ${a.id}` }, true);
        return json({ ok: true, asset: record });
      },
    },

    design_asset_get: {
      description: "Resolve an asset and cache it locally. Icons return vector metadata plus the cached path; set includeSvg to also return the SVG source. Metadata-only categories return their metadata and a clear reason.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" }, color: { type: "string" }, includeSvg: { type: "boolean" } },
        required: ["id"],
      },
      handler: async (a) => {
        try {
          const got = await assets().get(String(a.id), a.color as string | undefined);
          if (!got) return json({ ok: false, error: `unknown asset id: ${a.id}` }, true);
          const parsed = parseSvg(got.svg);
          return json({
            ok: true,
            asset: briefAsset(got.record),
            cachedPath: got.cachedPath,
            vector: {
              shapes: parsed.shapes.length,
              viewBox: parsed.viewBox,
              unsupported: parsed.unsupported,
            },
            svg: a.includeSvg === true ? got.svg : undefined,
          });
        } catch (e) {
          const err = e as Error & { code?: string };
          return json({ ok: false, code: err.code ?? "asset_error", error: err.message }, true);
        }
      },
    },

    design_asset_license: {
      description: "License and safety check for an asset id or source id: commercial use, attribution, redistribution and whether the terms are confirmed.",
      inputSchema: { type: "object", properties: { identifier: { type: "string" } }, required: ["identifier"] },
      handler: async (a) => {
        const info = assets().license(String(a.identifier));
        if (!info.license) return json({ ok: false, error: `no license known for ${a.identifier}` }, true);
        return json({
          ok: true,
          identifier: a.identifier,
          source: info.source ? { id: info.source.id, name: info.source.name, kind: info.source.kind, homepage: info.source.homepage } : null,
          license: info.license,
          safe_for_production: !info.license.uncertain && info.license.commercial_use === "yes",
        });
      },
    },

    design_asset_recommend: {
      description: "Higher-level recommendation for a design requirement: ranked icon, font and component-pattern candidates with reasons, plus consistency warnings (single icon family, reference-only categories).",
      inputSchema: {
        type: "object",
        properties: {
          product: { type: "string" },
          screen: { type: "string" },
          style: { type: "string" },
          theme: { enum: ["light", "dark", "any"] },
          language: { type: "string" },
          platform: { enum: ["web", "ios", "android", "desktop"] },
        },
      },
      handler: async (a) => {
        const out = await assets().recommend({
          product: a.product as string | undefined,
          screen: a.screen as string | undefined,
          style: a.style as string | undefined,
          theme: a.theme as never,
          language: a.language as string | undefined,
          platform: a.platform as never,
          context: designContext().get(),
        });
        return json({
          ok: true,
          recommendations: out.recommendations.map((r) => ({
            category: r.category,
            pick: r.asset ? briefAsset(r.asset) : null,
            alternatives: r.alternatives.slice(0, 3).map(briefAsset),
            reasons: r.reasons,
          })),
          notes: out.notes,
        });
      },
    },

    design_asset_insert: {
      description: "Insert a vector asset into the active XD document as real editable Path nodes (no rasterisation). Converts SVG geometry to artboard coordinates and queues the existing create_path operations through the normal panel gate.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          parent: { type: "string", description: "artboard/group guid" },
          x: { type: "number", description: "artboard-relative x of the icon box" },
          y: { type: "number" },
          size: { type: "number", description: "box size in px (default 24)" },
          color: { type: "string", description: "hex colour for fill/stroke (default #101114)" },
          name: { type: "string" },
        },
        required: ["id", "parent"],
      },
      handler: async (a) => {
        const parent = String(a.parent);
        const x = typeof a.x === "number" ? a.x : 0;
        const y = typeof a.y === "number" ? a.y : 0;
        const size = typeof a.size === "number" && a.size > 0 ? a.size : 24;
        const color = typeof a.color === "string" ? a.color : "#101114";
        let got;
        try {
          got = await assets().get(String(a.id), color);
        } catch (e) {
          const err = e as Error & { code?: string };
          return json({ ok: false, code: err.code ?? "asset_error", error: err.message }, true);
        }
        if (!got) return json({ ok: false, error: `unknown asset id: ${a.id}` }, true);

        const parsed = parseSvg(got.svg);
        if (parsed.shapes.length === 0) return json({ ok: false, error: "asset contains no drawable vector geometry" }, true);

        const scale = size / Math.max(parsed.viewBox.width || size, 1);
        const baseName = String(a.name ?? got.record.name);

        const operations = parsed.shapes.map((shape, i) => {
          const d = transformPathData(shape.d, {
            sx: scale,
            sy: scale,
            tx: x - parsed.viewBox.x * scale,
            ty: y - parsed.viewBox.y * scale,
          });
          const strokeOnly = !!shape.stroke && shape.stroke !== "none" && (!shape.fill || shape.fill === "none");
          const style = strokeOnly
            ? { stroke: color, strokeWidth: Math.max(0.5, Number(((shape.strokeWidth ?? 2) * scale).toFixed(2))), fill: "#00000000" }
            : { fill: color };
          return {
            op: "create_path",
            parent,
            name: parsed.shapes.length > 1 ? `${baseName} ${i + 1}` : baseName,
            pathData: d,
            x: 0,
            y: 0,
            position: "absolute",
            style,
          };
        });

        const r = await link.execute("execute_batch", { operations });
        if (!r.ok) return json({ ok: false, code: r.code, error: r.error }, true);
        return json({
          ok: true,
          queued: true,
          operations: operations.length,
          asset: briefAsset(got.record),
          placement: { parent, x, y, size, color },
          note: "Queued. The operations apply when the panel executes the queue; verify with xd_inspect_node afterwards.",
        });
      },
    },

    design_asset_apply_font: {
      description: "Set a text node's font family/weight/size from the typography registry. XD can only use fonts installed on the machine; the response states whether the family is a known curated family.",
      inputSchema: {
        type: "object",
        properties: {
          guid: { type: "string" },
          family: { type: "string" },
          style: { type: "string", description: "fontStyle, e.g. Bold / Semibold / Regular" },
          size: { type: "number" },
        },
        required: ["guid", "family"],
      },
      handler: async (a) => {
        const family = String(a.family);
        const known = assets().allRecords().some((r) => r.category === "font" && r.name.toLowerCase() === family.toLowerCase());
        const style: Record<string, unknown> = { fontFamily: family };
        if (a.style) style.fontStyle = a.style;
        if (typeof a.size === "number") style.fontSize = a.size;
        const r = await link.execute("update_text", { guid: String(a.guid), style });
        if (!r.ok) return json({ ok: false, code: r.code, error: r.error }, true);
        return json({
          ok: true,
          queued: true,
          family,
          curated_family: known,
          warning: known ? undefined : "This family is not in the curated registry; confirm it is installed in Adobe XD.",
        });
      },
    },

    design_context_get: {
      description: "Read the persisted design context (product, visual direction, palette, typography, icon style, radius, density, platform, language, RTL). Asset search is ranked against it.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => json({ ok: true, context: designContext().get(), cacheDir: assetCacheDir() }),
    },

    design_context_set: {
      description: "Merge fields into the persisted design context. Once a visual language is chosen, later asset searches stay consistent with it.",
      inputSchema: {
        type: "object",
        properties: {
          product: { type: "string" },
          visual_direction: { type: "string" },
          colors: { type: "array", items: { type: "string" } },
          typography: { type: "string" },
          icon_style: { type: "string" },
          illustration_style: { type: "string" },
          component_style: { type: "string" },
          radius: { type: "number" },
          density: { enum: ["compact", "comfortable", "spacious"] },
          platform: { enum: ["web", "ios", "android", "desktop"] },
          audience: { type: "string" },
          language: { type: "string" },
          direction: { enum: ["ltr", "rtl"] },
          accessibility: { type: "array", items: { type: "string" } },
          clear: { type: "boolean" },
        },
      },
      handler: async (a) => {
        const { clear, ...patch } = a as Record<string, unknown>;
        if (clear === true) designContext().clear();
        const context = designContext().set(patch as DesignContext);
        return json({ ok: true, context });
      },
    },

    xd_get_operation_status: {
      description: "Report bridge in-flight request count and the last executed batch result. The plugin panel's in-memory pending queue depth is not exposed by this API.",
      inputSchema: { type: "object", properties: {} },
      handler: () =>
        json({
          ok: true,
          xdConnected: link.isConnected(),
          pendingRequests: link.status.pendingRequests,
          lastEvent: link.lastEvent,
        }),
    },
  };
  return tools;
}

export function toolList(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  // schema objects are static; safe to build once per call
  const link = null as unknown as XdLink;
  const tools = buildTools(link);
  return Object.entries(tools).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema }));
}
