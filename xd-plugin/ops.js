/**
 * OpenCode Design Bridge — XD operation executor.
 * Every function maps to documented Adobe XD plugin APIs (scenegraph / commands).
 * Operations that cannot be executed return { ok:false, supported:false, reason }.
 */
(function () {
  "use strict";

  // --- BOOT diagnostics (temporary; remove after load failure is resolved) ---
  console.log("BOOT: ops.js evaluating");
  function __bootError(context, err) {
    try {
      console.error("BOOT: ERROR at " + context + ":", err && err.stack ? err.stack : String(err));
    } catch (e2) { /* console unavailable */ }
  }
  try {
    window.onerror = function (msg, src, line, col, err) {
      __bootError("window.onerror " + (src || "?") + ":" + line + ":" + col, err || new Error(String(msg)));
    };
  } catch (e) { /* window.onerror unsupported in this runtime */ }
  try {
    window.addEventListener("error", function (ev) {
      __bootError("error event", ev && (ev.error || ev.message));
    });
    window.addEventListener("unhandledrejection", function (ev) {
      __bootError("unhandled rejection", ev && (ev.reason && ev.reason.stack ? ev.reason.stack : ev.reason));
    });
  } catch (e) { /* event traps unsupported */ }

  const scenegraph = require("scenegraph");
  const commands = require("commands");
  const application = require("application");
  console.log("BOOT: ops.js core requires ok (scenegraph, commands, application)");

  function Color(hex) {
    return new scenegraph.Color(hex);
  }

  function tryShadow(sh) {
    // Shadow constructor signature varies across XD builds; try documented forms.
    try {
      return new scenegraph.Shadow(sh.x, sh.y, sh.blur, Color(sh.color), true);
    } catch (e1) {
      try {
        return new scenegraph.Shadow({ x: sh.x, y: sh.y, blur: sh.blur, color: Color(sh.color) });
      } catch (e2) {
        throw e1;
      }
    }
  }

  function tryInnerShadow(sh) {
    return new scenegraph.InnerShadow(sh.x, sh.y, sh.blur, Color(sh.color), true);
  }

  function applyFill(node, hex) {
    node.fill = Color(hex);
  }

  function makeGradient(spec) {
    let gradient;
    if (spec.type === "linear") gradient = new scenegraph.LinearGradient();
    else if (spec.type === "radial") gradient = new scenegraph.RadialGradient();
    else if (spec.type === "angular") gradient = new scenegraph.AngularGradient();
    else throw new Error("unsupported gradient type: " + spec.type);
    gradient.colorStops = spec.colorStops.map((s) => ({ stop: s.stop, color: Color(s.color) }));
    if (spec.type === "linear") gradient.setEndPoints(spec.startX, spec.startY, spec.endX, spec.endY);
    if (spec.type === "radial") {
      gradient.setCenterPoint(spec.centerX, spec.centerY);
      gradient.endR = spec.endR;
    }
    if (spec.type === "angular") {
      gradient.setEndPoints(spec.startX, spec.startY, spec.endX, spec.endY);
      gradient.rotation = spec.rotation;
    }
    return gradient;
  }

  function applyStyle(node, style) {
    if (!style) return;
    if (style.fill !== undefined && node.fill !== undefined) applyFill(node, style.fill);
    if (style.gradient !== undefined && node.fill !== undefined) node.fill = makeGradient(style.gradient);
    if (style.stroke !== undefined && node.stroke !== undefined) node.stroke = Color(style.stroke);
    if (style.strokeWidth !== undefined && node.strokeWidth !== undefined) node.strokeWidth = style.strokeWidth;
    if (style.strokePosition !== undefined && node.strokePosition !== undefined) node.strokePosition = style.strokePosition;
    if (style.strokeEndCaps !== undefined && node.strokeEndCaps !== undefined) {
      // Path nodes expose a different line-cap enum and throw
      // "lineCap: invalid value" for the GraphicNode constants. Caps are
      // decorative: never let them abort a whole batch.
      try { node.strokeEndCaps = style.strokeEndCaps; } catch (e) { /* best effort */ }
    }
    if (style.strokeJoins !== undefined && node.strokeJoins !== undefined) {
      try { node.strokeJoins = style.strokeJoins; } catch (e) { /* best effort */ }
    }
    if (style.strokeDashArray !== undefined && node.strokeDashArray !== undefined) node.strokeDashArray = style.strokeDashArray;
    if (style.strokeDashOffset !== undefined && node.strokeDashOffset !== undefined) node.strokeDashOffset = style.strokeDashOffset;
    if (style.cornerRadius !== undefined) {
      if (typeof node.setAllCornerRadii === "function") node.setAllCornerRadii(style.cornerRadius);
      else if (node.cornerRadius !== undefined) node.cornerRadius = style.cornerRadius;
    }
    if (style.opacity !== undefined) node.opacity = style.opacity;
    if (style.shadow && node.shadow !== undefined) node.shadow = tryShadow(style.shadow);
    if (style.innerShadow && node.innerShadow !== undefined) node.innerShadow = tryInnerShadow(style.innerShadow);
    if (style.blur && node.blur !== undefined) {
      node.blur = new scenegraph.Blur({ blurAmount: style.blur.blurAmount, brightnessDelta: style.blur.brightnessDelta || 0 });
    }
  }

  function setPosition(node, frame) {
    // Place the visible local-bounds top-left at the requested parent coordinate.
    // This matters for Text and Path nodes whose local origin is not their visual top-left.
    const b = node.localBounds || { x: 0, y: 0 };
    try {
      node.placeInParentCoordinates({ x: b.x, y: b.y }, { x: frame.x, y: frame.y });
    } catch (e) {
      // fall back to direct assignment on builds that expose writable x/y
      node.x = frame.x;
      node.y = frame.y;
    }
  }

  /**
   * Resolve the container a new node should be added to.
   * Never throws: returns {parent} or {error, code}.
   * Behaviour preserved: explicit parent guid -> that node; otherwise first
   * artboard; otherwise the scenegraph root (documented RootNode).
   */
  function findParent(params) {
    const sc = requireScene();
    if (!sc.ok) return { error: sc.error, code: sc.code };
    if (params.parent) {
      const found = findNode(sc.root, params.parent);
      if (found && !found.isContainer) return { error: "parent guid is not a container: " + params.parent, code: "invalid_parent" };
      if (found) {
        const contextError = editContextError([found]);
        return contextError ? { error: contextError.error, code: contextError.code } : { parent: found };
      }
      return { error: "parent guid not found: " + params.parent, code: "node_not_found" };
    }
    const abs = childList(sc.root).filter(isArtboard);
    const parent = abs.length > 0 ? abs[0] : sc.root;
    const contextError = editContextError([parent]);
    return contextError ? { error: contextError.error, code: contextError.code } : { parent };
  }

  function findNode(root, guid) {
    if (root.guid === guid) return root;
    for (const child of childList(root)) {
      const hit = findNode(child, guid);
      if (hit) return hit;
    }
    return null;
  }

  function walk(root, fn) {
    fn(root);
    childList(root).forEach((c) => walk(c, fn));
  }

  function nodeSummary(n) {
    return {
      guid: n.guid,
      name: n.name,
      type: n.constructor ? n.constructor.name : typeof n,
      frame: {
        x: n.globalDrawBounds ? n.globalDrawBounds.x : null,
        y: n.globalDrawBounds ? n.globalDrawBounds.y : null,
        width: n.globalDrawBounds ? n.globalDrawBounds.width : null,
        height: n.globalDrawBounds ? n.globalDrawBounds.height : null,
      },
      visible: n.visible,
      locked: n.locked,
      childCount: n.children ? n.children.length : 0,
    };
  }

  function hexOf(colorish) {
    try {
      if (!colorish) return null;
      if (typeof colorish.toHex === "function") return colorish.toHex();
      return String(colorish);
    } catch (e) {
      return null;
    }
  }

  function fillSummary(fill) {
    if (!fill) return null;
    if (typeof fill.toHex === "function") return fill.toHex();
    if (Array.isArray(fill.colorStops)) {
      return {
        type: fill.type || (fill.constructor && fill.constructor.name) || "Gradient",
        colorStops: fill.colorStops.map((s) => ({ stop: s.stop, color: hexOf(s.color) })),
        startX: fill.startX,
        startY: fill.startY,
        endX: fill.endX,
        endY: fill.endY,
        centerX: typeof fill.getCenterPoint === "function" ? fill.getCenterPoint().x : undefined,
        centerY: typeof fill.getCenterPoint === "function" ? fill.getCenterPoint().y : undefined,
        endR: fill.endR,
        rotation: fill.rotation,
      };
    }
    if (fill.assetId) return { type: "ImageFill", assetId: fill.assetId, scaleBehavior: fill.scaleBehavior, naturalWidth: fill.naturalWidth, naturalHeight: fill.naturalHeight };
    return String(fill);
  }

  function inspectDetail(n) {
    const s = nodeSummary(n);
    s.fill = fillSummary(n.fill);
    s.stroke = hexOf(n.stroke);
    s.opacity = n.opacity;
    s.markedForExport = n.markedForExport;
    try {
      s.blendMode = n.blendMode;
      s.hasDefaultName = n.hasDefaultName;
      s.layout = n.layout && n.layout.type ? n.layout.type : undefined;
    } catch (e) {
      /* optional properties are host dependent */
    }
    const kind = n.constructor ? n.constructor.name : "";
    if (kind === "Text") {
      s.text = n.text;
      s.fontFamily = n.fontFamily;
      s.fontSize = n.fontSize;
      s.textAlign = n.textAlign;
      s.lineSpacing = n.lineSpacing;
      s.paragraphSpacing = n.paragraphSpacing;
      try {
        s.layoutBox = n.layoutBox ? n.layoutBox.type : null;
        s.clippedByArea = n.clippedByArea;
      } catch (e) {
        /* pre-XD 34 */
      }
    }
    if (kind === "Path") s.pathData = n.pathData;
    s.children = childList(n).slice(0, 30).map(nodeSummary);
    return s;
  }

  function base64FromUint8(u8) {
    let s = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < u8.length; i += CHUNK) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    }
    return btoa(s);
  }

  function arrayBufferToBase64(buf) {
    const u8 = new Uint8Array(buf);
    let s = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < u8.length; i += CHUNK) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    }
    return btoa(s);
  }

  // --- document access helpers ------------------------------------------------
  // Verified against the Adobe XD plugin API reference (2026-11-10):
  //   application.activeDocument -> DocumentInfo { name, guid }  (XD 61)
  //     — it is NOT a document object: no .root, .path or .modified.
  //   scenegraph.root            -> RootNode of this document's scenegraph (XD 14+)
  // The previous code read `application.activeDocument.root.children`; `.root` is
  // undefined on DocumentInfo, so `.children` threw for every caller.
  function docInfo() {
    try {
      const info = application.activeDocument;
      return info && typeof info === "object" ? info : null;
    } catch (e) {
      return null;
    }
  }

  // Documented XD 61: SceneNode.children is a SceneNodeList — NOT an Array.
  // Index access `list[i]` does not work; use at(i). forEach() is available,
  // but filter/map/slice/find are not guaranteed. Normalise to a real Array.
  function childList(node) {
    if (!node) return [];
    const c = node.children;
    if (!c) return [];
    if (Array.isArray(c)) return c;
    const len = typeof c.length === "number" ? c.length : 0;
    const out = [];
    for (let i = 0; i < len; i++) {
      out.push(typeof c.at === "function" ? c.at(i) : c[i]);
    }
    return out;
  }

  function isArtboard(node) {
    if (!node) return false;
    if (node.constructor && node.constructor.name === "Artboard") return true;
    try {
      return node instanceof scenegraph.Artboard;
    } catch (e) {
      return false;
    }
  }

  /** Resolve the scenegraph root without ever throwing: {root} | {error, code}. */
  function sceneRoot() {
    let root = null;
    try {
      root = scenegraph.root;
    } catch (e) {
      root = null;
    }
    if (!root || typeof root !== "object") {
      return { error: "scenegraph root is unavailable (scenegraph.root was " + (root === null ? "null" : typeof root) + ")", code: "no_scenegraph_root" };
    }
    // RootNode.children is a SceneNodeList (array-like, not an Array).
    const c = root.children;
    if (!c || typeof c !== "object" || typeof c.length !== "number" || (!Array.isArray(c) && typeof c.at !== "function")) {
      return { error: "scenegraph root has no children list (RootNode.children was " + (c === null ? "null" : typeof c) + ")", code: "no_scenegraph_root" };
    }
    return { root };
  }

  /** Document metadata + scenegraph root, or a structured error. Never throws. */
  function requireScene() {
    const info = docInfo();
    if (!info) {
      return { ok: false, code: "no_active_document", error: "No active document is attached to this plugin instance (application.activeDocument is null)." };
    }
    const scene = sceneRoot();
    if (!scene.root) return { ok: false, code: scene.code, error: scene.error };
    return { ok: true, info, root: scene.root };
  }

  /**
   * Resolve a node by GUID. Documented fast path first (scenegraph.getNodeByGUID,
   * XD 28+), tree walk as fallback. Never throws; returns null when not found.
   */
  function resolveNode(guid) {
    if (!guid || typeof guid !== "string") return null;
    let n = null;
    try {
      n = scenegraph.getNodeByGUID(guid);
    } catch (e) {
      n = null;
    }
    if (n) return n;
    const scene = sceneRoot();
    return scene.root ? findNode(scene.root, guid) : null;
  }

  /**
   * Resolve a node inside a valid document context.
   * Returns {ok:true, node} or a ready-to-return structured error.
   */
  function requireNode(guid) {
    const sc = requireScene();
    if (!sc.ok) return sc;
    const node = resolveNode(guid);
    if (!node) return { ok: false, code: "node_not_found", error: "node not found: " + guid };
    return { ok: true, node };
  }

  function editContextError(nodes) {
    const selection = scenegraph.selection;
    if (!selection || typeof selection.isInEditContext !== "function") return null;
    const outside = (nodes || []).find((node) => node && !selection.isInEditContext(node));
    return outside
      ? { ok: false, code: "outside_edit_context", error: "node is outside the current XD edit context: " + outside.guid }
      : null;
  }

  function requireEditableNode(guid) {
    const result = requireNode(guid);
    if (!result.ok) return result;
    return editContextError([result.node]) || result;
  }

  function restoreSelection(items) {
    const original = items || [];
    const surviving = original.every((n) => n && n.guid && resolveNode(n.guid)) ? original : original.filter((n) => n && n.guid && resolveNode(n.guid));
    try {
      scenegraph.selection.items = surviving;
    } catch (e) {
      // A deleted node can invalidate the previous selection/edit context.
      try { scenegraph.selection.items = []; } catch (e2) { /* best-effort */ }
    }
  }

  function runSelectionCommand(guids, action) {
    const sc = requireScene();
    if (!sc.ok) return sc;
      const nodes = [];
      for (const guid of guids || []) {
      const node = resolveNode(guid);
      if (!node) return { ok: false, code: "node_not_found", error: "node not found: " + guid };
      nodes.push(node);
      }
      const contextError = editContextError(nodes);
      if (contextError) return contextError;
      if (nodes.length < 2) return { ok: false, code: "invalid_selection", error: "at least two nodes are required" };
    if (!nodes.every((n) => n.parent === nodes[0].parent)) {
      return { ok: false, code: "invalid_selection", error: "selected nodes must share the same parent" };
    }
    const commandsByAction = {
      bringToFront: commands.bringToFront,
      bringForward: commands.bringForward,
      sendToBack: commands.sendToBack,
      sendBackward: commands.sendBackward,
      alignLeft: commands.alignLeft,
      alignRight: commands.alignRight,
      alignHorizontalCenter: commands.alignHorizontalCenter,
      alignTop: commands.alignTop,
      alignBottom: commands.alignBottom,
      alignVerticalCenter: commands.alignVerticalCenter,
      distributeHorizontal: commands.distributeHorizontal,
      distributeVertical: commands.distributeVertical,
    };
    const command = commandsByAction[action];
    if (typeof command !== "function") return { ok: false, code: "unsupported_action", error: "unsupported XD command: " + action };
    const prev = scenegraph.selection.items;
    scenegraph.selection.items = nodes;
    try {
      command.call(commands);
      return { ok: true, action, guids: nodes.map((n) => n.guid) };
    } finally {
      restoreSelection(prev);
    }
  }

  function artboardFrame(a) {
    const b = a.globalDrawBounds || null;
    return {
      x: b && typeof b.x === "number" ? b.x : 0,
      y: b && typeof b.y === "number" ? b.y : 0,
      width: typeof a.width === "number" ? a.width : b && typeof b.width === "number" ? b.width : 0,
      height: typeof a.height === "number" ? a.height : b && typeof b.height === "number" ? b.height : 0,
    };
  }

  // --- opt-in diagnostics (off by default; shapes only, never content) --------
  // Enable at runtime from the XD plugin console when diagnosing the host:
  //   window.__xdBridgeDiag = true
  function diagEnabled() {
    try {
      return !!(window && window.__xdBridgeDiag === true);
    } catch (e) {
      return false;
    }
  }
  function diagShape(label, obj) {
    if (!diagEnabled()) return;
    try {
      if (obj === undefined) {
        console.log("DIAG " + label + "=undefined");
        return;
      }
      if (obj === null) {
        console.log("DIAG " + label + "=null");
        return;
      }
      const ctor = obj.constructor && obj.constructor.name ? obj.constructor.name : "(none)";
      const keys = Object.keys(obj).slice(0, 24).join(",");
      console.log("DIAG " + label + ": ctor=" + ctor + " keys=[" + keys + "]");
    } catch (e) {
      /* diagnostics must never throw */
    }
  }
  function diagDocumentProbe(op, info, scene) {
    if (!diagEnabled()) return;
    diagShape(op + ".application.activeDocument", info);
    console.log("DIAG " + op + ".activeDocument.root typeof=" + (info ? typeof info.root : "n/a"));
    diagShape(op + ".scenegraph.root", scene && scene.root);
    const cl = scene && scene.root ? scene.root.children : null;
    const kind = Array.isArray(cl) ? "Array" : cl && typeof cl.at === "function" ? "SceneNodeList-like" : typeof cl;
    console.log("DIAG " + op + ".scenegraph.root.children kind=" + kind + " length=" + (cl && typeof cl.length === "number" ? cl.length : "n/a"));
  }

  // --- op handlers -----------------------------------------------------------

  // --- text, layout and command helpers ---------------------------------------

  /**
   * Text sizing. XD 34+ replaced the deprecated `areaBox` with `layoutBox`;
   * setting `areaBox` with a non-existent `scenegraph.AreaType` threw and was
   * swallowed, which silently produced point text for every "fixed frame" text
   * node. Point text auto-fits its content, so textAlign had no visible effect
   * and neither width nor height were honoured.
   */
  function applyTextLayout(t, frame) {
    const hasW = frame && typeof frame.width === "number" && frame.width > 0;
    const hasH = frame && typeof frame.height === "number" && frame.height > 0;
    const T = scenegraph.Text || {};
    try {
      if (hasW && hasH) {
        t.layoutBox = { type: T.FIXED_HEIGHT, width: frame.width, height: frame.height };
        return "FIXED_HEIGHT";
      }
      if (hasW) {
        t.layoutBox = { type: T.AUTO_HEIGHT, width: frame.width };
        return "AUTO_HEIGHT";
      }
    } catch (e) {
      return "POINT (layoutBox rejected: " + String(e && e.message ? e.message : e) + ")";
    }
    return "POINT";
  }

  /** Documented Text.ALIGN_* constants, with a literal fallback for older hosts. */
  function textAlignValue(v) {
    if (!v) return null;
    const T = scenegraph.Text || {};
    const key = String(v).toLowerCase();
    if (key === "left") return T.ALIGN_LEFT || "left";
    if (key === "center") return T.ALIGN_CENTER || "center";
    if (key === "right") return T.ALIGN_RIGHT || "right";
    return null;
  }

  /**
   * Applies text style ranges + node-level typography. Range keys are limited to
   * the documented set (underline, strikethrough, textTransform, textScript are
   * all valid range keys); lineSpacing/paragraphSpacing/flipY are node-level.
   */
  function applyTextStyle(t, st, text) {
    if (!st) return;
    const range = { length: String(text || "").length };
    if (st.fontFamily) range.fontFamily = st.fontFamily;
    if (st.fontSize) range.fontSize = st.fontSize;
    if (st.fontStyle || st.fontWeight) range.fontStyle = st.fontStyle || st.fontWeight;
    if (st.charSpacing !== undefined) range.charSpacing = st.charSpacing;
    if (st.fill) range.fill = Color(st.fill);
    if (st.underline !== undefined) range.underline = st.underline;
    if (st.strikethrough !== undefined) range.strikethrough = st.strikethrough;
    if (st.textTransform) range.textTransform = st.textTransform;
    if (st.textScript) range.textScript = st.textScript;
    if (Object.keys(range).length > 1) t.styleRanges = [range];
    const align = textAlignValue(st.textAlign);
    if (align) t.textAlign = align;
    if (st.lineHeight) t.lineSpacing = st.lineHeight;
    if (st.paragraphSpacing !== undefined) t.paragraphSpacing = st.paragraphSpacing;
    if (st.flipY !== undefined) t.flipY = st.flipY;
  }

  /** Run a documented selection-based command over one or more resolved nodes. */
  function runCommandForNodes(guids, commandName, minCount) {
    const sc = requireScene();
    if (!sc.ok) return sc;
    const nodes = [];
    const list = guids || [];
    for (const guid of list) {
      const node = resolveNode(guid);
      if (!node) return { ok: false, code: "node_not_found", error: "node not found: " + guid };
      nodes.push(node);
    }
    if (nodes.length < (minCount || 1)) {
      return { ok: false, code: "invalid_selection", error: "at least " + (minCount || 1) + " node(s) required" };
    }
    const contextError = editContextError(nodes);
    if (contextError) return contextError;
    const fn = commands[commandName];
    if (typeof fn !== "function") {
      return { ok: false, code: "unsupported", error: "this Adobe XD version does not expose commands." + commandName };
    }
    const prev = scenegraph.selection.items;
    scenegraph.selection.items = nodes;
    try {
      fn.call(commands);
      const after = scenegraph.selection.items;
      return { ok: true, command: commandName, guids: after.map ? after.map((n) => n.guid) : nodes.map((n) => n.guid) };
    } finally {
      restoreSelection(prev);
    }
  }

  /** Single-node command (make/replace background), also selection driven. */
  function runCommandForNode(guid, commandName) {
    return runCommandForNodes([guid], commandName, 1);
  }

  // --- prototype wiring assistant ---------------------------------------------
  // XD's `interactions` module is READ-ONLY. No documented public API creates,
  // edits or deletes a prototype wire, so nothing below authors one. These
  // helpers only (a) read the real wires, (b) classify an expected edge against
  // them, and (c) drive selection + viewport so a HUMAN can draw the wire in
  // XD's Prototype workspace. Any code that claims to create a wire is lying.

  /** Narrow a SceneNodeList/Array of nodes to their GUIDs, or null when unreadable. */
  function readSelectionGuids() {
    try {
      const selection = scenegraph.selection;
      if (!selection) return null;
      const items = selection.items;
      if (!items) return null;
      const out = [];
      const len = typeof items.length === "number" ? items.length : 0;
      for (let i = 0; i < len; i++) {
        const n = typeof items.at === "function" ? items.at(i) : items[i];
        if (n && n.guid) out.push(n.guid);
      }
      return out;
    } catch (e) {
      return null;
    }
  }

  /** Nearest ancestor Artboard of a node (or the node itself). */
  function artboardOf(node) {
    let current = node;
    while (current) {
      if (isArtboard(current)) return current;
      current = current.parent || null;
    }
    return null;
  }

  /**
   * Read the documented viewport API. Returns availability + a snapshot of the
   * evidence XD actually exposes: `bounds` and `zoomFactor` are read-only
   * properties, and they are the only way to prove the view moved.
   *
   * Documented methods: scrollIntoView / scrollToCenter / zoomToRect.
   */
  function probeViewport() {
    let viewport = null;
    try {
      viewport = require("viewport");
    } catch (e) {
      return { available: false, code: "viewport_unavailable", error: String(e && e.message ? e.message : e) };
    }
    if (!viewport) return { available: false, code: "viewport_unavailable" };
    if (typeof viewport.scrollIntoView !== "function") {
      return { available: false, code: "viewport_unsupported", api: "scrollIntoView" };
    }
    const state = { available: true, api: "scrollIntoView", bounds: null, zoomFactor: null };
    try {
      const b = viewport.bounds;
      if (b && typeof b.x === "number" && typeof b.y === "number" && typeof b.width === "number" && typeof b.height === "number") {
        state.bounds = { x: b.x, y: b.y, width: b.width, height: b.height };
      }
    } catch (e) { /* bounds are optional evidence */ }
    try {
      if (typeof viewport.zoomFactor === "number") state.zoomFactor = viewport.zoomFactor;
    } catch (e) { /* zoom is optional evidence */ }
    return state;
  }

  function drawBoundsOf(node) {
    const b = node && node.globalDrawBounds ? node.globalDrawBounds : null;
    if (!b || typeof b.x !== "number") return null;
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  }

  function fullyInside(inner, outer) {
    return inner.x >= outer.x
      && inner.y >= outer.y
      && inner.x + inner.width <= outer.x + outer.width
      && inner.y + inner.height <= outer.y + outer.height;
  }

  /**
   * Pan the canvas to a node with the documented `viewport.scrollIntoView(node)`.
   * `scrolled` is only true when `viewport.bounds` demonstrably changed; an API
   * call that merely did not throw is never reported as movement.
   */
  function focusViewport(node) {
    const before = probeViewport();
    if (!before.available) {
      return { scrolled: false, code: before.code, evidence: "none", api: "scrollIntoView" };
    }
    const nodeBounds = drawBoundsOf(node);
    const alreadyInView = !!(nodeBounds && before.bounds && fullyInside(nodeBounds, before.bounds));

    let viewport;
    try {
      viewport = require("viewport");
    } catch (e) {
      return { scrolled: false, code: "viewport_unavailable", evidence: "none", api: "scrollIntoView" };
    }
    try {
      // Documented signature: scrollIntoView(node). Pass the resolved node, not a rect copy.
      viewport.scrollIntoView(node);
    } catch (e) {
      return {
        scrolled: false,
        code: "viewport_error",
        evidence: "call_failed",
        api: "scrollIntoView",
        error: String(e && e.message ? e.message : e),
        before: { bounds: before.bounds, zoomFactor: before.zoomFactor },
      };
    }

    const after = probeViewport();
    const afterEvidence = after.available ? { bounds: after.bounds, zoomFactor: after.zoomFactor } : null;
    const beforeEvidence = { bounds: before.bounds, zoomFactor: before.zoomFactor };

    if (!before.bounds || !afterEvidence || !afterEvidence.bounds) {
      return {
        scrolled: false,
        code: "viewport_change_unverified",
        evidence: "none",
        api: "scrollIntoView",
        reason: "viewport.bounds is not readable, so movement cannot be verified",
        before: beforeEvidence,
        after: afterEvidence,
      };
    }

    const moved = before.bounds.x !== afterEvidence.bounds.x || before.bounds.y !== afterEvidence.bounds.y;
    if (moved) {
      return { scrolled: true, code: "viewport_moved", evidence: "bounds", api: "scrollIntoView", before: beforeEvidence, after: afterEvidence };
    }
    return {
      scrolled: false,
      code: alreadyInView ? "already-in-view" : "viewport_change_unverified",
      evidence: "bounds",
      api: "scrollIntoView",
      reason: alreadyInView
        ? "the node was already fully inside viewport.bounds; scrollIntoView is documented to do nothing in that case"
        : "scrollIntoView is a smooth pan and viewport.bounds had not changed on synchronous read-back; movement is not proven",
      before: beforeEvidence,
      after: afterEvidence,
    };
  }

  /**
   * Select one node and classify what the transaction observed.
   *
   * XD refuses `scenegraph.selection.items = [...]` outside editDocument, so this
   * runs inside the panel's edit gate. Live testing showed a *selection-only*
   * transaction persists after commit, but a selection followed by more work in
   * the same transaction (a viewport pan) does not — so callers must run
   * focusViewport() FIRST and leave this as the last scenegraph-affecting step.
   *
   * Even then, this can only observe the in-transaction state: the handler cannot
   * see anything after commit. It therefore never claims "focused". Real focus
   * confirmation is an independent `xd_get_selection` read after execution.
   *
   * focusState: selection-assigned | selection-failed | focus-unverified
   */
  function attemptSelection(node) {
    const before = readSelectionGuids();
    if (before === null) {
      return {
        focusState: "focus-unverified",
        assignedTo: null,
        selectedInTransaction: false,
        wasSelectedBefore: false,
        selectionError: "scenegraph.selection is not readable in this host",
      };
    }

    let error = null;
    try {
      scenegraph.selection.items = [node];
    } catch (e) {
      error = String(e && e.message ? e.message : e);
    }

    const after = readSelectionGuids();
    const selectedInTransaction = !!after && after.length === 1 && after[0] === node.guid;
    const wasSelectedBefore = before.length === 1 && before[0] === node.guid;

    if (error) {
      return { focusState: "selection-failed", assignedTo: null, selectedInTransaction, wasSelectedBefore, selectionError: error };
    }
    if (!selectedInTransaction) {
      return {
        focusState: "selection-failed",
        assignedTo: null,
        selectedInTransaction: false,
        wasSelectedBefore,
        selectionError: "selection did not apply: read-back does not show the requested node",
      };
    }
    return {
      focusState: "selection-assigned",
      assignedTo: node.guid,
      selectedInTransaction: true,
      wasSelectedBefore,
      selectionError: null,
    };
  }

  /** Guidance attached to every focus result: the handler cannot see post-commit state. */
  const POST_COMMIT_CONFIRMATION = "read xd_get_selection after execution";



  /** Normalised read of every wire XD currently has in this document. */
  function readPrototypeEdges() {
    let interactions;
    try {
      interactions = require("interactions");
    } catch (e) {
      return { ok: false, code: "unsupported", supported: false, error: "XD interactions module is unavailable in this host" };
    }
    const edges = [];
    (interactions.allInteractions || []).forEach((entry) => {
      (entry.interactions || []).forEach((interaction) => {
        const action = interaction.action || {};
        const destination = action.destination || action.overlay || null;
        const transition = action.transition || null;
        edges.push({
          fromGuid: entry.triggerNode ? entry.triggerNode.guid : null,
          fromName: entry.triggerNode ? entry.triggerNode.name : null,
          toGuid: destination ? destination.guid : null,
          toName: destination ? destination.name : null,
          trigger: interaction.trigger ? interaction.trigger.type : null,
          action: action.type || null,
          transition: transition ? {
            type: transition.type || null,
            duration: typeof transition.duration === "number" ? transition.duration : null,
            easing: transition.easing || null,
          } : null,
        });
      });
    });
    return { ok: true, edges };
  }

  /**
   * Classify one expected edge against the real wires.
   * status: ok | missing | incomplete | wrong-destination | wrong-trigger | wrong-action | ambiguous
   */
  function classifyConnection(required, edges) {
    const fromEdges = edges.filter((edge) => edge.fromGuid === required.fromGuid);
    if (fromEdges.length === 0) return { status: "missing", matches: [], candidates: [] };
    const toEdges = fromEdges.filter((edge) => edge.toGuid === required.toGuid);
    if (toEdges.length === 0) {
      const noDestination = fromEdges.every((edge) => !edge.toGuid);
      return { status: noDestination ? "incomplete" : "wrong-destination", matches: [], candidates: fromEdges };
    }
    let narrowed = toEdges;
    if (required.trigger) {
      narrowed = toEdges.filter((edge) => edge.trigger === required.trigger);
      if (narrowed.length === 0) return { status: "wrong-trigger", matches: [], candidates: toEdges };
    }
    if (required.action) {
      narrowed = narrowed.filter((edge) => edge.action === required.action);
      if (narrowed.length === 0) return { status: "wrong-action", matches: [], candidates: toEdges };
    }
    if (narrowed.length > 1) return { status: "ambiguous", matches: narrowed, candidates: narrowed };
    return { status: "ok", matches: narrowed, candidates: narrowed };
  }

  function edgeLabel(edge) {
    const from = edge.fromName || edge.fromGuid || "?";
    const to = edge.toName || edge.toGuid || "(no destination)";
    return from + " → " + to + " [" + (edge.trigger || "?") + " / " + (edge.action || "?") + "]";
  }

  /** Human instructions for the manual XD Prototype-mode step. Never a claim of authorship. */
  function wireInstruction(source, target, trigger, action, transition, overlay) {
    const sourceName = source.name || source.guid;
    const targetName = target.name || target.guid;
    const host = artboardOf(source);
    const where = host ? " on artboard \"" + host.name + "\"" : "";
    const actionLabel = action === "overlay" ? "Overlay" : "Transition → \"" + targetName + "\"";
    const parts = [];
    parts.push("In XD, switch to Prototype mode and confirm the source node is selected on the canvas.");
    parts.push("Drag the blue connector from \"" + sourceName + "\"" + where + " onto artboard \"" + targetName + "\".");
    parts.push("Set Trigger = " + trigger + ", Action = " + actionLabel + ".");
    if (transition && transition.type) {
      const duration = typeof transition.duration === "number" ? ", duration " + transition.duration + "s" : "";
      const easing = transition.easing ? ", easing " + transition.easing : "";
      parts.push("Transition = " + transition.type + duration + easing + ".");
    }
    if (overlay && (typeof overlay.x === "number" || typeof overlay.y === "number")) {
      parts.push("Overlay position = (" + (overlay.x || 0) + ", " + (overlay.y || 0) + ").");
    }
    parts.push("This operation does not create the wire; it only prepares it.");
    return parts.join(" ");
  }

  function guidanceForStatus(status, source, target, required) {
    const from = source.name || source.guid;
    const to = target.name || target.guid;
    switch (status) {
      case "ok":
        return "Verified: " + from + " → " + to + " [" + required.trigger + " / " + required.action + "] exists in the document.";
      case "missing":
        return "No wire exists from " + from + ". Re-run prototype_prepare_connection and draw it in Prototype mode.";
      case "wrong-destination":
        return "A wire exists from " + from + " but it points somewhere other than " + to + ". Re-point it in XD's Prototype panel; no plugin API can edit it.";
      case "wrong-trigger":
        return "The wire reaches " + to + " but its trigger is not \"" + required.trigger + "\". Change the trigger in XD's Prototype panel.";
      case "wrong-action":
        return "The wire reaches " + to + " but its action is not \"" + required.action + "\". Change the action in XD's Prototype panel.";
      case "incomplete":
        return "A wire exists from " + from + " with no destination. Complete it in XD's Prototype panel.";
      case "ambiguous":
        return "More than one wire from " + from + " to " + to + " matches. Remove the duplicate(s) in XD's Prototype panel.";
      default:
        return "Unrecognised verification state: " + status;
    }
  }

  const handlers = {
    get_document_info: () => {
      const info = docInfo();
      const scene = sceneRoot();
      diagDocumentProbe("get_document_info", info, scene);
      if (!info) {
        return { ok: false, code: "no_active_document", error: "No active document is attached to this plugin instance (application.activeDocument is null)." };
      }
      if (!scene.root) {
        return { ok: false, code: scene.code, error: scene.error };
      }
      const abs = childList(scene.root).filter(isArtboard);
      let nodeCount = 0;
      walk(scene.root, (n) => {
        if (n !== scene.root) nodeCount++;
      });
      return {
        ok: true,
        document: {
          name: typeof info.name === "string" ? info.name : null,
          guid: typeof info.guid === "string" ? info.guid : scene.root.guid || null,
          artboardCount: abs.length,
          nodeCount,
          // DocumentInfo exposes name + guid only; these fields are deliberately null, not invented.
          path: null,
          modified: null,
        },
        notes: ["application.activeDocument is a DocumentInfo {name, guid} in XD 61; path and modified state are not exposed by the plugin API."],
      };
    },

    get_artboards: () => {
      const info = docInfo();
      const scene = sceneRoot();
      diagDocumentProbe("get_artboards", info, scene);
      if (!info) {
        return { ok: false, code: "no_active_document", error: "No active document is attached to this plugin instance (application.activeDocument is null)." };
      }
      if (!scene.root) {
        return { ok: false, code: scene.code, error: scene.error };
      }
      const abs = childList(scene.root).filter(isArtboard);
      return {
        ok: true,
        documentName: typeof info.name === "string" ? info.name : null,
        count: abs.length,
        artboards: abs.map((a) => ({
          guid: a.guid,
          name: a.name,
          frame: artboardFrame(a),
        })),
      };
    },

    get_selection: () => {
      const sel = require("scenegraph").selection;
      return {
        ok: true,
        selection: sel.items.map((n) => ({
          guid: n.guid,
          name: n.name,
          type: n.constructor ? n.constructor.name : "?",
          frame: { x: n.globalDrawBounds ? n.globalDrawBounds.x : 0, y: n.globalDrawBounds ? n.globalDrawBounds.y : 0, width: n.globalDrawBounds ? n.globalDrawBounds.width : 0, height: n.globalDrawBounds ? n.globalDrawBounds.height : 0 },
        })),
      };
    },

    inspect_node: (p) => {
      const nr = requireNode(p.guid);
      if (!nr.ok) return nr;
      return { ok: true, node: inspectDetail(nr.node) };
    },

    search_nodes: (p) => {
      const sc = requireScene();
      if (!sc.ok) return sc;
      const limit = p.limit || 50;
      const results = [];
      const q = p.query ? p.query.toLowerCase() : null;
      walk(sc.root, (n) => {
        if (results.length >= limit) return;
        const type = n.constructor ? n.constructor.name : "?";
        if (p.type && type !== p.type) return;
        if (q && !(n.name || "").toLowerCase().includes(q)) return;
        if ((p.type && type === p.type) || q) results.push(nodeSummary(n));
      });
      return { ok: true, nodes: results };
    },

    create_artboard: (p) => {
      const sc = requireScene();
      if (!sc.ok) return sc;
      // The pasteboard root IS the edit context. XD 61 reports
      // selection.isInEditContext(root) as false, so validating the root here
      // made artboard creation impossible ("outside_edit_context"). Adding an
      // Artboard to root is the documented flow; the panel's editDocument gate
      // still guarantees a legal edit context.
      const ab = new scenegraph.Artboard();
      ab.width = p.frame.width;
      ab.height = p.frame.height;
      ab.name = p.name || "Artboard";
      sc.root.addChild(ab);
      setPosition(ab, p.frame);
      return { ok: true, guid: ab.guid, name: ab.name };
    },

    create_screen: (p) => {
      // Composite: build an artboard AND its children inside ONE editDocument
      // transaction. Children can only be parented to the artboard created here,
      // which is exactly the dependency that otherwise forces a second panel
      // interaction (the artboard GUID does not exist until it is created).
      const sc = requireScene();
      if (!sc.ok) return sc;
      const spec = p.artboard || {};
      const frame = spec.frame;
      if (!frame) return { ok: false, code: "invalid_params", error: "artboard.frame is required" };

      const ab = new scenegraph.Artboard();
      ab.width = frame.width;
      ab.height = frame.height;
      ab.name = spec.name || "Screen";
      if (spec.style) applyStyle(ab, spec.style);
      sc.root.addChild(ab);
      setPosition(ab, frame);

      const results = [];
      let aborted = false;
      const children = p.children || [];
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        const entry = { op: child.op, name: child.name };
        if (aborted) {
          results.push(Object.assign({}, entry, { ok: false, error: "aborted after previous failure" }));
          continue;
        }
        const h = handlers[child.op];
        if (!h) {
          results.push(Object.assign({}, entry, { ok: false, error: "unsupported child op: " + child.op }));
          aborted = true;
          continue;
        }
        try {
          const params = Object.assign({}, child, { parent: ab.guid });
          delete params.op;
          const r = h(params);
          results.push(Object.assign({}, entry, r));
          if (!r.ok && r.supported !== false) aborted = true;
        } catch (e) {
          results.push(Object.assign({}, entry, { ok: false, error: String(e && e.message ? e.message : e) }));
          aborted = true;
        }
      }

      return {
        ok: results.every((r) => r.ok),
        guid: ab.guid,
        name: ab.name,
        frame: { x: frame.x, y: frame.y, width: frame.width, height: frame.height },
        childCount: results.length,
        aborted,
        children: results,
      };
    },

    create_rectangle: (p) => {
      const pf = findParent(p);
      if (!pf.parent) return { ok: false, code: pf.code, error: pf.error };
      const rect = new scenegraph.Rectangle();
      rect.width = p.frame.width;
      rect.height = p.frame.height;
      if (p.name) rect.name = p.name;
      applyStyle(rect, p.style);
      pf.parent.addChild(rect);
      setPosition(rect, p.frame);
      return { ok: true, guid: rect.guid, name: rect.name };
    },

    create_ellipse: (p) => {
      const pf = findParent(p);
      if (!pf.parent) return { ok: false, code: pf.code, error: pf.error };
      const el = new scenegraph.Ellipse();
      el.width = p.frame.width;
      el.height = p.frame.height;
      if (p.name) el.name = p.name;
      applyStyle(el, p.style);
      pf.parent.addChild(el);
      setPosition(el, p.frame);
      return { ok: true, guid: el.guid, name: el.name };
    },

    create_line: (p) => {
      const pf = findParent(p);
      if (!pf.parent) return { ok: false, code: pf.code, error: pf.error };
      const line = new scenegraph.Line();
      if (p.name) line.name = p.name;
      line.setStartEnd(p.start.x, p.start.y, p.end.x, p.end.y);
      applyStyle(line, p.style);
      pf.parent.addChild(line);
      return { ok: true, guid: line.guid, name: line.name };
    },

    create_polygon: (p) => {
      const pf = findParent(p);
      if (!pf.parent) return { ok: false, code: pf.code, error: pf.error };
      const polygon = new scenegraph.Polygon();
      polygon.cornerCount = p.cornerCount || 3;
      if (p.starRatio !== undefined) polygon.starRatio = p.starRatio;
      polygon.width = p.frame.width;
      polygon.height = p.frame.height;
      if (p.name) polygon.name = p.name;
      applyStyle(polygon, p.style);
      pf.parent.addChild(polygon);
      setPosition(polygon, p.frame);
      return { ok: true, guid: polygon.guid, name: polygon.name };
    },

    create_path: (p) => {
      const pf = findParent(p);
      if (!pf.parent) return { ok: false, code: pf.code, error: pf.error };
      const path = new scenegraph.Path();
      path.pathData = p.pathData;
      if (p.name) path.name = p.name;
      applyStyle(path, p.style);
      pf.parent.addChild(path);
      // position:"absolute" keeps the supplied coordinates exactly as authored
      // (used by the asset layer, which bakes final artboard coordinates into
      // the path data and must not have them re-anchored to the bbox).
      if (p.position !== "absolute") setPosition(path, { x: p.x, y: p.y });
      return { ok: true, guid: path.guid, name: path.name };
    },

    create_image: async (p) => {
      const pf = findParent(p);
      if (!pf.parent) return { ok: false, code: pf.code, error: pf.error };
      const storage = require("uxp").storage;
      const file = await storage.localFileSystem.getFileForOpening({ types: ["png", "jpg", "jpeg", "gif"] });
      if (!file) return { ok: false, code: "user_cancelled", error: "image selection cancelled in the XD file picker" };
      const rect = new scenegraph.Rectangle();
      rect.width = p.frame.width;
      rect.height = p.frame.height;
      rect.name = p.name || file.name || "Image";
      const imageFill = new scenegraph.ImageFill(file);
      if (p.scaleBehavior === "stretch") imageFill.scaleBehavior = scenegraph.ImageFill.SCALE_STRETCH;
      else imageFill.scaleBehavior = scenegraph.ImageFill.SCALE_COVER;
      rect.fill = imageFill;
      pf.parent.addChild(rect);
      setPosition(rect, p.frame);
      return { ok: true, guid: rect.guid, name: rect.name, assetId: imageFill.assetId || null, scaleBehavior: imageFill.scaleBehavior };
    },

    replace_image: async (p) => {
      const nr = requireEditableNode(p.guid);
      if (!nr.ok) return nr;
      const node = nr.node;
      if (!node.constructor || !["Rectangle", "Ellipse", "Polygon", "Path"].includes(node.constructor.name)) {
        return { ok: false, code: "wrong_node_type", error: "replace_image requires a Rectangle, Ellipse, Polygon, or Path" };
      }
      const storage = require("uxp").storage;
      const file = await storage.localFileSystem.getFileForOpening({ types: ["png", "jpg", "jpeg", "gif"] });
      if (!file) return { ok: false, code: "user_cancelled", error: "image replacement cancelled in the XD file picker" };
      const imageFill = new scenegraph.ImageFill(file);
      imageFill.scaleBehavior = p.scaleBehavior === "stretch" ? scenegraph.ImageFill.SCALE_STRETCH : scenegraph.ImageFill.SCALE_COVER;
      node.fill = imageFill;
      return { ok: true, guid: node.guid, name: node.name, assetId: imageFill.assetId || null, scaleBehavior: imageFill.scaleBehavior };
    },

    import_asset: async (p) => {
      const sc = requireScene();
      if (!sc.ok) return sc;
      const parent = resolveNode(p.parent);
      if (!parent) return { ok: false, code: "node_not_found", error: "parent not found: " + p.parent };
      if (!isArtboard(parent)) return { ok: false, code: "invalid_parent", error: "application.import assets must target an Artboard; use create_image for an explicit parent/group" };
      if (parent !== sc.root && scenegraph.selection.isInEditContext && !scenegraph.selection.isInEditContext(parent)) {
        return { ok: false, code: "outside_edit_context", error: "target parent is outside the current XD edit context" };
      }
      const before = new Set();
      walk(sc.root, (n) => before.add(n.guid));
      const previousSelection = scenegraph.selection.items;
      let placeholder = null;
      try {
        // Only a native XD file-picker grant is accepted; the bridge never passes paths.
        placeholder = new scenegraph.Rectangle();
        placeholder.name = "__OpenCodeImportAnchor__";
        placeholder.width = 1;
        placeholder.height = 1;
        placeholder.opacity = 0;
        parent.addChild(placeholder);
        scenegraph.selection.items = [placeholder];
        const storage = require("uxp").storage;
        const file = await storage.localFileSystem.getFileForOpening({ types: ["png", "jpg", "jpeg", "gif", "bmp", "tif", "tiff", "ai", "psd", "json", "mp4", "txt"] });
        if (!file) return { ok: false, code: "user_cancelled", error: "asset import cancelled in the XD file picker" };
        application.import([file]);
        const imported = childList(parent).filter((n) => n !== placeholder && !before.has(n.guid));
        placeholder.removeFromParent();
        placeholder = null;
        if (imported.length === 0) return { ok: false, code: "import_no_nodes", error: "XD import completed without adding a node under the requested parent" };
        if (p.name && imported.length === 1) imported[0].name = p.name;
        if (typeof p.x === "number" && typeof p.y === "number") imported.forEach((n) => setPosition(n, { x: p.x, y: p.y }));
        return { ok: true, imported: imported.map((n) => nodeSummary(n)), count: imported.length, parentGuid: parent.guid };
      } finally {
        if (placeholder && placeholder.parent) placeholder.removeFromParent();
        restoreSelection(previousSelection);
      }
    },

    create_text: (p) => {
      const pf = findParent(p);
      if (!pf.parent) return { ok: false, code: pf.code, error: pf.error };
      const parent = pf.parent;
      const t = new scenegraph.Text();
      t.text = p.text;
      if (p.name) t.name = p.name;
      applyTextStyle(t, p.style, p.text);
      parent.addChild(t);
      // layoutBox must be applied before positioning: switching text type moves the
      // local origin, and setPosition aligns localBounds' top-left.
      const textMode = applyTextLayout(t, p.frame);
      setPosition(t, p.frame);
      return { ok: true, guid: t.guid, name: t.name, textMode };
    },

    create_group: (p) => {
      const sc = requireScene();
      if (!sc.ok) return sc;
      const nodes = [];
      for (const g of p.guids) {
        const n = resolveNode(g);
        if (!n) return { ok: false, code: "node_not_found", error: "node not found: " + g };
        nodes.push(n);
      }
      const contextError = editContextError(nodes);
      if (contextError) return contextError;
      if (!nodes.every((n) => n.parent === nodes[0].parent)) {
        return { ok: false, code: "invalid_selection", error: "group nodes must share the same parent" };
      }
      // documented command: group(selection) — selection must contain the nodes
      const prev = scenegraph.selection.items;
      scenegraph.selection.items = nodes;
      try {
        commands.group();
        const g = scenegraph.selection.items[0];
        if (p.name) g.name = p.name;
        return { ok: true, guid: g.guid, name: g.name };
      } finally {
        restoreSelection(prev);
      }
    },

    create_mask_group: (p) => {
      const sc = requireScene();
      if (!sc.ok) return sc;
      const nodes = [];
      for (const guid of p.guids) {
        const n = resolveNode(guid);
        if (!n) return { ok: false, code: "node_not_found", error: "node not found: " + guid };
        nodes.push(n);
      }
      const contextError = editContextError(nodes);
      if (contextError) return contextError;
      if (!nodes.every((n) => n.parent === nodes[0].parent)) {
        return { ok: false, code: "invalid_selection", error: "mask group nodes must share the same parent" };
      }
      const prev = scenegraph.selection.items;
      scenegraph.selection.items = nodes;
      try {
        commands.createMaskGroup();
        const group = scenegraph.selection.items[0];
        return { ok: true, guid: group.guid, name: group.name, childCount: childList(group).length };
      } finally {
        restoreSelection(prev);
      }
    },

    ungroup: (p) => {
      const nr = requireEditableNode(p.guid);
      if (!nr.ok) return nr;
      const node = nr.node;
      if (!node.constructor || node.constructor.name !== "Group") {
        return { ok: false, code: "wrong_node_type", error: "ungroup requires a Group node" };
      }
      const prev = scenegraph.selection.items;
      scenegraph.selection.items = [node];
      try {
        commands.ungroup();
        return { ok: true, ungroupedGuid: node.guid, remainingSelection: scenegraph.selection.items.map((n) => n.guid) };
      } finally {
        restoreSelection(prev);
      }
    },

    duplicate_node: (p) => {
      const nr = requireEditableNode(p.guid);
      if (!nr.ok) return nr;
      const prev = scenegraph.selection.items;
      scenegraph.selection.items = [nr.node];
      try {
        commands.duplicate();
        const clones = scenegraph.selection.items.slice();
        if (!clones.length) return { ok: false, code: "duplicate_failed", error: "XD returned no duplicated node" };
        if (p.name && clones.length === 1) clones[0].name = p.name;
        if (p.offset) clones.forEach((n) => n.moveInParentCoordinates(p.offset.x, p.offset.y));
        return { ok: true, nodes: clones.map((n) => ({ guid: n.guid, name: n.name, type: n.constructor.name })) };
      } finally {
        restoreSelection(prev);
      }
    },

    delete_node: (p) => {
      const nr = requireEditableNode(p.guid);
      if (!nr.ok) return nr;
      const node = nr.node;
      if (!node.parent) return { ok: false, code: "protected_root", error: "the scenegraph root cannot be deleted" };
      const parentGuid = node.parent.guid;
      node.removeFromParent();
      return { ok: true, deletedGuid: node.guid, parentGuid };
    },

    reparent_node: (p) => {
      const sc = requireScene();
      if (!sc.ok) return sc;
      const node = resolveNode(p.guid);
      if (!node) return { ok: false, code: "node_not_found", error: "node not found: " + p.guid };
      const parent = resolveNode(p.parent);
      if (!parent) return { ok: false, code: "node_not_found", error: "parent not found: " + p.parent };
      const contextError = editContextError([node, parent]);
      if (contextError) return contextError;
      if (node === sc.root || node.isContainer) {
        return { ok: false, code: "unsupported_reparent", error: "only leaf nodes can be reparented through SceneNode.addChild" };
      }
      if (!parent.isContainer) return { ok: false, code: "invalid_parent", error: "target parent is not a container" };
      if (parent === node || findNode(node, parent.guid)) return { ok: false, code: "invalid_parent", error: "cannot reparent a node into itself or its descendant" };
      if ((node.rotation || parent.rotation || parent.rotationX || parent.rotationY)) {
        return { ok: false, code: "unsupported_reparent_transform", error: "reparenting rotated or 3D-transformed nodes is not supported by this operation" };
      }
      if (node.parent === parent) return { ok: true, guid: node.guid, oldParentGuid: parent.guid, parentGuid: parent.guid, unchanged: true };
      const oldParentGuid = node.parent ? node.parent.guid : null;
      const global = node.globalDrawBounds || { x: 0, y: 0 };
      const parentBounds = parent === sc.root ? { x: 0, y: 0 } : parent.globalDrawBounds || { x: 0, y: 0 };
      node.removeFromParent();
      parent.addChild(node);
      setPosition(node, { x: global.x - parentBounds.x, y: global.y - parentBounds.y });
      return { ok: true, guid: node.guid, oldParentGuid, parentGuid: parent.guid };
    },

    rotate_node: (p) => {
      const nr = requireEditableNode(p.guid);
      if (!nr.ok) return nr;
      const node = nr.node;
      node.rotateAround(p.angle, node.localCenterPoint);
      return { ok: true, guid: node.guid, rotation: node.rotation };
    },

    arrange_nodes: (p) => {
      const result = runSelectionCommand(p.guids, p.action);
      return result;
    },

    align_nodes: (p) => {
      const result = runSelectionCommand(p.guids, p.action);
      return result;
    },

    distribute_nodes: (p) => {
      const result = runSelectionCommand(p.guids, p.action);
      return result;
    },

    update_path: (p) => {
      const nr = requireEditableNode(p.guid);
      if (!nr.ok) return nr;
      const n = nr.node;
      if (!n.constructor || n.constructor.name !== "Path") {
        return { ok: false, code: "node_not_found", error: "path node not found: " + p.guid };
      }
      try {
        n.pathData = p.pathData;
      } catch (e) {
        return { ok: false, code: "plugin_exception", error: "pathData rejected: " + String(e && e.message ? e.message : e) };
      }
      return { ok: true, guid: n.guid, pathData: n.pathData };
    },

    convert_to_path: (p) => runCommandForNodes(p.guids, "convertToPath", 1),

    outline_stroke: (p) => runCommandForNodes(p.guids, "outlineStroke", 1),

    align_to_pixel_grid: (p) => runCommandForNodes(p.guids, "alignToPixelGrid", 1),

    reset_3d_transforms: (p) => runCommandForNodes(p.guids, "reset3DTransforms", 1),

    make_background: (p) => runCommandForNode(p.guid, "makeBackground"),

    replace_background: (p) => runCommandForNode(p.guid, "replaceBackground"),

    set_layout: (p) => {
      const nr = requireEditableNode(p.guid);
      if (!nr.ok) return nr;
      const n = nr.node;
      const S = scenegraph.SceneNode;
      if (!S || S.LAYOUT_STACK === undefined) {
        return { ok: false, code: "unsupported", error: "this Adobe XD version does not expose SceneNode.layout" };
      }
      const spec = p.layout || {};
      const types = {
        none: S.LAYOUT_NONE,
        responsive: S.LAYOUT_RESPONSIVE_RESIZE,
        padding: S.LAYOUT_PADDING,
        stack: S.LAYOUT_STACK,
      };
      const next = { type: types[spec.type] };
      if (spec.stack) {
        next.stack = {
          orientation: spec.stack.orientation === "horizontal" ? S.STACK_HORIZONTAL : S.STACK_VERTICAL,
          spacings: spec.stack.spacings,
        };
      }
      if (spec.padding !== undefined) next.padding = spec.padding;
      if (spec.resizeConstraints) {
        next.resizeConstraints = {
          type: spec.resizeConstraints.type === "auto" ? S.RESPONSIVE_RESIZE_AUTO : S.RESPONSIVE_RESIZE_MANUAL,
          values: spec.resizeConstraints.values,
        };
      }
      try {
        n.layout = next;
      } catch (e) {
        return { ok: false, code: "plugin_exception", error: "layout rejected: " + String(e && e.message ? e.message : e) };
      }
      let applied = null;
      try {
        applied = n.layout && n.layout.type;
      } catch (e) {
        /* getter may be unavailable */
      }
      return { ok: true, guid: n.guid, layoutType: applied };
    },

    set_constraints: (p) => {
      const nr = requireEditableNode(p.guid);
      if (!nr.ok) return nr;
      const n = nr.node;
      const S = scenegraph.SceneNode;
      if (!S || S.FIXED_LEFT === undefined) {
        return { ok: false, code: "unsupported", error: "this Adobe XD version does not expose Responsive Resize constraints" };
      }
      try {
        if (p.reset) n.resetToAutoConstraints();
        if (p.horizontal) {
          const pos = { left: S.FIXED_LEFT, right: S.FIXED_RIGHT, both: S.FIXED_BOTH, proportional: S.POSITION_PROPORTIONAL };
          const size = { fixed: S.SIZE_FIXED, resizes: S.SIZE_RESIZES };
          n.horizontalConstraints = { position: pos[p.horizontal.position], size: size[p.horizontal.size] };
        }
        if (p.vertical) {
          const pos = { top: S.FIXED_TOP, bottom: S.FIXED_BOTTOM, both: S.FIXED_BOTH, proportional: S.POSITION_PROPORTIONAL };
          const size = { fixed: S.SIZE_FIXED, resizes: S.SIZE_RESIZES };
          n.verticalConstraints = { position: pos[p.vertical.position], size: size[p.vertical.size] };
        }
      } catch (e) {
        return { ok: false, code: "plugin_exception", error: "constraints rejected: " + String(e && e.message ? e.message : e) };
      }
      return { ok: true, guid: n.guid, hasCustomConstraints: n.hasCustomConstraints };
    },

    create_component: (p) => {
      // XD's scenegraph class hierarchy has no Component master class (only
      // SymbolInstance); programmatic component creation is not supported.
      return {
        ok: false,
        supported: false,
        reason: "Adobe XD's public plugin API does not expose component creation (no Component constructor in the documented scenegraph class hierarchy; commands module has no createComponent). Create the component in XD's UI, then reference and style it via SymbolInstance guids.",
      };
    },

    update_node: (p) => {
      const nr = requireEditableNode(p.guid);
      if (!nr.ok) return nr;
      const n = nr.node;
      if (p.name) n.name = p.name;
      if (p.visible !== undefined) n.visible = p.visible;
      if (p.locked !== undefined) n.locked = p.locked;
      if (p.markedForExport !== undefined) n.markedForExport = p.markedForExport;
      if (p.fixedWhenScrolling !== undefined && n.fixedWhenScrolling !== undefined) {
        n.fixedWhenScrolling = p.fixedWhenScrolling;
      }
      if (p.blendMode !== undefined && n.blendMode !== undefined) {
        const constant = scenegraph.SceneNode ? scenegraph.SceneNode[p.blendMode] : undefined;
        n.blendMode = constant || p.blendMode;
      }
      applyStyle(n, p.style);
      return { ok: true, guid: n.guid };
    },

    move_node: (p) => {
      const nr = requireEditableNode(p.guid);
      if (!nr.ok) return nr;
      const n = nr.node;
      if (p.relative) {
        n.moveInParentCoordinates(p.x, p.y);
      } else {
        setPosition(n, { x: p.x, y: p.y });
      }
      return { ok: true, guid: n.guid };
    },

    resize_node: (p) => {
      const nr = requireEditableNode(p.guid);
      if (!nr.ok) return nr;
      const n = nr.node;
      const scaled = p.relative
        ? { w: (n.globalDrawBounds ? n.globalDrawBounds.width : 0) * (p.width || 1), h: (n.globalDrawBounds ? n.globalDrawBounds.height : 0) * (p.height || 1) }
        : { w: p.width !== undefined ? p.width : (n.globalDrawBounds ? n.globalDrawBounds.width : 0), h: p.height !== undefined ? p.height : (n.globalDrawBounds ? n.globalDrawBounds.height : 0) };
      try {
        if (n.constructor && n.constructor.name === "Artboard") {
          n.width = scaled.w;
          n.height = scaled.h;
        } else {
          n.resize(scaled.w, scaled.h);
        }
      } catch (e) {
        if (n.width !== undefined) n.width = scaled.w;
        if (n.height !== undefined) n.height = scaled.h;
      }
      return { ok: true, guid: n.guid };
    },

    apply_style: (p) => {
      const sc = requireScene();
      if (!sc.ok) return sc;
      const out = [];
      for (const g of p.guids) {
        const n = resolveNode(g);
        if (!n) {
          out.push({ guid: g, ok: false, error: "not found" });
          continue;
        }
        const contextError = editContextError([n]);
        if (contextError) {
          out.push({ guid: g, ok: false, code: contextError.code, error: contextError.error });
          continue;
        }
        applyStyle(n, p.style);
        out.push({ guid: g, ok: true });
      }
      return { ok: out.every((x) => x.ok), results: out };
    },

    update_text: (p) => {
      const nr = requireEditableNode(p.guid);
      if (!nr.ok) return nr;
      const n = nr.node;
      if (!n.constructor || n.constructor.name !== "Text") return { ok: false, code: "node_not_found", error: "text node not found: " + p.guid };
      // updateText preserves styleRanges; assigning .text resets them.
      if (p.text !== undefined) {
        if (typeof n.updateText === "function") n.updateText(p.text);
        else n.text = p.text;
      }
      applyTextStyle(n, p.style, p.text !== undefined ? p.text : n.text);
      return { ok: true, guid: n.guid };
    },

    apply_design_tokens: (p) => {
      // Creating document-level swatches is not exposed by the public API;
      // instead the token set is recorded as plugin data on the scenegraph root.
      const sc = requireScene();
      if (!sc.ok) return sc;
      let stored = false;
      try {
        sc.root.pluginData = { opencodeDesignTokens: p.tokens };
        stored = true;
      } catch (e) {
        /* pluginData set may fail on some hosts; tokens still reported */
      }
      const counts = {};
      for (const [cat, entries] of Object.entries(p.tokens)) counts[cat] = Object.keys(entries).length;
      return { ok: true, stored, appliedTo: "root.pluginData", counts, note: "XD public API does not expose document swatch creation; tokens are stored as document plugin data and applied per-node via xd_apply_style." };
    },

    create_component_variants: (p) => {
      return { ok: false, supported: false, reason: "XD's documented public plugin API does not create linked component variants. The agent may build separate editable visual states with ordinary nodes/artboards, but they are not native linked variants." };
    },

    inspect_design_consistency: (p) => {
      const sc = requireScene();
      if (!sc.ok) return sc;
      const findings = [];
      const allowedColors = new Set();
      const allowedSizes = new Set();
      const toks = p.tokens || {};
      for (const t of Object.values(toks.color || {})) allowedColors.add(t.value.toUpperCase());
      for (const t of Object.values(toks.typography || {})) if (t.fontSize) allowedSizes.add(t.fontSize);
      const colorUse = new Map();
      const sizeUse = new Map();
      walk(sc.root, (n) => {
        const type = n.constructor ? n.constructor.name : "?";
        if (type === "Text") {
          const fs = n.fontSize;
          if (fs) {
            const k = String(fs);
            sizeUse.set(k, (sizeUse.get(k) || 0) + 1);
            if (allowedSizes.size && !allowedSizes.has(fs)) findings.push({ type: "font-size-off-scale", guid: n.guid, name: n.name, value: fs });
          }
        }
        const hex = hexOf(n.fill);
        if (hex && type !== "Text") {
          colorUse.set(hex, (colorUse.get(hex) || 0) + 1);
          if (allowedColors.size && !allowedColors.has(hex.toUpperCase())) {
            findings.push({ type: "color-off-token", guid: n.guid, name: n.name, value: hex });
          }
        }
        // touch target floor (44px) for small interactive-looking nodes
        if (n.globalDrawBounds) {
          const w = n.globalDrawBounds.width;
          const h = n.globalDrawBounds.height;
          if (type !== "Artboard" && type !== "Group" && w > 0 && h > 0 && w < 44 && h < 44 && (n.name || "").match(/btn|button|icon|tap|link/i)) {
            findings.push({ type: "touch-target-small", guid: n.guid, name: n.name, value: `${w}x${h}` });
          }
        }
      });
      return { ok: true, findings, usage: { colors: Object.fromEntries(colorUse), fontSizes: Object.fromEntries(sizeUse) } };
    },

    prototype_focus: (p) => {
      const sc = requireScene();
      if (!sc.ok) return sc;
      const found = requireNode(p.guid);
      if (!found.ok) return found;
      const node = found.node;
      let target = null;
      if (p.targetGuid) {
        target = resolveNode(p.targetGuid);
        if (!target) return { ok: false, code: "target_not_found", error: "target artboard not found: " + p.targetGuid };
        if (!isArtboard(target)) {
          return { ok: false, code: "target_not_artboard", error: "target is not an Artboard: " + p.targetGuid + " (" + (target.constructor ? target.constructor.name : "?") + ")" };
        }
      }
      const host = artboardOf(node);
      // Order matters: live XD discards a selection that is followed by further
      // work in the same edit transaction. Pan first, select last.
      const viewport = focusViewport(node);
      const focus = attemptSelection(node);
      return {
        ok: true,
        executed: true,
        executedInEditContext: true,
        createdWire: false,
        authoringSupported: false,
        selectionIsDocumentMutation: false,
        source: {
          guid: node.guid,
          name: node.name,
          role: node.name,
          type: node.constructor ? node.constructor.name : "?",
          frame: nodeSummary(node).frame,
        },
        artboard: host ? { guid: host.guid, name: host.name } : null,
        target: target ? { guid: target.guid, name: target.name } : null,
        focusState: focus.focusState,
        assignedTo: focus.assignedTo,
        selectedInTransaction: focus.selectedInTransaction,
        wasSelectedBefore: focus.wasSelectedBefore,
        selectionError: focus.selectionError,
        confirmationRequired: POST_COMMIT_CONFIRMATION,
        viewport,
        nextStep: target
          ? "Wire \"" + (node.name || node.guid) + "\" → \"" + target.name + "\" in XD Prototype mode, then verify with prototype_verify_connection."
          : "Pick the destination artboard in XD Prototype mode, then verify with prototype_verify_connection.",
      };
    },

    prototype_prepare_connection: (p) => {
      const sc = requireScene();
      if (!sc.ok) return sc;
      const sourceResult = requireNode(p.sourceGuid);
      if (!sourceResult.ok) return { ok: false, code: "node_not_found", error: "source node not found: " + p.sourceGuid };
      const targetResult = requireNode(p.targetGuid);
      if (!targetResult.ok) return { ok: false, code: "target_not_found", error: "target artboard not found: " + p.targetGuid };
      const source = sourceResult.node;
      const target = targetResult.node;
      if (!isArtboard(target)) {
        return { ok: false, code: "target_not_artboard", error: "target must be an Artboard: " + p.targetGuid + " (" + (target.constructor ? target.constructor.name : "?") + ")" };
      }

      const trigger = p.trigger || "tap";
      const action = p.action || "goToArtboard";
      const required = { fromGuid: source.guid, toGuid: target.guid, trigger, action };

      const state = readPrototypeEdges();
      if (!state.ok) return state;
      const verdict = classifyConnection(required, state.edges);
      const alreadyWired = verdict.status === "ok";

      let focus;
      let viewport;
      if (alreadyWired) {
        const current = readSelectionGuids();
        const selectedNow = !!current && current.length === 1 && current[0] === source.guid;
        focus = { focusState: "not-attempted", assignedTo: null, selectedInTransaction: selectedNow, wasSelectedBefore: selectedNow, selectionError: null };
        viewport = { scrolled: false, code: "not-attempted", evidence: "none", api: "scrollIntoView", reason: "the wire already exists, so the canvas was left alone" };
      } else {
        // Pan first, select last: XD drops a selection that is followed by more
        // work in the same edit transaction.
        viewport = focusViewport(source);
        focus = attemptSelection(source);
      }
      const host = artboardOf(source);

      let status = "ready";
      let instruction;
      if (alreadyWired) {
        status = "already-wired";
        instruction = "This connection already exists (" + edgeLabel(verdict.matches[0]) + "). Nothing to wire.";
      } else {
        if (verdict.status === "wrong-destination") status = "wrong-wire-present";
        else if (verdict.status === "wrong-trigger") status = "wrong-trigger-present";
        else if (verdict.status === "wrong-action") status = "wrong-action-present";
        else if (verdict.status === "incomplete") status = "incomplete-wire-present";
        else if (verdict.status === "ambiguous") status = "ambiguous-wire-present";
        instruction = wireInstruction(source, target, trigger, action, p.transition, p.overlay);
        if (focus.focusState === "selection-failed" || focus.focusState === "focus-unverified") {
          instruction = "Select \"" + (source.name || source.guid) + "\" on the canvas first (automatic selection did not apply), then " + instruction;
        }
        if (verdict.candidates.length > 0) {
          instruction += " Existing wire(s) from this node: " + verdict.candidates.map(edgeLabel).join("; ") + ".";
        }
      }

      return {
        ok: true,
        executed: true,
        executedInEditContext: true,
        createdWire: false,
        authoringSupported: false,
        selectionIsDocumentMutation: false,
        status,
        connection: {
          source: {
            guid: source.guid,
            name: source.name,
            type: source.constructor ? source.constructor.name : "?",
            artboard: host ? { guid: host.guid, name: host.name } : null,
          },
          target: { guid: target.guid, name: target.name },
          trigger,
          action,
          transition: p.transition || null,
        },
        verdict: { status: verdict.status, candidates: verdict.candidates },
        focusState: focus.focusState,
        assignedTo: focus.assignedTo,
        selectedInTransaction: focus.selectedInTransaction,
        wasSelectedBefore: focus.wasSelectedBefore,
        selectionError: focus.selectionError,
        confirmationRequired: POST_COMMIT_CONFIRMATION,
        viewport,
        instruction,
        checklist: alreadyWired ? [] : [
          "1. Switch XD to Prototype mode.",
          "2. Drag the blue connector from \"" + (source.name || source.guid) + "\" to artboard \"" + target.name + "\".",
          "3. Set Trigger = " + trigger + ", Action = " + (action === "overlay" ? "Overlay" : "Transition → " + target.name) + ".",
          "4. Verify with prototype_verify_connection: a drag that silently failed looks identical to one that worked.",
        ],
      };
    },

    prototype_verify_connection: (p) => {
      const sc = requireScene();
      if (!sc.ok) return sc;
      const sourceResult = requireNode(p.sourceGuid);
      if (!sourceResult.ok) return { ok: false, code: "node_not_found", error: "source node not found: " + p.sourceGuid };
      const targetResult = requireNode(p.targetGuid);
      if (!targetResult.ok) return { ok: false, code: "target_not_found", error: "target artboard not found: " + p.targetGuid };
      const source = sourceResult.node;
      const target = targetResult.node;
      const required = {
        fromGuid: source.guid,
        toGuid: target.guid,
        trigger: p.trigger || "tap",
        action: p.action || "goToArtboard",
      };
      const state = readPrototypeEdges();
      if (!state.ok) return state;
      const verdict = classifyConnection(required, state.edges);
      const host = artboardOf(source);
      return {
        ok: true,
        verified: verdict.status === "ok",
        status: verdict.status,
        authoringSupported: false,
        createdWire: false,
        required,
        source: { guid: source.guid, name: source.name, artboard: host ? { guid: host.guid, name: host.name } : null },
        target: { guid: target.guid, name: target.name },
        matches: verdict.matches,
        candidates: verdict.candidates,
        checkedAt: Date.now(),
        guidance: guidanceForStatus(verdict.status, source, target, required),
      };
    },

    get_prototype_state: () => {
      const sc = requireScene();
      if (!sc.ok) return sc;
      let interactions;
      try {
        interactions = require("interactions");
      } catch (e) {
        return { ok: false, code: "unsupported", supported: false, error: "XD interactions module is unavailable in this host" };
      }
      const nodeRef = (n) => n ? { guid: n.guid, name: n.name, type: n.constructor ? n.constructor.name : "?" } : null;
      const records = (interactions.allInteractions || []).map((entry) => ({
        triggerNode: nodeRef(entry.triggerNode),
        interactions: (entry.interactions || []).map((interaction) => {
          const trigger = interaction.trigger || {};
          const action = interaction.action || {};
          const transition = action.transition || null;
          return {
            trigger: {
              type: trigger.type || null,
              delay: typeof trigger.delay === "number" ? trigger.delay : undefined,
              speechCommand: typeof trigger.speechCommand === "string" ? trigger.speechCommand : undefined,
            },
            action: {
              type: action.type || null,
              destination: nodeRef(action.destination),
              overlay: nodeRef(action.overlay),
              overlayTopLeft: action.overlayTopLeft || undefined,
              preserveScrollPosition: typeof action.preserveScrollPosition === "boolean" ? action.preserveScrollPosition : undefined,
              speechOutput: typeof action.speechOutput === "string" ? action.speechOutput : undefined,
              locale: typeof action.locale === "string" ? action.locale : undefined,
              voice: typeof action.voice === "string" ? action.voice : undefined,
              transition: transition ? {
                type: transition.type || null,
                fromSide: transition.fromSide || undefined,
                duration: typeof transition.duration === "number" ? transition.duration : undefined,
                easing: transition.easing || undefined,
              } : null,
            },
          };
        }),
      }));
      const flows = (interactions.flows || []).map((flow) => ({
        name: flow.name || null,
        homeArtboard: nodeRef(flow.homeArtboard),
      }));
      return { ok: true, supported: { inspectFlows: true, inspectInteractions: true, authorInteractions: false }, flows, interactions: records };
    },

    validate_prototype: (p) => {
      const sc = requireScene();
      if (!sc.ok) return sc;
      const state = readPrototypeEdges();
      if (!state.ok) return state;
      const actual = state.edges;
      const requiredList = p.requiredConnections || [];

      const checked = requiredList.map((required) => {
        const fromNode = resolveNode(required.fromGuid);
        const toNode = resolveNode(required.toGuid);
        const verdict = classifyConnection(required, actual);
        const problems = [];
        if (!fromNode) problems.push("source-node-missing");
        if (!toNode || !isArtboard(toNode)) problems.push("destination-artboard-missing");
        if (verdict.status !== "ok") problems.push("connection-missing");
        return {
          required,
          ok: problems.length === 0,
          problems,
          status: verdict.status,
          source: fromNode ? { guid: fromNode.guid, name: fromNode.name, type: fromNode.constructor ? fromNode.constructor.name : "?" } : null,
          target: toNode ? { guid: toNode.guid, name: toNode.name } : null,
          matches: verdict.matches,
          candidates: verdict.candidates,
        };
      });

      const edgeMatches = (expected, edge) => edge.fromGuid === expected.fromGuid
        && edge.toGuid === expected.toGuid
        && (!expected.trigger || edge.trigger === expected.trigger)
        && (!expected.action || edge.action === expected.action);

      const extra = actual.filter((edge) => !requiredList.some((expected) => edgeMatches(expected, edge)));
      const missing = checked.filter((item) => item.status === "missing").map((item) => item.required);
      const incorrect = checked
        .filter((item) => item.status !== "ok" && item.status !== "missing")
        .map((item) => ({ required: item.required, status: item.status, candidates: item.candidates }));
      const expected = checked.map((item) => ({
        fromGuid: item.required.fromGuid,
        fromName: item.source ? item.source.name : null,
        toGuid: item.required.toGuid,
        toName: item.target ? item.target.name : null,
        trigger: item.required.trigger || null,
        action: item.required.action || null,
        status: item.status,
        ok: item.ok,
      }));
      const detected = actual.map((edge) => ({
        fromGuid: edge.fromGuid,
        fromName: edge.fromName || null,
        toGuid: edge.toGuid,
        toName: edge.toName || null,
        trigger: edge.trigger,
        action: edge.action,
        transition: edge.transition,
      }));

      const okCount = checked.filter((item) => item.ok).length;
      const valid = checked.every((item) => item.ok);
      return {
        ok: true,
        valid,
        verdict: valid ? "pass" : "fail",
        authoringSupported: false,
        expected,
        detected,
        missing,
        incorrect,
        extra,
        results: checked,
        summary: {
          expectedCount: checked.length,
          detectedCount: actual.length,
          okCount,
          missingCount: missing.length,
          incorrectCount: incorrect.length,
          extraCount: extra.length,
          coverage: checked.length === 0 ? 0 : Number((okCount / checked.length).toFixed(3)),
        },
        actualConnectionCount: actual.length,
      };
    },

    audit_screen: (p) => {
      const sc = requireScene();
      if (!sc.ok) return sc;
      const artboard = resolveNode(p.guid);
      if (!artboard || !isArtboard(artboard)) return { ok: false, code: "artboard_not_found", error: "screen audit target is not an Artboard: " + p.guid };
      const descendants = [];
      childList(artboard).forEach((child) => walk(child, (n) => descendants.push(n)));
      const roles = (p.requirements || []).map((requirement) => {
        const prefix = requirement.role + "/";
        const matches = descendants.filter((node) => node.name === requirement.role || (node.name || "").startsWith(prefix));
        const types = requirement.types || [];
        const missingTypes = types.filter((type) => !matches.some((node) => (node.constructor ? node.constructor.name : "?") === type));
        const hasNonEmptyText = !requirement.requireNonEmptyText || matches.some((node) => node.constructor && node.constructor.name === "Text" && typeof node.text === "string" && node.text.trim().length > 0);
        return {
          role: requirement.role,
          requiredTypes: types,
          requireNonEmptyText: requirement.requireNonEmptyText === true,
          ok: matches.length > 0 && missingTypes.length === 0 && hasNonEmptyText,
          missingTypes,
          hasNonEmptyText: requirement.requireNonEmptyText ? hasNonEmptyText : undefined,
          matches: matches.map((node) => ({
            guid: node.guid,
            name: node.name,
            type: node.constructor ? node.constructor.name : "?",
            frame: nodeSummary(node).frame,
            visible: node.visible !== false,
            opacity: typeof node.opacity === "number" ? node.opacity : null,
            fill: fillSummary(node.fill),
            nonEmptyText: node.constructor && node.constructor.name === "Text" ? !!(node.text && node.text.trim()) : undefined,
          })),
        };
      });
      const byType = {};
      descendants.forEach((node) => {
        const type = node.constructor ? node.constructor.name : "?";
        byType[type] = (byType[type] || 0) + 1;
      });
      return {
        ok: true,
        complete: roles.every((role) => role.ok),
        artboard: { guid: artboard.guid, name: artboard.name, frame: artboardFrame(artboard) },
        stats: { descendantCount: descendants.length, byType },
        roles,
        missingRoles: roles.filter((role) => !role.ok).map((role) => role.role),
        note: "Structural role coverage only. This does not certify visual quality, content suitability, or accessibility.",
      };
    },

    export_artboard: async (p) => {
      const sc = requireScene();
      if (!sc.ok) return sc;
      let ab = null;
      if (p.guid) ab = resolveNode(p.guid);
      if (!ab && p.name) ab = childList(sc.root).find((c) => isArtboard(c) && c.name === p.name);
      if (!ab) return { ok: false, code: "artboard_not_found", error: "artboard not found (guid/name): " + (p.guid || p.name) };
      const scale = p.scale || 2;
      // Documented XD rendition API (not exportAsync, which other UXP hosts use)
      const fs = require("uxp").storage.localFileSystem;
      const formats = require("uxp").storage.formats;
      const tempFolder = await fs.getTemporaryFolder();
      const file = await tempFolder.createFile("ocbridge-" + Date.now() + ".png", { overwrite: true });
      const renditions = [{ node: ab, outputFile: file, type: application.RenditionType.PNG, scale: scale }];
      const results = await application.createRenditions(renditions);
      const buf = await file.read({ format: formats.binary });
      const base64 = arrayBufferToBase64(buf);
      try { file.delete(); } catch (e) { /* temp cleanup optional */ }
      return {
        ok: true,
        base64: base64,
        width: Math.round(ab.width * scale),
        height: Math.round(ab.height * scale),
        artboardName: ab.name,
      };
    },

    export_selection: async () => {
      const sel = scenegraph.selection;
      if (!sel.items || sel.items.length === 0) return { ok: false, error: "selection is empty" };
      const fs = require("uxp").storage.localFileSystem;
      const formats = require("uxp").storage.formats;
      const tempFolder = await fs.getTemporaryFolder();
      const file = await tempFolder.createFile("ocbridge-sel-" + Date.now() + ".png", { overwrite: true });
      await application.createRenditions([{ node: sel.items[0], outputFile: file, type: application.RenditionType.PNG, scale: 2 }]);
      const buf = await file.read({ format: formats.binary });
      const base64 = arrayBufferToBase64(buf);
      try { file.delete(); } catch (e) { /* temp cleanup optional */ }
      return {
        ok: true,
        base64: base64,
        width: sel.items[0].globalDrawBounds ? Math.round(sel.items[0].globalDrawBounds.width * 2) : null,
        height: sel.items[0].globalDrawBounds ? Math.round(sel.items[0].globalDrawBounds.height * 2) : null,
        nodeName: sel.items[0].name,
      };
    },

    validate_document: () => {
      const sc = requireScene();
      if (!sc.ok) return sc;
      const findings = [];
      walk(sc.root, (n) => {
        const type = n.constructor ? n.constructor.name : "?";
        if (type === "Group" && n.children && n.children.length === 0) {
          findings.push({ type: "empty-group", guid: n.guid, name: n.name });
        }
        if (/^(Rectangle|Ellipse|Text|Group|Path) \d+$/.test(n.name || "")) {
          findings.push({ type: "default-name", guid: n.guid, name: n.name, suggestion: "rename to semantic layer name" });
        }
        if (n.globalDrawBounds && (n.globalDrawBounds.width === 0 || n.globalDrawBounds.height === 0) && type !== "Line") {
          findings.push({ type: "zero-size", guid: n.guid, name: n.name });
        }
      });
      return { ok: true, findings };
    },

    execute_batch: async (p) => {
      // runs inside a single editDocument context from main.js; each op executes serially
      const results = [];
      let aborted = false;
      for (const entry of p.operations) {
        if (aborted) {
          results.push({ op: entry.op, ok: false, error: "batch aborted after previous failure" });
          continue;
        }
        try {
          const h = handlers[entry.op];
          if (!h) throw new Error("no handler for op " + entry.op);
          const r = await h(entry.params || {});
          results.push(Object.assign({ op: entry.op }, r));
          if (!r.ok && r.supported !== false) aborted = true;
        } catch (e) {
          results.push({ op: entry.op, ok: false, error: String(e && e.message ? e.message : e) });
          aborted = true;
        }
      }
      return { ok: results.every((r) => r.ok), results };
    },
  };

  // prototype_focus / prototype_prepare_connection mutate XD selection, which XD refuses
  // outside editDocument ("not permitted to make changes from the background"). They must
  // therefore travel through the panel queue like any other edit-gated operation.
  // prototype_verify_connection only reads.
  const nonMutating = new Set(["get_document_info", "get_artboards", "get_selection", "inspect_node", "search_nodes", "create_component", "create_component_variants", "inspect_design_consistency", "get_prototype_state", "validate_prototype", "prototype_verify_connection", "audit_screen", "export_artboard", "export_selection", "validate_document"]);
  const mutateOps = new Set(Object.keys(handlers).filter((op) => !nonMutating.has(op)));
  window.__xdBridgeOps = { handlers, mutateOps, nonMutating };
  console.log("BOOT: ops registered (" + Object.keys(handlers).length + " handlers) on window.__xdBridgeOps");
})();
