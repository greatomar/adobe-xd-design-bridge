/**
 * Semantic asset ranking.
 *
 * Deterministic and explainable: every score is paired with human-readable
 * reasons so the agent can justify a choice ("why this icon?"), which is the
 * difference between a search box and a design decision.
 */
import type { AssetRecord, DesignContext, ScoredAsset, SearchQuery } from "./types.ts";

const STOP = new Set(["a", "an", "the", "for", "of", "with", "and", "to", "in", "on", "my", "i", "is", "it", "that", "this"]);

export function tokenize(text: string): string[] {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9\u0600-\u06FF]+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

function overlap(a: string[], b: string[]): string[] {
  const set = new Set(b.map((x) => x.toLowerCase()));
  return a.filter((x) => set.has(x.toLowerCase()));
}

function contextTerms(ctx?: DesignContext): string[] {
  if (!ctx) return [];
  return tokenize(
    [ctx.product, ctx.visual_direction, ctx.icon_style, ctx.illustration_style, ctx.component_style, ctx.platform, ctx.audience, ctx.typography]
      .filter(Boolean)
      .join(" "),
  );
}

export function licenseAllowed(asset: AssetRecord, mode: SearchQuery["license"]): boolean {
  if (!mode || mode === "any") return true;
  const lic = asset.license;
  if (mode === "commercial") return !lic.uncertain && lic.commercial_use === "yes";
  // permissive: commercial use is explicitly allowed and terms are known
  return !lic.uncertain && lic.commercial_use === "yes";
}

export function scoreAsset(asset: AssetRecord, q: SearchQuery): ScoredAsset | null {
  if (q.category && asset.category !== q.category) return null;
  if (q.source && asset.sourceId !== q.source && asset.source.toLowerCase() !== q.source.toLowerCase()) return null;
  if (q.format && !asset.format.includes(q.format)) return null;
  if (q.style && !asset.style.some((s) => s.toLowerCase() === q.style!.toLowerCase())) return null;
  if (!licenseAllowed(asset, q.license)) return null;

  const reasons: string[] = [];
  let score = 0;

  const queryTokens = tokenize(q.query || "");
  const nameTokens = tokenize(asset.name);
  const haystack = [...asset.keywords, ...asset.tags, ...asset.style].map((s) => s.toLowerCase());
  const descriptionTokens = tokenize(asset.description);

  if (queryTokens.length === 0) {
    score += 5;
    reasons.push("listed without a text query");
  }

  const nameExact = q.query && asset.name.toLowerCase() === q.query.trim().toLowerCase();
  if (nameExact) {
    score += 60;
    reasons.push("exact name match");
  }

  const nameHits = overlap(queryTokens, nameTokens);
  if (nameHits.length) {
    score += Math.min(30, nameHits.length * 25);
    reasons.push(`name matches "${nameHits.join('", "')}"`);
  }

  const keyHits = overlap(queryTokens, haystack);
  if (keyHits.length) {
    score += Math.min(40, keyHits.length * 12);
    reasons.push(`keywords match "${keyHits.slice(0, 5).join('", "')}"`);
  }

  const descHits = overlap(queryTokens, descriptionTokens);
  if (descHits.length) {
    score += Math.min(12, descHits.length * 4);
    reasons.push("description is relevant");
  }

  // --- design-context consistency ---
  const ctx = q.context;
  if (ctx) {
    const terms = contextTerms(ctx);
    // Match on tokens, not whole phrases: "enterprise tables" must react to
    // an "enterprise" product, and "enterprise" must not be silently ignored.
    const fitVocabulary = tokenize([...asset.recommended_for, ...asset.style, ...asset.tags, ...asset.keywords].join(" "));
    const avoidVocabulary = tokenize(asset.avoid_for.join(" "));
    const fitHits = overlap(terms, fitVocabulary);
    if (fitHits.length) {
      score += Math.min(30, fitHits.length * 8);
      reasons.push(`fits the current design direction ("${fitHits.slice(0, 4).join('", "')}")`);
    }
    const mism = overlap(terms, avoidVocabulary);
    if (mism.length) {
      score -= 20;
      reasons.push(`conflicts with the current direction ("${mism.join('", "')}")`);
    }
    if (ctx.icon_style && asset.category === "icon" && overlap(tokenize(ctx.icon_style), asset.style).length) {
      score += 8;
      reasons.push(`matches the chosen icon style (${ctx.icon_style})`);
    }
    if (ctx.language && /arab|rtl/i.test(ctx.language) && asset.style.includes("arabic")) {
      score += 20;
      reasons.push("supports the target language");
    }
    if (ctx.typography && asset.category === "font" && asset.name.toLowerCase() === ctx.typography.toLowerCase()) {
      score += 25;
      reasons.push("is already the screen's typography choice");
    }
  }

  if (asset.license.uncertain) {
    score -= 25;
    reasons.push("license is uncertain — do not use in production without checking");
  }
  if (asset.license.attribution_required) {
    score -= 2;
    reasons.push("requires attribution");
  }

  if (score <= 0) return null;
  return { asset, score: Math.round(score * 100) / 100, reasons };
}

export function searchAssets(records: AssetRecord[], q: SearchQuery): ScoredAsset[] {
  const limit = Math.min(Math.max(q.limit ?? 10, 1), 50);
  const scored: ScoredAsset[] = [];
  for (const asset of records) {
    const hit = scoreAsset(asset, q);
    if (hit) scored.push(hit);
  }
  scored.sort((a, b) => b.score - a.score || a.asset.name.localeCompare(b.asset.name));
  return scored.slice(0, limit);
}
