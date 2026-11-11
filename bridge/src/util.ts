/**
 * Shared utilities: logging, auth token management, color math, id generation.
 * AdobeXD-DesignBridge — private local integration. No network exposure.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BRIDGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const BRIDGE_DIR = dirname(BRIDGE_ROOT); // AdobeXD-DesignBridge/
export const EXPORT_DIR = join(BRIDGE_DIR, "exports");
export const TOKEN_FILE = join(BRIDGE_ROOT, ".bridge-token");
export const LOG_FILE = join(BRIDGE_ROOT, "bridge.log");

const MAX_LOG_BYTES = 2_000_000;

export function log(level: "info" | "warn" | "error" | "debug", msg: string, data?: unknown): void {
  const line =
    new Date().toISOString() +
    ` [${level}] ` +
    msg +
    (data !== undefined ? " " + safeJson(data) : "") +
    "\n";
  try {
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > MAX_LOG_BYTES) unlinkSync(LOG_FILE);
    appendFileSync(LOG_FILE, line);
  } catch {
    /* logging must never crash the bridge */
  }
  if (process.env.XD_BRIDGE_VERBOSE === "1" || level === "error") {
    process.stderr.write(line);
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Get or create the bridge auth token (file is created user-only on NTFS default ACL). */
export function getOrCreateToken(): string {
  const envToken = process.env.XD_BRIDGE_TOKEN;
  if (envToken && envToken.length >= 16) return envToken;
  if (existsSync(TOKEN_FILE)) {
    const t = readFileSync(TOKEN_FILE, "utf8").trim();
    if (t.length >= 16) return t;
  }
  const token = "xdbr-" + randomBytes(24).toString("base64url");
  try {
    writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  } catch (e) {
    log("error", "cannot persist token file; using ephemeral token for this run", String(e));
  }
  return token;
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

// ---------------------------------------------------------------------------
// Color utilities (WCAG contrast for accessibility checks)
// ---------------------------------------------------------------------------

export function parseColor(input: string): { r: number; g: number; b: number; a: number } | null {
  const hex = input.trim().replace(/^#/, "");
  let m: RegExpMatchArray | null;
  if ((m = hex.match(/^([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})?$/))) {
    return {
      r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16),
      a: m[4] ? parseInt(m[4], 16) / 255 : 1,
    };
  }
  if ((m = hex.match(/^([0-9a-fA-F]{3})([0-9a-fA-F]{3})?$/)) && !m[2]) {
    return {
      r: parseInt(m[1][0] + m[1][0], 16),
      g: parseInt(m[1][1] + m[1][1], 16),
      b: parseInt(m[1][2] + m[1][2], 16),
      a: 1,
    };
  }
  return null;
}

function relLuminance(r: number, g: number, b: number): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** WCAG contrast ratio between two hex colors, or null if unparseable. */
export function contrastRatio(a: string, b: string): number | null {
  const ca = parseColor(a);
  const cb = parseColor(b);
  if (!ca || !cb) return null;
  const la = relLuminance(ca.r, ca.g, ca.b);
  const lb = relLuminance(cb.r, cb.g, cb.b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

export function sha256(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

export function ensureDirs(): void {
  mkdirSync(EXPORT_DIR, { recursive: true });
}
