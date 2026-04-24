/**
 * prev-sync.ts — local history store for the Synology sync plugin.
 *
 * Persists a per-file snapshot (mtime, size, last_sync_ts) to
 * `.obsidian/plugins/synology-sync/prev-sync.json` via an injected
 * PrevSyncAdapter.  All I/O is handled through the adapter so the module
 * remains pure-Node and is fully testable without an Obsidian runtime.
 */

// ---------------------------------------------------------------------------
// Adapter interface — subset of Obsidian's DataAdapter we actually need.
// ---------------------------------------------------------------------------

/** Injected I/O interface; in production pass `app.vault.adapter`. */
export interface PrevSyncAdapter {
  exists(p: string): Promise<boolean>;
  read(p: string): Promise<string>;
  write(p: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(p: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PrevSyncEntry {
  mtime: number;
  size: number;
  lastSyncTs: number;
}

export type PrevSyncMap = Map<string, PrevSyncEntry>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PREV_SYNC_PATH =
  ".obsidian/plugins/synology-sync/prev-sync.json";

const PREV_SYNC_TMP = PREV_SYNC_PATH + ".tmp";

// ---------------------------------------------------------------------------
// On-disk JSON schema (v1)
// ---------------------------------------------------------------------------

interface PrevSyncFileEntry {
  mtime: number;
  size: number;
  last_sync_ts: number;
}

interface PrevSyncFile {
  version: number;
  files: Record<string, PrevSyncFileEntry>;
}

const CURRENT_VERSION = 1;

// ---------------------------------------------------------------------------
// readPrevSync
// ---------------------------------------------------------------------------

/**
 * Returns the persisted sync history as a Map.
 *
 * Safe defaults: returns an empty Map if the file is missing, empty, or
 * contains corrupt/unrecognised JSON.  Never throws on I/O or parse errors.
 */
export async function readPrevSync(
  adapter: PrevSyncAdapter,
): Promise<PrevSyncMap> {
  const empty: PrevSyncMap = new Map();

  const fileExists = await adapter.exists(PREV_SYNC_PATH);
  if (!fileExists) {
    return empty;
  }

  let raw: string;
  try {
    raw = await adapter.read(PREV_SYNC_PATH);
  } catch (err) {
    console.warn("[prev-sync] Failed to read prev-sync file:", err);
    return empty;
  }

  if (!raw || raw.trim() === "") {
    return empty;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(
      "[prev-sync] Corrupt JSON in prev-sync file — discarding history and starting fresh.",
    );
    return empty;
  }

  // Runtime shape-check and version guard
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as PrevSyncFile).version !== CURRENT_VERSION ||
    typeof (parsed as PrevSyncFile).files !== "object" ||
    (parsed as PrevSyncFile).files === null
  ) {
    console.warn(
      "[prev-sync] Unrecognised prev-sync schema (version or shape mismatch) — discarding history.",
    );
    return empty;
  }

  const data = parsed as PrevSyncFile;
  const result: PrevSyncMap = new Map();

  for (const [path, entry] of Object.entries(data.files)) {
    if (
      typeof entry.mtime === "number" &&
      typeof entry.size === "number" &&
      typeof entry.last_sync_ts === "number"
    ) {
      result.set(path, {
        mtime: entry.mtime,
        size: entry.size,
        lastSyncTs: entry.last_sync_ts,
      });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// writePrevSync
// ---------------------------------------------------------------------------

/**
 * Atomically persists `entries` to disk.
 *
 * Write sequence:
 *   1. Write JSON to `PREV_SYNC_PATH + ".tmp"`
 *   2. Rename tmp → PREV_SYNC_PATH
 *   3. If rename throws, best-effort remove the tmp file, then re-throw.
 */
export async function writePrevSync(
  adapter: PrevSyncAdapter,
  entries: PrevSyncMap,
): Promise<void> {
  const filesRecord: Record<string, PrevSyncFileEntry> = {};

  for (const [path, entry] of entries) {
    filesRecord[path] = {
      mtime: entry.mtime,
      size: entry.size,
      last_sync_ts: entry.lastSyncTs,
    };
  }

  const payload: PrevSyncFile = {
    version: CURRENT_VERSION,
    files: filesRecord,
  };

  await adapter.write(PREV_SYNC_TMP, JSON.stringify(payload, null, 2));

  try {
    await adapter.rename(PREV_SYNC_TMP, PREV_SYNC_PATH);
  } catch (renameErr) {
    // Best-effort cleanup — swallow remove errors so we re-throw the original.
    try {
      await adapter.remove(PREV_SYNC_TMP);
    } catch {
      // intentionally ignored
    }
    throw renameErr;
  }
}

// ---------------------------------------------------------------------------
// buildPrevSyncSnapshot
// ---------------------------------------------------------------------------

/**
 * Converts a scan of local files into a PrevSyncMap stamped with
 * `syncCompletedAt` as the `lastSyncTs` for every entry.
 */
export function buildPrevSyncSnapshot(
  localFiles: Map<string, { mtime: number; size: number }>,
  syncCompletedAt: number,
): PrevSyncMap {
  const result: PrevSyncMap = new Map();

  for (const [path, stat] of localFiles) {
    result.set(path, {
      mtime: stat.mtime,
      size: stat.size,
      lastSyncTs: syncCompletedAt,
    });
  }

  return result;
}
