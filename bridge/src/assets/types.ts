/**
 * Design Asset Intelligence — shared types.
 *
 * The asset layer is deliberately transport-agnostic: it never talks to XD
 * directly. MCP tools resolve assets here and then hand validated operations to
 * the existing Design Bridge queue.
 */

export type AssetCategory =
  | "icon"
  | "font"
  | "component"
  | "illustration"
  | "3d"
  | "avatar"
  | "logo"
  | "motion"
  | "photo"
  | "background"
  | "mockup";

export const ASSET_CATEGORIES: AssetCategory[] = [
  "icon", "font", "component", "illustration", "3d", "avatar",
  "logo", "motion", "photo", "background", "mockup",
];

/** How the bridge is allowed to obtain assets from a source. */
export type IntegrationKind =
  | "api"          // documented public HTTP API, no key
  | "api-key"      // documented API that requires a user-supplied key
  | "package"      // official npm package / CDN mirror
  | "download"     // official static file hosting
  | "reference"    // design knowledge only: never downloaded automatically
  | "manual";      // requires the user to import by hand

export type Tri = "yes" | "no" | "varies" | "unknown";

export interface LicenseInfo {
  /** human-readable license name, e.g. "MIT", "CC0 1.0", "OFL 1.1" */
  name: string;
  spdx?: string;
  commercial_use: Tri;
  attribution_required: boolean;
  redistribution_allowed: Tri;
  /** canonical license text or source page */
  url: string;
  /** true when the bridge could not confirm the terms and must not auto-use it */
  uncertain?: boolean;
  notes?: string;
}

export interface AssetSource {
  id: string;
  name: string;
  categories: AssetCategory[];
  kind: IntegrationKind;
  homepage: string;
  /** documented API base, when kind is api/api-key */
  api?: string;
  /** Iconify collection prefix, when the source is served through Iconify */
  iconifyPrefix?: string;
  license: LicenseInfo;
  notes?: string;
}

export type AssetFormat = "svg" | "png" | "json" | "woff2" | "ttf" | "lottie" | "rive" | "unknown";

export interface AssetVariant {
  name: string;
  /** weight/style label, e.g. "regular" | "bold" | "fill" | "duotone" */
  style?: string;
  weight?: number;
  format: AssetFormat;
  url?: string;
  cachedPath?: string;
}

export interface AssetRecord {
  /** "<source>:<name>" — stable across sessions */
  id: string;
  name: string;
  category: AssetCategory;
  source: string;
  sourceId: string;
  type: string;
  format: AssetFormat[];
  style: string[];
  tags: string[];
  keywords: string[];
  description: string;
  variants: AssetVariant[];
  license: LicenseInfo;
  sourceUrl?: string;
  cachedPath?: string;
  recommended_for: string[];
  avoid_for: string[];
  /** extra, category-specific metadata (font weights, subsets, etc.) */
  meta?: Record<string, unknown>;
}

export interface SearchQuery {
  query?: string;
  category?: AssetCategory;
  source?: string;
  style?: string;
  format?: AssetFormat;
  /** "permissive" excludes uncertain / non-commercial sources */
  license?: "any" | "permissive" | "commercial";
  limit?: number;
  /** optional design context used for consistency boosting */
  context?: DesignContext;
}

export interface ScoredAsset {
  asset: AssetRecord;
  score: number;
  reasons: string[];
}

export interface DesignContext {
  product?: string;
  visual_direction?: string;
  colors?: string[];
  typography?: string;
  icon_style?: string;
  illustration_style?: string;
  component_style?: string;
  radius?: number;
  density?: "compact" | "comfortable" | "spacious";
  platform?: "web" | "ios" | "android" | "desktop";
  audience?: string;
  language?: string;
  direction?: "ltr" | "rtl";
  accessibility?: string[];
}

export interface RecommendationRequest {
  product?: string;
  screen?: string;
  style?: string;
  theme?: "light" | "dark" | "any";
  language?: string;
  platform?: DesignContext["platform"];
  context?: DesignContext;
}

export interface Recommendation {
  category: AssetCategory;
  asset: AssetRecord | null;
  alternatives: AssetRecord[];
  reasons: string[];
}

export type Fetcher = (url: string, init?: { timeoutMs?: number }) => Promise<string>;

export interface AssetServiceOptions {
  cacheDir: string;
  fetcher?: Fetcher;
  now?: () => number;
  /** optional user registry overlay (JSON) merged over built-ins */
  extraRegistry?: AssetRecord[];
}
