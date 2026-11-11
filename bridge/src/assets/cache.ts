/**
 * Project-local asset cache.
 *
 * Layout:  <cacheDir>/<source>/<asset>.<ext>
 *          <cacheDir>/manifest.json      (source url, sha256, license, fetch time)
 *
 * The cache never touches global system directories (no AppData\Roaming, no
 * temp sprawl beyond the bridge folder) and is fully configurable so a project
 * can keep its dependencies isolated.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { sha256 } from "../util.ts";

export interface CacheManifestEntry {
  key: string;
  source: string;
  assetId: string;
  url: string;
  file: string;
  sha256: string;
  bytes: number;
  fetchedAt: number;
  license: string;
}

const SAFE = /[^a-z0-9._-]+/g;

function safeSegment(value: string): string {
  return String(value)
    .toLowerCase()
    .replace(SAFE, "-")
    .replace(/\.{2,}/g, ".")      // never allow ".." sequences
    .replace(/^[.-]+|[.-]+$/g, "") // no leading/trailing dots or dashes
    .slice(0, 120) || "asset";
}

export class AssetCache {
  readonly dir: string;
  private manifestPath: string;
  private manifest: Record<string, CacheManifestEntry> | null = null;

  constructor(dir: string) {
    this.dir = dir;
    this.manifestPath = join(dir, "manifest.json");
    mkdirSync(dir, { recursive: true });
  }

  private load(): Record<string, CacheManifestEntry> {
    if (this.manifest) return this.manifest;
    try {
      this.manifest = existsSync(this.manifestPath)
        ? (JSON.parse(readFileSync(this.manifestPath, "utf8")) as Record<string, CacheManifestEntry>)
        : {};
    } catch {
      this.manifest = {};
    }
    return this.manifest;
  }

  private persist(): void {
    try {
      writeFileSync(this.manifestPath, JSON.stringify(this.load(), null, 2), "utf8");
    } catch {
      /* cache is best-effort; never fail a request over it */
    }
  }

  fileFor(source: string, assetId: string, ext: string): string {
    return join(this.dir, safeSegment(source), safeSegment(assetId).replace(/\.(svg|json|png)$/i, "") + "." + ext);
  }

  entry(key: string): CacheManifestEntry | null {
    return this.load()[key] ?? null;
  }

  /** Returns cached content only when the file still exists and matches the manifest hash. */
  read(key: string): { entry: CacheManifestEntry; content: string } | null {
    const entry = this.load()[key];
    if (!entry || !existsSync(entry.file)) return null;
    try {
      const content = readFileSync(entry.file, "utf8");
      if (sha256(content) !== entry.sha256) return null;
      return { entry, content };
    } catch {
      return null;
    }
  }

  /** Writes only when content changed; identical payloads are deduplicated by hash. */
  write(meta: { key: string; source: string; assetId: string; url: string; license: string }, content: string, ext = "svg"): CacheManifestEntry {
    const file = this.fileFor(meta.source, meta.assetId, ext);
    const hash = sha256(content);
    const existing = this.load()[meta.key];
    if (existing && existing.sha256 === hash && existsSync(existing.file)) return existing;

    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content, "utf8");
    const entry: CacheManifestEntry = {
      ...meta,
      file,
      sha256: hash,
      bytes: Buffer.byteLength(content, "utf8"),
      fetchedAt: Date.now(),
    };
    this.load()[meta.key] = entry;
    this.persist();
    return entry;
  }

  stats(): { dir: string; entries: number; bytes: number } {
    const m = this.load();
    let bytes = 0;
    for (const e of Object.values(m)) {
      try {
        if (existsSync(e.file)) bytes += statSync(e.file).size;
      } catch {
        /* ignore */
      }
    }
    return { dir: this.dir, entries: Object.keys(m).length, bytes };
  }

  /** Removes entries whose files disappeared (cache invalidation for manual deletions). */
  prune(): number {
    const m = this.load();
    let removed = 0;
    for (const [k, e] of Object.entries(m)) {
      if (!existsSync(e.file)) {
        delete m[k];
        removed++;
      }
    }
    if (removed) this.persist();
    return removed;
  }

  listSourcesOnDisk(): string[] {
    try {
      return readdirSync(this.dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return [];
    }
  }
}
