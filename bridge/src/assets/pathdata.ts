/**
 * SVG path-data transform utilities.
 *
 * XD's Path node cannot be scaled non-destructively from the bridge, so icon
 * geometry is transformed numerically before insertion. This keeps the result a
 * single editable Path (no rasterisation, no screenshots).
 */

const PARAM_COUNT: Record<string, number> = {
  M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0,
};

const TOKEN = /([a-zA-Z])|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;

function tokens(d: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(TOKEN.source, "g");
  while ((m = re.exec(d)) !== null) out.push(m[0]);
  return out;
}

const n = (v: number): string => {
  const r = Math.round(v * 1000) / 1000;
  return String(r);
};

export interface PathTransform {
  sx: number;
  sy: number;
  tx?: number;
  ty?: number;
}

/**
 * Scales/translates path data. Relative commands are scaled but not translated.
 * Arc radii are scaled; rotation and flags are preserved.
 */
export function transformPathData(d: string, t: PathTransform): string {
  const sx = t.sx;
  const sy = t.sy;
  const tx = t.tx ?? 0;
  const ty = t.ty ?? 0;
  const parts = tokens(d);
  const out: string[] = [];
  let i = 0;
  let cmd = "";

  // A leading relative moveto is treated as absolute by the SVG spec. Without
  // this, icons that start with "m x y" (common in Material Symbols) would be
  // translated by (0,0) and render at the artboard origin.
  if (parts[0] === "m") {
    const fx = Number(parts[1]);
    const fy = Number(parts[2]);
    if (Number.isFinite(fx) && Number.isFinite(fy)) {
      out.push("M", n(fx * sx + tx), n(fy * sy + ty));
      i = 3;
      cmd = "l";
    }
  }

  while (i < parts.length) {
    const token = parts[i];
    if (/[a-zA-Z]/.test(token)) {
      cmd = token;
      i++;
      if (cmd === "Z" || cmd === "z") {
        out.push(cmd);
        continue;
      }
      out.push(cmd);
      continue;
    }

    const upper = cmd.toUpperCase();
    const relative = cmd !== upper;
    const count = PARAM_COUNT[upper] ?? 2;
    const args: number[] = [];
    for (let k = 0; k < count; k++) {
      args.push(Number(parts[i + k]));
    }
    i += count;
    if (args.length < count || args.some((v) => !Number.isFinite(v))) break;

    const px = (v: number) => (relative ? n(v * sx) : n(v * sx + tx));
    const py = (v: number) => (relative ? n(v * sy) : n(v * sy + ty));

    switch (upper) {
      case "H":
        out.push(relative ? n(args[0] * sx) : n(args[0] * sx + tx));
        break;
      case "V":
        out.push(relative ? n(args[0] * sy) : n(args[0] * sy + ty));
        break;
      case "A": {
        // rx ry x-axis-rotation large-arc-flag sweep-flag x y
        out.push(n(args[0] * sx), n(args[1] * sy), n(args[2]), String(args[3]), String(args[4]), px(args[5]), py(args[6]));
        break;
      }
      case "M":
      case "L":
      case "T":
        out.push(px(args[0]), py(args[1]));
        break;
      case "C":
        out.push(px(args[0]), py(args[1]), px(args[2]), py(args[3]), px(args[4]), py(args[5]));
        break;
      case "S":
      case "Q":
        out.push(px(args[0]), py(args[1]), px(args[2]), py(args[3]));
        break;
      default:
        out.push(...args.map((v, idx) => (idx % 2 === 0 ? px(v) : py(v))));
        break;
    }
  }

  // Re-join as "<cmd><n,n ...>" with single spaces between command groups.
  const rebuilt: string[] = [];
  let buffer: string[] = [];
  for (const p of out) {
    if (/^[a-zA-Z]$/.test(p)) {
      if (buffer.length) rebuilt.push(buffer.join(" "));
      buffer = [];
      rebuilt.push(p);
    } else {
      buffer.push(p);
    }
  }
  if (buffer.length) rebuilt.push(buffer.join(" "));
  return rebuilt.join(" ").replace(/\s+/g, " ").trim();
}

/** Replaces `currentColor` in an SVG string with a concrete hex colour. */
export function tintSvg(svg: string, color: string): string {
  return svg.split("currentColor").join(color);
}
