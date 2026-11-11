/**
 * Workflow harness: models the parts of the system that the handler-level tests do not —
 * the user-mediated panel queue, execution events, read-back and evidence levels.
 *
 * This is a specification executable: `ExecutionController` enforces the transitions and
 * evidence gates defined in `agents/design.md`. It never touches Adobe XD.
 */

export type Level = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type State =
  | "DISCOVER"
  | "INSPECT"
  | "PLAN"
  | "PREPARE"
  | "QUEUE"
  | "WAIT_FOR_PANEL_EXECUTION"
  | "VERIFY_EXECUTION"
  | "READ_BACK"
  | "CONTINUE_BUILDING"
  | "VISUAL_QA"
  | "REPAIR"
  | "EXPORT"
  | "FINAL_VERIFY"
  | "DELIVER"
  | "RECOVER"
  | "UNKNOWN_QUEUE_LOST";

export interface Op {
  op: string;
  [key: string]: any;
}

export interface OpResult {
  op: string;
  ok: boolean;
  guid?: string;
  error?: string;
}

export interface ExecResult {
  ok: boolean;
  results: OpResult[];
  at: number;
}

export class EvidenceError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "EvidenceError";
    this.code = code;
  }
}

interface XdNode {
  guid: string;
  type: string;
  name: string;
  parent: string | null;
  frame: { x: number; y: number; width: number; height: number };
  fill: string | null;
  childCount: number;
  text?: string;
}

/** Fake XD document. Only the operations the design agent uses. */
export class FakeXd {
  nodes = new Map<string, XdNode>();
  private seq = 0;
  failOps = new Set<string>();
  zeroSizeOps = new Set<string>();
  wrongParentOps = new Set<string>();
  failExport = false;

  constructor() {
    const root = this.add("RootNode", "Root", null, { x: 0, y: 0, width: 0, height: 0 }, null);
    this.nodes.delete(root.guid);
    root.guid = "root";
    this.nodes.set("root", root);
  }

  private add(type: string, name: string, parent: string | null, frame: XdNode["frame"], fill: string | null): XdNode {
    const guid = `guid-${++this.seq}`;
    const node: XdNode = { guid, type, name, parent, frame, fill, childCount: 0 };
    this.nodes.set(guid, node);
    return node;
  }

  byName(name: string): XdNode | undefined {
    return [...this.nodes.values()].find((n) => n.name === name);
  }

  byGuid(guid: string): XdNode | undefined {
    return this.nodes.get(guid);
  }

  childrenOf(guid: string): XdNode[] {
    return [...this.nodes.values()].filter((n) => n.parent === guid);
  }

  createArtboard(name: string, frame: XdNode["frame"], fill: string | null): XdNode {
    const n = this.add("Artboard", name, "root", frame, fill);
    this.nodes.get("root")!.childCount++;
    return n;
  }

  createShape(op: string, name: string, parent: string, frame: XdNode["frame"], fill: string | null): XdNode {
    const type = op === "create_ellipse" ? "Ellipse"
      : op === "create_polygon" ? "Polygon"
      : op === "create_path" ? "Path"
      : op === "create_line" ? "Line"
      : "Rectangle";
    const n = this.add(type, name, parent, frame, fill);
    const p = this.nodes.get(parent);
    if (p) p.childCount++;
    return n;
  }

  createText(name: string, parent: string, frame: XdNode["frame"], text: string): XdNode {
    const n = this.add("Text", name, parent, frame, null);
    n.text = text;
    const p = this.nodes.get(parent);
    if (p) p.childCount++;
    n.frame.width = frame.width || text.length * 7;
    n.frame.height = frame.height || 20;
    return n;
  }

  exportArtboard(guid: string): Uint8Array {
    if (this.failExport) return new Uint8Array(0);
    const ab = this.nodes.get(guid);
    if (!ab) return new Uint8Array(0);
    // a blank artboard renders to an empty payload
    if (ab.childCount === 0) return new Uint8Array(0);
    return new Uint8Array(1024).fill(7);
  }

  run(op: Op): OpResult {
    if (this.failOps.has(op.op)) return { op: op.op, ok: false, error: "injected failure" };

    if (op.op === "create_artboard") {
      const frame = this.zeroSizeOps.has(op.op) ? { ...op.frame, width: 0 } : op.frame;
      const n = this.createArtboard(op.name ?? "Artboard", frame, op.style?.fill ?? null);
      return { op: op.op, ok: true, guid: n.guid };
    }
    // operations that act on existing nodes need no parent
    if (op.op === "apply_style") {
      const targets: string[] = op.guids ?? (op.guid ? [op.guid] : []);
      for (const g of targets) {
        const n = this.nodes.get(g);
        if (n && op.style?.fill) n.fill = op.style.fill;
      }
      return { op: op.op, ok: true };
    }
    if (op.op === "update_node") {
      const n = this.nodes.get(op.guid);
      if (!n) return { op: op.op, ok: false, error: "node not found" };
      if (op.name) n.name = op.name;
      if (op.style?.fill) n.fill = op.style.fill;
      return { op: op.op, ok: true };
    }
    if (op.op === "create_group") {
      const guids: string[] = op.guids ?? [];
      if (guids.some((g) => !this.nodes.has(g))) return { op: op.op, ok: false, error: "node not found" };
      const sameParent = new Set(guids.map((g) => this.nodes.get(g)?.parent));
      if (sameParent.size !== 1) return { op: op.op, ok: false, error: "nodes must share one parent" };
      const first = this.nodes.get(guids[0])!;
      const g = this.add("Group", op.name ?? "Group", first.parent, { ...first.frame }, null);
      for (const gid of guids) this.nodes.get(gid)!.parent = g.guid;
      g.childCount = guids.length;
      return { op: op.op, ok: true, guid: g.guid };
    }

    const parent = (op.parent as string | undefined) ?? undefined;
    if (!parent) return { op: op.op, ok: false, error: "parent required" };
    if (!this.nodes.has(parent)) return { op: op.op, ok: false, error: "parent not found" };
    if (this.wrongParentOps.has(op.op)) {
      const other = [...this.nodes.values()].find((n) => n.type === "Artboard" && n.guid !== parent);
      const n = this.createShape(op.op, op.name ?? op.op, other ? other.guid : "root", op.frame, op.style?.fill ?? null);
      return { op: op.op, ok: true, guid: n.guid };
    }
    if (op.op === "create_rectangle" || op.op === "create_ellipse") {
      const frame = this.zeroSizeOps.has(op.op) ? { ...op.frame, height: 0 } : op.frame;
      const n = this.createShape(op.op, op.name ?? op.op, parent, frame, op.style?.fill ?? null);
      return { op: op.op, ok: true, guid: n.guid };
    }
    if (op.op === "create_text") {
      const n = this.createText(op.name ?? "Text", parent, op.frame, op.text ?? "");
      if (op.style?.fill) n.fill = op.style.fill;
      return { op: op.op, ok: true, guid: n.guid };
    }
    return { op: op.op, ok: false, error: `unsupported in harness: ${op.op}` };
  }
}

/** Plugin panel queue: in-memory, executes only on a user click, lost on reload. */
export class PanelQueue {
  private pending: Op[] = [];
  autoExecute = false;
  executed: ExecResult[] = [];
  reloads = 0;
  xd: FakeXd;

  constructor(xd: FakeXd) {
    this.xd = xd;
  }

  depth(): number {
    return this.pending.length;
  }

  enqueue(ops: Op[]): { ok: true; queued: true; pending: number } {
    this.pending.push(...ops);
    return { ok: true, queued: true, pending: this.pending.length };
  }

  clickExecute(): ExecResult {
    const batch = this.pending.splice(0);
    const results = batch.map((o) => this.xd.run(o));
    const res: ExecResult = { ok: results.every((r) => r.ok), results, at: Date.now() };
    this.executed.push(res);
    return res;
  }

  /** Panel closed/reloaded: pending work disappears without any event. */
  reload(): void {
    this.pending = [];
    this.reloads++;
  }
}

/** Bridge façade: what MCP actually returns. */
export class Bridge {
  lastEvent: { name: string; data: ExecResult | null } | null = null;
  panel: PanelQueue;

  constructor(panel: PanelQueue) {
    this.panel = panel;
  }

  queue(ops: Op[]) {
    const r = this.panel.enqueue(ops);
    return { ok: true, queued: true, op: "execute_batch", pending: r.pending };
  }

  status() {
    return { ok: true, xdConnected: true, pendingRequests: 0, lastEvent: this.lastEvent };
  }

  recordExecution(res: ExecResult) {
    this.lastEvent = { name: "batchExecuted", data: res };
  }
}

export interface ExpectedNode {
  name: string;
  parent: string;
  frame: { x: number; y: number; width: number; height: number };
  fill?: string;
}

/**
 * The contract's state machine, executable. Illegal transitions and over-claimed
 * evidence levels throw EvidenceError — that is the point of the tests.
 */
export class ExecutionController {
  state: State = "DISCOVER";
  level = 0;
  batches: Array<{ ops: Op[]; result: ExecResult | null; verified: boolean }> = [];
  guids = new Map<string, string>();
  screens = new Set<string>();
  queueLost = false;
  allowRetryAfterLoss = false;
  panel: PanelQueue;
  bridge: Bridge;
  xd: FakeXd;
  expectedScreens: number;

  constructor(panel: PanelQueue, bridge: Bridge, xd: FakeXd, expectedScreens = 1) {
    this.panel = panel;
    this.bridge = bridge;
    this.xd = xd;
    this.expectedScreens = expectedScreens;
  }

  private to(next: State) {
    this.state = next;
  }

  private assert(states: State[], action: string) {
    if (!states.includes(this.state)) {
      throw new EvidenceError("illegal_transition", `${action} not allowed in state ${this.state}`);
    }
  }

  discover() {
    this.assert(["DISCOVER"], "discover");
    this.to("INSPECT");
  }

  inspect() {
    this.assert(["INSPECT"], "inspect");
    this.to("PLAN");
  }

  plan() {
    this.assert(["PLAN"], "plan");
    this.to("PREPARE");
  }

  /** Queue a batch. Refuses while another batch is unexecuted. */
  queueBatch(ops: Op[]) {
    this.assert(["PREPARE", "CONTINUE_BUILDING"], "queueBatch");
    if (this.panel.depth() > 0) throw new EvidenceError("queue_not_empty", "previous batch is still pending");
    this.to("QUEUE");
    const res = this.bridge.queue(ops);
    this.batches.push({ ops, result: null, verified: false });
    this.level = Math.max(this.level, 2);
    this.to("WAIT_FOR_PANEL_EXECUTION");
    return res;
  }

  /** The user clicks Execute pending. The only way forward from WAIT. */
  userClicksExecute() {
    this.assert(["WAIT_FOR_PANEL_EXECUTION"], "userClicksExecute");
    if (this.panel.depth() === 0) throw new EvidenceError("nothing_pending", "no queued operations to execute");
    const res = this.panel.clickExecute();
    this.bridge.recordExecution(res);
    const batch = this.batches[this.batches.length - 1];
    batch.result = res;
    this.to("VERIFY_EXECUTION");
    return res;
  }

  verifyExecution() {
    this.assert(["VERIFY_EXECUTION"], "verifyExecution");
    const batch = this.batches[this.batches.length - 1];
    if (!batch || !batch.result) throw new EvidenceError("no_result", "no execution result to verify");
    if (!batch.result.ok) {
      this.to("RECOVER");
      throw new EvidenceError("execution_failed", "one or more operations failed");
    }
    this.level = 3;
    this.to("READ_BACK");
  }

  /** Read back every expected node; any mismatch is a failure, not a warning. */
  readBack(expected: ExpectedNode[]) {
    this.assert(["READ_BACK"], "readBack");
    for (const exp of expected) {
      const matches = [...this.xd.nodes.values()].filter((n) => n.name === exp.name);
      const node = matches.find((n) => n.parent === exp.parent) ?? matches[0];
      if (!node) {
        this.to("RECOVER");
        throw new EvidenceError("missing_node", `node not found: ${exp.name}`);
      }
      if (node.parent !== exp.parent) {
        this.to("RECOVER");
        throw new EvidenceError("wrong_parent", `${exp.name} parent=${node.parent} expected=${exp.parent}`);
      }
      if (!(node.frame.width > 0) || !(node.frame.height > 0)) {
        this.to("RECOVER");
        throw new EvidenceError("invalid_dimensions", `${exp.name} is ${node.frame.width}x${node.frame.height}`);
      }
      if (exp.fill && node.fill !== exp.fill) {
        this.to("RECOVER");
        throw new EvidenceError("wrong_fill", `${exp.name} fill=${node.fill} expected=${exp.fill}`);
      }
      this.guids.set(exp.name, node.guid);
      const batch = this.batches[this.batches.length - 1];
      batch.verified = true;
    }
    this.level = 4;
    this.to("CONTINUE_BUILDING");
  }

  /** Export and require a non-empty render. */
  exportAndRender(artboardGuid: string, screenName?: string) {
    this.assert(["CONTINUE_BUILDING", "VISUAL_QA", "EXPORT"], "exportAndRender");
    const image = this.xd.exportArtboard(artboardGuid);
    if (!image || image.length === 0) {
      this.to("RECOVER");
      throw new EvidenceError("empty_export", "export produced no visible content");
    }
    if (screenName) this.screens.add(screenName);
    this.level = Math.max(this.level, 5);
    this.to("VISUAL_QA");
    return image;
  }

  qaPass() {
    this.assert(["VISUAL_QA"], "qaPass");
    this.level = Math.max(this.level, 6);
    this.to("EXPORT");
  }

  /** Move to the next screen after one screen's export has been verified. */
  beginNextScreen() {
    this.assert(["EXPORT", "CONTINUE_BUILDING"], "beginNextScreen");
    this.to("PREPARE");
  }

  finalVerify() {
    this.assert(["EXPORT"], "finalVerify");
    if (this.level < 6) throw new EvidenceError("premature_final_verify", `level ${this.level} < 6`);
    this.to("FINAL_VERIFY");
  }

  deliver() {
    this.assert(["FINAL_VERIFY"], "deliver");
    if (this.screens.size < this.expectedScreens) {
      throw new EvidenceError("premature_delivery", `only ${this.screens.size}/${this.expectedScreens} screens rendered`);
    }
    if (this.level < 6) throw new EvidenceError("premature_delivery", `level ${this.level} < 6`);
    this.level = 7;
    this.to("DELIVER");
  }

  /** Guard used by tests: claiming a level you did not reach is an error. */
  claim(level: Level) {
    if (this.level < level) {
      throw new EvidenceError("premature_claim", `claimed LEVEL ${level}, proved LEVEL ${this.level}`);
    }
    return true;
  }

  /** Panel reloaded while work was pending: state is unknown, never auto-retry. */
  panelReloaded() {
    this.queueLost = this.panel.depth() > 0 || this.state === "WAIT_FOR_PANEL_EXECUTION";
    this.panel.reload();
    if (this.queueLost) {
      this.to("UNKNOWN_QUEUE_LOST");
      this.allowRetryAfterLoss = false;
    }
    return this.queueLost;
  }

  /**
   * Resolve an unknown queue state by reading the document, not by retrying.
   * Returns "applied" (work exists), "not_applied" (safe to re-queue once), or throws.
   */
  resolveUnknownQueue(expected: ExpectedNode[]): "applied" | "not_applied" {
    this.assert(["UNKNOWN_QUEUE_LOST"], "resolveUnknownQueue");
    const applied = expected.every((e) => {
      const n = this.xd.byName(e.name);
      return !!n && n.parent === e.parent;
    });
    if (applied) {
      this.level = Math.max(this.level, 4);
      this.to("CONTINUE_BUILDING");
      return "applied";
    }
    this.allowRetryAfterLoss = true;
    this.to("PREPARE");
    return "not_applied";
  }

  /** Only legal after resolveUnknownQueue said not_applied. */
  requeueAfterLoss(ops: Op[]) {
    if (!this.allowRetryAfterLoss) {
      throw new EvidenceError("blind_retry", "refusing to retry while execution state is unknown");
    }
    this.allowRetryAfterLoss = false;
    return this.queueBatch(ops);
  }
}

/** Screen-specific semantic requirement passed to auditScreen/evaluateScreen. */
export interface ScreenRoleRequirement {
  role: string;
  types?: string[];
  requireNonEmptyText?: boolean;
}

/**
 * Screen completeness evaluation — an artboard is a canvas, not a screen.
 * Completion is driven by the designer's per-screen role manifest, never a
 * universal node-count template.
 */
export interface ScreenEvaluation {
  screen: string;
  complete: boolean;
  missingRoles: string[];
  roles: Array<{ role: string; ok: boolean; missingTypes: string[]; matches: Array<{ guid: string; type: string; name: string }> }>;
  stats: {
    children: number;
    descendants: number;
    text: number;
    groups: number;
    rendered: boolean;
  };
}

export function evaluateScreen(
  xd: FakeXd,
  artboardName: string,
  requirements: ScreenRoleRequirement[],
  opts: { rendered?: boolean; requireRender?: boolean } = {},
): ScreenEvaluation {
  const board = xd.byName(artboardName);
  const stats = { children: 0, descendants: 0, text: 0, groups: 0, rendered: !!opts.rendered };

  if (!board || board.type !== "Artboard") {
    return { screen: artboardName, complete: false, missingRoles: ["artboard_missing"], roles: [], stats };
  }

  const children = xd.childrenOf(board.guid);
  stats.children = children.length;
  const descendants: XdNode[] = [];
  const visit = (parent: string) => {
    for (const n of xd.childrenOf(parent)) {
      descendants.push(n);
      visit(n.guid);
    }
  };
  visit(board.guid);
  stats.descendants = descendants.length;
  stats.text = descendants.filter((n) => n.type === "Text").length;
  stats.groups = descendants.filter((n) => n.type === "Group").length;

  const roles = requirements.map((requirement) => {
    const prefix = `${requirement.role}/`;
    const matches = descendants.filter((n) => n.name === requirement.role || n.name.startsWith(prefix));
    const missingTypes = (requirement.types || []).filter((type) => !matches.some((n) => n.type === type));
    const textOk = !requirement.requireNonEmptyText || matches.some((n) => n.type === "Text" && !!n.text?.trim());
    return { role: requirement.role, ok: matches.length > 0 && missingTypes.length === 0 && textOk, missingTypes, matches: matches.map((n) => ({ guid: n.guid, type: n.type, name: n.name })) };
  });
  const missingRoles = roles.filter((r) => !r.ok).map((r) => r.role);
  if (opts.requireRender && !opts.rendered) missingRoles.push("rendered-preview");
  return { screen: artboardName, complete: missingRoles.length === 0, missingRoles, roles, stats };
}

/**
 * Text style mapping against documented XD keys. v1.0.3 supports Text.styleRanges.fill,
 * Text.styleRanges.fontStyle and the Text.lineSpacing property directly.
 */export function mapTextStyle(input: { fill?: string; fontWeight?: string; lineHeight?: number; fontFamily?: string; fontSize?: number }) {
  const range: Record<string, unknown> = {};
  const fallbackOps: Op[] = [];
  const notes: string[] = [];

  if (input.fontFamily) range.fontFamily = input.fontFamily;
  if (input.fontSize) range.fontSize = input.fontSize;
  if (input.fill) range.fill = input.fill;
  if (input.fontWeight) {
    range.fontStyle = input.fontWeight;
  }
  if (input.lineHeight) notes.push("lineHeight maps to Text.lineSpacing (a node-level property)");

  return { range, fallbackOps, notes };
}
