/**
 * Asset service — the single entry point the MCP tools call.
 *
 * Responsibilities: registry assembly, live icon lookup (Iconify), caching,
 * licensing gates and recommendations. It performs no XD operations.
 */
import { AssetCache } from "./cache.ts";
import { COMPONENT_PATTERNS, FONT_SEEDS, REFERENCE_ONLY_GUIDANCE, componentRecords, fontSeedsToRecords } from "./registry.ts";
import { SOURCES, sourceById } from "./sources.ts";
import { licenseAllowed, searchAssets, tokenize } from "./search.ts";
import type {
  AssetCategory, AssetFormat, AssetRecord, AssetServiceOptions, AssetSource,
  Fetcher, LicenseInfo, Recommendation, RecommendationRequest, ScoredAsset, SearchQuery,
} from "./types.ts";

const DEFAULT_TIMEOUT = 15_000;

const defaultFetcher: Fetcher = async (url, init) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init?.timeoutMs ?? DEFAULT_TIMEOUT);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: "image/svg+xml,application/json;q=0.9,*/*;q=0.5" } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
};

const ICON_STYLES: Record<string, string[]> = {
  lucide: ["outline", "modern", "product-ui", "minimal"],
  ph: ["outline", "modern", "flexible"],
  tabler: ["outline", "dashboard", "dense"],
  heroicons: ["outline", "solid", "tailwind"],
  "material-symbols": ["filled", "outline", "material"],
  "simple-icons": ["brand", "solid"],
};

const humanize = (name: string): string =>
  name.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();

export class AssetService {
  readonly cache: AssetCache;
  private fetcher: Fetcher;
  private records: AssetRecord[];
  private iconIndex = new Map<string, AssetRecord>();

  /** Icon families the bridge understands well enough to recommend coherently. */
  static readonly ICON_PREFIXES = ["lucide", "ph", "tabler", "heroicons", "material-symbols", "simple-icons"];

  constructor(opts: AssetServiceOptions) {
    this.cache = new AssetCache(opts.cacheDir);
    this.fetcher = opts.fetcher ?? defaultFetcher;
    this.records = [
      ...fontSeedsToRecords(),
      ...componentRecords(),
      ...(opts.extraRegistry ?? []),
    ];
  }

  listCategories(): Array<{ category: AssetCategory; sources: number; note?: string }> {
    const cats = new Set<AssetCategory>(SOURCES.flatMap((s) => s.categories));
    for (const r of this.records) cats.add(r.category);
    return [...cats].sort().map((category) => ({
      category,
      sources: SOURCES.filter((s) => s.categories.includes(category)).length,
      note: REFERENCE_ONLY_GUIDANCE[category],
    }));
  }

  listSources(filter: { category?: AssetCategory; kind?: AssetSource["kind"] } = {}): AssetSource[] {
    return SOURCES.filter((s) => (!filter.category || s.categories.includes(filter.category)) && (!filter.kind || s.kind === filter.kind));
  }

  /** All locally known records (no network). */
  allRecords(): AssetRecord[] {
    return [...this.records, ...this.iconIndex.values()];
  }

  private iconRecord(iconId: string): AssetRecord {
    const [prefix, name] = iconId.split(":");
    const source = SOURCES.find((s) => s.iconifyPrefix === prefix);
    const style = ICON_STYLES[prefix] ?? ["outline"];
    const record: AssetRecord = {
      id: `iconify:${iconId}`,
      name: humanize(name ?? iconId),
      category: prefix === "simple-icons" ? "logo" : "icon",
      source: source?.name ?? "Iconify",
      sourceId: source?.id ?? "iconify",
      type: "svg-icon",
      format: ["svg"],
      style,
      tags: [prefix ?? "icon", ...style, ...tokenize(name ?? "").slice(0, 4)],
      keywords: tokenize(name ?? ""),
      description: `${humanize(name ?? iconId)} icon from ${source?.name ?? prefix}. Vector SVG, editable as XD Path nodes.`,
      variants: [{ name: "default", format: "svg" as AssetFormat }],
      license: source?.license ?? {
        name: "Per-collection (Iconify)", commercial_use: "varies", attribution_required: false,
        redistribution_allowed: "varies", url: "https://iconify.design/docs/icon-sets/", uncertain: true,
      },
      sourceUrl: `https://icon-sets.iconify.design/${prefix}/`,
      recommended_for: ["ui", "icons", "interface"],
      avoid_for: [],
      meta: { prefix, icon: name },
    };
    this.iconIndex.set(record.id, record);
    return record;
  }

  /**
   * Searches curated records first, then Iconify for icon/logo queries.
   * Network failures degrade to the local registry instead of throwing.
   */
  async search(q: SearchQuery): Promise<{ results: ScoredAsset[]; degraded?: string }> {
    const local = searchAssets(this.records, q);
    const wantsIcons = !q.category || q.category === "icon" || q.category === "logo";
    const queryTokens = tokenize(q.query || "");
    if (!wantsIcons || queryTokens.length === 0) return { results: local };

    try {
      const icons = await this.iconifySearch(q.query!, q.limit ?? 12);
      const prefixFilter = q.source ? sourceById(q.source)?.iconifyPrefix : undefined;
      const records = icons
        .filter((id) => AssetService.ICON_PREFIXES.some((p) => id.startsWith(p + ":")))
        .filter((id) => !prefixFilter || id.startsWith(prefixFilter + ":"))
        .filter((id) => (q.category === "logo" ? id.startsWith("simple-icons:") : true))
        .map((id) => {
          const existing = [...this.iconIndex.values()].find((r) => r.meta?.prefix + ":" + r.meta?.icon === id);
          return existing ?? this.iconRecord(id);
        })
        .filter((record) => licenseAllowed(record, q.license));
      const remote = records.map((rec, idx) => {
        const lexical = searchAssets([rec], { ...q, limit: 1 })[0];
        // Iconify already performed the semantic match; keep its ordering signal
        // instead of discarding an icon just because the query words are absent
        // from its name ("settings" -> sliders-horizontal).
        const prefix = String(rec.meta?.prefix ?? "");
        const FAMILY_BOOST: Record<string, number> = { lucide: 8, ph: 6, tabler: 5, heroicons: 4, "material-symbols": 2 };
        const familyBoost = FAMILY_BOOST[prefix] ?? 0;
        const providerScore = Math.max(5, 30 - idx * 2) + familyBoost;
        return {
          asset: rec,
          score: (lexical?.score ?? 0) + providerScore,
          reasons: [...(lexical?.reasons ?? []), `Iconify ranks this result #${idx + 1} for "${q.query}"`],
        };
      });
      const merged = [...local, ...remote].sort((a, b) => b.score - a.score);
      const seen = new Set<string>();
      return { results: merged.filter((r) => (seen.has(r.asset.id) ? false : (seen.add(r.asset.id), true))).slice(0, q.limit ?? 10) };
    } catch (e) {
      return { results: local, degraded: `Iconify unavailable (${String((e as Error).message || e)}); returned local registry results only` };
    }
  }

  private async iconifySearch(query: string, limit: number): Promise<string[]> {
    const attempt = async (q: string): Promise<string[]> => {
      const key = `iconify:search:v2:${q.toLowerCase()}:${limit}`;
      const cached = this.cache.read(key);
      let raw: string;
      if (cached) {
        raw = cached.content;
      } else {
        const prefixes = AssetService.ICON_PREFIXES.join(",");
        const url = `https://api.iconify.design/search?query=${encodeURIComponent(q)}&limit=${limit}&prefixes=${prefixes}`;
        raw = await this.fetcher(url);
        this.cache.write({ key, source: "iconify", assetId: `search-${q.slice(0, 40)}`, url: "https://api.iconify.design/search", license: "per-collection" }, raw, "json");
      }
      const parsed = JSON.parse(raw) as { icons?: string[] };
      return Array.isArray(parsed.icons) ? parsed.icons : [];
    };

    const direct = await attempt(query);
    if (direct.length) return direct;

    // Iconify matches single tokens: "settings gear" returns nothing, so fall
    // back to the individual terms and merge them in query order.
    const terms = tokenize(query).slice(0, 3);
    if (terms.length < 2) return direct;
    const merged: string[] = [];
    for (const term of terms) {
      for (const icon of await attempt(term)) if (!merged.includes(icon)) merged.push(icon);
      if (merged.length >= limit) break;
    }
    return merged;
  }

  async inspect(id: string): Promise<AssetRecord | null> {
    const local = this.records.find((r) => r.id === id) ?? this.iconIndex.get(id);
    if (local) return local;
    const parsed = this.parseIconId(id);
    if (parsed) return this.iconRecord(parsed);
    return null;
  }

  private parseIconId(id: string): string | null {
    const m = /^iconify:([a-z0-9-]+):([a-z0-9-]+)$/i.exec(id);
    return m ? `${m[1]}:${m[2]}` : null;
  }

  /** Fetches (and caches) an icon SVG. Returns null when the id is not a vector asset. */
  async get(id: string, color?: string): Promise<{ record: AssetRecord; svg: string; cachedPath: string } | null> {
    const record = await this.inspect(id);
    if (!record) return null;
    const iconId = this.parseIconId(id);
    if (!iconId) {
      const cached = this.cache.entry(id);
      if (cached) {
        const hit = this.cache.read(id);
        if (hit) return { record, svg: hit.content, cachedPath: hit.entry.file };
      }
      throw Object.assign(new Error(`${record.category} assets are metadata-only; use design_asset_search / design_asset_recommend`), { code: "metadata_only" });
    }

    const cached = this.cache.read(id);
    if (cached) return { record, svg: cached.content, cachedPath: cached.entry.file };

    // Documented Iconify endpoint is /<prefix>/<name>.svg (colon form is API-only).
    const [prefix, name] = iconId.split(":");
    const url = `https://api.iconify.design/${prefix}/${name}.svg`;
    const svg = await this.fetcher(url);
    const entry = this.cache.write(
      { key: id, source: record.sourceId, assetId: `${prefix}-${name}`, url, license: record.license.name },
      svg,
      "svg",
    );
    return { record, svg: color ? svg.split("currentColor").join(color) : svg, cachedPath: entry.file };
  }

  license(identifier: string): { source: AssetSource | null; license: LicenseInfo | null; record?: AssetRecord } {
    const byId = this.records.find((r) => r.id === identifier);
    if (byId) {
      const src = SOURCES.find((s) => s.id === byId.sourceId) ?? null;
      return { source: src, license: byId.license, record: byId };
    }
    const parsed = this.parseIconId(identifier);
    if (parsed) {
      const prefix = parsed.split(":")[0];
      const src = SOURCES.find((s) => s.iconifyPrefix === prefix) ?? null;
      return { source: src, license: src?.license ?? null };
    }
    const src = sourceById(identifier) ?? null;
    return { source: src, license: src?.license ?? null };
  }

  /** Higher-level: pick a coherent set of assets for a design requirement. */
  async recommend(req: RecommendationRequest): Promise<{ recommendations: Recommendation[]; notes: string[] }> {
    const notes: string[] = [];
    const ctx = req.context ?? {};
    const merged: SearchQuery["context"] = {
      ...ctx,
      product: req.product ?? ctx.product,
      visual_direction: req.style ?? ctx.visual_direction,
      language: req.language ?? ctx.language,
      platform: req.platform ?? ctx.platform,
    };
    const theme = req.theme && req.theme !== "any" ? ` ${req.theme} theme` : "";

    const iconQuery = [req.screen, req.style, "icon"].filter(Boolean).join(" ");
    const iconHit = await this.search({ query: iconQuery, category: "icon", limit: 5, context: merged, license: "commercial" });

    const fontQ = [req.style, req.language, "ui"].filter(Boolean).join(" ");
    const fontHit = await this.search({ query: fontQ, category: "font", limit: 5, context: merged });

    const compQ = [req.screen, req.product, "pattern"].filter(Boolean).join(" ");
    const compHit = await this.search({ query: compQ, category: "component", limit: 4, context: merged });

    const recommendations: Recommendation[] = [
      {
        category: "icon",
        asset: iconHit.results[0]?.asset ?? null,
        alternatives: iconHit.results.slice(1).map((r) => r.asset),
        reasons: iconHit.results[0]?.reasons ?? ["no matching icon found"],
      },
      {
        category: "font",
        asset: fontHit.results[0]?.asset ?? null,
        alternatives: fontHit.results.slice(1).map((r) => r.asset),
        reasons: fontHit.results[0]?.reasons ?? ["no matching font found"],
      },
      {
        category: "component",
        asset: compHit.results[0]?.asset ?? null,
        alternatives: compHit.results.slice(1).map((r) => r.asset),
        reasons: compHit.results[0]?.reasons ?? ["no matching pattern found"],
      },
    ];

    if (iconHit.results[0]) {
      const family = iconHit.results[0].asset.source;
      const mixed = iconHit.results.filter((r) => r.asset.source !== family).length;
      if (mixed > 0) notes.push(`Keep one icon family per screen: prefer ${family} and do not mix ${mixed} other families.`);
    }
    for (const [category, guidance] of Object.entries(REFERENCE_ONLY_GUIDANCE)) {
      if (/illustration|3d|motion|photo|background|mockup/.test(category)) notes.push(`${category}: ${guidance}`);
    }
    if (theme) notes.push(`Target theme:${theme}.`);
    return { recommendations, notes };
  }
}
