/**
 * Panel executor contract tests.
 *
 * Loads the real xd-plugin/executor.js. Regression for the async completion
 * race: XD's editDocument() may return undefined while still invoking the async
 * edit callback. Completion must be reported from the *callback's* promise, and
 * exactly once.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const EXECUTOR_SRC = readFileSync(
  join(process.env.LOCALAPPDATA ?? "", "OpenCode", "AdobeXD-DesignBridge", "xd-plugin", "executor.js"),
  "utf8",
);

/** VM-created arrays/errors have their own realm; normalize before deep comparison. */
function plain<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Realm-safe "is an error-like object" check (vm errors fail instanceof Error). */
function hasError(value: any): boolean {
  return !!value && typeof value === "object" && typeof value.message === "string";
}

interface Settle {
  results: any[];
  error: any;
}

interface Harness {
  settles: Settle[];
  done: Promise<Settle>;
  invoke: (options?: any) => any;
}

function loadExecutor(): { runQueuedBatch: (options: any) => any } {
  const sandbox: any = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(EXECUTOR_SRC, sandbox, { filename: "executor.js" });
  return sandbox.window.__xdBridgeExecutor;
}

/** Runs one executor scenario and resolves as soon as the first settle occurs. */
function scenario(opts: {
  editDocument?: (options: any, callback: () => Promise<unknown>) => unknown;
  execute?: (operations: any[]) => Promise<any[]>;
  operations?: any[];
  application?: any;
}): Harness {
  const executor = loadExecutor();
  const settles: Settle[] = [];
  let resolveDone!: (s: Settle) => void;
  const done = new Promise<Settle>((resolve) => {
    resolveDone = resolve;
  });

  const application =
    opts.application !== undefined
      ? opts.application
      : { editDocument: opts.editDocument ?? ((_options: any, callback: () => Promise<unknown>) => { void callback(); }) };

  const invoke = () =>
    executor.runQueuedBatch({
      application,
      editLabel: "Test batch",
      operations: opts.operations ?? [{ op: "create_rectangle", params: { name: "R" } }],
      execute: opts.execute ?? (async () => [{ op: "create_rectangle", ok: true, guid: "guid-1" }]),
      onSettled: (results: any[], error: any) => {
        settles.push({ results, error });
        if (settles.length === 1) resolveDone({ results, error });
      },
    });

  return { settles, done, invoke };
}

/** Rejects instead of hanging forever when a settle never arrives. */
async function settled(harness: Harness, label: string): Promise<Settle> {
  const timeout = new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new Error(`${label}: no settle within 2000ms`)), 2000);
  });
  return Promise.race([harness.done, timeout]);
}

/** Lets pending microtasks/macrotasks run so late settles would be observed. */
async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test("editDocument returning undefined still completes from the async callback", async () => {
  let observedEditReturn: unknown = "unset";
  const harness = scenario({
    editDocument: (_options, callback) => {
      void callback();
      return undefined; // XD 61 behavior that broke the old implementation
    },
    execute: async () => [{ op: "create_rectangle", ok: true, guid: "guid-1" }],
  });

  observedEditReturn = harness.invoke();
  const settle = await settled(harness, "undefined return");
  assert.equal(observedEditReturn !== undefined, true, "executor returns a diagnostics object");

  assert.equal(settle.error, null);
  assert.equal(settle.results.length, 1, "completion carries real per-operation results");
  assert.equal(settle.results[0].guid, "guid-1");
});

test("settle waits for the async execute to finish (no empty early event)", async () => {
  let release!: (value: any[]) => void;
  const gate = new Promise<any[]>((resolve) => {
    release = resolve;
  });
  const harness = scenario({
    editDocument: (_options, callback) => {
      void callback();
      return undefined;
    },
    execute: () => gate,
  });

  harness.invoke();
  await flush();
  assert.equal(harness.settles.length, 0, "must not settle while the batch is still running");

  release([{ op: "create_rectangle", ok: true, guid: "late-guid" }]);
  const settle = await settled(harness, "gated execute");
  assert.equal(settle.results[0].guid, "late-guid");
});

test("execute receives exactly the queued operations", async () => {
  let received: any[] | null = null;
  const operations = [
    { op: "create_rectangle", params: { name: "A" } },
    { op: "create_text", params: { text: "B" } },
  ];
  const harness = scenario({
    operations,
    execute: async (ops) => {
      received = ops;
      return ops.map((op) => ({ op: op.op, ok: true }));
    },
  });

  harness.invoke();
  await settled(harness, "operations passthrough");
  assert.deepEqual(plain(received), plain(operations));
});

test("successful async batch completion settles once with all results", async () => {
  const results = [
    { op: "create_rectangle", ok: true, guid: "g1" },
    { op: "create_text", ok: true, guid: "g2" },
  ];
  const harness = scenario({ execute: async () => results });

  harness.invoke();
  const settle = await settled(harness, "success");
  await flush();
  assert.equal(harness.settles.length, 1);
  assert.equal(settle.error, null);
  assert.deepEqual(settle.results, results);
});

test("handler failure results are passed through, not converted to an empty batch", async () => {
  const results = [{ op: "create_rectangle", ok: false, error: "parent not found" }];
  const harness = scenario({ execute: async () => results });

  harness.invoke();
  const settle = await settled(harness, "handler failure");
  assert.equal(settle.error, null, "per-operation failure is reported through results");
  assert.deepEqual(settle.results, results);
  assert.equal(settle.results[0].ok, false);
});

test("rejected async handler settles once with the error and no results", async () => {
  const boom = new Error("execute_batch blew up");
  const harness = scenario({
    execute: async () => {
      throw boom;
    },
  });

  harness.invoke();
  const settle = await settled(harness, "rejected execute");
  await flush();
  assert.equal(hasError(settle.error), true, "settle error is an error-like object");
  assert.equal(settle.results.length, 0);
  assert.equal(harness.settles.length, 1);
});

test("picker cancellation is reported as a normal per-operation result", async () => {
  const results = [{ op: "create_image", ok: false, code: "user_cancelled", error: "image selection cancelled" }];
  const harness = scenario({
    operations: [{ op: "create_image", params: { parent: "artboard-guid" } }],
    execute: async () => results,
  });

  harness.invoke();
  const settle = await settled(harness, "picker cancel");
  assert.equal(settle.error, null, "cancelling a picker is not an executor exception");
  assert.equal(settle.results[0].code, "user_cancelled");
});

test("editDocument throwing synchronously settles once without executing", async () => {
  let executed = false;
  const boom = new Error("not a UI event");
  const harness = scenario({
    editDocument: () => {
      throw boom;
    },
    execute: async () => {
      executed = true;
      return [];
    },
  });

  harness.invoke();
  const settle = await settled(harness, "sync throw");
  assert.equal(settle.error, boom);
  assert.equal(settle.results.length, 0);
  assert.equal(executed, false);
});

test("editDocument that never invokes the callback settles once with an error", async () => {
  const harness = scenario({ editDocument: () => undefined });

  harness.invoke();
  const settle = await settled(harness, "no callback");
  assert.equal(hasError(settle.error), true);
  assert.match(String(settle.error && settle.error.message), /did not invoke the edit callback/);
  assert.equal(settle.results.length, 0);
});

test("double completion is impossible: late or duplicate callbacks settle only once", async () => {
  let deliveries = 0;
  const harness = scenario({
    editDocument: (_options, callback) => {
      void callback();
      void callback(); // duplicate invocation: a second settle must be ignored
      return undefined;
    },
    execute: async () => {
      deliveries += 1;
      return [{ op: "create_rectangle", ok: true, guid: "g1" }];
    },
  });

  harness.invoke();
  const settle = await settled(harness, "duplicate callback");
  await flush();
  assert.equal(deliveries, 2, "both callback runs reached execute");
  assert.equal(harness.settles.length, 1, "onSettled must run exactly once");
  assert.equal(settle.results.length, 1);
});

test("a synchronous throw after the callback starts does not double-settle", async () => {
  const harness = scenario({
    editDocument: (_options, callback) => {
      void callback();
      throw new Error("host failed after dispatch");
    },
    execute: async () => [{ op: "create_rectangle", ok: true, guid: "g1" }],
  });

  harness.invoke();
  await settled(harness, "throw after dispatch");
  await flush();
  assert.equal(harness.settles.length, 1);
});

test("missing executor dependency fails closed with a structured error", async () => {
  const harness = scenario({ application: {} });
  harness.invoke();
  const settle = await settled(harness, "no editDocument");
  assert.equal(hasError(settle.error), true);
  assert.match(String(settle.error && settle.error.message), /editDocument is unavailable/);
});
