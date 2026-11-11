/**
 * Plugin-side handler tests for xd-plugin/ops.js.
 *
 * The MCP tests use bridge/src/mock-plugin.ts, which answers these ops
 * in-process — so they can never catch a bug in the real plugin handlers.
 * This suite loads the *actual* ops.js in a vm sandbox with a functional fake
 * XD runtime and asserts the documented XD 61 API shape:
 *
 *   application.activeDocument -> DocumentInfo { name, guid }   (no .root)
 *   scenegraph.root            -> RootNode of the document scenegraph
 *   scenegraph.selection       -> selection state
 *
 * No real XD API is contacted: every write in these tests mutates the fake
 * scenegraph inside the sandbox.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const OPS_PATH = join(process.env.LOCALAPPDATA ?? "", "OpenCode", "AdobeXD-DesignBridge", "xd-plugin", "ops.js");
const OPS_SRC = readFileSync(OPS_PATH, "utf8");
const PNG_BYTES = [137, 80, 78, 71, 13, 10, 26, 10];

/** Objects created inside the vm context have their own prototypes; normalize before deep comparison. */
function plain<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Harness {
  handlers: Record<string, (p?: any) => any>;
  nonMutating: Set<string>;
  mutateOps: Set<string>;
  logs: string[];
  app: any;
  sg: any;
  interactions: any;
  root: any;
  doc: any;
  access: { root: number; path: number; modified: number };
  files: any[];
  renditionCalls: any[][];
  artboard: (name: string, frame?: Partial<Frame>) => any;
  rectangle: (name?: string) => any;
  ellipse: (name?: string) => any;
  text: (name: string, content?: string) => any;
  group: (name: string) => any;
  /** Real array of a node's children (SceneNodeList or Array under the hood). */
  kids: (node: any) => any[];
  diagLines: () => string[];
  setDiagnostics: (on: boolean) => void;
}

/**
 * Documented SceneNodeList behaviour: NOT an Array, no `[i]` access, `at(i)`
 * and `forEach()` only, plus `length`. No filter/map/slice/find.
 */
function sceneNodeList(items: any[]) {
  return {
    get length() {
      return items.length;
    },
    at(i: number) {
      return items[i];
    },
    forEach(cb: (n: any, i: number) => void, thisArg?: unknown) {
      items.forEach(cb, thisArg);
    },
  };
}

/**
 * Functional fake XD runtime. Mirrors only documented scenegraph members:
 * addChild / resize / translateInParent / placeInParentCoordinates, plus the
 * properties the handlers read. Renditions and the file system are recorded,
 * never performed.
 */
function load(opts: { documentName?: string; childrenKind?: "array" | "sceneNodeList"; filePickerCancel?: boolean } = {}): Harness {
  const childrenKind = opts.childrenKind ?? "array";
  const logs: string[] = [];
  const record = (...args: unknown[]) => {
    logs.push(args.map((a) => String(a)).join(" "));
  };
  const consoleStub = { log: record, info: record, warn: record, error: record };

  let seq = 0;
  const registry = new Map<string, any>();
  const nextGuid = () => "guid-" + ++seq;

  function xdClass(className: string): any {
    const C = class {
      guid: string;
      name: string;
      parent: any;
      _children: any[];
      _listView: any;
      globalDrawBounds: Frame;
      visible: boolean;
      locked: boolean;
      opacity: number;
      markedForExport: boolean;
      pluginData: any;
      fill: any;
      stroke: any;
      strokeWidth: number;
      strokePosition: string;
      strokeEndCaps: string;
      strokeJoins: string;
      strokeDashArray: number[];
      strokeDashOffset: number;
      cornerRadius: number;
      shadow: any;
      innerShadow: any;
      blur: any;
      localBounds: Frame;
      isContainer: boolean;
      rotation: number;

      constructor(nodeName = "") {
        this.guid = nextGuid();
        this.name = nodeName;
        this.parent = null;
        this._children = [];
        this._listView = sceneNodeList(this._children);
        this.globalDrawBounds = { x: 0, y: 0, width: 0, height: 0 };
        this.localBounds = { x: 0, y: 0, width: 0, height: 0 };
        this.isContainer = ["RootNode", "Artboard", "Group", "BooleanGroup", "ScrollableGroup", "RepeatGrid", "SymbolInstance"].includes(className);
        this.rotation = 0;
        this.visible = true;
        this.locked = false;
        this.opacity = 1;
        this.markedForExport = false;
        this.blendMode = "BLEND_MODE_PASSTHROUGH";
        this.pluginData = null;
        this.fill = null;
        this.stroke = null;
        this.strokeWidth = 0;
        this.strokePosition = "CENTER_STROKE";
        this.strokeEndCaps = "STROKE_CAP_NONE";
        this.strokeJoins = "STROKE_JOIN_MITER";
        this.strokeDashArray = [];
        this.strokeDashOffset = 0;
        this.cornerRadius = 0;
        this.shadow = null;
        this.innerShadow = null;
        this.blur = null;
        // Real XD: children is a SceneNodeList (array-like). Array mode keeps the
        // plain-array path covered too.
        Object.defineProperty(this, "children", {
          enumerable: true,
          get: () => (childrenKind === "array" ? this._children : this._listView),
        });
        registry.set(this.guid, this);
      }

      addChild(node: any) {
        if (!node) throw new Error("addChild(undefined) — scenegraph misuse");
        node.parent = this;
        this._children.push(node);
      }

      resize(w: number, h: number) {
        this.globalDrawBounds.width = w;
        this.globalDrawBounds.height = h;
        this.localBounds.width = w;
        this.localBounds.height = h;
      }

      moveInParentCoordinates(dx: number, dy: number) {
        this.globalDrawBounds.x += dx;
        this.globalDrawBounds.y += dy;
      }

      placeInParentCoordinates(registrationPoint: { x: number; y: number }, targetPoint: { x: number; y: number }) {
        this.globalDrawBounds.x = targetPoint.x - registrationPoint.x;
        this.globalDrawBounds.y = targetPoint.y - registrationPoint.y;
      }

      rotateAround(delta: number, _center: { x: number; y: number }) {
        this.rotation += delta;
      }

      setStartEnd(x1: number, y1: number, x2: number, y2: number) {
        this.start = { x: x1, y: y1 };
        this.end = { x: x2, y: y2 };
        this.globalDrawBounds = { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
      }

      setAllCornerRadii(_radius: number) {
        this.cornerRadius = _radius;
      }

      removeFromParent() {
        if (this.parent) {
          const i = this.parent._children.indexOf(this);
          if (i >= 0) this.parent._children.splice(i, 1);
          this.parent = null;
        }
      }

      resetToAutoConstraints() {
        this.resetCount = (this.resetCount || 0) + 1;
      }
    };
    Object.defineProperty(C, "name", { value: className });
    return C;
  }

  const RootNode = xdClass("RootNode");
  const Artboard = xdClass("Artboard");
  const Rectangle = xdClass("Rectangle");
  const Ellipse = xdClass("Ellipse");
  const Text = xdClass("Text");
  const Group = xdClass("Group");
  const Line = xdClass("Line");
  const Polygon = xdClass("Polygon");
  const Path = xdClass("Path");

  // Documented XD 34+ text-layout constants (Text.layoutBox / textAlign).
  Object.assign(Text, {
    POINT: "POINT",
    FIXED_HEIGHT: "FIXED_HEIGHT",
    AUTO_HEIGHT: "AUTO_HEIGHT",
    ALIGN_LEFT: "LEFT",
    ALIGN_CENTER: "CENTER",
    ALIGN_RIGHT: "RIGHT",
  });

  // Documented SceneNode layout / constraint constants (XD 29+ / 38+).
  const SceneNode = xdClass("SceneNode");
  Object.assign(SceneNode, {
    LAYOUT_NONE: "NONE",
    LAYOUT_RESPONSIVE_RESIZE: "RESPONSIVE_RESIZE",
    LAYOUT_PADDING: "PADDING",
    LAYOUT_STACK: "STACK",
    STACK_HORIZONTAL: "HORIZONTAL",
    STACK_VERTICAL: "VERTICAL",
    RESPONSIVE_RESIZE_AUTO: "AUTO",
    RESPONSIVE_RESIZE_MANUAL: "MANUAL",
    FIXED_LEFT: "FIXED_LEFT",
    FIXED_RIGHT: "FIXED_RIGHT",
    FIXED_TOP: "FIXED_TOP",
    FIXED_BOTTOM: "FIXED_BOTTOM",
    FIXED_BOTH: "FIXED_BOTH",
    POSITION_PROPORTIONAL: "PROPORTIONAL",
    SIZE_FIXED: "FIXED",
    SIZE_RESIZES: "RESIZES",
    BLEND_MODE_NORMAL: "NORMAL",
  });

  const root = new RootNode("Root");
  registry.delete(root.guid);
  root.guid = "root-guid";
  registry.set(root.guid, root);

  // Exactly the documented DocumentInfo shape (name + guid). The getters make
  // any read of the non-existent .root/.path/.modified visible to the tests.
  const access = { root: 0, path: 0, modified: 0 };
  const doc: any = { name: opts.documentName ?? "Untitled-1", guid: "doc-guid" };
  for (const key of ["root", "path", "modified"] as const) {
    Object.defineProperty(doc, key, {
      enumerable: false,
      configurable: true,
      get() {
        access[key]++;
        return undefined;
      },
    });
  }

  const sg: any = {
    root,
    selection: {
      items: [] as any[],
      blockedGuids: new Set<string>(),
      isInEditContext(node: any) {
        return !this.blockedGuids.has(node.guid);
      },
    },
    getNodeByGUID: (guid: string) => {
      const node = registry.get(guid);
      let parent = node;
      while (parent && parent !== root) parent = parent.parent;
      return parent === root ? node : undefined;
    },
    Artboard,
    Rectangle,
    Ellipse,
    Text,
    Group,
    Line,
    Polygon,
    Path,
    RootNode,
    SceneNode,
    ImageFill: class ImageFill {
      static SCALE_COVER = "cover";
      static SCALE_STRETCH = "stretch";
      file: any;
      assetId: string;
      scaleBehavior: string;
      constructor(file: any) {
        this.file = file;
        this.assetId = "asset-" + file.name;
        this.scaleBehavior = "cover";
      }
    },
    AreaType: { FIXED: "FIXED" },
    Color: class Color {
      value: unknown;
      constructor(v: unknown) {
        this.value = v;
      }
      toHex() {
        return String(this.value);
      }
    },
    LinearGradient: class LinearGradient {
      type = "linear";
      colorStops: any[] = [];
      startX = 0; startY = 0; endX = 1; endY = 1;
      setEndPoints(sx: number, sy: number, ex: number, ey: number) { this.startX = sx; this.startY = sy; this.endX = ex; this.endY = ey; }
    },
    RadialGradient: class RadialGradient {
      type = "radial";
      colorStops: any[] = [];
      endR = 1;
      center = { x: 0.5, y: 0.5 };
      setCenterPoint(x: number, y: number) { this.center = { x, y }; }
      getCenterPoint() { return this.center; }
    },
    AngularGradient: class AngularGradient {
      type = "angular";
      colorStops: any[] = [];
      startX = 0.5; startY = 0.5; endX = 1; endY = 0.5; rotation = 0;
      setEndPoints(sx: number, sy: number, ex: number, ey: number) { this.startX = sx; this.startY = sy; this.endX = ex; this.endY = ey; }
    },
    Shadow: class Shadow {
      args: unknown[];
      constructor(...args: unknown[]) {
        this.args = args;
      }
    },
    InnerShadow: class InnerShadow {
      args: unknown[];
      constructor(...args: unknown[]) { this.args = args; }
    },
    Blur: class Blur {
      constructor(_opts: unknown) {
        /* no-op */
      }
    },
  };

  const commands = {
    /** Documented commands.group(): groups selection.items and selects the group. */
    group() {
      const items = sg.selection.items.slice();
      if (items.length === 0) return;
      const parent = items[0].parent;
      const index = parent ? parent._children.indexOf(items[0]) : -1;
      const grouped = new Group("Group");
      for (const node of items) {
        if (node.parent) {
          const i = node.parent._children.indexOf(node);
          if (i >= 0) node.parent._children.splice(i, 1);
        }
        node.parent = grouped;
        grouped._children.push(node);
      }
      grouped.globalDrawBounds = { x: 0, y: 0, width: 100, height: 100 };
      if (parent) {
        grouped.parent = parent;
        if (index >= 0) parent._children.splice(index, 0, grouped);
        else parent._children.push(grouped);
      }
      sg.selection.items = [grouped];
    },
    ungroup() {
      const group = sg.selection.items[0];
      if (!group || group.constructor.name !== "Group") return;
      const parent = group.parent;
      if (!parent) return;
      const index = parent._children.indexOf(group);
      parent._children.splice(index, 1, ...group._children);
      const children = group._children.slice();
      for (const child of children) child.parent = parent;
      group._children = [];
      group.parent = null;
      sg.selection.items = children;
    },
    createMaskGroup() {
      this.group();
      if (sg.selection.items[0]) sg.selection.items[0].mask = sg.selection.items[0]._children.at(-1) ?? null;
    },
    duplicate() {
      const copies = [];
      const cloneTree = (node: any): any => {
        const copy = new node.constructor((node.name || "") + " Copy");
        for (const key of ["width", "height", "text", "pathData", "cornerCount", "starRatio", "fill", "stroke", "strokeWidth", "opacity", "rotation", "globalDrawBounds", "localBounds"]) {
          if (node[key] !== undefined) copy[key] = key === "globalDrawBounds" || key === "localBounds" ? { ...node[key] } : node[key];
        }
        for (const child of node._children || []) copy.addChild(cloneTree(child));
        return copy;
      };
      for (const original of sg.selection.items.slice()) {
        const copy = cloneTree(original);
        const parent = original.parent;
        if (parent) parent.addChild(copy);
        copies.push(copy);
      }
      sg.selection.items = copies;
    },
    /** Records the last documented command applied to each selected node. */
    _mark(name: string) {
      for (const n of sg.selection.items) n._lastCommand = name;
    },
    convertToPath() { this._mark("convertToPath"); },
    outlineStroke() { this._mark("outlineStroke"); },
    alignToPixelGrid() { this._mark("alignToPixelGrid"); },
    reset3DTransforms() { this._mark("reset3DTransforms"); },
    makeBackground() { this._mark("makeBackground"); },
    replaceBackground() { this._mark("replaceBackground"); },
    bringToFront() {
      const nodes = sg.selection.items.slice();
      for (const n of nodes) {
        const siblings = n.parent?._children;
        if (!siblings) continue;
        const i = siblings.indexOf(n);
        if (i >= 0) siblings.splice(i, 1);
        siblings.push(n);
      }
    },
    bringForward() { this.bringToFront(); },
    sendToBack() {
      const nodes = sg.selection.items.slice().reverse();
      for (const n of nodes) {
        const siblings = n.parent?._children;
        if (!siblings) continue;
        const i = siblings.indexOf(n);
        if (i >= 0) siblings.splice(i, 1);
        siblings.unshift(n);
      }
    },
    sendBackward() { this.sendToBack(); },
    alignLeft() {
      const nodes = sg.selection.items;
      const x = Math.min(...nodes.map((n: any) => n.globalDrawBounds.x));
      nodes.forEach((n: any) => { n.globalDrawBounds.x = x; });
    },
    alignRight() {
      const nodes = sg.selection.items;
      const right = Math.max(...nodes.map((n: any) => n.globalDrawBounds.x + n.globalDrawBounds.width));
      nodes.forEach((n: any) => { n.globalDrawBounds.x = right - n.globalDrawBounds.width; });
    },
    alignHorizontalCenter() {
      const nodes = sg.selection.items;
      const center = nodes.reduce((s: number, n: any) => s + n.globalDrawBounds.x + n.globalDrawBounds.width / 2, 0) / nodes.length;
      nodes.forEach((n: any) => { n.globalDrawBounds.x = center - n.globalDrawBounds.width / 2; });
    },
    alignTop() {
      const nodes = sg.selection.items;
      const y = Math.min(...nodes.map((n: any) => n.globalDrawBounds.y));
      nodes.forEach((n: any) => { n.globalDrawBounds.y = y; });
    },
    alignBottom() {
      const nodes = sg.selection.items;
      const bottom = Math.max(...nodes.map((n: any) => n.globalDrawBounds.y + n.globalDrawBounds.height));
      nodes.forEach((n: any) => { n.globalDrawBounds.y = bottom - n.globalDrawBounds.height; });
    },
    alignVerticalCenter() {
      const nodes = sg.selection.items;
      const center = nodes.reduce((s: number, n: any) => s + n.globalDrawBounds.y + n.globalDrawBounds.height / 2, 0) / nodes.length;
      nodes.forEach((n: any) => { n.globalDrawBounds.y = center - n.globalDrawBounds.height / 2; });
    },
    distributeHorizontal() {
      const nodes = sg.selection.items.slice().sort((a: any, b: any) => a.globalDrawBounds.x - b.globalDrawBounds.x);
      const left = nodes[0].globalDrawBounds.x;
      const right = nodes[nodes.length - 1].globalDrawBounds.x + nodes[nodes.length - 1].globalDrawBounds.width;
      const total = nodes.reduce((s: number, n: any) => s + n.globalDrawBounds.width, 0);
      const gap = (right - left - total) / (nodes.length - 1);
      let x = left;
      for (const n of nodes) {
        n.globalDrawBounds.x = x;
        x += n.globalDrawBounds.width + gap;
      }
    },
    distributeVertical() {
      const nodes = sg.selection.items.slice().sort((a: any, b: any) => a.globalDrawBounds.y - b.globalDrawBounds.y);
      const top = nodes[0].globalDrawBounds.y;
      const bottom = nodes[nodes.length - 1].globalDrawBounds.y + nodes[nodes.length - 1].globalDrawBounds.height;
      const total = nodes.reduce((s: number, n: any) => s + n.globalDrawBounds.height, 0);
      const gap = (bottom - top - total) / (nodes.length - 1);
      let y = top;
      for (const n of nodes) {
        n.globalDrawBounds.y = y;
        y += n.globalDrawBounds.height + gap;
      }
    },
  };

  const interactions: any = { flows: [], allInteractions: [] };

  const files: any[] = [];
  const renditionCalls: any[][] = [];
  const application: any = {
    activeDocument: doc,
    RenditionType: { PNG: "PNG", JPG: "JPG", SVG: "SVG", PDF: "PDF" },
    async createRenditions(renditions: any[]) {
      renditionCalls.push(renditions);
      return renditions.map((r) => ({ outputFile: r.outputFile }));
    },
    import(entries: any[]) {
      let target = sg.selection.items[0] || root;
      while (target && target !== root && target.constructor.name !== "Artboard") target = target.parent;
      if (!target) target = root;
      const imported = new Rectangle(entries[0]?.name || "Imported Asset");
      imported.width = 120;
      imported.height = 80;
      imported.globalDrawBounds = { x: 0, y: 0, width: 120, height: 80 };
      imported.fill = { toHex: () => "#IMAGE" };
      target.addChild(imported);
    },
    editDocument: (_opts: unknown, fn?: () => unknown) => (typeof _opts === "function" ? _opts() : fn && fn()),
  };

  const uxp = {
    storage: {
      formats: { binary: "binary" },
      localFileSystem: {
        async getFileForOpening() {
          return opts.filePickerCancel ? null : { name: "selected-image.png" };
        },
        async getTemporaryFolder() {
          return {
            async createFile(fileName: string) {
              const file = {
                name: fileName,
                deleted: false,
                async write() {
                  /* no-op */
                },
                async read() {
                  return new Uint8Array(PNG_BYTES);
                },
                async delete() {
                  this.deleted = true;
                },
              };
              files.push(file);
              return file;
            },
          };
        },
      },
    },
  };

  const modules: Record<string, any> = { scenegraph: sg, commands, application, uxp, interactions };

  const sandbox: any = {
    console: consoleStub,
    window: { addEventListener() {} },
    btoa: (s: string) => Buffer.from(s, "latin1").toString("base64"),
    require: (m: string) => {
      if (!(m in modules)) throw new Error("unexpected require: " + m);
      return modules[m];
    },
  };

  vm.createContext(sandbox);
  vm.runInContext(OPS_SRC, sandbox, { filename: "ops.js" });

  const bridgeOps = sandbox.window.__xdBridgeOps;

  const artboard = (name: string, frame: Partial<Frame> = {}) => {
    const f: Frame = { x: 0, y: 0, width: 390, height: 844, ...frame };
    const ab = new Artboard(name);
    ab.width = f.width;
    ab.height = f.height;
    ab.globalDrawBounds = { ...f };
    return ab;
  };
  const rectangle = (name = "Rectangle") => new Rectangle(name);
  const ellipse = (name = "Ellipse") => new Ellipse(name);
  const text = (name: string, content = "Text") => {
    const t = new Text(name);
    t.text = content;
    return t;
  };
  const group = (name: string) => new Group(name);

  return {
    handlers: bridgeOps.handlers,
    nonMutating: bridgeOps.nonMutating,
    mutateOps: bridgeOps.mutateOps,
    logs,
    app: application,
    sg,
    interactions,
    root,
    doc,
    access,
    files,
    renditionCalls,
    artboard,
    rectangle,
    ellipse,
    text,
    group,
    kids: (node: any) => (node && node._children ? node._children : []),
    diagLines: () => logs.filter((l) => l.startsWith("DIAG ")),
    setDiagnostics: (on: boolean) => {
      sandbox.window.__xdBridgeDiag = on;
    },
  };
}

/** A small realistic document: Artboard > Group > (Rectangle, Text), plus a stray shape. */
function seeded(h: Harness) {
  const home = h.artboard("Home", { x: 0, y: 0, width: 390, height: 844 });
  h.root.addChild(home);
  const card = h.group("Card");
  card.globalDrawBounds = { x: 24, y: 120, width: 342, height: 180 };
  home.addChild(card);
  const rect = h.rectangle("Card/Background");
  rect.globalDrawBounds = { x: 24, y: 120, width: 342, height: 180 };
  card.addChild(rect);
  const title = h.text("Card/Title", "Weekly overview");
  title.globalDrawBounds = { x: 40, y: 144, width: 310, height: 28 };
  title.fontSize = 18;
  card.addChild(title);
  return { home, card, rect, title };
}

// --- blank document ----------------------------------------------------------

test("blank document: get_document_info returns zero counts, no exception", () => {
  const h = load();
  const r = h.handlers.get_document_info();
  assert.equal(r.ok, true);
  assert.equal(r.document.artboardCount, 0);
  assert.equal(r.document.nodeCount, 0);
  assert.equal(r.document.name, "Untitled-1");
  assert.equal(r.document.guid, "doc-guid");
  assert.equal(r.document.path, null);
  assert.equal(r.document.modified, null);
});

test("blank document: get_artboards returns an empty list, no exception", () => {
  const h = load();
  const r = h.handlers.get_artboards();
  assert.equal(r.ok, true);
  assert.deepEqual(plain(r.artboards), []);
  assert.equal(r.count, 0);
});

// --- documents with content ---------------------------------------------------

test("multiple artboards: inventory, frames and counts are correct", () => {
  const h = load({ documentName: "Solstice" });
  h.root.addChild(h.artboard("Home", { x: 0, y: 0, width: 390, height: 844 }));
  h.root.addChild(h.artboard("Detail", { x: 480, y: 0, width: 390, height: 844 }));
  h.root.addChild(h.rectangle("Stray"));

  const info = h.handlers.get_document_info();
  assert.equal(info.document.artboardCount, 2, "non-artboard children are not artboards");
  assert.equal(info.document.nodeCount, 3, "nodeCount excludes the root container");

  const r = h.handlers.get_artboards();
  assert.equal(r.count, 2);
  assert.deepEqual(plain(r.artboards.map((a: any) => [a.name, a.guid])), [
    ["Home", "guid-2"],
    ["Detail", "guid-3"],
  ]);
  assert.deepEqual(plain(r.artboards[1].frame), { x: 480, y: 0, width: 390, height: 844 });
});

test("artboard frame falls back to globalDrawBounds when width/height are absent", () => {
  const h = load();
  const ab = h.artboard("NoSize", { x: 12, y: 24, width: 320, height: 640 });
  delete ab.width;
  delete ab.height;
  h.root.addChild(ab);
  assert.deepEqual(plain(h.handlers.get_artboards().artboards[0].frame), { x: 12, y: 24, width: 320, height: 640 });
});

test("nested groups and shapes: traversal finds deep nodes and reports child counts", () => {
  const h = load();
  const { card } = seeded(h);

  const byType = h.handlers.search_nodes({ type: "Group" });
  assert.equal(byType.ok, true);
  assert.equal(byType.nodes.length, 1);
  assert.equal(byType.nodes[0].name, "Card");
  assert.equal(byType.nodes[0].childCount, 2, "group children are visible through traversal");

  const deep = h.handlers.inspect_node({ guid: "guid-does-not-exist" });
  assert.equal(deep.ok, false, "unknown guid must not throw");
  assert.equal(deep.code, "node_not_found");

  const nested = h.handlers.inspect_node({ guid: h.kids(card)[0].guid });
  assert.equal(nested.ok, true);
  assert.equal(nested.node.name, "Card/Background");
  assert.equal(nested.node.type, "Rectangle");
});

// --- parent resolution --------------------------------------------------------

test("parent resolution: explicit parent guid wins", () => {
  const h = load();
  const { card } = seeded(h);
  const r = h.handlers.create_rectangle({
    parent: card.guid,
    name: "Card/Body",
    frame: { x: 1, y: 2, width: 10, height: 10 },
  });
  assert.equal(r.ok, true);
  assert.equal(h.kids(card).length, 3);
  const created = h.kids(card)[2];
  assert.equal(created.guid, r.guid);
  assert.equal(created.parent, card);
});

test("parent resolution: unknown parent guid returns a structured error", () => {
  const h = load();
  seeded(h);
  const r = h.handlers.create_rectangle({ parent: "does-not-exist", frame: { x: 0, y: 0, width: 10, height: 10 } });
  assert.equal(r.ok, false);
  assert.equal(r.code, "node_not_found");
  assert.match(r.error, /parent guid not found/);
});

test("parent resolution rejects a leaf node as a container", () => {
  const h = load();
  const { rect } = seeded(h);
  const r = h.handlers.create_rectangle({ parent: rect.guid, frame: { x: 0, y: 0, width: 10, height: 10 } });
  assert.equal(r.ok, false);
  assert.equal(r.code, "invalid_parent");
});

test("parent resolution: defaults to the first artboard", () => {
  const h = load();
  const { home } = seeded(h);
  const before = h.kids(home).length;
  const r = h.handlers.create_ellipse({ name: "Dot", frame: { x: 5, y: 5, width: 8, height: 8 } });
  assert.equal(r.ok, true);
  assert.equal(h.kids(home).length, before + 1);
  assert.equal(h.kids(home)[h.kids(home).length - 1].guid, r.guid);
});

test("parent resolution: falls back to the root when no artboard exists", () => {
  const h = load();
  const r = h.handlers.create_rectangle({ name: "Pasteboard", frame: { x: 0, y: 0, width: 10, height: 10 } });
  assert.equal(r.ok, true);
  assert.equal(h.kids(h.root).length, 1);
  assert.equal(h.kids(h.root)[0].guid, r.guid);
});

// --- node lookup --------------------------------------------------------------

test("node lookup by GUID: update_node mutates the nested node and rejects unknown guids", () => {
  const h = load();
  const { rect } = seeded(h);

  const ok = h.handlers.update_node({ guid: rect.guid, name: "Card/Surface", visible: false, locked: true });
  assert.equal(ok.ok, true);
  assert.equal(rect.name, "Card/Surface");
  assert.equal(rect.visible, false);
  assert.equal(rect.locked, true);

  const missing = h.handlers.update_node({ guid: "nope" });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "node_not_found");
});

test("mutations outside the current XD edit context return a structured error", () => {
  const h = load();
  const { rect, home } = seeded(h);
  h.sg.selection.blockedGuids.add(rect.guid);
  const update = h.handlers.update_node({ guid: rect.guid, name: "Blocked" });
  assert.equal(update.ok, false);
  assert.equal(update.code, "outside_edit_context");
  assert.equal(rect.name, "Card/Background", "no mutation occurs after the context check");

  h.sg.selection.blockedGuids.add(home.guid);
  const add = h.handlers.create_rectangle({ parent: home.guid, frame: { x: 1, y: 1, width: 10, height: 10 } });
  assert.equal(add.ok, false);
  assert.equal(add.code, "outside_edit_context");
});

// --- creation -----------------------------------------------------------------

test("create shapes under the root and under an artboard/group", () => {
  const h = load();
  const { card } = seeded(h);

  const ellipse = h.handlers.create_ellipse({ parent: card.guid, frame: { x: 10, y: 10, width: 20, height: 20 } });
  assert.equal(ellipse.ok, true);
  assert.equal(h.kids(card)[h.kids(card).length - 1].constructor.name, "Ellipse");

  const rootLevel = load();
  const created = rootLevel.handlers.create_rectangle({ frame: { x: 7, y: 8, width: 9, height: 9 } });
  assert.equal(created.ok, true);
  assert.equal(rootLevel.kids(rootLevel.root).length, 1);
  assert.equal(rootLevel.kids(rootLevel.root)[0].constructor.name, "Rectangle");
});

test("create_artboard adds an Artboard to the root with the requested frame", () => {
  const h = load();
  const r = h.handlers.create_artboard({ name: "Detail", frame: { x: 480, y: 0, width: 390, height: 844 } });
  assert.equal(r.ok, true);
  assert.equal(r.name, "Detail");
  const ab = h.kids(h.root)[0];
  assert.equal(ab.guid, r.guid);
  assert.equal(ab.constructor.name, "Artboard");
  assert.equal(ab.width, 390);
  assert.equal(ab.height, 844);
  assert.deepEqual(plain({ x: ab.globalDrawBounds.x, y: ab.globalDrawBounds.y }), { x: 480, y: 0 });
});

test("create_line, create_polygon, and create_path produce editable native vector nodes", () => {
  const h = load();
  const { home } = seeded(h);

  const line = h.handlers.create_line({
    parent: home.guid,
    name: "Chart/Grid/Rule",
    start: { x: 40, y: 100 },
    end: { x: 320, y: 100 },
    style: { stroke: "#313742", strokeWidth: 1 },
  });
  assert.equal(line.ok, true);
  const lineNode = h.sg.getNodeByGUID(line.guid);
  assert.equal(lineNode.constructor.name, "Line");
  assert.deepEqual(plain(lineNode.start), { x: 40, y: 100 });

  const polygon = h.handlers.create_polygon({
    parent: home.guid,
    name: "Asset/Icon/ETH",
    frame: { x: 20, y: 200, width: 32, height: 32 },
    cornerCount: 6,
    starRatio: 100,
    style: { fill: "#7AA2F7" },
  });
  assert.equal(polygon.ok, true);
  const polygonNode = h.sg.getNodeByGUID(polygon.guid);
  assert.equal(polygonNode.constructor.name, "Polygon");
  assert.equal(polygonNode.cornerCount, 6);
  assert.equal(polygonNode.fill.toHex(), "#7AA2F7");

  const path = h.handlers.create_path({
    parent: home.guid,
    name: "Chart/Series/Line",
    pathData: "M0 20 L30 0 L60 12",
    x: 40,
    y: 300,
    style: { stroke: "#E3B04B", strokeWidth: 2 },
  });
  assert.equal(path.ok, true);
  const pathNode = h.sg.getNodeByGUID(path.guid);
  assert.equal(pathNode.constructor.name, "Path");
  assert.equal(pathNode.pathData, "M0 20 L30 0 L60 12");
  assert.equal(pathNode.stroke.toHex(), "#E3B04B");
});

test("apply_style creates native Linear/Radial/Angular gradients and read-back describes stops", () => {
  const h = load();
  const { rect, home } = seeded(h);
  const stops = [
    { stop: 0, color: "#101820" },
    { stop: 1, color: "#E3B04B" },
  ];

  assert.equal(h.handlers.apply_style({ guids: [rect.guid], style: { gradient: { type: "linear", colorStops: stops, startX: 0, startY: 0, endX: 1, endY: 1 } } }).ok, true);
  assert.equal(rect.fill.type, "linear");
  assert.equal(rect.fill.colorStops[1].color.toHex(), "#E3B04B");
  const inspected = h.handlers.inspect_node({ guid: rect.guid });
  assert.equal(inspected.node.fill.type, "linear");
  assert.equal(inspected.node.fill.colorStops.length, 2);

  const ellipse = h.ellipse("Radial");
  home.addChild(ellipse);
  assert.equal(h.handlers.apply_style({ guids: [ellipse.guid], style: { gradient: { type: "radial", colorStops: stops, centerX: 0.4, centerY: 0.6, endR: 1 } } }).ok, true);
  assert.equal(ellipse.fill.type, "radial");
  assert.deepEqual(plain(ellipse.fill.getCenterPoint()), { x: 0.4, y: 0.6 });

  const angular = h.handlers.apply_style({ guids: [ellipse.guid], style: { gradient: { type: "angular", colorStops: stops, rotation: 25 } } });
  assert.equal(angular.ok, true);
  assert.equal(ellipse.fill.type, "angular");
  assert.equal(ellipse.fill.rotation, 25);
});

test("import_asset uses only the native user file picker and attaches to the explicit parent", async () => {
  const h = load();
  const { home } = seeded(h);
  const previousSelection = h.sg.selection.items;
  const r = await h.handlers.import_asset({ parent: home.guid, name: "Brand/Logo", x: 32, y: 40 });
  assert.equal(r.ok, true);
  assert.equal(r.count, 1);
  assert.equal(r.parentGuid, home.guid);
  const node = h.sg.getNodeByGUID(r.imported[0].guid);
  assert.ok(node, "imported node is attached to the scenegraph");
  assert.equal(node.name, "Brand/Logo");
  assert.equal(node.parent, home);
  assert.deepEqual(plain({ x: node.globalDrawBounds.x, y: node.globalDrawBounds.y }), { x: 32, y: 40 });
  assert.equal(h.sg.selection.items, previousSelection, "pre-import selection is restored");
});

test("create_image uses ImageFill and preserves an explicit parent/frame", async () => {
  const h = load();
  const { card } = seeded(h);
  const r = await h.handlers.create_image({
    parent: card.guid,
    name: "Brand/Logo",
    frame: { x: 16, y: 24, width: 48, height: 48 },
    scaleBehavior: "stretch",
  });
  assert.equal(r.ok, true);
  const imageNode = h.sg.getNodeByGUID(r.guid);
  assert.equal(imageNode.constructor.name, "Rectangle");
  assert.equal(imageNode.parent, card);
  assert.equal(imageNode.name, "Brand/Logo");
  assert.equal(imageNode.fill.scaleBehavior, "stretch");
  assert.equal(imageNode.fill.file.name, "selected-image.png");
  assert.equal(imageNode.width, 48);
  assert.equal(imageNode.height, 48);
});

test("replace_image replaces one image fill without replacing the native shape node", async () => {
  const h = load();
  const { rect } = seeded(h);
  const guid = rect.guid;
  const parent = rect.parent;
  const frame = plain(rect.globalDrawBounds);
  const r = await h.handlers.replace_image({ guid, scaleBehavior: "stretch" });
  assert.equal(r.ok, true);
  assert.equal(r.guid, guid);
  assert.equal(h.sg.getNodeByGUID(guid), rect);
  assert.equal(rect.parent, parent);
  assert.deepEqual(plain(rect.globalDrawBounds), frame);
  assert.equal(rect.fill.scaleBehavior, "stretch");
  assert.equal(rect.fill.file.name, "selected-image.png");
});

test("cancelled native asset picker leaves the artboard and selection unchanged", async () => {
  const h = load({ filePickerCancel: true });
  const { home } = seeded(h);
  const before = h.kids(home).map((n: any) => n.guid);
  const selection = h.sg.selection.items;

  const imported = await h.handlers.import_asset({ parent: home.guid });
  assert.equal(imported.ok, false);
  assert.equal(imported.code, "user_cancelled");
  const image = await h.handlers.create_image({ parent: home.guid, frame: { x: 0, y: 0, width: 24, height: 24 } });
  assert.equal(image.ok, false);
  assert.equal(image.code, "user_cancelled");

  assert.deepEqual(h.kids(home).map((n: any) => n.guid), before, "no temporary or imported nodes remain");
  assert.equal(h.sg.selection.items, selection);
});

test("execute_batch awaits import_asset inside the edit transaction", async () => {
  const h = load();
  const { home } = seeded(h);
  const result = await h.handlers.execute_batch({
    operations: [{ op: "import_asset", params: { parent: home.guid, name: "Brand/Mark", x: 12, y: 16 } }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[0].imported[0].name, "Brand/Mark");
  assert.equal(h.kids(home).some((n: any) => n.name === "Brand/Mark"), true);
});

test("create_text applies style ranges and uses the documented layoutBox for area text", () => {
  const h = load();
  const { home } = seeded(h);
  const r = h.handlers.create_text({
    parent: home.guid,
    name: "Body",
    text: "Hello",
    frame: { x: 24, y: 60, width: 200, height: 40 },
    style: { fontFamily: "Inter", fontSize: 14, fontWeight: "Semibold", lineHeight: 18, fill: "#112233", textAlign: "right" },
  });
  assert.equal(r.ok, true);
  assert.equal(r.textMode, "FIXED_HEIGHT");
  const node = h.kids(home)[h.kids(home).length - 1];
  assert.equal(node.text, "Hello");
  assert.equal(node.styleRanges[0].length, 5);
  assert.equal(node.styleRanges[0].fontFamily, "Inter");
  assert.equal(node.styleRanges[0].fontStyle, "Semibold");
  assert.equal(node.styleRanges[0].fill.toHex(), "#112233");
  assert.equal(node.lineSpacing, 18);
  // XD 34+ area text: layoutBox replaces the deprecated areaBox, which the old
  // implementation set with a non-existent scenegraph.AreaType (silently ignored).
  assert.equal(node.layoutBox.width, 200);
  assert.equal(node.layoutBox.height, 40);
  assert.equal(node.areaBox, undefined);
  assert.equal(node.textAlign, "RIGHT");
});

test("create_group uses commands.group(), renames the group and restores selection", () => {
  const h = load();
  const { rect, title } = seeded(h);
  const previous = h.sg.selection.items;
  // Both nodes live inside the "Card" group, so the new group is created there.
  const container = rect.parent;
  assert.equal(container, title.parent);

  const r = h.handlers.create_group({ guids: [rect.guid, title.guid], name: "Card/Inner" });
  assert.equal(r.ok, true);
  assert.equal(r.name, "Card/Inner");

  const created = h.kids(container).find((c: any) => c.guid === r.guid);
  assert.ok(created, "group must be attached where its children were");
  assert.equal(created.constructor.name, "Group");
  assert.equal(h.kids(created).length, 2);
  assert.equal(created.name, "Card/Inner");
  assert.equal(created.parent, container);
  assert.equal(h.sg.selection.items, previous, "selection must be restored after grouping");
});

test("create_mask_group delegates mask structure to the documented XD command", () => {
  const h = load();
  const { rect, title } = seeded(h);
  const r = h.handlers.create_mask_group({ guids: [rect.guid, title.guid] });
  assert.equal(r.ok, true);
  const group = h.sg.getNodeByGUID(r.guid);
  assert.equal(group.constructor.name, "Group");
  assert.equal(group.mask.guid, title.guid, "fake command marks the highest-z selected child as mask");
  assert.equal(rect.parent, group);
  assert.equal(title.parent, group);
});

test("duplicate_node, rename, and offset use the documented duplicate command", () => {
  const h = load();
  const { home, rect } = seeded(h);
  const oldSelection = h.sg.selection.items;

  const r = h.handlers.duplicate_node({ guid: rect.guid, name: "Card/Background Copy", offset: { x: 12, y: 8 } });
  assert.equal(r.ok, true);
  assert.equal(r.nodes.length, 1);
  const copy = h.sg.getNodeByGUID(r.nodes[0].guid);
  assert.equal(copy.name, "Card/Background Copy");
  assert.equal(copy.parent, rect.parent);
  assert.equal(copy.globalDrawBounds.x, rect.globalDrawBounds.x + 12);
  assert.equal(copy.globalDrawBounds.y, rect.globalDrawBounds.y + 8);
  assert.equal(h.sg.selection.items, oldSelection);
  assert.ok(h.kids(home).length >= 1);
});

test("delete_node removes only the GUID-targeted node and protects the root", () => {
  const h = load();
  const { rect, title } = seeded(h);
  const parent = rect.parent;

  const r = h.handlers.delete_node({ guid: rect.guid });
  assert.equal(r.ok, true);
  assert.equal(h.sg.getNodeByGUID(rect.guid), undefined);
  assert.equal(h.kids(parent).includes(rect), false);
  assert.equal(h.sg.getNodeByGUID(title.guid), title, "unrelated sibling remains");

  const protectedResult = h.handlers.delete_node({ guid: h.root.guid });
  assert.equal(protectedResult.ok, false);
  assert.equal(protectedResult.code, "protected_root");
});

test("reparent_node moves a leaf into a verified new container", () => {
  const h = load();
  const { home, card, rect } = seeded(h);
  const newParent = h.group("Card/Inner");
  home.addChild(newParent);

  const r = h.handlers.reparent_node({ guid: rect.guid, parent: newParent.guid });
  assert.equal(r.ok, true);
  assert.equal(rect.parent, newParent);
  assert.equal(h.kids(card).includes(rect), false);
  assert.equal(h.kids(newParent).includes(rect), true);
});

test("rotate_node and arrange/align/distribute operations invoke documented commands", () => {
  const h = load();
  const { rect, title } = seeded(h);
  const third = h.rectangle("Card/Third");
  third.globalDrawBounds = { x: 200, y: 220, width: 100, height: 40 };
  rect.parent.addChild(third);
  const parent = rect.parent;

  assert.equal(h.handlers.rotate_node({ guid: rect.guid, angle: 30 }).ok, true);
  assert.equal(rect.rotation, 30);
  assert.equal(h.handlers.arrange_nodes({ guids: [rect.guid, title.guid], action: "bringToFront" }).ok, true);
  assert.deepEqual(h.kids(parent).slice(-2).map((n: any) => n.guid), [rect.guid, title.guid]);
  assert.equal(h.handlers.align_nodes({ guids: [rect.guid, title.guid], action: "alignLeft" }).ok, true);
  assert.equal(rect.globalDrawBounds.x, title.globalDrawBounds.x);
  assert.equal(h.handlers.distribute_nodes({ guids: [rect.guid, title.guid, third.guid], action: "distributeHorizontal" }).ok, true);
  assert.equal(new Set(h.kids(parent).map((n: any) => n.globalDrawBounds.x)).size > 1, true);
});

test("ungroup flattens children to the original parent and preserves unrelated nodes", () => {
  const h = load();
  const { home, card, rect, title } = seeded(h);
  const other = h.rectangle("Other");
  home.addChild(other);

  const r = h.handlers.ungroup({ guid: card.guid });
  assert.equal(r.ok, true);
  assert.equal(h.sg.getNodeByGUID(card.guid), undefined);
  assert.equal(rect.parent, home);
  assert.equal(title.parent, home);
  assert.equal(other.parent, home);
  assert.equal(h.kids(home).length, 3);
});

test("get_prototype_state reads flows and wires without mutating document state", () => {
  const h = load();
  const { home, rect } = seeded(h);
  h.interactions.flows = [{ name: "Main", homeArtboard: home, url: "https://example.invalid/private" }];
  h.interactions.allInteractions = [{
    triggerNode: rect,
    interactions: [{
      trigger: { type: "tap" },
      action: { type: "goToArtboard", destination: home, transition: { type: "dissolve", duration: 0.2, easing: "ease-out" } },
    }],
  }];
  const before = h.handlers.get_document_info().document.nodeCount;
  const r = h.handlers.get_prototype_state();
  assert.equal(r.ok, true);
  assert.equal(r.supported.authorInteractions, false);
  assert.equal(r.flows[0].name, "Main");
  assert.equal(r.flows[0].homeArtboard.guid, home.guid);
  assert.equal(r.interactions[0].triggerNode.guid, rect.guid);
  assert.equal(r.interactions[0].interactions[0].action.destination.guid, home.guid);
  assert.equal(JSON.stringify(r).includes("example.invalid"), false, "published URLs are not exposed");
  assert.equal(h.handlers.get_document_info().document.nodeCount, before, "inspection is read-only");
});

test("validate_prototype detects missing connections without attempting to author wires", () => {
  const h = load();
  const { home, rect } = seeded(h);
  h.interactions.allInteractions = [{
    triggerNode: rect,
    interactions: [{ trigger: { type: "tap" }, action: { type: "goToArtboard", destination: home } }],
  }];

  const pass = h.handlers.validate_prototype({ requiredConnections: [{ fromGuid: rect.guid, toGuid: home.guid, trigger: "tap", action: "goToArtboard" }] });
  assert.equal(pass.ok, true);
  assert.equal(pass.valid, true);
  assert.equal(pass.authoringSupported, false);

  const fail = h.handlers.validate_prototype({ requiredConnections: [{ fromGuid: rect.guid, toGuid: home.guid, trigger: "drag" }] });
  assert.equal(fail.ok, true);
  assert.equal(fail.valid, false);
  assert.ok(fail.results[0].problems.includes("connection-missing"));
});

test("audit_screen checks screen-specific semantic roles without imposing a node quota", () => {
  const h = load();
  const { home } = seeded(h);
  const requirements = [
    { role: "Card/Background", types: ["Rectangle"] },
    { role: "Card/Title", types: ["Text"], requireNonEmptyText: true },
  ];
  const incomplete = h.handlers.audit_screen({ guid: home.guid, requirements: [...requirements, { role: "Table/Rows", types: ["Group"] }] });
  assert.equal(incomplete.ok, true);
  assert.equal(incomplete.complete, false);
  assert.deepEqual(plain(incomplete.missingRoles), ["Table/Rows"]);
  assert.ok(incomplete.stats.descendantCount > 0, "the seeded card group and title are real descendants");

  const complete = h.handlers.audit_screen({ guid: home.guid, requirements });
  assert.equal(complete.complete, true);
  assert.equal(complete.roles.find((r: any) => r.role === "Card/Title").matches[0].type, "Text");
  assert.match(complete.note, /does not certify visual quality/);
});

// --- mutation -----------------------------------------------------------------

test("move_node supports absolute and relative positioning", () => {
  const h = load();
  const { rect } = seeded(h);

  h.handlers.move_node({ guid: rect.guid, x: 100, y: 200 });
  assert.deepEqual(plain({ x: rect.globalDrawBounds.x, y: rect.globalDrawBounds.y }), { x: 100, y: 200 });

  h.handlers.move_node({ guid: rect.guid, relative: true, x: 5, y: -10 });
  assert.deepEqual(plain({ x: rect.globalDrawBounds.x, y: rect.globalDrawBounds.y }), { x: 105, y: 190 });
});

test("resize_node supports absolute and relative sizing", () => {
  const h = load();
  const { rect } = seeded(h);

  h.handlers.resize_node({ guid: rect.guid, width: 50, height: 60 });
  assert.deepEqual(plain({ w: rect.globalDrawBounds.width, h: rect.globalDrawBounds.height }), { w: 50, h: 60 });

  h.handlers.resize_node({ guid: rect.guid, relative: true, width: 2, height: 0.5 });
  assert.deepEqual(plain({ w: rect.globalDrawBounds.width, h: rect.globalDrawBounds.height }), { w: 100, h: 30 });
});

test("apply_style applies to several guids and reports per-guid failures", () => {
  const h = load();
  const { rect, title } = seeded(h);
  const r = h.handlers.apply_style({
    guids: [rect.guid, "missing-guid"],
    style: { fill: "#FF0000", cornerRadius: 12, opacity: 0.5 },
  });
  assert.equal(r.ok, false, "one missing guid makes the aggregate fail");
  assert.equal(r.results[0].ok, true);
  assert.equal(r.results[1].ok, false);
  assert.equal(rect.fill.toHex(), "#FF0000");
  assert.equal(rect.cornerRadius, 12);
  assert.equal(rect.opacity, 0.5);
  assert.equal(title.fill, null, "unrelated nodes untouched");
});

test("apply_style supports documented stroke position, dash, caps and join properties", () => {
  const h = load();
  const { rect } = seeded(h);
  const r = h.handlers.apply_style({
    guids: [rect.guid],
    style: {
      stroke: "#313742",
      strokeWidth: 2,
      strokePosition: "OUTER_STROKE",
      strokeEndCaps: "STROKE_CAP_ROUND",
      strokeJoins: "STROKE_JOIN_BEVEL",
      strokeDashArray: [6, 3],
      strokeDashOffset: 1,
      innerShadow: { x: 0, y: 2, blur: 4, color: "#000000" },
    },
  });
  assert.equal(r.ok, true);
  assert.equal(rect.stroke.toHex(), "#313742");
  assert.equal(rect.strokeWidth, 2);
  assert.equal(rect.strokePosition, "OUTER_STROKE");
  assert.equal(rect.strokeEndCaps, "STROKE_CAP_ROUND");
  assert.equal(rect.strokeJoins, "STROKE_JOIN_BEVEL");
  assert.deepEqual(rect.strokeDashArray, [6, 3]);
  assert.equal(rect.strokeDashOffset, 1);
  assert.deepEqual(plain(rect.innerShadow.args.slice(0, 3)), [0, 2, 4]);
  assert.equal(rect.innerShadow.args[3].toHex(), "#000000");
});

test("update_text changes content and typography", () => {
  const h = load();
  const { title } = seeded(h);
  const r = h.handlers.update_text({ guid: title.guid, text: "Renamed", style: { fontSize: 20, fontFamily: "Inter" } });
  assert.equal(r.ok, true);
  assert.equal(title.text, "Renamed");
  assert.equal(title.styleRanges[0].length, 7);
  assert.equal(title.styleRanges[0].fontSize, 20);
  assert.equal(title.styleRanges[0].fontFamily, "Inter");
  assert.equal(title.styleRanges[0].fontStyle, undefined, "unspecified style range keys preserve existing typography");

  const notText = h.handlers.update_text({ guid: seeded(h).rect.guid });
  assert.equal(notText.ok, false);
});

test("apply_design_tokens records tokens on the root pluginData", () => {
  const h = load();
  const tokens = {
    color: { brand: { value: "#112233" }, ink: { value: "#0A1B2E" } },
    typography: { body: { fontSize: 16 } },
  };
  const r = h.handlers.apply_design_tokens({ tokens });
  assert.equal(r.ok, true);
  assert.equal(r.stored, true);
  assert.deepEqual(plain(r.counts), { color: 2, typography: 1 });
  assert.deepEqual(plain(h.root.pluginData.opencodeDesignTokens), tokens);
});

// --- query / audit ------------------------------------------------------------

test("search_nodes filters by query, by type, and respects limit", () => {
  const h = load();
  seeded(h);

  const byQuery = h.handlers.search_nodes({ query: "title" });
  assert.equal(byQuery.ok, true);
  assert.equal(byQuery.nodes.length, 1);
  assert.equal(byQuery.nodes[0].name, "Card/Title");

  const byType = h.handlers.search_nodes({ type: "Rectangle" });
  assert.equal(byType.nodes.length, 1);
  assert.equal(byType.nodes[0].type, "Rectangle");

  const limited = h.handlers.search_nodes({ query: "card", limit: 1 });
  assert.equal(limited.nodes.length, 1, "limit caps the result set");
});

test("validate_document reports default names, zero-size nodes and empty groups", () => {
  const h = load();
  const ab = h.artboard("Home");
  h.root.addChild(ab);
  const dflt = h.rectangle("Rectangle 12");
  dflt.globalDrawBounds = { x: 0, y: 0, width: 10, height: 10 };
  ab.addChild(dflt);
  const zero = h.ellipse("Badge");
  zero.globalDrawBounds = { x: 0, y: 0, width: 0, height: 10 };
  ab.addChild(zero);
  const empty = h.group("Empty");
  ab.addChild(empty);

  const r = h.handlers.validate_document();
  assert.equal(r.ok, true);
  const types = r.findings.map((f: any) => f.type);
  assert.ok(types.includes("default-name"));
  assert.ok(types.includes("zero-size"));
  assert.ok(types.includes("empty-group"));
  assert.ok(r.findings.every((f: any) => typeof f.guid === "string"));
});

test("inspect_design_consistency flags off-token colors, off-scale sizes and small targets", () => {
  const h = load();
  const ab = h.artboard("Home");
  h.root.addChild(ab);
  const body = h.text("Body", "copy");
  body.fontSize = 13;
  body.globalDrawBounds = { x: 0, y: 0, width: 200, height: 20 };
  ab.addChild(body);
  const accent = h.rectangle("Accent");
  accent.fill = new h.sg.Color("#FF0000");
  accent.globalDrawBounds = { x: 0, y: 0, width: 100, height: 100 };
  ab.addChild(accent);
  const icon = h.rectangle("Icon/Back");
  icon.globalDrawBounds = { x: 0, y: 0, width: 20, height: 20 };
  ab.addChild(icon);

  const r = h.handlers.inspect_design_consistency({
    tokens: { color: { brand: { value: "#FFFFFF" } }, typography: { body: { fontSize: 16 } } },
  });
  assert.equal(r.ok, true);
  const types = r.findings.map((f: any) => f.type);
  assert.ok(types.includes("font-size-off-scale"));
  assert.ok(types.includes("color-off-token"));
  assert.ok(types.includes("touch-target-small"));
  assert.equal(r.usage.fontSizes["13"], 1);
});

// --- exports ------------------------------------------------------------------

test("export_artboard uses the rendition API and returns base64 + scaled size", async () => {
  const h = load();
  const { home } = seeded(h);

  const r = await h.handlers.export_artboard({ name: "Home", scale: 3 });
  assert.equal(r.ok, true);
  assert.equal(r.artboardName, "Home");
  assert.equal(r.width, 1170);
  assert.equal(r.height, 2532);
  assert.deepEqual([...Buffer.from(r.base64, "base64")], PNG_BYTES);

  assert.equal(h.renditionCalls.length, 1, "exactly one createRenditions call");
  const call = h.renditionCalls[0][0];
  assert.equal(call.node, home, "rendition is requested for the resolved artboard");
  assert.equal(call.type, "PNG");
  assert.equal(call.scale, 3);
  assert.equal(h.files[0].deleted, true, "temp file is cleaned up");
});

test("export_artboard resolves by guid and reports unknown artboards", async () => {
  const h = load();
  const { home } = seeded(h);
  const byGuid = await h.handlers.export_artboard({ guid: home.guid });
  assert.equal(byGuid.ok, true);
  assert.equal(byGuid.scale, undefined);
  assert.equal(byGuid.width, 780, "default scale is 2");

  const missing = await h.handlers.export_artboard({ name: "Nope" });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "artboard_not_found");
});

test("export_selection renders the selected node and rejects an empty selection", async () => {
  const h = load();
  const { rect } = seeded(h);
  rect.globalDrawBounds = { x: 0, y: 0, width: 30, height: 40 };
  h.sg.selection.items = [rect];

  const r = await h.handlers.export_selection();
  assert.equal(r.ok, true);
  assert.equal(r.width, 60);
  assert.equal(r.height, 80);
  assert.equal(r.nodeName, "Card/Background");

  h.sg.selection.items = [];
  const empty = await h.handlers.export_selection();
  assert.equal(empty.ok, false);
  assert.match(empty.error, /selection is empty/);
});

// --- batch semantics ----------------------------------------------------------

test("execute_batch runs serially, aborts after failure and preserves the batch contract", async () => {
  const h = load();
  const ok = await h.handlers.execute_batch({
    operations: [
      { op: "create_artboard", params: { name: "Home", frame: { x: 0, y: 0, width: 390, height: 844 } } },
      { op: "create_rectangle", params: { name: "Card", frame: { x: 1, y: 2, width: 10, height: 10 } } },
    ],
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.results.length, 2);
  assert.equal(h.kids(h.kids(h.root)[0]).length, 1);

  const before = h.kids(h.root).length;
  const failed = await h.handlers.execute_batch({
    operations: [
      { op: "move_node", params: { guid: "missing", x: 1, y: 1 } },
      { op: "create_artboard", params: { name: "Nope", frame: { x: 0, y: 0, width: 10, height: 10 } } },
    ],
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.results[0].ok, false);
  assert.match(failed.results[1].error, /batch aborted/);
  assert.equal(h.kids(h.root).length, before, "no operation runs after the abort");
});

// --- failure modes ------------------------------------------------------------

const SCENE_OPS: Array<[string, (h: Harness) => any]> = [
  ["get_document_info", () => ({})],
  ["get_artboards", () => ({})],
  ["search_nodes", () => ({ query: "x" })],
  ["create_artboard", () => ({ name: "A", frame: { x: 0, y: 0, width: 10, height: 10 } })],
  ["create_rectangle", () => ({ frame: { x: 0, y: 0, width: 10, height: 10 } })],
  ["create_ellipse", () => ({ frame: { x: 0, y: 0, width: 10, height: 10 } })],
  ["create_line", () => ({ start: { x: 0, y: 0 }, end: { x: 10, y: 10 }, style: { stroke: "#000000" } })],
  ["create_polygon", () => ({ frame: { x: 0, y: 0, width: 10, height: 10 } })],
  ["create_path", () => ({ pathData: "M0 0 L10 0 L10 10 Z", x: 0, y: 0 })],
  ["create_image", (h) => ({ parent: h.kids(h.root)[0]?.guid ?? "x", frame: { x: 0, y: 0, width: 10, height: 10 } })],
  ["replace_image", () => ({ guid: "guid-2" })],
  ["import_asset", (h) => ({ parent: h.kids(h.root)[0]?.guid ?? "x" })],
  ["create_text", () => ({ text: "hi", frame: { x: 0, y: 0, width: 10, height: 10 } })],
  ["create_group", (h) => ({ guids: [h.kids(h.root)[0]?.guid ?? "x"] })],
  ["create_mask_group", (h) => ({ guids: [h.kids(h.root)[0]?.guid ?? "x", "y"] })],
  ["ungroup", () => ({ guid: "guid-2" })],
  ["duplicate_node", () => ({ guid: "guid-2" })],
  ["delete_node", () => ({ guid: "guid-2" })],
  ["reparent_node", () => ({ guid: "guid-2", parent: "guid-3" })],
  ["rotate_node", () => ({ guid: "guid-2", angle: 15 })],
  ["arrange_nodes", () => ({ guids: ["guid-2", "guid-3"], action: "bringToFront" })],
  ["align_nodes", () => ({ guids: ["guid-2", "guid-3"], action: "alignLeft" })],
  ["distribute_nodes", () => ({ guids: ["guid-2", "guid-3", "guid-4"], action: "distributeHorizontal" })],
  ["get_prototype_state", () => ({})],
  ["validate_prototype", () => ({ requiredConnections: [{ fromGuid: "a", toGuid: "b" }] })],
  ["audit_screen", (h) => ({ guid: h.kids(h.root)[0]?.guid ?? "x", requirements: [{ role: "A" }] })],
  ["update_node", () => ({ guid: "guid-2", name: "n" })],
  ["move_node", () => ({ guid: "guid-2", x: 1, y: 1 })],
  ["resize_node", () => ({ guid: "guid-2", width: 1, height: 1 })],
  ["apply_style", () => ({ guids: ["guid-2"], style: { fill: "#000000" } })],
  ["update_text", () => ({ guid: "guid-3", text: "t" })],
  ["apply_design_tokens", () => ({ tokens: { color: {} } })],
  ["inspect_design_consistency", () => ({ tokens: {} })],
  ["export_artboard", () => ({ name: "Home" })],
  ["validate_document", () => ({})],
];

test("no active document: every scene-dependent op returns a structured error", async () => {
  const h = load();
  seeded(h);
  h.app.activeDocument = null;
  for (const [op, params] of SCENE_OPS) {
    const r = await h.handlers[op](params(h));
    assert.equal(r.ok, false, op);
    assert.equal(r.code, "no_active_document", op);
    assert.equal(typeof r.error, "string", op);
  }
});

test("no active document (undefined): every scene-dependent op returns a structured error", async () => {
  const h = load();
  seeded(h);
  delete h.app.activeDocument;
  for (const [op, params] of SCENE_OPS) {
    const r = await h.handlers[op](params(h));
    assert.equal(r.ok, false, op);
    assert.equal(r.code, "no_active_document", op);
  }
});

test("missing scenegraph root: every scene-dependent op returns a structured error", async () => {
  const h = load();
  seeded(h);
  h.sg.root = undefined;
  for (const [op, params] of SCENE_OPS) {
    const r = await h.handlers[op](params(h));
    assert.equal(r.ok, false, op);
    assert.equal(r.code, "no_scenegraph_root", op);
    assert.match(r.error, /scenegraph root/i, op);
  }
});

test("malformed scenegraph root: every scene-dependent op returns a structured error", async () => {
  for (const badRoot of [{}, { children: null }, { children: "nope" }, { children: { length: 0 } }]) {
    const h = load();
    seeded(h);
    h.sg.root = badRoot;
    for (const [op, params] of SCENE_OPS) {
      const r = await h.handlers[op](params(h));
      assert.equal(r.ok, false, `${op} for ${JSON.stringify(badRoot)}`);
      assert.equal(r.code, "no_scenegraph_root", op);
    }
  }
});

// --- regression: SceneNodeList (live XD shape) --------------------------------

test("live-shaped SceneNodeList: handlers work when children is not an Array", async () => {
  const h = load({ childrenKind: "sceneNodeList" });
  assert.equal(Array.isArray(h.root.children), false, "XD SceneNodeList is not an Array");
  assert.equal(h.root.children[0], undefined, "SceneNodeList has no index access");

  // empty document first
  const blank = h.handlers.get_document_info();
  assert.equal(blank.ok, true);
  assert.equal(blank.document.artboardCount, 0);
  assert.deepEqual(plain(h.handlers.get_artboards().artboards), []);

  const home = h.artboard("Home", { x: 0, y: 0, width: 390, height: 844 });
  h.root.addChild(home);
  const card = h.group("Card");
  home.addChild(card);
  const rect = h.rectangle("Card/Background");
  card.addChild(rect);

  assert.equal(h.handlers.get_artboards().count, 1);
  assert.equal(h.handlers.get_document_info().document.nodeCount, 3);
  assert.equal(h.handlers.search_nodes({ type: "Rectangle" }).nodes.length, 1);

  const created = h.handlers.create_rectangle({
    parent: card.guid,
    name: "Card/Body",
    frame: { x: 1, y: 2, width: 10, height: 10 },
  });
  assert.equal(created.ok, true);
  assert.equal(h.kids(card).length, 2);

  assert.equal(h.handlers.update_node({ guid: rect.guid, name: "Renamed" }).ok, true);
  assert.equal(rect.name, "Renamed");

  const validated = h.handlers.validate_document();
  assert.equal(validated.ok, true);

  const exported = await h.handlers.export_artboard({ name: "Home" });
  assert.equal(exported.ok, true);
  assert.equal(exported.width, 780);

  assert.equal(h.handlers.update_node({ guid: "nope" }).code, "node_not_found");
});

// --- regression: no handler touches invalid DocumentInfo properties -----------
test("regression: no handler reads activeDocument.root / .path / .modified", async () => {
  const h = load({ documentName: "Regression" });
  const { home, card, rect, title } = seeded(h);
  const textNode = title;

  const params: Record<string, any> = {
    get_document_info: {},
    get_artboards: {},
    get_selection: {},
    inspect_node: { guid: rect.guid },
    search_nodes: { query: "card" },
    create_artboard: { name: "New", frame: { x: 0, y: 0, width: 100, height: 100 } },
    create_rectangle: { parent: card.guid, name: "R2", frame: { x: 1, y: 2, width: 10, height: 10 } },
    create_ellipse: { name: "E", frame: { x: 1, y: 2, width: 10, height: 10 } },
    create_line: { name: "Line", start: { x: 0, y: 0 }, end: { x: 10, y: 10 }, style: { stroke: "#112233" } },
    create_polygon: { name: "Triangle", frame: { x: 1, y: 2, width: 10, height: 10 }, style: { fill: "#112233" } },
    create_path: { name: "Path", pathData: "M0 0 L10 0 L10 10 Z", x: 1, y: 2, style: { fill: "#112233" } },
    create_image: { parent: home.guid, name: "Asset/Logo", frame: { x: 2, y: 2, width: 16, height: 16 } },
    replace_image: { guid: rect.guid },
    import_asset: { parent: home.guid, name: "Imported/Asset" },
    create_text: { name: "T2", text: "hi", frame: { x: 1, y: 2, width: 10, height: 10 } },
    create_group: { guids: [rect.guid], name: "G2" },
    create_mask_group: { guids: [rect.guid, title.guid] },
    ungroup: { guid: card.guid },
    duplicate_node: { guid: rect.guid, name: "Rect Copy", offset: { x: 2, y: 2 } },
    delete_node: { guid: rect.guid },
    reparent_node: { guid: rect.guid, parent: home.guid },
    rotate_node: { guid: rect.guid, angle: 15 },
    arrange_nodes: { guids: [rect.guid, title.guid], action: "bringToFront" },
    align_nodes: { guids: [rect.guid, title.guid], action: "alignLeft" },
    distribute_nodes: { guids: [rect.guid, title.guid, card.guid], action: "distributeHorizontal" },
    get_prototype_state: {},
    validate_prototype: { requiredConnections: [{ fromGuid: rect.guid, toGuid: home.guid }] },
    audit_screen: { guid: home.guid, requirements: [{ role: "Dash/Nav" }] },
    create_component: {},
    update_node: { guid: rect.guid, name: "Renamed" },
    move_node: { guid: rect.guid, x: 5, y: 6 },
    resize_node: { guid: rect.guid, width: 20, height: 30 },
    apply_style: { guids: [rect.guid], style: { fill: "#112233" } },
    update_text: { guid: textNode.guid, text: "changed" },
    apply_design_tokens: { tokens: { color: { brand: { value: "#000000" } } } },
    create_component_variants: {},
    inspect_design_consistency: { tokens: {} },
    export_artboard: { name: "Home" },
    export_selection: {},
    validate_document: {},
    execute_batch: { operations: [{ op: "create_rectangle", params: { frame: { x: 0, y: 0, width: 5, height: 5 } } }] },
  };

  const thrown: string[] = [];
  for (const op of Object.keys(h.handlers)) {
    try {
      await h.handlers[op](params[op] ?? {});
    } catch (e: any) {
      thrown.push(op + ": " + (e?.message ?? String(e)));
    }
  }

  assert.deepEqual(thrown, [], "no handler may throw");
  assert.equal(h.access.root, 0, "activeDocument.root must never be read");
  assert.equal(h.access.path, 0, "activeDocument.path must never be read");
  assert.equal(h.access.modified, 0, "activeDocument.modified must never be read");
  assert.equal(home.constructor.name, "Artboard");
});

// --- diagnostics + inventory ---------------------------------------------------

test("unsupported component authoring is reported immediately and honestly", () => {
  const h = load();
  const component = h.handlers.create_component({ guid: "guid-unused" });
  const variants = h.handlers.create_component_variants({ guid: "guid-unused", variants: ["Hover"] });
  assert.equal(component.ok, false);
  assert.equal(component.supported, false);
  assert.match(component.reason, /does not expose component creation/);
  assert.equal(variants.ok, false);
  assert.equal(variants.supported, false);
  assert.ok(h.nonMutating.has("create_component"));
  assert.ok(h.nonMutating.has("create_component_variants"));
});

test("diagnostics are off by default and privacy-safe when enabled", () => {
  const docName = "SECRET-PROJECT-NAME";
  const layerName = "CONFIDENTIAL-LAYER";
  const h = load({ documentName: docName });
  h.sg.root.addChild(h.artboard(layerName));

  h.handlers.get_document_info();
  h.handlers.get_artboards();
  assert.equal(h.diagLines().length, 0, "no diagnostics unless explicitly enabled");

  h.setDiagnostics(true);
  h.handlers.get_document_info();
  h.handlers.get_artboards();

  const diag = h.diagLines().join("\n");
  assert.ok(diag.length > 0, "expected DIAG lines once enabled");
  assert.match(diag, /keys=\[/, "diagnostics report key names");
  assert.match(diag, /activeDocument\.root typeof=undefined/, "diagnostics name the undefined object");
  assert.match(diag, /children kind=(Array|SceneNodeList-like)/, "diagnostics report the children collection kind");
  assert.ok(!diag.includes(docName), "document name must never be logged");
  assert.ok(!diag.includes(layerName), "layer name must never be logged");
});

test("handler inventory preserves prior operations and exposes documented capabilities (50 ops, 14 read-only)", () => {
  const h = load();
  const names = Object.keys(h.handlers).sort();
  assert.equal(names.length, 50);
  for (const expected of [
    "get_document_info",
    "get_artboards",
    "get_selection",
    "inspect_node",
    "search_nodes",
    "create_artboard",
    "create_rectangle",
    "create_ellipse",
    "create_line",
    "create_polygon",
    "create_path",
    "create_image",
    "replace_image",
    "import_asset",
    "create_text",
    "create_group",
    "create_mask_group",
    "ungroup",
    "duplicate_node",
    "delete_node",
    "reparent_node",
    "rotate_node",
    "arrange_nodes",
    "align_nodes",
    "distribute_nodes",
    "create_component",
    "update_node",
    "move_node",
    "resize_node",
    "apply_style",
    "update_text",
    "apply_design_tokens",
    "create_component_variants",
    "inspect_design_consistency",
    "get_prototype_state",
    "validate_prototype",
    "audit_screen",
    "export_artboard",
    "export_selection",
    "validate_document",
    "execute_batch",
    // v1.0.5 documented-API additions
    "update_path",
    "convert_to_path",
    "outline_stroke",
    "align_to_pixel_grid",
    "reset_3d_transforms",
    "make_background",
    "replace_background",
    "set_layout",
    "set_constraints",
  ]) {
    assert.ok(names.includes(expected), "missing handler " + expected);
  }
  assert.equal(h.nonMutating.size, 14);
  assert.equal(h.mutateOps.size, 36);
  for (const readOnly of ["get_document_info", "get_artboards", "get_selection", "inspect_node", "search_nodes"]) {
    assert.ok(h.nonMutating.has(readOnly), readOnly + " must stay read-only");
  }
  assert.ok(h.nonMutating.has("get_prototype_state"), "prototype state inspection stays read-only");
  assert.ok(h.nonMutating.has("audit_screen"), "screen role audit is read-only");
  assert.ok(h.nonMutating.has("validate_prototype"), "prototype edge validation is read-only");
  assert.ok(h.nonMutating.has("create_component"), "unsupported component creation is reported immediately, not queued");
  assert.ok(h.nonMutating.has("create_component_variants"), "unsupported variants are reported immediately, not queued");
  assert.ok(!h.nonMutating.has("create_rectangle"), "writes must stay queued");
  assert.ok(h.mutateOps.has("create_image"), "picker import remains user-gated");
  assert.ok(h.mutateOps.has("replace_image"), "image replacement remains user-gated");
  assert.ok(!h.mutateOps.has("get_prototype_state"), "prototype inspection is read-only");
});

test("create_artboard works even when the pasteboard root is not in the edit context", () => {
  const h = load();
  // XD 61 reports selection.isInEditContext(root) as false; the root *is* the
  // edit context. Validating it made artboard creation impossible live.
  h.sg.selection.blockedGuids.add(h.root.guid);
  const r = h.handlers.create_artboard({ frame: { x: 0, y: 0, width: 390, height: 844 }, name: "Scratch" });
  assert.equal(r.ok, true);
  assert.equal(h.kids(h.root).some((n: any) => n.guid === r.guid), true, "new artboard is attached to the root");
});

test("get_selection still works and does not depend on the document root", () => {
  const h = load();
  h.sg.root = undefined;
  const r = h.handlers.get_selection();
  assert.equal(r.ok, true);
  assert.deepEqual(plain(r.selection), []);
});

// --- v1.0.5: documented-API additions -----------------------------------------

test("create_text uses AUTO_HEIGHT layout when only a width is given", () => {
  const h = load();
  const { home } = seeded(h);
  const r = h.handlers.create_text({
    parent: home.guid,
    name: "Label",
    text: "Total balance",
    frame: { x: 10, y: 10, width: 180 },
    style: { fontSize: 12 },
  });
  assert.equal(r.ok, true);
  assert.equal(r.textMode, "AUTO_HEIGHT");
  const node = h.kids(home).at(-1);
  assert.equal(node.layoutBox.type, "AUTO_HEIGHT");
  assert.equal(node.layoutBox.width, 180);
  assert.equal(node.layoutBox.height, undefined);
});

test("update_path rewrites Path geometry and refuses non-Path nodes", () => {
  const h = load();
  const { home, rect } = seeded(h);
  const path = new h.sg.Path("Curve");
  home.addChild(path);

  const ok = h.handlers.update_path({ guid: path.guid, pathData: "M0,0 L10,10 L20,0 Z" });
  assert.equal(ok.ok, true);
  assert.equal(path.pathData, "M0,0 L10,10 L20,0 Z");

  const bad = h.handlers.update_path({ guid: rect.guid, pathData: "M0,0 L1,1" });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "node_not_found");
});

test("set_layout maps stack orientation and spacings onto SceneNode constants", () => {
  const h = load();
  const { home } = seeded(h);
  const r = h.handlers.set_layout({
    guid: home.guid,
    layout: { type: "stack", stack: { orientation: "vertical", spacings: 12 }, padding: 16 },
  });
  assert.equal(r.ok, true);
  assert.equal(home.layout.type, "STACK");
  assert.equal(home.layout.stack.orientation, "VERTICAL");
  assert.equal(home.layout.stack.spacings, 12);
  assert.equal(home.layout.padding, 16);
});

test("set_constraints writes documented constraint constants and can reset", () => {
  const h = load();
  const { rect } = seeded(h);
  const r = h.handlers.set_constraints({
    guid: rect.guid,
    horizontal: { position: "left", size: "fixed" },
    vertical: { position: "bottom", size: "resizes" },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(plain(rect.horizontalConstraints), { position: "FIXED_LEFT", size: "FIXED" });
  assert.deepEqual(plain(rect.verticalConstraints), { position: "FIXED_BOTTOM", size: "RESIZES" });

  const reset = h.handlers.set_constraints({ guid: rect.guid, reset: true });
  assert.equal(reset.ok, true);
  assert.equal(rect.resetCount, 1, "resetToAutoConstraints is invoked");
});

test("selection-command wrappers invoke the documented commands module", () => {
  const h = load();
  const { rect, title } = seeded(h);
  assert.equal(h.handlers.convert_to_path({ guids: [rect.guid] }).ok, true);
  assert.equal(rect._lastCommand, "convertToPath");
  assert.equal(h.handlers.outline_stroke({ guids: [title.guid] }).ok, true);
  assert.equal(title._lastCommand, "outlineStroke");
  assert.equal(h.handlers.align_to_pixel_grid({ guids: [rect.guid] }).ok, true);
  assert.equal(rect._lastCommand, "alignToPixelGrid");
});

test("update_node writes blendMode, markedForExport and fixedWhenScrolling", () => {
  const h = load();
  const { rect } = seeded(h);
  // fixedWhenScrolling is only defined for nodes whose direct parent is an Artboard.
  rect.fixedWhenScrolling = true;
  const r = h.handlers.update_node({
    guid: rect.guid,
    blendMode: "BLEND_MODE_MULTIPLY",
    markedForExport: true,
    fixedWhenScrolling: true,
  });
  assert.equal(r.ok, true);
  assert.equal(rect.blendMode, "BLEND_MODE_MULTIPLY");
  assert.equal(rect.markedForExport, true);
  assert.equal(rect.fixedWhenScrolling, true);
});
