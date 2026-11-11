/**
 * Source catalog.
 *
 * Every entry records what the bridge is actually allowed to do with the
 * source, not what would be convenient. `kind` is the integration contract:
 *
 *   api / api-key / package / download -> can be fetched automatically
 *   reference / manual                 -> design knowledge only, never fetched
 *
 * License data was taken from each project's published terms. Where the terms
 * could not be confirmed, `uncertain: true` is set and the bridge refuses to
 * auto-use the asset in production designs.
 */
import type { AssetSource } from "./types.ts";

const MIT = (url: string, name = "MIT"): AssetSource["license"] => ({
  name, spdx: "MIT", commercial_use: "yes", attribution_required: false,
  redistribution_allowed: "yes", url,
});

export const SOURCES: AssetSource[] = [
  // ---------------------------------------------------------------- icons ---
  {
    id: "lucide", name: "Lucide", categories: ["icon"], kind: "api",
    homepage: "https://lucide.dev", api: "https://api.iconify.design", iconifyPrefix: "lucide",
    license: { name: "ISC", spdx: "ISC", commercial_use: "yes", attribution_required: false, redistribution_allowed: "yes", url: "https://github.com/lucide-icons/lucide/blob/main/LICENSE" },
    notes: "Default recommendation for modern product UI: 1.5–2px outline, consistent 24px grid.",
  },
  {
    id: "phosphor", name: "Phosphor", categories: ["icon"], kind: "api",
    homepage: "https://phosphoricons.com", api: "https://api.iconify.design", iconifyPrefix: "ph",
    license: MIT("https://github.com/phosphor-icons/core/blob/main/LICENSE"),
    notes: "Six weights; use one weight family consistently across a screen.",
  },
  {
    id: "tabler", name: "Tabler Icons", categories: ["icon"], kind: "api",
    homepage: "https://tabler.io/icons", api: "https://api.iconify.design", iconifyPrefix: "tabler",
    license: MIT("https://github.com/tabler/tabler-icons/blob/main/LICENSE"),
    notes: "Stroke-first, very large set, good for dense dashboards.",
  },
  {
    id: "heroicons", name: "Heroicons", categories: ["icon"], kind: "api",
    homepage: "https://heroicons.com", api: "https://api.iconify.design", iconifyPrefix: "heroicons",
    license: MIT("https://github.com/tailwindlabs/heroicons/blob/master/LICENSE"),
    notes: "Outline + solid pairs designed together; strong with Tailwind-style products.",
  },
  {
    id: "material-symbols", name: "Material Symbols", categories: ["icon"], kind: "api",
    homepage: "https://fonts.google.com/icons", api: "https://api.iconify.design", iconifyPrefix: "material-symbols",
    license: { name: "Apache-2.0", spdx: "Apache-2.0", commercial_use: "yes", attribution_required: false, redistribution_allowed: "yes", url: "https://github.com/google/material-design-icons/blob/master/LICENSE" },
    notes: "Android/Material products. Variable weight, fill and grade axes.",
  },
  {
    id: "iconify", name: "Iconify", categories: ["icon", "logo"], kind: "api",
    homepage: "https://iconify.design", api: "https://api.iconify.design",
    license: { name: "Per-collection (aggregator)", commercial_use: "varies", attribution_required: false, redistribution_allowed: "varies", url: "https://iconify.design/docs/icon-sets/", notes: "Iconify serves 200+ sets; the license of the underlying set always applies." },
    notes: "Search and retrieval API used by this bridge. Per-set license is resolved per icon.",
  },

  // ---------------------------------------------------------------- logos ---
  {
    id: "simple-icons", name: "Simple Icons", categories: ["logo", "icon"], kind: "api",
    homepage: "https://simpleicons.org", api: "https://api.iconify.design", iconifyPrefix: "simple-icons",
    license: { name: "CC0 1.0", spdx: "CC0-1.0", commercial_use: "yes", attribution_required: false, redistribution_allowed: "yes", url: "https://github.com/simple-icons/simple-icons/blob/develop/LICENSE.md", notes: "Trademarks remain the property of their owners; use only to reference the brand." },
    notes: "Brand marks for integrations and partner cards.",
  },
  {
    id: "svgl", name: "SVGL", categories: ["logo"], kind: "reference",
    homepage: "https://svgl.app",
    license: MIT("https://github.com/pheralb/svgl/blob/main/LICENSE", "MIT (site code); logo trademarks vary"),
    notes: "No documented public API for assets; catalogued as a reference for brand marks.",
  },
  {
    id: "devicon", name: "Devicon", categories: ["logo"], kind: "download",
    homepage: "https://devicon.dev", api: "https://cdn.jsdelivr.net/gh/devicons/devicon/icons",
    license: MIT("https://github.com/devicons/devicon/blob/master/LICENSE"),
    notes: "Developer-tool marks via jsDelivr; used only when Simple Icons lacks the mark.",
  },

  // ---------------------------------------------------------------- fonts ---
  {
    id: "google-fonts", name: "Google Fonts", categories: ["font"], kind: "api",
    homepage: "https://fonts.google.com", api: "https://fonts.google.com/metadata/fonts",
    license: { name: "Per-family (OFL 1.1 / Apache-2.0)", commercial_use: "yes", attribution_required: false, redistribution_allowed: "yes", url: "https://fonts.google.com/", notes: "Each family ships its own OFL or Apache license; both allow commercial use and embedding." },
    notes: "Canonical metadata source for family, weights, styles and subsets (incl. Arabic).",
  },

  // ------------------------------------------------ components / systems ---
  {
    id: "shadcn", name: "shadcn/ui", categories: ["component"], kind: "reference",
    homepage: "https://ui.shadcn.com",
    license: MIT("https://github.com/shadcn-ui/ui/blob/main/LICENSE.md"),
    notes: "Pattern reference (composition + states), not a downloadable asset set.",
  },
  {
    id: "radix", name: "Radix UI", categories: ["component"], kind: "reference",
    homepage: "https://www.radix-ui.com",
    license: MIT("https://github.com/radix-ui/primitives/blob/main/LICENSE"),
    notes: "Accessibility semantics for dialogs, selects, menus, tabs.",
  },
  {
    id: "material3", name: "Material 3", categories: ["component"], kind: "reference",
    homepage: "https://m3.material.io",
    license: { name: "Apache-2.0", spdx: "Apache-2.0", commercial_use: "yes", attribution_required: false, redistribution_allowed: "yes", url: "https://github.com/material-components/material-components-web/blob/master/LICENSE" },
    notes: "Guideline reference for elevation, state layers, motion.",
  },
  {
    id: "mui", name: "MUI", categories: ["component"], kind: "reference",
    homepage: "https://mui.com",
    license: MIT("https://github.com/mui/material-ui/blob/master/LICENSE"),
    notes: "Dense enterprise data patterns: tables, toolbars, dialogs.",
  },
  {
    id: "antd", name: "Ant Design", categories: ["component"], kind: "reference",
    homepage: "https://ant.design",
    license: MIT("https://github.com/ant-design/ant-design/blob/master/LICENSE"),
    notes: "Complex forms and data-entry patterns.",
  },
  {
    id: "untitled-ui", name: "Untitled UI", categories: ["component"], kind: "manual",
    homepage: "https://www.untitledui.com",
    license: { name: "Untitled UI license (free tier)", commercial_use: "varies", attribution_required: false, redistribution_allowed: "no", url: "https://www.untitledui.com/license", notes: "Figma files only; free tier forbids redistributing the files as an asset pack." },
    notes: "Manual import only. High-quality desktop SaaS patterns.",
  },

  // ------------------------------------------------------- illustrations ---
  {
    id: "undraw", name: "unDraw", categories: ["illustration"], kind: "reference",
    homepage: "https://undraw.co",
    license: { name: "unDraw license", commercial_use: "yes", attribution_required: false, redistribution_allowed: "no", url: "https://undraw.co/license", notes: "Free to use and modify; reselling or redistributing the illustrations as-is is not allowed. No public API." },
    notes: "Recolourable flat illustrations; catalogue as reference, import by hand.",
  },
  {
    id: "drawkit", name: "DrawKit", categories: ["illustration"], kind: "reference",
    homepage: "https://www.drawkit.com",
    license: { name: "DrawKit license (free + premium)", commercial_use: "varies", attribution_required: false, redistribution_allowed: "no", url: "https://www.drawkit.com/license" },
    notes: "Mixed free/premium; verify per pack before use.",
  },
  {
    id: "humaaans", name: "Humaaans", categories: ["illustration", "avatar"], kind: "reference",
    homepage: "https://www.humaaans.com",
    license: { name: "CC0 1.0", spdx: "CC0-1.0", commercial_use: "yes", attribution_required: false, redistribution_allowed: "yes", url: "https://www.humaaans.com/" },
    notes: "Mix-and-match people. Figma/Sketch files only.",
  },
  {
    id: "openpeeps", name: "Open Peeps", categories: ["illustration", "avatar"], kind: "reference",
    homepage: "https://www.openpeeps.com",
    license: { name: "CC0 1.0", spdx: "CC0-1.0", commercial_use: "yes", attribution_required: false, redistribution_allowed: "yes", url: "https://www.openpeeps.com/" },
  },
  {
    id: "storyset", name: "Storyset", categories: ["illustration"], kind: "reference",
    homepage: "https://storyset.com",
    license: { name: "Freepik license", commercial_use: "varies", attribution_required: true, redistribution_allowed: "no", url: "https://www.freepik.com/legal/terms-of-use" },
    notes: "Attribution required on the free tier.",
  },
  {
    id: "manypixels", name: "ManyPixels", categories: ["illustration"], kind: "reference",
    homepage: "https://www.manypixels.co/gallery",
    license: { name: "ManyPixels license", commercial_use: "yes", attribution_required: true, redistribution_allowed: "no", url: "https://www.manypixels.co/gallery" },
  },

  // ------------------------------------------------------------------- 3d ---
  {
    id: "3dicons", name: "3Dicons", categories: ["3d"], kind: "reference",
    homepage: "https://3dicons.co",
    license: { name: "3Dicons license", commercial_use: "varies", attribution_required: false, redistribution_allowed: "no", url: "https://3dicons.co", uncertain: true, notes: "Terms not confirmable from a machine-readable source; treat as reference until verified." },
    notes: "Deliberately not auto-downloaded (uncertain license + heavy PNG renders).",
  },

  // -------------------------------------------------------------- avatars ---
  {
    id: "dicebear", name: "DiceBear", categories: ["avatar"], kind: "api",
    homepage: "https://www.dicebear.com", api: "https://api.dicebear.com/9.x",
    license: { name: "Per-style (mostly CC0 / MIT)", commercial_use: "yes", attribution_required: false, redistribution_allowed: "yes", url: "https://www.dicebear.com/licenses/", notes: "Each avatar style declares its own license; 'initials' and 'thumbs' are CC0." },
    notes: "Deterministic SVG avatars from a seed — ideal for realistic filler content.",
  },
  {
    id: "uifaces", name: "UI Faces", categories: ["avatar"], kind: "reference",
    homepage: "https://uifaces.co",
    license: { name: "UI Faces terms", commercial_use: "varies", attribution_required: true, redistribution_allowed: "no", url: "https://uifaces.co", uncertain: true },
    notes: "Requires API access and permission to use likenesses; not automated.",
  },

  // --------------------------------------------------------------- motion ---
  {
    id: "lottie", name: "LottieFiles", categories: ["motion"], kind: "reference",
    homepage: "https://lottiefiles.com",
    license: { name: "Per-asset Lottie Simple License", commercial_use: "varies", attribution_required: false, redistribution_allowed: "varies", url: "https://lottiefiles.com/page/license" },
    notes: "XD cannot play Lottie; represent motion as a poster frame + spec.",
  },
  {
    id: "rive", name: "Rive", categories: ["motion"], kind: "reference",
    homepage: "https://rive.app",
    license: { name: "Rive runtime MIT / assets vary", commercial_use: "varies", attribution_required: false, redistribution_allowed: "varies", url: "https://rive.app/legal/terms" },
    notes: "Interactive runtime assets; not supported by XD.",
  },

  // --------------------------------------------------------------- photos ---
  {
    id: "unsplash", name: "Unsplash", categories: ["photo"], kind: "api-key",
    homepage: "https://unsplash.com", api: "https://api.unsplash.com",
    license: { name: "Unsplash License", commercial_use: "yes", attribution_required: true, redistribution_allowed: "no", url: "https://unsplash.com/license", notes: "Attribution appreciated and required by the API guidelines; cannot compile a competing service." },
    notes: "Requires a user API key. Never auto-downloaded without one.",
  },
  {
    id: "pexels", name: "Pexels", categories: ["photo"], kind: "api-key",
    homepage: "https://www.pexels.com", api: "https://api.pexels.com",
    license: { name: "Pexels License", commercial_use: "yes", attribution_required: false, redistribution_allowed: "no", url: "https://www.pexels.com/license/" },
    notes: "Requires a user API key.",
  },

  // ---------------------------------------------------------- backgrounds ---
  {
    id: "haikei", name: "Haikei", categories: ["background"], kind: "reference",
    homepage: "https://haikei.app",
    license: { name: "Haikei license", commercial_use: "yes", attribution_required: false, redistribution_allowed: "no", url: "https://haikei.app" },
    notes: "Browser generator, no API. Equivalent output is produced locally as SVG.",
  },
  {
    id: "svgbackgrounds", name: "SVG Backgrounds", categories: ["background"], kind: "reference",
    homepage: "https://www.svgbackgrounds.com",
    license: { name: "Per-asset", commercial_use: "varies", attribution_required: true, redistribution_allowed: "no", url: "https://www.svgbackgrounds.com/license/" },
  },
  {
    id: "bgjar", name: "BGJar", categories: ["background"], kind: "reference",
    homepage: "https://bgjar.com",
    license: { name: "Free for commercial use", commercial_use: "yes", attribution_required: false, redistribution_allowed: "no", url: "https://bgjar.com" },
  },

  // -------------------------------------------------------------- mockups ---
  {
    id: "shots", name: "Shots", categories: ["mockup"], kind: "reference",
    homepage: "https://shots.so",
    license: { name: "Shots terms", commercial_use: "yes", attribution_required: false, redistribution_allowed: "no", url: "https://shots.so", uncertain: true },
    notes: "Browser tool; no documented public API.",
  },
  {
    id: "mockuuups", name: "Mockuuups Studio", categories: ["mockup"], kind: "manual",
    homepage: "https://mockuuups.studio",
    license: { name: "Commercial product license", commercial_use: "varies", attribution_required: false, redistribution_allowed: "no", url: "https://mockuuups.studio/license" },
  },
  {
    id: "figma-community", name: "Figma Community", categories: ["component", "illustration", "3d", "mockup"], kind: "manual",
    homepage: "https://www.figma.com/community",
    license: { name: "Per-resource (Figma Community terms)", commercial_use: "varies", attribution_required: true, redistribution_allowed: "no", url: "https://www.figma.com/community/terms", uncertain: true, notes: "No public API for Community files; each file carries its own license. Import manually, never scrape." },
  },
];

export function sourceById(id: string): AssetSource | undefined {
  return SOURCES.find((s) => s.id === id);
}

export const AUTOMATABLE_KINDS: AssetSource["kind"][] = ["api", "download", "package", "api-key"];
