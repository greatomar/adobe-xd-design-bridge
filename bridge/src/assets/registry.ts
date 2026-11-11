/**
 * Curated registry content.
 *
 * Icons, logos and fonts are resolved live from official APIs (Iconify,
 * Google Fonts) and cached; everything else is curated knowledge that the agent
 * can reason about. Nothing here is auto-downloaded unless its source is
 * `api` / `download` / `package`.
 */
import type { AssetRecord, AssetFormat, LicenseInfo } from "./types.ts";

const OFL: LicenseInfo = {
  name: "SIL Open Font License 1.1",
  spdx: "OFL-1.1",
  commercial_use: "yes",
  attribution_required: false,
  redistribution_allowed: "yes",
  url: "https://openfontlicense.org/",
};

export interface FontSeed {
  family: string;
  weights: number[];
  styles: string[];
  subsets: string[];
  arabic: boolean;
  character: string;
  recommended_for: string[];
  avoid_for: string[];
  keywords: string[];
  license: LicenseInfo;
  source: "google-fonts";
}

/**
 * Typography guidance. `recommended_for` describes fit, not rules: the agent
 * should treat these as hints and keep a screen inside one family.
 */
export const FONT_SEEDS: FontSeed[] = [
  {
    family: "Inter", weights: [400, 500, 600, 700], styles: ["normal", "italic"],
    subsets: ["latin", "latin-ext", "cyrillic", "greek"], arabic: false,
    character: "Neutral, highly legible UI grotesque with tall x-height; excellent numerals.",
    recommended_for: ["SaaS", "dashboard", "data tables", "product UI", "documentation"],
    avoid_for: ["editorial display", "playful consumer brands"],
    keywords: ["ui", "neutral", "legible", "modern", "technical", "screen"],
    license: OFL, source: "google-fonts",
  },
  {
    family: "Geist", weights: [400, 500, 600, 700], styles: ["normal"],
    subsets: ["latin"], arabic: false,
    character: "Vercel's geometric-neutral UI face; precise, slightly technical.",
    recommended_for: ["developer tools", "modern SaaS", "dashboard", "dark UI"],
    avoid_for: ["warm consumer apps", "print"],
    keywords: ["modern", "technical", "geometric", "developer", "minimal"],
    license: OFL, source: "google-fonts",
  },
  {
    family: "Manrope", weights: [400, 500, 600, 700, 800], styles: ["normal"],
    subsets: ["latin", "latin-ext", "cyrillic"], arabic: false,
    character: "Rounded geometric sans, friendly but still professional.",
    recommended_for: ["SaaS", "fintech", "modern product", "marketing"],
    avoid_for: ["dense data grids", "legal documents"],
    keywords: ["friendly", "geometric", "modern", "rounded", "product"],
    license: OFL, source: "google-fonts",
  },
  {
    family: "DM Sans", weights: [400, 500, 700], styles: ["normal", "italic"],
    subsets: ["latin", "latin-ext"], arabic: false,
    character: "Low-contrast geometric sans with generous spacing; airy.",
    recommended_for: ["marketing", "editorial", "modern web", "light UI"],
    avoid_for: ["very dense tables"],
    keywords: ["clean", "airy", "geometric", "editorial", "friendly"],
    license: OFL, source: "google-fonts",
  },
  {
    family: "Plus Jakarta Sans", weights: [400, 500, 600, 700, 800], styles: ["normal", "italic"],
    subsets: ["latin", "latin-ext", "vietnamese"], arabic: false,
    character: "Modern geometric with slightly condensed caps; confident headings.",
    recommended_for: ["modern SaaS", "startup brand", "landing page", "dashboard"],
    avoid_for: ["long-form reading"],
    keywords: ["modern", "confident", "geometric", "startup", "heading"],
    license: OFL, source: "google-fonts",
  },
  {
    family: "IBM Plex Sans", weights: [400, 500, 600, 700], styles: ["normal", "italic"],
    subsets: ["latin", "latin-ext", "cyrillic", "greek"], arabic: false,
    character: "Corporate humanist with engineering undertones; excellent small sizes.",
    recommended_for: ["enterprise", "corporate", "government", "technical documentation"],
    avoid_for: ["playful consumer", "luxury"],
    keywords: ["corporate", "enterprise", "technical", "humanist", "trustworthy"],
    license: OFL, source: "google-fonts",
  },
  {
    family: "Space Grotesk", weights: [400, 500, 600, 700], styles: ["normal"],
    subsets: ["latin", "latin-ext", "vietnamese"], arabic: false,
    character: "Quirky proportional grotesque; strong personality in display sizes.",
    recommended_for: ["creative", "portfolio", "experimental brand", "headlines"],
    avoid_for: ["dense UI", "body copy", "enterprise tables"],
    keywords: ["creative", "distinctive", "display", "quirky", "bold"],
    license: OFL, source: "google-fonts",
  },
  {
    family: "Montserrat", weights: [400, 500, 600, 700, 800], styles: ["normal", "italic"],
    subsets: ["latin", "latin-ext", "cyrillic", "vietnamese"], arabic: false,
    character: "Geometric urban sans; wide, confident, marketing-oriented.",
    recommended_for: ["marketing", "brand", "headlines", "presentations"],
    avoid_for: ["body text at small sizes", "dense analytics"],
    keywords: ["geometric", "bold", "marketing", "urban", "headline"],
    license: OFL, source: "google-fonts",
  },
  {
    family: "Poppins", weights: [400, 500, 600, 700], styles: ["normal", "italic"],
    subsets: ["latin", "latin-ext", "devanagari"], arabic: false,
    character: "Pure geometric with circular forms; very friendly.",
    recommended_for: ["consumer apps", "marketing", "education", "social"],
    avoid_for: ["enterprise dashboards", "legal"],
    keywords: ["geometric", "friendly", "consumer", "rounded", "popular"],
    license: OFL, source: "google-fonts",
  },
  {
    family: "Noto Sans", weights: [400, 500, 600, 700], styles: ["normal", "italic"],
    subsets: ["latin", "latin-ext", "cyrillic", "greek", "vietnamese"], arabic: false,
    character: "Pan-lingual neutral UI sans with enormous glyph coverage.",
    recommended_for: ["internationalisation", "government", "accessibility", "multi-script"],
    avoid_for: ["brand expression"],
    keywords: ["universal", "coverage", "neutral", "accessible", "i18n"],
    license: OFL, source: "google-fonts",
  },
  {
    family: "Noto Sans Arabic", weights: [400, 500, 600, 700], styles: ["normal"],
    subsets: ["arabic"], arabic: true,
    character: "Arabic companion to Noto Sans; matched metrics for bilingual UI.",
    recommended_for: ["Arabic UI", "RTL", "government", "bilingual product"],
    avoid_for: ["Latin-only marketing"],
    keywords: ["arabic", "rtl", "bilingual", "neutral", "accessible"],
    license: OFL, source: "google-fonts",
  },
  {
    family: "Noto Kufi Arabic", weights: [400, 500, 600, 700], styles: ["normal"],
    subsets: ["arabic"], arabic: true,
    character: "Geometric Kufi with strong horizontal rhythm; confident Arabic display.",
    recommended_for: ["Arabic headings", "RTL brand", "government", "editorial Arabic"],
    avoid_for: ["long Arabic body copy"],
    keywords: ["arabic", "kufi", "geometric", "heading", "rtl"],
    license: OFL, source: "google-fonts",
  },
];

export interface ComponentPattern {
  id: string;
  name: string;
  system: string;
  category: "component";
  tags: string[];
  description: string;
  states: string[];
  guidance: string[];
  sourceUrl: string;
}

/** Design-system knowledge, not code to copy. */
export const COMPONENT_PATTERNS: ComponentPattern[] = [
  {
    id: "shadcn:button", name: "Button", system: "shadcn/ui", category: "component",
    tags: ["button", "action", "primary", "secondary"],
    description: "Neutral bordered button with 6-8px radius, 32/40px heights, 500 weight label.",
    states: ["default", "hover", "focus-visible", "disabled", "loading"],
    guidance: ["One primary action per view.", "Keep 2px+ focus ring contrast against the surface.", "Minimum 40px height for touch."],
    sourceUrl: "https://ui.shadcn.com/docs/components/button",
  },
  {
    id: "shadcn:input", name: "Input", system: "shadcn/ui", category: "component",
    tags: ["input", "form", "text field", "validation"],
    description: "Bordered field with label above, helper text below, inline error state.",
    states: ["default", "focus", "invalid", "disabled", "read-only"],
    guidance: ["Always pair with a visible label.", "Error text replaces helper text, never stacks both."],
    sourceUrl: "https://ui.shadcn.com/docs/components/input",
  },
  {
    id: "radix:dialog", name: "Dialog", system: "Radix UI", category: "component",
    tags: ["dialog", "modal", "overlay", "confirmation"],
    description: "Centred modal with scrim, focus trap and escape dismissal.",
    states: ["open", "closing", "destructive"],
    guidance: ["Trap focus; restore it on close.", "Use for decisions, not for passive info."],
    sourceUrl: "https://www.radix-ui.com/primitives/docs/components/dialog",
  },
  {
    id: "radix:select", name: "Select", system: "Radix UI", category: "component",
    tags: ["select", "dropdown", "combobox", "menu"],
    description: "Trigger + popover listbox with typeahead and keyboard navigation.",
    states: ["closed", "open", "selected", "disabled"],
    guidance: ["Show a check on the selected row.", "Never nest a select inside a scrollable card without a boundary."],
    sourceUrl: "https://www.radix-ui.com/primitives/docs/components/select",
  },
  {
    id: "material3:card", name: "Card", system: "Material 3", category: "component",
    tags: ["card", "surface", "container"],
    description: "Elevated or filled surface with 12-16px radius and 16-24px padding.",
    states: ["resting", "hover", "dragged"],
    guidance: ["Elevation communicates hierarchy; do not stack three levels."],
    sourceUrl: "https://m3.material.io/components/cards/overview",
  },
  {
    id: "mui:data-table", name: "Data table", system: "MUI", category: "component",
    tags: ["table", "data grid", "rows", "sorting", "pagination"],
    description: "Header row with sort affordances, zebra-free row separators, sticky header.",
    states: ["sorted", "selected", "empty", "loading", "error"],
    guidance: ["Right-align numerics, left-align text.", "Row height 44-52px for density; keep to one font family."],
    sourceUrl: "https://mui.com/material-ui/react-table/",
  },
  {
    id: "antd:form", name: "Form", system: "Ant Design", category: "component",
    tags: ["form", "validation", "fields", "layout"],
    description: "Vertical label/field stack with inline validation and grouped sections.",
    states: ["pristine", "validating", "invalid", "submitted"],
    guidance: ["Group related fields.", "Validate on blur, not on every keystroke."],
    sourceUrl: "https://ant.design/components/form",
  },
  {
    id: "radix:tabs", name: "Tabs", system: "Radix UI", category: "component",
    tags: ["tabs", "segmented", "navigation"],
    description: "Horizontal tablist with underline or pill indicator.",
    states: ["active", "inactive", "focus", "disabled"],
    guidance: ["Keep 3-5 tabs.", "Do not use tabs for sequential steps."],
    sourceUrl: "https://www.radix-ui.com/primitives/docs/components/tabs",
  },
  {
    id: "shadcn:sidebar", name: "Sidebar", system: "shadcn/ui", category: "component",
    tags: ["sidebar", "navigation", "rail", "app shell"],
    description: "Persistent 240-280px rail with section labels and an active indicator.",
    states: ["expanded", "collapsed", "mobile-overlay"],
    guidance: ["One active item.", "Icons optional; labels always present."],
    sourceUrl: "https://ui.shadcn.com/docs/components/sidebar",
  },
  {
    id: "material3:empty-state", name: "Empty state", system: "Material 3", category: "component",
    tags: ["empty state", "zero data", "onboarding", "illustration"],
    description: "Centred icon or illustration, one-line explanation, single primary action.",
    states: ["no-data", "no-results", "error"],
    guidance: ["Explain what will appear here.", "Exactly one action."],
    sourceUrl: "https://m3.material.io/components",
  },
  {
    id: "mui:pagination", name: "Pagination", system: "MUI", category: "component",
    tags: ["pagination", "pager", "page size"],
    description: "Prev/next with page numbers and a page-size selector.",
    states: ["first", "middle", "last", "disabled"],
    guidance: ["Show total count next to the control."],
    sourceUrl: "https://mui.com/material-ui/react-pagination/",
  },
  {
    id: "antd:alert", name: "Alert", system: "Ant Design", category: "component",
    tags: ["alert", "banner", "toast", "feedback"],
    description: "Inline banner with intent colour, icon and optional action.",
    states: ["info", "success", "warning", "error", "dismissed"],
    guidance: ["Colour alone must not carry meaning; include an icon or label."],
    sourceUrl: "https://ant.design/components/alert",
  },
  {
    id: "shadcn:chart", name: "Data visualisation", system: "shadcn/ui", category: "component",
    tags: ["chart", "graph", "sparkline", "dashboard", "metric"],
    description: "Card-wrapped chart with muted grid, single accent series, right-aligned axis labels.",
    states: ["loading", "populated", "empty"],
    guidance: ["One accent colour per series set.", "Grid lines at 1px, 6-10% contrast against the surface."],
    sourceUrl: "https://ui.shadcn.com/docs/components/chart",
  },
];

/** Categories whose sources are reference-only; the agent must not fabricate them. */
export const REFERENCE_ONLY_GUIDANCE: Record<string, string> = {
  illustration: "No illustration source exposes a licensed public API. Use illustration guidance, or insert a vector you can legally obtain; never scrape unDraw/DrawKit.",
  "3d": "3D asset licensing could not be verified programmatically. Treat as reference; do not auto-download.",
  motion: "Adobe XD cannot play Lottie/Rive. Represent motion as a static poster frame plus an interaction note.",
  photo: "Stock APIs require a user key. Ask before using photos, and only when they carry real content.",
  background: "Generate backgrounds locally as SVG (mesh/grid/noise) instead of downloading them.",
  mockup: "Mockup tools are browser/commercial apps with no public API. Use the user's own exports.",
};

export function fontSeedsToRecords(): AssetRecord[] {
  return FONT_SEEDS.map((f) => ({
    id: `google-fonts:${f.family.toLowerCase().replace(/\s+/g, "-")}`,
    name: f.family,
    category: "font" as const,
    source: "Google Fonts",
    sourceId: "google-fonts",
    type: "font-family",
    format: ["woff2", "ttf"] as AssetFormat[],
    style: [f.arabic ? "arabic" : "latin", ...(f.arabic ? ["rtl"] : [])],
    tags: ["font", "typography", ...(f.arabic ? ["arabic", "rtl"] : [])],
    keywords: f.keywords,
    description: f.character,
    variants: f.weights.map((w) => ({ name: String(w), weight: w, format: "woff2" as const })),
    license: f.license,
    recommended_for: f.recommended_for,
    avoid_for: f.avoid_for,
    meta: { family: f.family, weights: f.weights, styles: f.styles, subsets: f.subsets, arabic: f.arabic },
  }));
}

export function componentRecords(): AssetRecord[] {
  const SYSTEM_IDS: Record<string, string> = {
    "shadcn/ui": "shadcn",
    "Radix UI": "radix",
    "Material 3": "material3",
    MUI: "mui",
    "Ant Design": "antd",
    "Untitled UI": "untitled-ui",
  };
  return COMPONENT_PATTERNS.map((c) => ({
    id: c.id,
    name: c.name,
    category: "component" as const,
    source: c.system,
    sourceId: SYSTEM_IDS[c.system] ?? c.system.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    type: "pattern",
    format: ["json"] as AssetFormat[],
    style: ["design-system"],
    tags: c.tags,
    keywords: c.tags,
    description: c.description,
    variants: c.states.map((s) => ({ name: s, format: "json" as const })),
    license: { name: "Reference (see source)", commercial_use: "varies", attribution_required: false, redistribution_allowed: "no", url: c.sourceUrl },
    sourceUrl: c.sourceUrl,
    recommended_for: ["ui", "design system", "patterns"],
    avoid_for: ["copying implementation code verbatim"],
    meta: { states: c.states, guidance: c.guidance },
  }));
}
