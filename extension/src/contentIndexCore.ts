// Pure core of the content-id linking — NO `vscode` import, so it runs in plain-Node unit
// tests. The VS Code-coupled I/O (load/save/resolve against the workspace) lives in
// contentIndex.ts, which re-exports these so callers have a single import surface.

import { createHash } from "node:crypto";

/** Number of hex chars kept from the SHA-256. MUST match `crop_helper.py hash --len`. */
export const CONTENT_ID_LEN = 16;

export const INDEX_VERSION = 1;
export const INDEX_NOTE =
  "Rebuildable cache: maps each PDF's workspace-relative path to the SHA-256 content id " +
  "BetaXiv keys its summaries/annotations by. Deterministic — safe to commit, delete, or " +
  "regenerate by re-hashing the PDFs.";

export interface IndexEntry {
  /** First CONTENT_ID_LEN hex chars of the PDF's SHA-256. */
  hash: string;
  /** PDF byte size — the cheap cache key that lets us skip re-hashing an unchanged file. */
  size: number;
  /** Human-readable title (from the summary), so a person browsing index.json can read it. */
  title?: string;
}

export interface ContentIndex {
  version: number;
  note: string;
  /** key: workspace-relative POSIX path of the PDF (e.g. "papers/attention.pdf"). */
  entries: Record<string, IndexEntry>;
}

/** The content id for a PDF's raw bytes — identical to `crop_helper.py hash`. */
export function contentIdFromBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, CONTENT_ID_LEN);
}

/**
 * Workspace-relative POSIX path of `targetPath` under `basePath` (no leading slash). Both are
 * POSIX paths (vscode `uri.path`). Falls back to the basename when the target is outside the
 * base, so an out-of-workspace PDF still gets a stable-ish key.
 */
export function relativizePath(basePath: string, targetPath: string): string {
  const base = basePath.replace(/\/+$/, "");
  if (targetPath === base) return "";
  if (targetPath.startsWith(base + "/")) return targetPath.slice(base.length + 1);
  return targetPath.split("/").pop() ?? targetPath;
}

/** Record a human-readable title for a PDF path. Returns true if it changed the index. */
export function setTitle(index: ContentIndex, rel: string, title: string): boolean {
  const entry = index.entries[rel];
  if (!entry || entry.title === title || !title) return false;
  entry.title = title;
  return true;
}

/**
 * Re-point index entries after an in-editor rename/move. Handles both a single PDF (exact key)
 * and a directory (every descendant key gets its prefix rewritten), so moving a folder of PDFs
 * keeps their ids without re-hashing. Returns true if any entry moved.
 */
export function repathEntries(index: ContentIndex, oldRel: string, newRel: string): boolean {
  let changed = false;
  if (index.entries[oldRel]) {
    index.entries[newRel] = index.entries[oldRel];
    delete index.entries[oldRel];
    changed = true;
  }
  const prefix = oldRel + "/";
  for (const key of Object.keys(index.entries)) {
    if (key.startsWith(prefix)) {
      index.entries[newRel + "/" + key.slice(prefix.length)] = index.entries[key];
      delete index.entries[key];
      changed = true;
    }
  }
  return changed;
}
