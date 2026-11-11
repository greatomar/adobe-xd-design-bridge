/**
 * Operation registry: every document operation the XD plugin can execute,
 * with strict parameter validation and dry-run support. Operations not listed
 * here are rejected — arbitrary code execution is impossible by design.
 */
import { parseColor } from "./util.ts";

export interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TextStyle {
  fontFamily?: string;
  fontStyle?: string;
  fontSize?: number;
  fontWeight?: string;
  fill?: string;
  lineHeight?: number;
  charSpacing?: number;
  textAlign?: "left" | "center" | "right";
  /** distance added after a hard line break (Text.paragraphSpacing) */
  paragraphSpacing?: number;
  textTransform?: "none" | "uppercase" | "lowercase" | "titlecase";
  /** "superscript" | "subscript" | "none" (Text.textScript) */
  textScript?: "none" | "superscript" | "subscript";
  underline?: boolean;
  strikethrough?: boolean;
  flipY?: boolean;
}

export interface NodeStyle {
  fill?: string;
  gradient?: {
    type: "linear" | "radial" | "angular";
    colorStops: Array<{ stop: number; color: string }>;
    startX?: number;
    startY?: number;
    endX?: number;
    endY?: number;
    centerX?: number;
    centerY?: number;
    endR?: number;
    rotation?: number;
  };
  stroke?: string;
  strokeWidth?: number;
  strokePosition?: "INNER_STROKE" | "OUTER_STROKE" | "CENTER_STROKE";
  strokeEndCaps?: "STROKE_CAP_NONE" | "STROKE_CAP_SQUARE" | "STROKE_CAP_ROUND";
  strokeJoins?: "STROKE_JOIN_BEVEL" | "STROKE_JOIN_ROUND" | "STROKE_JOIN_MITER";
  strokeDashArray?: number[];
  strokeDashOffset?: number;
  cornerRadius?: number;
  opacity?: number;
  shadow?: { x: number; y: number; blur: number; color: string };
  innerShadow?: { x: number; y: number; blur: number; color: string };
  blur?: { blurAmount: number; brightnessDelta?: number };
}

export type OpParams = Record<string, unknown>;

export interface OpResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  code?: string;
}

export interface OpSpec {
  /** short op key used in the wire protocol */
  op: string;
  description: string;
  /** mutating = requires editDocument on the plugin side */
  mutating: boolean;
  validate: (p: OpParams) => { ok: true; params: OpParams } | { ok: false; error: string };
  /** human-readable summary for dry-run previews */
  preview: (p: OpParams) => string;
}

// --- validation helpers -----------------------------------------------------

function num(v: unknown, name: string, opts: { min?: number; max?: number; int?: boolean } = {}): string | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return `${name} must be a finite number`;
  if (opts.int && !Number.isInteger(v)) return `${name} must be an integer`;
  if (opts.min !== undefined && v < opts.min) return `${name} must be >= ${opts.min}`;
  if (opts.max !== undefined && v > opts.max) return `${name} must be <= ${opts.max}`;
  return null;
}

function str(v: unknown, name: string, maxLen = 4096): string | null {
  if (typeof v !== "string") return `${name} must be a string`;
  if (v.length > maxLen) return `${name} exceeds maximum length ${maxLen}`;
  return null;
}

function optStr(p: OpParams, name: string, maxLen = 4096): { error?: string; value?: string } {
  if (p[name] === undefined) return {};
  const e = str(p[name], name, maxLen);
  return e ? { error: e } : { value: p[name] as string };
}

function optNum(p: OpParams, name: string, opts: { min?: number; max?: number; int?: boolean } = {}): { error?: string; value?: number } {
  if (p[name] === undefined) return {};
  const e = num(p[name], name, opts);
  return e ? { error: e } : { value: p[name] as number };
}

function hexColor(v: unknown, name: string): string | null {
  if (typeof v !== "string") return `${name} must be a hex color string`;
  if (!parseColor(v)) return `${name} is not a valid hex color`;
  return null;
}

function frame(f: unknown, requireSize: true): { ok?: Frame; error?: string };
function frame(f: unknown, requireSize: false): { ok?: Partial<Frame>; error?: string };
function frame(f: unknown, requireSize: boolean): { ok?: Partial<Frame>; error?: string } {
  if (typeof f !== "object" || f === null) return { error: "frame must be an object {x,y,width,height}" };
  const o = f as Record<string, unknown>;
  const out: Partial<Frame> = {};
  for (const k of ["x", "y"] as const) {
    if (typeof o[k] !== "number" || !Number.isFinite(o[k])) return { error: `frame.${k} must be a number` };
    out[k] = o[k] as number;
  }
  for (const k of ["width", "height"] as const) {
    if (requireSize || o[k] !== undefined) {
      if (typeof o[k] !== "number" || !Number.isFinite(o[k]) || (o[k] as number) < 0.1 || (o[k] as number) > 20000) {
        return { error: `frame.${k} must be a number between 0.1 and 20000` };
      }
      out[k] = o[k] as number;
    }
  }
  // Preserve omitted dimensions for point text. Materializing them as zero made
  // validation non-idempotent: execute_batch validates an already-normalized
  // create_text operation a second time and rejected width/height 0.
  return { ok: requireSize ? (out as Frame) : out };
}

function validateStyle(s: unknown): { error?: string; value?: NodeStyle } {
  if (s === undefined) return {};
  if (typeof s !== "object" || s === null) return { error: "style must be an object" };
  const o = s as Record<string, unknown>;
  const v: NodeStyle = {};
  for (const key of ["fill", "stroke"] as const) {
    if (o[key] !== undefined) {
      const e = hexColor(o[key], `style.${key}`);
      if (e) return { error: e };
      (v as Record<string, unknown>)[key] = o[key];
    }
  }
  if (o.gradient !== undefined) {
    if (o.fill !== undefined) return { error: "style.gradient and style.fill are mutually exclusive" };
    if (typeof o.gradient !== "object" || o.gradient === null) return { error: "style.gradient must be an object" };
    const gradient = o.gradient as Record<string, unknown>;
    if (!["linear", "radial", "angular"].includes(gradient.type as string)) return { error: "style.gradient.type must be linear|radial|angular" };
    if (!Array.isArray(gradient.colorStops) || gradient.colorStops.length < 2 || gradient.colorStops.length > 32) return { error: "style.gradient.colorStops must contain 2–32 stops" };
    const colorStops: Array<{ stop: number; color: string }> = [];
    let prior = -1;
    for (let i = 0; i < gradient.colorStops.length; i++) {
      const stop = gradient.colorStops[i] as Record<string, unknown>;
      if (!stop || typeof stop !== "object") return { error: `style.gradient.colorStops[${i}] must be an object` };
      const eStop = num(stop.stop, `style.gradient.colorStops[${i}].stop`, { min: 0, max: 1 });
      if (eStop) return { error: eStop };
      if ((stop.stop as number) < prior) return { error: "style.gradient.colorStops must be sorted by stop" };
      const eColor = hexColor(stop.color, `style.gradient.colorStops[${i}].color`);
      if (eColor) return { error: eColor };
      colorStops.push({ stop: stop.stop as number, color: stop.color as string });
      prior = stop.stop as number;
    }
    const coordinate = (key: string, fallback: number, min = -10, max = 10) => {
      if (gradient[key] === undefined) return { value: fallback };
      const error = num(gradient[key], `style.gradient.${key}`, { min, max });
      return error ? { error } : { value: gradient[key] as number };
    };
    const out: NodeStyle["gradient"] = { type: gradient.type as "linear" | "radial" | "angular", colorStops };
    if (gradient.type === "linear") {
      const sx = coordinate("startX", 0), sy = coordinate("startY", 0), ex = coordinate("endX", 1), ey = coordinate("endY", 1);
      const err = sx.error || sy.error || ex.error || ey.error;
      if (err) return { error: err };
      out.startX = sx.value; out.startY = sy.value; out.endX = ex.value; out.endY = ey.value;
    } else if (gradient.type === "radial") {
      const cx = coordinate("centerX", 0.5), cy = coordinate("centerY", 0.5);
      const radius = optNum(gradient, "endR", { min: 0, max: 10 });
      const err = cx.error || cy.error || radius.error;
      if (err) return { error: err };
      out.centerX = cx.value; out.centerY = cy.value; out.endR = radius.value ?? 1;
    } else {
      const sx = coordinate("startX", 0.5), sy = coordinate("startY", 0.5), ex = coordinate("endX", 1), ey = coordinate("endY", 0.5);
      const rotation = optNum(gradient, "rotation", { min: -3600, max: 3600 });
      const err = sx.error || sy.error || ex.error || ey.error || rotation.error;
      if (err) return { error: err };
      out.startX = sx.value; out.startY = sy.value; out.endX = ex.value; out.endY = ey.value; out.rotation = rotation.value ?? 0;
    }
    v.gradient = out;
  }
  const r = optNum(o, "strokeWidth", { min: 0, max: 1000 });
  if (r.error) return { error: r.error };
  if (r.value !== undefined) v.strokeWidth = r.value;
  const enumStyle = (key: string, allowed: string[]) => {
    if (o[key] === undefined) return {} as { value?: string; error?: string };
    return typeof o[key] === "string" && allowed.includes(o[key] as string)
      ? { value: o[key] as string }
      : { error: `style.${key} must be one of ${allowed.join("|")}` };
  };
  for (const [key, allowed] of [
    ["strokePosition", ["INNER_STROKE", "OUTER_STROKE", "CENTER_STROKE"]],
    ["strokeEndCaps", ["STROKE_CAP_NONE", "STROKE_CAP_SQUARE", "STROKE_CAP_ROUND"]],
    ["strokeJoins", ["STROKE_JOIN_BEVEL", "STROKE_JOIN_ROUND", "STROKE_JOIN_MITER"]],
  ] as Array<[string, string[]]>) {
    const result = enumStyle(key, allowed);
    if (result.error) return { error: result.error };
    if (result.value !== undefined) (v as Record<string, unknown>)[key] = result.value;
  }
  if (o.strokeDashArray !== undefined) {
    if (!Array.isArray(o.strokeDashArray) || o.strokeDashArray.length > 64) return { error: "style.strokeDashArray must be an array of at most 64 positive lengths" };
    for (let i = 0; i < o.strokeDashArray.length; i++) {
      const e = num(o.strokeDashArray[i], `style.strokeDashArray[${i}]`, { min: 0.1, max: 20000 });
      if (e) return { error: e };
    }
    v.strokeDashArray = o.strokeDashArray as number[];
  }
  const dashOffset = optNum(o, "strokeDashOffset", { min: -20000, max: 20000 });
  if (dashOffset.error) return { error: dashOffset.error };
  if (dashOffset.value !== undefined) v.strokeDashOffset = dashOffset.value;
  const rad = optNum(o, "cornerRadius", { min: 0, max: 10000 });
  if (rad.error) return { error: rad.error };
  if (rad.value !== undefined) v.cornerRadius = rad.value;
  const op = optNum(o, "opacity", { min: 0, max: 1 });
  if (op.error) return { error: op.error };
  if (op.value !== undefined) v.opacity = op.value;
  if (o.shadow !== undefined) {
    const sh = o.shadow as Record<string, unknown>;
    if (typeof sh !== "object" || sh === null) return { error: "style.shadow must be an object" };
    const e0 = num(sh.x, "shadow.x");
    if (e0) return { error: e0 };
    const e1 = num(sh.y, "shadow.y");
    if (e1) return { error: e1 };
    const e2 = num(sh.blur, "shadow.blur", { min: 0 });
    if (e2) return { error: e2 };
    const e3 = hexColor(sh.color, "shadow.color");
    if (e3) return { error: e3 };
    v.shadow = { x: sh.x as number, y: sh.y as number, blur: sh.blur as number, color: sh.color as string };
  }
  if (o.innerShadow !== undefined) {
    const sh = o.innerShadow as Record<string, unknown>;
    if (typeof sh !== "object" || sh === null) return { error: "style.innerShadow must be an object" };
    const e0 = num(sh.x, "innerShadow.x");
    if (e0) return { error: e0 };
    const e1 = num(sh.y, "innerShadow.y");
    if (e1) return { error: e1 };
    const e2 = num(sh.blur, "innerShadow.blur", { min: 0 });
    if (e2) return { error: e2 };
    const e3 = hexColor(sh.color, "innerShadow.color");
    if (e3) return { error: e3 };
    v.innerShadow = { x: sh.x as number, y: sh.y as number, blur: sh.blur as number, color: sh.color as string };
  }
  if (o.blur !== undefined) {
    const bl = o.blur as Record<string, unknown>;
    if (typeof bl !== "object" || bl === null) return { error: "style.blur must be an object" };
    const e = num(bl.blurAmount, "blur.blurAmount", { min: 0, max: 500 });
    if (e) return { error: e };
    v.blur = { blurAmount: bl.blurAmount as number, brightnessDelta: typeof bl.brightnessDelta === "number" ? bl.brightnessDelta : undefined };
  }
  return { value: v };
}

function validateTextStyle(s: unknown): { error?: string; value?: TextStyle } {
  if (s === undefined) return {};
  const base = validateStyle(s);
  if (base.error) return base;
  if (base.value?.gradient) return { error: "Text nodes support solid-color fill only; gradients are not supported" };
  const o = s as Record<string, unknown>;
  const v: TextStyle = { ...(base.value ?? {}) };
  const ff = optStr(o, "fontFamily", 256);
  if (ff.error) return { error: ff.error };
  if (ff.value !== undefined) v.fontFamily = ff.value;
  const fs = optNum(o, "fontSize", { min: 1, max: 2000 });
  if (fs.error) return { error: fs.error };
  if (fs.value !== undefined) v.fontSize = fs.value;
  const fstyle = optStr(o, "fontStyle", 64);
  if (fstyle.error) return { error: fstyle.error };
  const fweight = optStr(o, "fontWeight", 64);
  if (fweight.error) return { error: fweight.error };
  // Keep fontWeight as a compatibility alias, but normalize to the documented XD key.
  if (fstyle.value !== undefined || fweight.value !== undefined) v.fontStyle = fstyle.value ?? fweight.value;
  const lh = optNum(o, "lineHeight", { min: 1, max: 4000 });
  if (lh.error) return { error: lh.error };
  if (lh.value !== undefined) v.lineHeight = lh.value;
  const cs = optNum(o, "charSpacing", { min: -500, max: 5000 });
  if (cs.error) return { error: cs.error };
  if (cs.value !== undefined) v.charSpacing = cs.value;
  if (o.textAlign !== undefined) {
    if (!["left", "center", "right"].includes(o.textAlign as string)) {
      return { error: "textAlign must be left|center|right" };
    }
    v.textAlign = o.textAlign as TextStyle["textAlign"];
  }
  const ps = optNum(o, "paragraphSpacing", { min: 0, max: 4000 });
  if (ps.error) return { error: ps.error };
  if (ps.value !== undefined) v.paragraphSpacing = ps.value;
  if (o.textTransform !== undefined) {
    if (!["none", "uppercase", "lowercase", "titlecase"].includes(o.textTransform as string)) {
      return { error: "textTransform must be none|uppercase|lowercase|titlecase" };
    }
    v.textTransform = o.textTransform as TextStyle["textTransform"];
  }
  if (o.textScript !== undefined) {
    if (!["none", "superscript", "subscript"].includes(o.textScript as string)) {
      return { error: "textScript must be none|superscript|subscript" };
    }
    v.textScript = o.textScript as TextStyle["textScript"];
  }
  for (const key of ["underline", "strikethrough", "flipY"] as const) {
    if (o[key] === undefined) continue;
    if (typeof o[key] !== "boolean") return { error: `${key} must be boolean` };
    v[key] = o[key] as boolean;
  }
  return { value: v };
}

function validateGuids(p: OpParams, field = "guids", min = 1): { error?: string; value?: string[] } {
  const g = p[field];
  if (!Array.isArray(g) || g.length < min) return { error: `${field} must be an array of at least ${min} guid string(s)` };
  for (const item of g) {
    if (typeof item !== "string" || item.length === 0 || item.length > 256) {
      return { error: `${field} entries must be non-empty guid strings` };
    }
  }
  return { value: g as string[] };
}

function optGuid(p: OpParams, name: string): { error?: string; value?: string } {
  const v = p[name];
  if (v === undefined) return {};
  if (typeof v !== "string" || v.length === 0 || v.length > 256) return { error: `${name} must be a non-empty guid string` };
  return { value: v };
}

export const BLEND_MODES = [
  "BLEND_MODE_PASSTHROUGH", "BLEND_MODE_NORMAL", "BLEND_MODE_MULTIPLY", "BLEND_MODE_DARKEN",
  "BLEND_MODE_COLOR_BURN", "BLEND_MODE_LIGHTEN", "BLEND_MODE_SCREEN", "BLEND_MODE_COLOR_DODGE",
  "BLEND_MODE_OVERLAY", "BLEND_MODE_SOFT_LIGHT", "BLEND_MODE_HARD_LIGHT", "BLEND_MODE_DIFFERENCE",
  "BLEND_MODE_EXCLUSION", "BLEND_MODE_HUE", "BLEND_MODE_SATURATION", "BLEND_MODE_COLOR",
  "BLEND_MODE_LUMINOSITY",
] as const;

function clean(p: OpParams): OpParams {
  const out: OpParams = {};
  for (const [k, v] of Object.entries(p)) if (v !== undefined) out[k] = v;
  return out;
}

// --- op definitions ----------------------------------------------------------

const createShape = (op: string, description: string): OpSpec => ({
  op,
  description,
  mutating: true,
  validate: (p) => {
    const f = frame(p.frame, true);
    if (f.error) return { ok: false as const, error: f.error };
    const nm = optStr(p, "name", 256);
    if (nm.error) return { ok: false as const, error: nm.error };
    const st = validateStyle(p.style);
    if (st.error) return { ok: false as const, error: st.error };
    const parent = optGuid(p, "parent");
    if (parent.error) return { ok: false as const, error: parent.error };
    return { ok: true as const, params: clean({ frame: f.ok, name: nm.value, style: st.value, parent: parent.value }) };
  },
  preview: (p) => `${op} ${String((p.name as string) ?? "")} @ ${JSON.stringify(p.frame)}`,
});

export const OPERATIONS: Record<string, OpSpec> = {
  get_document_info: {
    op: "get_document_info",
    description: "Read active document metadata and scenegraph counts. XD DocumentInfo exposes name and guid; path and modified state are unavailable.",
    mutating: false,
    validate: () => ({ ok: true, params: {} }),
    preview: () => "get_document_info",
  },
  get_artboards: {
    op: "get_artboards",
    description: "List all artboards with frames and coordinates.",
    mutating: false,
    validate: () => ({ ok: true, params: {} }),
    preview: () => "get_artboards",
  },
  get_selection: {
    op: "get_selection",
    description: "Read the current selection (guids, names, types, frames).",
    mutating: false,
    validate: () => ({ ok: true, params: {} }),
    preview: () => "get_selection",
  },
  inspect_node: {
    op: "inspect_node",
    description: "Full property dump of one node by guid.",
    mutating: false,
    validate: (p) => {
      const g = optGuid(p, "guid");
      return g.error ? { ok: false, error: g.error } : { ok: true, params: { guid: g.value } };
    },
    preview: (p) => `inspect_node ${String(p.guid)}`,
  },
  search_nodes: {
    op: "search_nodes",
    description: "Find nodes by name substring and/or scene node type.",
    mutating: false,
    validate: (p) => {
      const q = optStr(p, "query", 256);
      if (q.error) return { ok: false, error: q.error };
      const type = optStr(p, "type", 64);
      if (type.error) return { ok: false, error: type.error };
      if (q.value === undefined && type.value === undefined) {
        return { ok: false, error: "provide query and/or type" };
      }
      const limit = optNum(p, "limit", { min: 1, max: 500, int: true });
      if (limit.error) return { ok: false, error: limit.error };
      return { ok: true, params: clean({ query: q.value, type: type.value, limit: limit.value ?? 50 }) };
    },
    preview: (p) => `search_nodes "${String(p.query ?? "")}" type=${String(p.type ?? "*")}`,
  },
  create_artboard: {
    op: "create_artboard",
    description: "Create a new artboard with frame and name.",
    mutating: true,
    validate: (p) => {
      const f = frame(p.frame, true);
      if (f.error) return { ok: false, error: f.error };
      const nm = optStr(p, "name", 256);
      if (nm.error) return { ok: false, error: nm.error };
      return { ok: true, params: clean({ frame: f.ok, name: nm.value }) };
    },
    preview: (p) => `create_artboard "${String(p.name ?? "")}" ${JSON.stringify(p.frame)}`,
  },
  create_rectangle: createShape("create_rectangle", "Create a rectangle (optionally a corner-radius card)."),
  create_ellipse: createShape("create_ellipse", "Create an ellipse (circle when width == height)."),
  create_text: {
    op: "create_text",
    description: "Create a text node (point text sized by content, or fixed frame).",
    mutating: true,
    validate: (p) => {
      const t = str(p.text, "text", 8192);
      if (t) return { ok: false, error: t };
      const st = validateTextStyle(p.style);
      if (st.error) return { ok: false, error: st.error };
      const f = frame(p.frame, false);
      if (f.error) return { ok: false, error: f.error };
      const nm = optStr(p, "name", 256);
      if (nm.error) return { ok: false, error: nm.error };
      const parent = optGuid(p, "parent");
      if (parent.error) return { ok: false, error: parent.error };
      return { ok: true, params: clean({ text: p.text, frame: f.ok, style: st.value, name: nm.value, parent: parent.value }) };
    },
    preview: (p) => `create_text "${String(p.text).slice(0, 40)}"`,
  },
  create_line: {
    op: "create_line",
    description: "Create a native Line node between parent-relative endpoints.",
    mutating: true,
    validate: (p) => {
      const point = (v: unknown, name: string): { value?: { x: number; y: number }; error?: string } => {
        if (typeof v !== "object" || v === null) return { error: `${name} must be an {x,y} point` };
        const o = v as Record<string, unknown>;
        const ex = num(o.x, `${name}.x`);
        if (ex) return { error: ex };
        const ey = num(o.y, `${name}.y`);
        if (ey) return { error: ey };
        return { value: { x: o.x as number, y: o.y as number } };
      };
      const start = point(p.start, "start");
      if (start.error) return { ok: false, error: start.error };
      const end = point(p.end, "end");
      if (end.error) return { ok: false, error: end.error };
      const parent = optGuid(p, "parent");
      if (parent.error) return { ok: false, error: parent.error };
      const nm = optStr(p, "name", 256);
      if (nm.error) return { ok: false, error: nm.error };
      const st = validateStyle(p.style);
      if (st.error) return { ok: false, error: st.error };
      if (!st.value?.stroke) return { ok: false, error: "style.stroke is required for a visible Line" };
      return { ok: true, params: clean({ start: start.value, end: end.value, parent: parent.value, name: nm.value, style: st.value }) };
    },
    preview: (p) => `create_line ${JSON.stringify(p.start)} → ${JSON.stringify(p.end)}`,
  },
  create_polygon: {
    op: "create_polygon",
    description: "Create a native polygon or star shape.",
    mutating: true,
    validate: (p) => {
      const f = frame(p.frame, true);
      if (f.error) return { ok: false, error: f.error };
      const parent = optGuid(p, "parent");
      if (parent.error) return { ok: false, error: parent.error };
      const nm = optStr(p, "name", 256);
      if (nm.error) return { ok: false, error: nm.error };
      const corners = optNum(p, "cornerCount", { min: 3, max: 100, int: true });
      if (corners.error) return { ok: false, error: corners.error };
      const ratio = optNum(p, "starRatio", { min: 1, max: 100 });
      if (ratio.error) return { ok: false, error: ratio.error };
      const st = validateStyle(p.style);
      if (st.error) return { ok: false, error: st.error };
      return { ok: true, params: clean({ frame: f.ok, parent: parent.value, name: nm.value, cornerCount: corners.value, starRatio: ratio.value, style: st.value }) };
    },
    preview: (p) => `create_polygon ${String(p.cornerCount ?? 3)} sides @ ${JSON.stringify(p.frame)}`,
  },
  create_path: {
    op: "create_path",
    description: "Create a native editable Path from SVG path-data syntax (not arbitrary SVG/XML).",
    mutating: true,
    validate: (p) => {
      const d = str(p.pathData, "pathData", 8192);
      if (d) return { ok: false, error: d };
      if (!/^[MmLlHhVvCcSsQqTtAaZz0-9eE+.,\s-]+$/.test(p.pathData as string)) {
        return { ok: false, error: "pathData may contain only SVG path commands and numeric coordinates" };
      }
      const x = num(p.x, "x");
      if (x) return { ok: false, error: x };
      const y = num(p.y, "y");
      if (y) return { ok: false, error: y };
      const parent = optGuid(p, "parent");
      if (parent.error) return { ok: false, error: parent.error };
      const nm = optStr(p, "name", 256);
      if (nm.error) return { ok: false, error: nm.error };
      const st = validateStyle(p.style);
      if (st.error) return { ok: false, error: st.error };
      if (p.position !== undefined && p.position !== "frame" && p.position !== "absolute") {
        return { ok: false, error: "position must be frame|absolute" };
      }
      return { ok: true, params: clean({ pathData: p.pathData, x: p.x, y: p.y, parent: parent.value, name: nm.value, style: st.value, position: p.position }) };
    },
    preview: (p) => `create_path ${String(p.name ?? "")} @ ${p.x},${p.y}${p.position === "absolute" ? " (absolute)" : ""}`,
  },
  create_image: {
    op: "create_image",
    description: "Create a native image-filled Rectangle from a user-selected PNG/JPEG/GIF inside an explicit parent using ImageFill.",
    mutating: true,
    validate: (p) => {
      const f = frame(p.frame, true);
      if (f.error) return { ok: false, error: f.error };
      const parent = optGuid(p, "parent");
      if (parent.error) return { ok: false, error: parent.error };
      if (!parent.value) return { ok: false, error: "parent artboard/group guid is required" };
      const nm = optStr(p, "name", 256);
      if (nm.error) return { ok: false, error: nm.error };
      const behavior = p.scaleBehavior === undefined ? "cover" : p.scaleBehavior;
      if (behavior !== "cover" && behavior !== "stretch") return { ok: false, error: "scaleBehavior must be cover|stretch" };
      return { ok: true, params: clean({ frame: f.ok, parent: parent.value, name: nm.value, scaleBehavior: behavior }) };
    },
    preview: (p) => `create_image ${String(p.name ?? "")} @ ${JSON.stringify(p.frame)}`,
  },
  replace_image: {
    op: "replace_image",
    description: "Replace the ImageFill on one existing native shape using a user-selected PNG/JPEG/GIF; preserves the node and frame.",
    mutating: true,
    validate: (p) => {
      const g = optGuid(p, "guid");
      if (g.error) return { ok: false, error: g.error };
      if (!g.value) return { ok: false, error: "guid is required" };
      const behavior = p.scaleBehavior === undefined ? "cover" : p.scaleBehavior;
      if (behavior !== "cover" && behavior !== "stretch") return { ok: false, error: "scaleBehavior must be cover|stretch" };
      return { ok: true, params: { guid: g.value, scaleBehavior: behavior } };
    },
    preview: (p) => `replace_image ${String(p.guid)}`,
  },
  import_asset: {
    op: "import_asset",
    description: "Import a user-selected supported asset into an explicit Artboard using XD's native importer and file picker. No arbitrary filesystem path is accepted.",
    mutating: true,
    validate: (p) => {
      const parent = optGuid(p, "parent");
      if (parent.error) return { ok: false, error: parent.error };
      if (!parent.value) return { ok: false, error: "parent artboard/group guid is required" };
      const nm = optStr(p, "name", 256);
      if (nm.error) return { ok: false, error: nm.error };
      const x = optNum(p, "x");
      if (x.error) return { ok: false, error: x.error };
      const y = optNum(p, "y");
      if (y.error) return { ok: false, error: y.error };
      return { ok: true, params: clean({ parent: parent.value, name: nm.value, x: x.value, y: y.value }) };
    },
    preview: (p) => `import_asset into ${String(p.parent)}${p.name ? ` as ${String(p.name)}` : ""}`,
  },
  create_group: {
    op: "create_group",
    description: "Group existing nodes by guid list (must share one parent).",
    mutating: true,
    validate: (p) => {
      const g = validateGuids(p, "guids", 2);
      if (g.error) return { ok: false, error: g.error };
      const nm = optStr(p, "name", 256);
      if (nm.error) return { ok: false, error: nm.error };
      return { ok: true, params: clean({ guids: g.value, name: nm.value }) };
    },
    preview: (p) => `create_group [${(p.guids as string[])?.length} nodes]`,
  },
  create_mask_group: {
    op: "create_mask_group",
    description: "Create a native mask group from at least two same-parent nodes; XD uses the highest z-order selected node as the mask.",
    mutating: true,
    validate: (p) => {
      const g = validateGuids(p, "guids", 2);
      return g.error ? { ok: false, error: g.error } : { ok: true, params: { guids: g.value } };
    },
    preview: (p) => `create_mask_group [${(p.guids as string[])?.length} nodes]`,
  },
  ungroup: {
    op: "ungroup",
    description: "Ungroup one native Group by guid.",
    mutating: true,
    validate: (p) => {
      const g = optGuid(p, "guid");
      if (g.error) return { ok: false, error: g.error };
      return g.value ? { ok: true, params: { guid: g.value } } : { ok: false, error: "guid is required" };
    },
    preview: (p) => `ungroup ${String(p.guid)}`,
  },
  duplicate_node: {
    op: "duplicate_node",
    description: "Duplicate one selected node using the documented XD Duplicate command; optional offset/name applies to the duplicate.",
    mutating: true,
    validate: (p) => {
      const g = optGuid(p, "guid");
      if (g.error) return { ok: false, error: g.error };
      if (!g.value) return { ok: false, error: "guid is required" };
      const nm = optStr(p, "name", 256);
      if (nm.error) return { ok: false, error: nm.error };
      let offset: { x: number; y: number } | undefined;
      if (p.offset !== undefined) {
        if (typeof p.offset !== "object" || p.offset === null) return { ok: false, error: "offset must be an {x,y} object" };
        const o = p.offset as Record<string, unknown>;
        const ex = num(o.x, "offset.x");
        if (ex) return { ok: false, error: ex };
        const ey = num(o.y, "offset.y");
        if (ey) return { ok: false, error: ey };
        offset = { x: o.x as number, y: o.y as number };
      }
      return { ok: true, params: clean({ guid: g.value, name: nm.value, offset }) };
    },
    preview: (p) => `duplicate_node ${String(p.guid)}`,
  },
  delete_node: {
    op: "delete_node",
    description: "Remove one exact node by guid. Destructive; never use without explicit scope/authorization.",
    mutating: true,
    validate: (p) => {
      const g = optGuid(p, "guid");
      if (g.error) return { ok: false, error: g.error };
      return g.value ? { ok: true, params: { guid: g.value } } : { ok: false, error: "guid is required" };
    },
    preview: (p) => `delete_node ${String(p.guid)}`,
  },
  reparent_node: {
    op: "reparent_node",
    description: "Move a leaf node to another container in the same document.",
    mutating: true,
    validate: (p) => {
      const g = optGuid(p, "guid");
      if (g.error) return { ok: false, error: g.error };
      if (!g.value) return { ok: false, error: "guid is required" };
      const parent = optGuid(p, "parent");
      if (parent.error) return { ok: false, error: parent.error };
      if (!parent.value) return { ok: false, error: "parent is required" };
      return { ok: true, params: { guid: g.value, parent: parent.value } };
    },
    preview: (p) => `reparent_node ${String(p.guid)} → ${String(p.parent)}`,
  },
  rotate_node: {
    op: "rotate_node",
    description: "Rotate a node clockwise around its local center by a delta in degrees.",
    mutating: true,
    validate: (p) => {
      const g = optGuid(p, "guid");
      if (g.error) return { ok: false, error: g.error };
      if (!g.value) return { ok: false, error: "guid is required" };
      const angle = num(p.angle, "angle", { min: -3600, max: 3600 });
      return angle ? { ok: false, error: angle } : { ok: true, params: { guid: g.value, angle: p.angle } };
    },
    preview: (p) => `rotate_node ${String(p.guid)} by ${String(p.angle)}°`,
  },
  arrange_nodes: {
    op: "arrange_nodes",
    description: "Change z-order of one or more nodes using a documented XD Arrange command.",
    mutating: true,
    validate: (p) => {
      const g = validateGuids(p, "guids", 1);
      if (g.error) return { ok: false, error: g.error };
      if (!["bringToFront", "bringForward", "sendToBack", "sendBackward"].includes(p.action as string)) return { ok: false, error: "action must be bringToFront|bringForward|sendToBack|sendBackward" };
      return { ok: true, params: { guids: g.value, action: p.action } };
    },
    preview: (p) => `arrange_nodes ${(p.guids as string[]).length} → ${String(p.action)}`,
  },
  align_nodes: {
    op: "align_nodes",
    description: "Align same-context nodes using a documented XD Align command.",
    mutating: true,
    validate: (p) => {
      const g = validateGuids(p, "guids", 2);
      if (g.error) return { ok: false, error: g.error };
      if (!["alignLeft", "alignRight", "alignHorizontalCenter", "alignTop", "alignBottom", "alignVerticalCenter"].includes(p.action as string)) return { ok: false, error: "unsupported alignment action" };
      return { ok: true, params: { guids: g.value, action: p.action } };
    },
    preview: (p) => `align_nodes ${(p.guids as string[]).length} → ${String(p.action)}`,
  },
  distribute_nodes: {
    op: "distribute_nodes",
    description: "Distribute same-context nodes using a documented XD Distribute command.",
    mutating: true,
    validate: (p) => {
      const g = validateGuids(p, "guids", 3);
      if (g.error) return { ok: false, error: g.error };
      if (!["distributeHorizontal", "distributeVertical"].includes(p.action as string)) return { ok: false, error: "action must be distributeHorizontal|distributeVertical" };
      return { ok: true, params: { guids: g.value, action: p.action } };
    },
    preview: (p) => `distribute_nodes ${(p.guids as string[]).length} → ${String(p.action)}`,
  },
  get_prototype_state: {
    op: "get_prototype_state",
    description: "Read XD prototype flows and interactions. The public API is read-only for prototype wiring.",
    mutating: false,
    validate: () => ({ ok: true, params: {} }),
    preview: () => "get_prototype_state",
  },
  validate_prototype: {
    op: "validate_prototype",
    description: "Compare required navigation edges with existing XD prototype interactions. Read-only; it does not create wires.",
    mutating: false,
    validate: (p) => {
      if (!Array.isArray(p.requiredConnections) || p.requiredConnections.length === 0 || p.requiredConnections.length > 500) return { ok: false, error: "requiredConnections must be a non-empty array (max 500)" };
      const allowedTriggers = new Set(["tap", "drag", "time", "voice"]);
      const allowedActions = new Set(["goToArtboard", "overlay"]);
      const requiredConnections = [];
      for (let i = 0; i < p.requiredConnections.length; i++) {
        const edge = p.requiredConnections[i] as Record<string, unknown>;
        if (!edge || typeof edge !== "object") return { ok: false, error: `requiredConnections[${i}] must be an object` };
        for (const key of ["fromGuid", "toGuid"] as const) {
          if (typeof edge[key] !== "string" || !edge[key] || (edge[key] as string).length > 256) return { ok: false, error: `requiredConnections[${i}].${key} must be a non-empty GUID string` };
        }
        if (edge.trigger !== undefined && (typeof edge.trigger !== "string" || !allowedTriggers.has(edge.trigger))) return { ok: false, error: `requiredConnections[${i}].trigger is unsupported` };
        if (edge.action !== undefined && (typeof edge.action !== "string" || !allowedActions.has(edge.action))) return { ok: false, error: `requiredConnections[${i}].action is unsupported` };
        requiredConnections.push({ fromGuid: edge.fromGuid as string, toGuid: edge.toGuid as string, trigger: edge.trigger as string | undefined, action: edge.action as string | undefined });
      }
      return { ok: true, params: { requiredConnections } };
    },
    preview: (p) => `validate_prototype ${(p.requiredConnections as unknown[])?.length ?? 0} required connections`,
  },
  audit_screen: {
    op: "audit_screen",
    description: "Check a real artboard against a screen-specific semantic role manifest. Every listed type is required for its role. Structural verification only, not a visual-quality claim.",
    mutating: false,
    validate: (p) => {
      const g = optGuid(p, "guid");
      if (g.error) return { ok: false, error: g.error };
      if (!g.value) return { ok: false, error: "guid is required" };
      if (!Array.isArray(p.requirements) || p.requirements.length === 0 || p.requirements.length > 50) return { ok: false, error: "requirements must be a non-empty array (max 50)" };
      const allowedTypes = new Set(["Artboard", "Rectangle", "Ellipse", "Text", "Group", "Line", "Polygon", "Path", "BooleanGroup", "SymbolInstance", "RepeatGrid", "ScrollableGroup", "LinkedGraphic", "Lottie", "Video"]);
      const requirements = [];
      for (let i = 0; i < p.requirements.length; i++) {
        const r = p.requirements[i] as Record<string, unknown>;
        if (!r || typeof r !== "object") return { ok: false, error: `requirements[${i}] must be an object` };
        const roleError = str(r.role, `requirements[${i}].role`, 128);
        if (roleError) return { ok: false, error: roleError };
        if (Array.isArray(r.types) && r.types.some((t) => typeof t !== "string" || !allowedTypes.has(t))) return { ok: false, error: `requirements[${i}].types contains an unsupported scene node type` };
        if (r.requireNonEmptyText !== undefined && typeof r.requireNonEmptyText !== "boolean") return { ok: false, error: `requirements[${i}].requireNonEmptyText must be boolean` };
        requirements.push({ role: r.role as string, types: Array.isArray(r.types) ? r.types as string[] : [], requireNonEmptyText: r.requireNonEmptyText === true });
      }
      return { ok: true, params: { guid: g.value, requirements } };
    },
    preview: (p) => `audit_screen ${String(p.guid)} (${(p.requirements as unknown[])?.length ?? 0} roles)`,
  },
  create_component: {
    op: "create_component",
    description: "Unsupported: Adobe XD's documented public plugin API does not create component masters or SymbolInstance nodes.",
    mutating: false,
    validate: (p) => {
      const g = optGuid(p, "guid");
      if (g.error) return { ok: false, error: g.error };
      const nm = optStr(p, "name", 256);
      if (nm.error) return { ok: false, error: nm.error };
      return { ok: true, params: clean({ guid: g.value, name: nm.value }) };
    },
    preview: (p) => `create_component ${String(p.guid)} "${String(p.name ?? "")}"`,
  },
  update_node: {
    op: "update_node",
    description: "Set writable properties (name, style, visible, locked, blendMode, markedForExport, fixedWhenScrolling) on a node by guid.",
    mutating: true,
    validate: (p) => {
      const g = optGuid(p, "guid");
      if (g.error) return { ok: false, error: g.error };
      const st = validateStyle(p.style);
      if (st.error) return { ok: false, error: st.error };
      const nm = optStr(p, "name", 256);
      if (nm.error) return { ok: false, error: nm.error };
      const vis = p.visible === undefined ? {} : { visible: typeof p.visible === "boolean" ? { value: p.visible } : { error: "visible must be boolean" } };
      if ("error" in vis && vis.error) return { ok: false, error: vis.error };
      const lock = p.locked === undefined ? {} : { locked: typeof p.locked === "boolean" ? { value: p.locked } : { error: "locked must be boolean" } };
      if ("error" in lock && lock.error) return { ok: false, error: lock.error };
      let blend: string | undefined;
      if (p.blendMode !== undefined) {
        const allowed = BLEND_MODES;
        if (typeof p.blendMode !== "string" || !allowed.includes(p.blendMode)) {
          return { ok: false, error: `blendMode must be one of ${allowed.join("|")}` };
        }
        blend = p.blendMode;
      }
      for (const key of ["markedForExport", "fixedWhenScrolling"] as const) {
        if (p[key] !== undefined && typeof p[key] !== "boolean") return { ok: false, error: `${key} must be boolean` };
      }
      return {
        ok: true,
        params: clean({
          guid: g.value, style: st.value, name: nm.value,
          visible: (vis as { value?: boolean }).value, locked: (lock as { value?: boolean }).value,
          blendMode: blend, markedForExport: p.markedForExport as boolean | undefined,
          fixedWhenScrolling: p.fixedWhenScrolling as boolean | undefined,
        }),
      };
    },
    preview: (p) => `update_node ${String(p.guid)}`,
  },
  move_node: {
    op: "move_node",
    description: "Reposition a node by guid (absolute or relative).",
    mutating: true,
    validate: (p) => {
      const g = optGuid(p, "guid");
      if (g.error) return { ok: false, error: g.error };
      const eX = num(p.x, "x");
      if (eX) return { ok: false, error: eX };
      const eY = num(p.y, "y");
      if (eY) return { ok: false, error: eY };
      const rel = p.relative === undefined ? { value: false } : typeof p.relative === "boolean" ? { value: p.relative } : { error: "relative must be boolean" };
      if ((rel as { error?: string }).error) return { ok: false, error: (rel as { error: string }).error };
      return { ok: true, params: clean({ guid: g.value, x: p.x, y: p.y, relative: (rel as { value: boolean }).value }) };
    },
    preview: (p) => `move_node ${String(p.guid)} → ${p.x},${p.y}`,
  },
  resize_node: {
    op: "resize_node",
    description: "Resize a node by guid (absolute or relative width/height).",
    mutating: true,
    validate: (p) => {
      const g = optGuid(p, "guid");
      if (g.error) return { ok: false, error: g.error };
      const w = optNum(p, "width", { min: 0.1, max: 20000 });
      if (w.error) return { ok: false, error: w.error };
      const h = optNum(p, "height", { min: 0.1, max: 20000 });
      if (h.error) return { ok: false, error: h.error };
      if (w.value === undefined && h.value === undefined) return { ok: false, error: "provide width and/or height" };
      const rel = p.relative === undefined ? { value: false } : typeof p.relative === "boolean" ? { value: p.relative } : { error: "relative must be boolean" };
      if ((rel as { error?: string }).error) return { ok: false, error: (rel as { error: string }).error };
      return { ok: true, params: clean({ guid: g.value, width: w.value, height: h.value, relative: (rel as { value: boolean }).value }) };
    },
    preview: (p) => `resize_node ${String(p.guid)}`,
  },
  apply_style: {
    op: "apply_style",
    description: "Apply a style bundle to one or many nodes by guid.",
    mutating: true,
    validate: (p) => {
      const st = validateStyle(p.style);
      if (st.error) return { ok: false, error: st.error };
      if (!st.value || Object.keys(st.value).length === 0) return { ok: false, error: "style must set at least one property" };
      const single = optGuid(p, "guid");
      const many = validateGuids(p, "guids", 1);
      const guids = single.value ? [single.value] : many.value;
      if (single.error) return { ok: false, error: single.error };
      if (many.error && !single.value) return { ok: false, error: many.error };
      if (!guids) return { ok: false, error: "provide guid or guids" };
      return { ok: true, params: clean({ guids, style: st.value }) };
    },
    preview: (p) => `apply_style → ${Array.isArray(p.guids) ? p.guids.length : 1} node(s)`,
  },
  update_text: {
    op: "update_text",
    description: "Update text content and/or typography of a text node by guid.",
    mutating: true,
    validate: (p) => {
      const g = optGuid(p, "guid");
      if (g.error) return { ok: false, error: g.error };
      const st = validateTextStyle(p.style);
      if (st.error) return { ok: false, error: st.error };
      const t = optStr(p, "text", 8192);
      if (t.error) return { ok: false, error: t.error };
      if (t.value === undefined && !st.value) return { ok: false, error: "provide text and/or style" };
      return { ok: true, params: clean({ guid: g.value, text: t.value, style: st.value }) };
    },
    preview: (p) => `update_text ${String(p.guid)}`,
  },
  apply_design_tokens: {
    op: "apply_design_tokens",
    description: "Validate and record a design token JSON object on root.pluginData. Does not create native XD swatches or character styles.",
    mutating: true,
    validate: (p) => {
      if (typeof p.tokens !== "object" || p.tokens === null) return { ok: false, error: "tokens must be the token JSON object" };
      const tokens = p.tokens as Record<string, Record<string, unknown>>;
      for (const [cat, entries] of Object.entries(tokens)) {
        if (typeof entries !== "object" || entries === null) return { ok: false, error: `tokens.${cat} must be an object of named tokens` };
        for (const [name, tok] of Object.entries(entries)) {
          if (typeof tok !== "object" || tok === null || typeof (tok as Record<string, unknown>).value !== "string") {
            return { ok: false, error: `tokens.${cat}.${name} must have a string value` };
          }
          if (cat === "color") {
            const e = hexColor((tok as Record<string, unknown>).value, `tokens.color.${name}.value`);
            if (e) return { ok: false, error: e };
          }
        }
      }
      return { ok: true, params: { tokens } };
    },
    preview: (p) => `apply_design_tokens (${Object.keys(p.tokens as object).length} categories)`,
  },
  create_component_variants: {
    op: "create_component_variants",
    description: "Unsupported: Adobe XD's documented public plugin API does not create linked component variants.",
    mutating: false,
    validate: (p) => {
      const g = optGuid(p, "guid");
      if (g.error) return { ok: false, error: g.error };
      if (!Array.isArray(p.variants) || p.variants.length === 0) return { ok: false, error: "variants must be a non-empty array of state names" };
      for (const v of p.variants as unknown[]) {
        if (typeof v !== "string" || !/^[A-Za-z0-9 _-]{1,64}$/.test(v)) return { ok: false, error: "variant names must be 1-64 chars of letters/digits/space/-/_" };
      }
      return { ok: true, params: { guid: g.value, variants: p.variants } };
    },
    preview: (p) => `create_component_variants ${String(p.guid)} → ${(p.variants as string[]).join(", ")}`,
  },
  inspect_design_consistency: {
    op: "inspect_design_consistency",
    description: "Audit document colors, font sizes and target sizes against the provided token set and accessibility floors.",
    mutating: false,
    validate: (p) => {
      if (p.tokens !== undefined && (typeof p.tokens !== "object" || p.tokens === null)) return { ok: false, error: "tokens must be an object" };
      return { ok: true, params: { tokens: p.tokens ?? null } };
    },
    preview: () => "inspect_design_consistency",
  },
  export_artboard: {
    op: "export_artboard",
    description: "Export an artboard as PNG (base64 image content) via application.createRenditions.",
    mutating: false,
    validate: (p) => {
      const g = optGuid(p, "guid");
      if (g.error) return { ok: false, error: g.error };
      const nm = optStr(p, "name", 256);
      if (nm.error) return { ok: false, error: nm.error };
      if (g.value === undefined && nm.value === undefined) return { ok: false, error: "provide guid or name" };
      const scale = optNum(p, "scale", { min: 0.5, max: 4 });
      if (scale.error) return { ok: false, error: scale.error };
      return { ok: true, params: clean({ guid: g.value, name: nm.value, scale: scale.value ?? 2 }) };
    },
    preview: (p) => `export_artboard ${String(p.guid ?? p.name)} @${String(p.scale ?? 2)}x`,
  },
  export_selection: {
    op: "export_selection",
    description: "Export the current selection as PNG (base64 image content).",
    mutating: false,
    validate: () => ({ ok: true, params: {} }),
    preview: () => "export_selection",
  },
  validate_document: {
    op: "validate_document",
    description: "Structural sanity audit: default names, empty groups, zero-size nodes.",
    mutating: false,
    validate: () => ({ ok: true, params: {} }),
    preview: () => "validate_document",
  },
  update_path: {
    op: "update_path",
    description: "Replace the geometry of an existing Path node with new SVG path data (Path.pathData is writable).",
    mutating: true,
    validate: (p) => {
      const g = optGuid(p, "guid");
      if (g.error) return { ok: false, error: g.error };
      const d = optStr(p, "pathData", 200000);
      if (d.error) return { ok: false, error: d.error };
      if (!d.value) return { ok: false, error: "pathData is required" };
      if (!/^\s*[MmZz]/.test(d.value)) return { ok: false, error: "pathData must start with an SVG move (M/m) or close (Z/z) command" };
      return { ok: true, params: clean({ guid: g.value, pathData: d.value }) };
    },
    preview: (p) => `update_path ${String(p.guid)}`,
  },
  convert_to_path: {
    op: "convert_to_path",
    description: "Convert selected leaf nodes / boolean groups to Path nodes (Object > Path > Convert to Path).",
    mutating: true,
    validate: (p) => {
      const guids = validateGuids(p, "guids", 1);
      if (guids.error) return { ok: false, error: guids.error };
      return { ok: true, params: { guids: guids.value } };
    },
    preview: (p) => `convert_to_path → ${Array.isArray(p.guids) ? p.guids.length : 0} node(s)`,
  },
  outline_stroke: {
    op: "outline_stroke",
    description: "Convert each selected node's stroke to an outline Path (Object > Path > Outline Stroke, XD 42+).",
    mutating: true,
    validate: (p) => {
      const guids = validateGuids(p, "guids", 1);
      if (guids.error) return { ok: false, error: guids.error };
      return { ok: true, params: { guids: guids.value } };
    },
    preview: (p) => `outline_stroke → ${Array.isArray(p.guids) ? p.guids.length : 0} node(s)`,
  },
  align_to_pixel_grid: {
    op: "align_to_pixel_grid",
    description: "Shift selected nodes onto the pixel grid (Object > Align to Pixel Grid).",
    mutating: true,
    validate: (p) => {
      const guids = validateGuids(p, "guids", 1);
      if (guids.error) return { ok: false, error: guids.error };
      return { ok: true, params: { guids: guids.value } };
    },
    preview: (p) => `align_to_pixel_grid → ${Array.isArray(p.guids) ? p.guids.length : 0} node(s)`,
  },
  reset_3d_transforms: {
    op: "reset_3d_transforms",
    description: "Reset X rotation, Y rotation and Z depth of selected nodes to 0 (XD 47+).",
    mutating: true,
    validate: (p) => {
      const guids = validateGuids(p, "guids", 1);
      if (guids.error) return { ok: false, error: guids.error };
      return { ok: true, params: { guids: guids.value } };
    },
    preview: (p) => `reset_3d_transforms → ${Array.isArray(p.guids) ? p.guids.length : 0} node(s)`,
  },
  make_background: {
    op: "make_background",
    description: "Make the given stack cell the background of its Stack (Object > Make Background).",
    mutating: true,
    validate: (p) => {
      const g = optGuid(p, "guid");
      if (g.error) return { ok: false, error: g.error };
      if (!g.value) return { ok: false, error: "guid is required" };
      return { ok: true, params: { guid: g.value } };
    },
    preview: (p) => `make_background ${String(p.guid)}`,
  },
  replace_background: {
    op: "replace_background",
    description: "Replace the background of a Stack with the given stack cell (Object > Replace Background).",
    mutating: true,
    validate: (p) => {
      const g = optGuid(p, "guid");
      if (g.error) return { ok: false, error: g.error };
      if (!g.value) return { ok: false, error: "guid is required" };
      return { ok: true, params: { guid: g.value } };
    },
    preview: (p) => `replace_background ${String(p.guid)}`,
  },
  set_layout: {
    op: "set_layout",
    description: "Set Responsive Resize / Padding / Stack layout on a node (SceneNode.layout).",
    mutating: true,
    validate: (p) => {
      const g = optGuid(p, "guid");
      if (g.error) return { ok: false, error: g.error };
      if (!g.value) return { ok: false, error: "guid is required" };
      const l = p.layout;
      if (typeof l !== "object" || l === null) return { ok: false, error: "layout must be an object" };
      const o = l as Record<string, unknown>;
      const types = ["none", "responsive", "padding", "stack"];
      if (typeof o.type !== "string" || !types.includes(o.type)) return { ok: false, error: `layout.type must be one of ${types.join("|")}` };
      const out: Record<string, unknown> = { type: o.type };
      if (o.type === "stack") {
        const s = o.stack;
        if (typeof s !== "object" || s === null) return { ok: false, error: "layout.stack is required when type is stack" };
        const so = s as Record<string, unknown>;
        if (!["horizontal", "vertical"].includes(so.orientation as string)) return { ok: false, error: "layout.stack.orientation must be horizontal|vertical" };
        out.stack = { orientation: so.orientation };
        if (so.spacings !== undefined) {
          if (typeof so.spacings === "number") {
            const e = num(so.spacings, "layout.stack.spacings", { min: 0, max: 10000 });
            if (e) return { ok: false, error: e };
            out.stack = { ...(out.stack as object), spacings: so.spacings };
          } else if (Array.isArray(so.spacings)) {
            for (let i = 0; i < so.spacings.length; i++) {
              const e = num(so.spacings[i], `layout.stack.spacings[${i}]`, { min: 0, max: 10000 });
              if (e) return { ok: false, error: e };
            }
            out.stack = { ...(out.stack as object), spacings: so.spacings };
          } else {
            return { ok: false, error: "layout.stack.spacings must be a number or an array of numbers" };
          }
        }
      }
      if (o.padding !== undefined) {
        if (typeof o.padding === "number") {
          const e = num(o.padding, "layout.padding", { min: 0, max: 10000 });
          if (e) return { ok: false, error: e };
          out.padding = o.padding;
        } else if (typeof o.padding === "object" && o.padding !== null) {
          const po = o.padding as Record<string, unknown>;
          const sides: Record<string, number> = {};
          for (const side of ["top", "right", "bottom", "left"]) {
            if (po[side] === undefined) continue;
            const e = num(po[side], `layout.padding.${side}`, { min: 0, max: 10000 });
            if (e) return { ok: false, error: e };
            sides[side] = po[side] as number;
          }
          out.padding = sides;
        } else {
          return { ok: false, error: "layout.padding must be a number or {top,right,bottom,left}" };
        }
      }
      if (o.resizeConstraints !== undefined) {
        const r = o.resizeConstraints;
        if (typeof r !== "object" || r === null) return { ok: false, error: "layout.resizeConstraints must be an object" };
        const ro = r as Record<string, unknown>;
        if (!["auto", "manual"].includes(ro.type as string)) return { ok: false, error: "layout.resizeConstraints.type must be auto|manual" };
        out.resizeConstraints = { type: ro.type };
        if (ro.values !== undefined) {
          if (typeof ro.values !== "object" || ro.values === null) return { ok: false, error: "layout.resizeConstraints.values must be an object of booleans" };
          const vals: Record<string, boolean> = {};
          for (const k of ["top", "right", "bottom", "left", "width", "height"]) {
            const v = (ro.values as Record<string, unknown>)[k];
            if (v === undefined) continue;
            if (typeof v !== "boolean") return { ok: false, error: `layout.resizeConstraints.values.${k} must be boolean` };
            vals[k] = v;
          }
          out.resizeConstraints = { type: ro.type, values: vals };
        }
      }
      return { ok: true, params: { guid: g.value, layout: out } };
    },
    preview: (p) => `set_layout ${String(p.guid)} type=${String((p.layout as Record<string, unknown>)?.type)}`,
  },
  set_constraints: {
    op: "set_constraints",
    description: "Set or reset Responsive Resize constraints (SceneNode.horizontalConstraints / verticalConstraints).",
    mutating: true,
    validate: (p) => {
      const g = optGuid(p, "guid");
      if (g.error) return { ok: false, error: g.error };
      if (!g.value) return { ok: false, error: "guid is required" };
      const axis = (key: "horizontal" | "vertical") => {
        if (p[key] === undefined) return undefined;
        const v = p[key];
        if (typeof v !== "object" || v === null) return `${key} must be an object {position,size}`;
        const o = v as Record<string, unknown>;
        const positions = key === "horizontal" ? ["left", "right", "both", "proportional"] : ["top", "bottom", "both", "proportional"];
        if (typeof o.position !== "string" || !positions.includes(o.position)) return `${key}.position must be one of ${positions.join("|")}`;
        if (!["fixed", "resizes"].includes(o.size as string)) return `${key}.size must be fixed|resizes`;
        return { position: o.position, size: o.size };
      };
      const h = axis("horizontal");
      if (typeof h === "string") return { ok: false, error: h };
      const v = axis("vertical");
      if (typeof v === "string") return { ok: false, error: v };
      if (p.reset !== undefined && typeof p.reset !== "boolean") return { ok: false, error: "reset must be boolean" };
      if (!h && !v && p.reset !== true) return { ok: false, error: "provide horizontal, vertical and/or reset:true" };
      return { ok: true, params: clean({ guid: g.value, horizontal: h, vertical: v, reset: p.reset as boolean | undefined }) };
    },
    preview: (p) => `set_constraints ${String(p.guid)}`,
  },
  execute_batch: {
    op: "execute_batch",
    description: "Execute a pre-validated list of operations inside a single editDocument context in XD.",
    mutating: true,
    validate: (p) => {
      if (!Array.isArray(p.operations) || p.operations.length === 0) return { ok: false, error: "operations must be a non-empty array" };
      if (p.operations.length > 100) return { ok: false, error: "batch is limited to 100 operations" };
      const out: Array<{ op: string; params: OpParams }> = [];
      for (const raw of p.operations) {
        if (typeof raw !== "object" || raw === null) return { ok: false, error: "each operation must be {op, params}" };
        const o = raw as Record<string, unknown>;
        if (typeof o.op !== "string") return { ok: false, error: "each operation must have a string op" };
        const spec = OPERATIONS[o.op];
        if (!spec) return { ok: false, error: `unknown operation "${o.op}"` };
        const v = spec.validate((o.params ?? {}) as OpParams);
        if (!v.ok) return { ok: false, error: `[${o.op}] ${v.error}` };
        out.push({ op: o.op, params: v.params });
      }
      return { ok: true, params: { operations: out } };
    },
    preview: (p) => `execute_batch [${(p.operations as unknown[])?.length ?? 0} operations]`,
  },
};

export const OP_KEYS = Object.keys(OPERATIONS);

/** Validate a single operation object {op, ...params}. */
export function validateOperation(raw: unknown): { ok: true; op: string; params: OpParams } | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "operation must be an object" };
  const o = raw as Record<string, unknown>;
  if (typeof o.op !== "string") return { ok: false, error: "operation.op must be a string" };
  const spec = OPERATIONS[o.op];
  if (!spec) {
    return { ok: false, error: `unknown operation "${o.op}". Supported: ${OP_KEYS.join(", ")}` };
  }
  const rest: OpParams = { ...o };
  delete rest.op;
  const v = spec.validate(rest);
  if (!v.ok) return { ok: false, error: `[${o.op}] ${v.error}` };
  return { ok: true, op: o.op, params: v.params };
}
