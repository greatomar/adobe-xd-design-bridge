/**
 * Geometry for the coordinate fallback.
 *
 * The primary authoring path never needs screen coordinates: source selection
 * uses the Layers list (UI Automation SelectionItem) and the wire is created by
 * the Interaction pane, not by dragging on the canvas.
 *
 * Adobe XD's canvas is a single UIA Custom element with no child elements, so
 * canvas-rendered objects are not addressable. If a future step ever has to
 * click a canvas point, the mapping must be derived from live state — never
 * hard-coded:
 *
 *   screenX = canvas.x + (docX - viewport.x) * zoom
 *   screenY = canvas.y + (docY - viewport.y) * zoom
 *
 * where `canvas` is the UIA bounding rectangle of `canvasView`, and `viewport`
 * (bounds in document coordinates) + `zoom` come from the documented XD
 * `viewport` module through the plugin.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface ViewportState {
  /** visible region in document coordinates (XD viewport.bounds) */
  bounds: Rect;
  /** document units → CSS pixels scale (XD viewport.zoomFactor) */
  zoomFactor: number;
}

export type ScreenPointResult =
  | { ok: true; x: number; y: number; insideCanvas: boolean }
  | { ok: false; reason: string };

const MIN_ZOOM = 0.01;
const MAX_ZOOM = 64;

function finitePositive(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

export function isValidViewport(viewport: ViewportState | null | undefined): viewport is ViewportState {
  if (!viewport) return false;
  const z = viewport.zoomFactor;
  if (!finitePositive(z) || z < MIN_ZOOM || z > MAX_ZOOM) return false;
  const b = viewport.bounds;
  return finitePositive(b.width) && finitePositive(b.height) && Number.isFinite(b.x) && Number.isFinite(b.y);
}

export function rectContains(rect: Rect, point: Point): boolean {
  return point.x >= rect.x && point.y >= rect.y
    && point.x <= rect.x + rect.width && point.y <= rect.y + rect.height;
}

export function rectCenter(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/**
 * Document point → screen point. Refuses to answer when the viewport state is
 * unreadable or the point is outside the visible canvas, because a click there
 * would hit the pasteboard (or another window) instead of the intended node.
 */
export function documentToScreen(
  point: Point,
  viewport: ViewportState | null | undefined,
  canvas: Rect | null | undefined,
): ScreenPointResult {
  if (!viewport) return { ok: false, reason: "VIEWPORT_STATE_UNKNOWN: viewport bounds/zoom are unavailable" };
  if (!isValidViewport(viewport)) return { ok: false, reason: "VIEWPORT_STATE_UNKNOWN: viewport bounds/zoom are not plausible" };
  if (!canvas || !finitePositive(canvas.width) || !finitePositive(canvas.height)) {
    return { ok: false, reason: "VIEWPORT_STATE_UNKNOWN: the canvas rectangle is unavailable" };
  }
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    return { ok: false, reason: "invalid document point" };
  }

  const x = canvas.x + (point.x - viewport.bounds.x) * viewport.zoomFactor;
  const y = canvas.y + (point.y - viewport.bounds.y) * viewport.zoomFactor;
  const insideCanvas = rectContains(canvas, { x, y });
  return { ok: true, x, y, insideCanvas };
}

/** Convenience: the centre of an artboard-relative frame, in document space. */
export function frameCenterInDocument(artboardOrigin: Point, frame: Rect): Point {
  return {
    x: artboardOrigin.x + frame.x + frame.width / 2,
    y: artboardOrigin.y + frame.y + frame.height / 2,
  };
}
