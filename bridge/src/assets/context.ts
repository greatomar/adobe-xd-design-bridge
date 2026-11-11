/**
 * Persistent design context.
 *
 * The context is what keeps asset choices coherent across a session: once a
 * screen commits to Inter + 12px radii + outline icons, later asset searches
 * are ranked against those choices instead of starting from zero.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DesignContext } from "./types.ts";

export class DesignContextStore {
  readonly file: string;
  private cached: DesignContext | null = null;

  constructor(file: string) {
    this.file = file;
  }

  get(): DesignContext {
    if (this.cached) return this.cached;
    try {
      this.cached = existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as DesignContext) : {};
    } catch {
      this.cached = {};
    }
    return this.cached;
  }

  /** Shallow merge; arrays replace (palette edits should be explicit). */
  set(patch: DesignContext): DesignContext {
    const next: DesignContext = { ...this.get(), ...patch };
    for (const key of Object.keys(next) as Array<keyof DesignContext>) {
      if (next[key] === undefined || next[key] === null || next[key] === "") delete next[key];
    }
    this.cached = next;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(next, null, 2), "utf8");
    } catch {
      /* context persistence is best-effort */
    }
    return next;
  }

  clear(): void {
    this.cached = {};
    try {
      writeFileSync(this.file, "{}", "utf8");
    } catch {
      /* ignore */
    }
  }
}
