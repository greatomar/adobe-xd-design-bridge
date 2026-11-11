/**
 * Design Asset Intelligence tests.
 *
 * These exercise real behaviour, not existence: ranking quality, licence
 * gating, cache dedupe, SVG parsing, path transforms and the actual operations
 * queued for XD. Network access is replaced by an injected fetcher, so the
 * suite is deterministic and offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AssetService } from "../bridge/src/assets/service.ts";
import { AssetCache } from "../bridge/src/assets/cache.ts";
import { parseSvg } from "../bridge/src/assets/svg.ts";
import { transformPathData } from "../bridge/src/assets/pathdata.ts";
import { searchAssets } from "../bridge/src/assets/search.ts";
import { DesignContextStore } from "../bridge/src/assets/context.ts";
import { buildTools, setAssetService } from "../bridge/src/tools.ts";
import { SOURCES } from "../bridge/src/assets/sources.ts";

const SETTINGS_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/><circle cx="12" cy="12" r="2"/></svg>`;

function fakeFetch(map: Record<string, string>, counter = { n: 0 }) {
  const fn = async (url: string): Promise<string> => {
    counter.n++;
    for (const [needle, body] of Object.entries(map)) {
      if (url.includes(needle)) return body;
    }
    throw new Error("unexpected fetch: " + url);
  };
  (fn as unknown as { counter: { n: number } }).counter = counter;
  return fn;
}

function tempDir(prefix = "asset-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function serviceWith(fetchMap: Record<string, string>, dir = tempDir()) {
  const counter = { n: 0 };
  const svc = new AssetService({ cacheDir: dir, fetcher: fakeFetch(fetchMap, counter) });
  return { svc, dir, counter };
}

// ---------------------------------------------------------------- registry ---

test("registry loads curated fonts and component patterns", () => {
  const { svc } = serviceWith({});
  const all = svc.allRecords();
  const fonts = all.filter((r) => r.category === "font");
  const comps = all.filter((r) => r.category === "component");
  assert.ok(fonts.length >= 10, "expected the curated font set");
  assert.ok(comps.length >= 10, "expected the component pattern set");
  assert.ok(fonts.every((f) => f.license && f.recommended_for.length > 0));
  const arabic = fonts.filter((f) => f.style.includes("arabic"));
  assert.deepEqual(arabic.map((f) => f.name).sort(), ["Noto Kufi Arabic", "Noto Sans Arabic"]);
});

test("every source declares an integration kind and license", () => {
  for (const s of SOURCES) {
    assert.ok(["api", "api-key", "package", "download", "reference", "manual"].includes(s.kind), s.id);
    assert.ok(s.license.name && s.license.url, s.id);
    assert.ok(typeof s.license.attribution_required === "boolean", s.id);
    if (s.kind === "api" || s.kind === "download") {
      assert.ok(!s.license.uncertain, `${s.id} is automatable but its license is uncertain`);
    }
  }
});

// ------------------------------------------------------------------ search ---

test("font search recommends a neutral UI family for SaaS, with reasons", () => {
  const { svc } = serviceWith({});
  const res = searchAssets(svc.allRecords(), { query: "modern SaaS dashboard UI font", category: "font", limit: 5 });
  const names = res.map((r) => r.asset.name);
  assert.ok(names.includes("Inter") || names.includes("Geist"), "expected Inter/Geist near the top, got " + names.join(", "));
  assert.ok(res[0].reasons.length > 0, "every ranked result explains itself");
});

test("Arabic requirement surfaces Arabic-capable fonts", () => {
  const { svc } = serviceWith({});
  const res = searchAssets(svc.allRecords(), {
    query: "professional font for a government portal",
    category: "font",
    limit: 5,
    context: { language: "Arabic", direction: "rtl" },
  });
  assert.ok(res[0].asset.style.includes("arabic"), "top pick must support Arabic, got " + res[0].asset.name);
});

test("design context shifts ranking toward the established direction", () => {
  const { svc } = serviceWith({});
  const plain = searchAssets(svc.allRecords(), { query: "creative display type", category: "font", limit: 10 });
  const ctx = searchAssets(svc.allRecords(), {
    query: "creative display type",
    category: "font",
    limit: 10,
    context: { product: "enterprise bank", visual_direction: "corporate" },
  });
  const scoreOf = (res: typeof plain, name: string) => res.find((r) => r.asset.name === name)?.score ?? -1;
  assert.ok(
    scoreOf(ctx, "IBM Plex Sans") > scoreOf(plain, "IBM Plex Sans"),
    "corporate context should raise IBM Plex Sans",
  );
  assert.ok(
    scoreOf(ctx, "Space Grotesk") < scoreOf(plain, "Space Grotesk"),
    "corporate context should lower the creative-display face",
  );
});

test("license filter removes uncertain and non-commercial assets", () => {
  const { svc } = serviceWith({});
  const all = searchAssets(svc.allRecords(), { query: "illustration", limit: 20 });
  const safe = searchAssets(svc.allRecords(), { query: "illustration", limit: 20, license: "commercial" });
  assert.ok(safe.every((r) => r.asset.license.uncertain !== true && r.asset.license.commercial_use === "yes"));
  assert.ok(safe.length <= all.length);
});

test("source and category filters are strict", () => {
  const { svc } = serviceWith({});
  const only = searchAssets(svc.allRecords(), { query: "button", category: "component", source: "shadcn", limit: 10 });
  assert.ok(only.length > 0);
  assert.ok(only.every((r) => r.asset.sourceId === "shadcn"));
  const wrong = searchAssets(svc.allRecords(), { query: "button", category: "font", limit: 10 });
  assert.ok(wrong.every((r) => r.asset.category === "font"));
});

// ------------------------------------------------------------- icon lookup ---

test("icon search calls the Iconify API once and caches the result", async () => {
  const { svc, counter } = serviceWith({
    "api.iconify.design/search": JSON.stringify({ icons: ["lucide:settings", "lucide:sliders-horizontal", "ph:gear"] }),
  });
  const first = await svc.search({ query: "settings gear", limit: 5 });
  assert.ok(first.results.length >= 3, "expected icon hits");
  const ids = first.results.map((r) => r.asset.id);
  assert.ok(ids.some((id) => id.startsWith("iconify:lucide:")), "expected a Lucide icon, got " + ids.join(", "));
  const callsAfterFirst = counter.n;

  await svc.search({ query: "settings gear", limit: 5 });
  assert.equal(counter.n, callsAfterFirst, "repeat search must be served from cache");
});

test("icon search degrades gracefully when the network fails", async () => {
  const svc = new AssetService({
    cacheDir: tempDir(),
    fetcher: async () => {
      throw new Error("offline");
    },
  });
  const res = await svc.search({ query: "settings icon", limit: 5 });
  assert.ok(Array.isArray(res.results));
  assert.match(String(res.degraded), /Iconify unavailable/);
  assert.ok(res.results.every((r) => r.asset.category !== "icon"), "no invented icons while offline");
});

test("get() downloads an icon once and persists it to the project cache", async () => {
  const { svc, dir, counter } = serviceWith({ ".svg": SETTINGS_SVG, "api.iconify.design/search": JSON.stringify({ icons: ["lucide:settings"] }) });
  await svc.search({ query: "settings", limit: 3 });
  const before = counter.n;
  const got = await svc.get("iconify:lucide:settings");
  assert.ok(got && got.svg.includes("<svg"));
  assert.equal(counter.n, before + 1, "exactly one SVG download");
  assert.ok(existsSync(got!.cachedPath), "svg written to cache");
  assert.ok(got!.cachedPath.startsWith(dir), "cache stays inside the configured directory");

  const again = await svc.get("iconify:lucide:settings");
  assert.equal(counter.n, before + 1, "second get is served from cache");
  assert.equal(again!.svg.length, got!.svg.length);
});

// ------------------------------------------------------------------- cache ---

test("cache deduplicates identical content and records source metadata", () => {
  const dir = tempDir();
  const cache = new AssetCache(dir);
  const meta = { key: "lucide:settings", source: "lucide", assetId: "settings", url: "https://api.iconify.design/lucide/settings.svg", license: "ISC" };
  const a = cache.write(meta, SETTINGS_SVG, "svg");
  const b = cache.write(meta, SETTINGS_SVG, "svg");
  assert.equal(a.sha256, b.sha256);
  assert.equal(Object.keys(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))).length, 1, "one manifest entry");
  assert.equal(cache.stats().entries, 1);
  assert.equal(cache.stats().bytes > 0, true);

  const hit = cache.read("lucide:settings");
  assert.ok(hit && hit.content.includes("svg"));
});

test("cache rejects tampered content and survives a missing file", () => {
  const dir = tempDir();
  const cache = new AssetCache(dir);
  const meta = { key: "lucide:x", source: "lucide", assetId: "x", url: "https://example.test/x.svg", license: "ISC" };
  const entry = cache.write(meta, SETTINGS_SVG, "svg");
  writeFileSync(entry.file, "tampered", "utf8");
  assert.equal(cache.read("lucide:x"), null, "hash mismatch invalidates the entry");

  unlinkSync(entry.file);
  assert.equal(cache.prune(), 1, "missing files are pruned");
  assert.equal(cache.stats().entries, 0);
});

test("cache paths cannot escape the cache directory", () => {
  const dir = tempDir();
  const cache = new AssetCache(dir);
  const file = cache.fileFor("../../evil", "../../etc/passwd", "svg");
  assert.ok(file.startsWith(dir), "path traversal is neutralised: " + file);
  assert.ok(!file.includes(".."));
});

// --------------------------------------------------------------------- svg ---

test("SVG parser extracts paths, shapes, inheritance and unsupported features", () => {
  const parsed = parseSvg(`<svg viewBox="0 0 24 24" width="24" height="24"><g fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 4h16v16H4z"/><rect x="2" y="3" width="10" height="5" rx="2"/></g><circle cx="12" cy="12" r="3"/><text x="0" y="0">x</text></svg>`);
  assert.equal(parsed.viewBox.width, 24);
  assert.equal(parsed.shapes.length, 3);
  assert.equal(parsed.shapes[0].stroke, "currentColor");
  assert.equal(parsed.shapes[0].strokeWidth, 1.5);
  assert.equal(parsed.shapes[0].fill, "none");
  assert.ok(parsed.unsupported.includes("text"));
  assert.ok(parsed.shapes[1].d.includes("A"), "rounded rect becomes arcs");
});

test("path transform scales and translates absolute coordinates only", () => {
  const out = transformPathData("M12 2L12 22", { sx: 2, sy: 2, tx: 100, ty: 50 });
  assert.equal(out, "M 124 54 L 124 94");

  // A leading relative moveto is absolute per the SVG spec, so it must be
  // translated; following relative commands only scale.
  const leading = transformPathData("m1 1l2 2", { sx: 2, sy: 2, tx: 100, ty: 50 });
  assert.equal(leading, "M 102 52 l 4 4");

  // Mid-path relative movetos stay relative (no translation).
  const mid = transformPathData("M0 0m2 2", { sx: 2, sy: 2, tx: 100, ty: 50 });
  assert.equal(mid, "M 100 50 m 4 4");
});

// ------------------------------------------------------------ XD insertion ---

function fakeLink() {
  const calls: Array<{ op: string; params: Record<string, unknown> }> = [];
  return {
    calls,
    execute: async (op: string, params: Record<string, unknown>) => {
      calls.push({ op, params });
      return { ok: true, result: { ok: true, queued: true, op, pending: 1 } };
    },
    isConnected: () => true,
    status: { listening: true, port: 27183, xdConnected: true, pendingRequests: 0, pluginInfo: {}, lastEvent: null },
    pluginInfo: {},
    lastEvent: null,
  };
}

function payload(result: { content: Array<{ type: string; text?: string }> }) {
  const block = result.content.find((c) => c.type === "text");
  assert.ok(block?.text, "tool returned text content");
  return JSON.parse(block!.text);
}

test("design_asset_insert queues editable Path operations at the requested position", async () => {
  const { svc } = serviceWith({ ".svg": SETTINGS_SVG });
  setAssetService(svc);
  const link = fakeLink();
  const tools = buildTools(link as never);

  const res = await tools.design_asset_insert.handler({ id: "iconify:lucide:settings", parent: "artboard-guid", x: 100, y: 50, size: 24, color: "#1B6BEF" });
  const body = payload(res as never);
  assert.equal(body.ok, true);
  assert.equal(body.operations, 2, "path + circle become two editable paths");

  const call = link.calls.find((c) => c.op === "execute_batch");
  assert.ok(call, "queued through the existing execute_batch path");
  const ops = (call!.params as { operations: Array<Record<string, any>> }).operations;
  assert.equal(ops[0].op, "create_path");
  assert.equal(ops[0].position, "absolute");
  assert.equal(ops[0].parent, "artboard-guid");
  assert.equal(ops[0].style.fill, "#00000000", "stroke-only icon must not gain a solid fill");
  assert.equal(ops[0].style.stroke, "#1B6BEF");
  assert.match(ops[0].pathData, /^M 112 65/, "geometry translated into artboard coordinates");
});

test("design_asset_get returns metadata and refuses metadata-only categories", async () => {
  const { svc } = serviceWith({ ".svg": SETTINGS_SVG });
  setAssetService(svc);
  const tools = buildTools(fakeLink() as never);

  const icon = payload((await tools.design_asset_get.handler({ id: "iconify:lucide:settings" })) as never);
  assert.equal(icon.ok, true);
  assert.equal(icon.vector.shapes, 2);
  assert.equal(icon.svg, undefined, "raw svg is not returned unless requested");

  const font = payload((await tools.design_asset_get.handler({ id: "google-fonts:inter" })) as never);
  assert.equal(font.ok, false);
  assert.equal(font.code, "metadata_only");

  const missing = payload((await tools.design_asset_inspect.handler({ id: "nope:nothing" })) as never);
  assert.equal(missing.ok, false);
});

test("design_asset_license reports production safety", async () => {
  const { svc } = serviceWith({});
  setAssetService(svc);
  const tools = buildTools(fakeLink() as never);

  const safe = payload((await tools.design_asset_license.handler({ identifier: "lucide" })) as never);
  assert.equal(safe.ok, true);
  assert.equal(safe.license.commercial_use, "yes");
  assert.equal(safe.safe_for_production, true);

  const unknown = payload((await tools.design_asset_license.handler({ identifier: "nothing-here" })) as never);
  assert.equal(unknown.ok, false);
});

test("design_context_set persists and feeds search ranking", async () => {
  const dir = tempDir();
  const svc = new AssetService({ cacheDir: dir, fetcher: async () => "" });
  setAssetService(svc);
  const tools = buildTools(fakeLink() as never);

  const set = payload((await tools.design_context_set.handler({ typography: "Inter", icon_style: "outline", language: "English" })) as never);
  assert.equal(set.ok, true);
  assert.equal(set.context.typography, "Inter");

  const got = payload((await tools.design_context_get.handler({})) as never);
  assert.equal(got.context.icon_style, "outline");

  const store = new DesignContextStore(join(dir, "design-context.json"));
  assert.equal(store.get().typography, "Inter", "context is persisted to disk");

  const cleared = payload((await tools.design_context_set.handler({ clear: true })) as never);
  assert.deepEqual(cleared.context, {});
});

test("design_asset_recommend returns a coherent set with consistency warnings", async () => {
  const { svc } = serviceWith({
    "api.iconify.design/search": JSON.stringify({ icons: ["lucide:layout-dashboard", "ph:squares-four"] }),
  });
  setAssetService(svc);
  const tools = buildTools(fakeLink() as never);

  const body = payload((await tools.design_asset_recommend.handler({
    product: "project management SaaS",
    screen: "empty project state",
    style: "modern minimal professional",
    language: "English",
  })) as never);

  assert.equal(body.ok, true);
  assert.equal(body.recommendations.length, 3);
  assert.ok(body.recommendations.every((r: any) => Array.isArray(r.reasons) && r.reasons.length > 0));
  assert.ok(body.notes.some((n: string) => /icon family/i.test(n)), "warns about mixing icon families");
});

test("list_sources and list_categories expose integration reality", async () => {
  setAssetService(serviceWith({}).svc);
  const tools = buildTools(fakeLink() as never);
  const sources = payload((await tools.design_asset_list_sources.handler({})) as never);
  assert.ok(sources.sources.some((s: any) => s.id === "lucide" && s.kind === "api"));
  assert.ok(sources.sources.some((s: any) => s.id === "undraw" && s.kind === "reference"));

  const cats = payload((await tools.design_asset_list_categories.handler({})) as never);
  assert.ok(cats.categories.some((c: any) => c.category === "icon"));
  assert.ok(cats.categories.some((c: any) => c.category === "illustration" && c.note));
});
