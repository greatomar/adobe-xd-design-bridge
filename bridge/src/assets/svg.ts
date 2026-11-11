/**
 * Minimal, dependency-free SVG reader.
 *
 * It only extracts what the bridge can turn into real XD Path nodes: viewBox,
 * geometry (path / circle / rect / line / polyline) and the resolved
 * fill/stroke/stroke-width, including inherited attributes from <g> and <svg>.
 *
 * It is intentionally not a general SVG renderer: gradients, filters, masks,
 * text and images are reported as unsupported instead of silently dropped.
 */

export interface SvgShape {
  d: string;
  fill: string | null;
  stroke: string | null;
  strokeWidth: number | null;
}

export interface ParsedSvg {
  width: number;
  height: number;
  viewBox: { x: number; y: number; width: number; height: number };
  shapes: SvgShape[];
  unsupported: string[];
}

const ATTR = /([a-zA-Z:_-]+)\s*=\s*"([^"]*)"|([a-zA-Z:_-]+)\s*=\s*'([^']*)'/g;

function attrsOf(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = new RegExp(ATTR.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const k = m[1] ?? m[3];
    const v = m[2] ?? m[4];
    if (k) out[k] = v;
  }
  return out;
}

const num = (v: string | undefined, fallback = 0): number => {
  if (v === undefined) return fallback;
  const parsed = Number(String(v).replace(/px$/, ""));
  return Number.isFinite(parsed) ? parsed : fallback;
};

function rectPath(x: number, y: number, w: number, h: number, rx: number): string {
  if (rx <= 0) return `M ${x},${y} L ${x + w},${y} L ${x + w},${y + h} L ${x},${y + h} Z`;
  const r = Math.min(rx, w / 2, h / 2);
  return [
    `M ${x + r},${y}`,
    `L ${x + w - r},${y}`, `A ${r},${r} 0 0 1 ${x + w},${y + r}`,
    `L ${x + w},${y + h - r}`, `A ${r},${r} 0 0 1 ${x + w - r},${y + h}`,
    `L ${x + r},${y + h}`, `A ${r},${r} 0 0 1 ${x},${y + h - r}`,
    `L ${x},${y + r}`, `A ${r},${r} 0 0 1 ${x + r},${y}`,
    "Z",
  ].join(" ");
}

function circlePath(cx: number, cy: number, r: number): string {
  const k = 0.5522847498 * r;
  return [
    `M ${cx},${cy - r}`,
    `C ${cx + k},${cy - r} ${cx + r},${cy - k} ${cx + r},${cy}`,
    `C ${cx + r},${cy + k} ${cx + k},${cy + r} ${cx},${cy + r}`,
    `C ${cx - k},${cy + r} ${cx - r},${cy + k} ${cx - r},${cy}`,
    `C ${cx - r},${cy - k} ${cx - k},${cy - r} ${cx},${cy - r}`,
    "Z",
  ].join(" ");
}

function polyPath(points: string, close: boolean): string {
  const nums = points.split(/[\s,]+/).map(Number).filter((v) => Number.isFinite(v));
  if (nums.length < 4) return "";
  const parts = [`M ${nums[0]},${nums[1]}`];
  for (let i = 2; i + 1 < nums.length; i += 2) parts.push(`L ${nums[i]},${nums[i + 1]}`);
  if (close) parts.push("Z");
  return parts.join(" ");
}

const UNSUPPORTED_TAGS = ["linearGradient", "radialGradient", "filter", "mask", "image", "text", "use", "clipPath"];

export function parseSvg(raw: string): ParsedSvg {
  const svg = raw.replace(/<!--[\s\S]*?-->/g, "");
  const openTag = /<svg([^>]*)>/i.exec(svg);
  const svgAttrs = openTag ? attrsOf(openTag[1]) : {};

  const vb = (svgAttrs.viewBox ?? "").split(/[\s,]+/).map(Number).filter((v) => Number.isFinite(v));
  const width = num(svgAttrs.width, vb.length === 4 ? vb[2] : 24);
  const height = num(svgAttrs.height, vb.length === 4 ? vb[3] : 24);
  const viewBox = vb.length === 4
    ? { x: vb[0], y: vb[1], width: vb[2], height: vb[3] }
    : { x: 0, y: 0, width, height };

  const unsupported: string[] = [];
  for (const tag of UNSUPPORTED_TAGS) if (new RegExp(`<${tag}[\\s>]`, "i").test(svg)) unsupported.push(tag);

  const shapes: SvgShape[] = [];
  const stack: Array<Record<string, string>> = [svgAttrs];

  const tagRe = /<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(svg)) !== null) {
    const closing = m[1] === "/";
    const name = m[2];
    const attrs = attrsOf(m[3] ?? "");
    const selfClosing = m[4] === "/";

    if (closing) {
      if (stack.length > 1) stack.pop();
      continue;
    }

    const inherited = stack[stack.length - 1] ?? {};
    const pick = (key: string): string | undefined => attrs[key] ?? inherited[key];

    const fill = pick("fill") ?? null;
    const stroke = pick("stroke") ?? null;
    const swRaw = pick("stroke-width");
    const strokeWidth = swRaw === undefined ? null : num(swRaw, 1);

    if (name === "g" || name === "svg") {
      if (!selfClosing) stack.push({ ...inherited, ...attrs });
      continue;
    }

    let d = "";
    if (name === "path") d = attrs.d ?? "";
    else if (name === "circle") d = circlePath(num(attrs.cx), num(attrs.cy), num(attrs.r, 1));
    else if (name === "rect") d = rectPath(num(attrs.x), num(attrs.y), num(attrs.width), num(attrs.height), num(attrs.rx, num(attrs.ry)));
    else if (name === "line") d = `M ${num(attrs.x1)},${num(attrs.y1)} L ${num(attrs.x2)},${num(attrs.y2)}`;
    else if (name === "polyline") d = polyPath(attrs.points ?? "", false);
    else if (name === "polygon") d = polyPath(attrs.points ?? "", true);
    else continue;

    if (d.trim()) shapes.push({ d, fill, stroke, strokeWidth });
  }

  return { width, height, viewBox, shapes, unsupported };
}

/** True when the SVG can be represented as editable XD paths. */
export function isVectorSafe(parsed: ParsedSvg): boolean {
  return parsed.shapes.length > 0 && parsed.unsupported.every((u) => u !== "image" && u !== "text");
}
