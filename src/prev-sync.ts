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
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PrevSyncEntry {
  mtime: number;
  size: number;
  lastSyncTs: number;
  /**
   * Consecutive cycles this path has been present locally but absent remotely.
   * Consumed by the Row 3 staleness gate.  Omitted for backward-compat reads.
   */
  missingCount?: number;
}

export type PrevSyncMap = Map<string, PrevSyncEntry>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PREV_SYNC_PATH =
  ".obsidian/plugins/synology-sync/prev-sync.json";

// ---------------------------------------------------------------------------
// On-disk JSON schema (v1)
// ---------------------------------------------------------------------------

interface PrevSyncFileEntry {
  mtime: number;
  size: number;
  last_sync_ts: number;
  missing_count?: number;
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
      const mapped: PrevSyncEntry = {
        mtime: entry.mtime,
        size: entry.size,
        lastSyncTs: entry.last_sync_ts,
      };
      if (typeof entry.missing_count === "number") {
        mapped.missingCount = entry.missing_count;
      }
      result.set(path, mapped);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// writePrevSync
// ---------------------------------------------------------------------------

/**
 * Persists `entries` to disk via `adapter.write`.
 *
 * Obsidian's DataAdapter.write is itself atomic (internal tmp+rename on mobile,
 * direct overwrite on desktop). An outer tmp-then-rename is both redundant and
 * broken across platforms because DataAdapter.rename rejects existing targets
 * with "Destination file already exists!" — see issue #5.
 */
export async function writePrevSync(
  adapter: PrevSyncAdapter,
  entries: PrevSyncMap,
): Promise<void> {
  const filesRecord: Record<string, PrevSyncFileEntry> = {};

  for (const [path, entry] of entries) {
    const out: PrevSyncFileEntry = {
      mtime: entry.mtime,
      size: entry.size,
      last_sync_ts: entry.lastSyncTs,
    };
    if (typeof entry.missingCount === "number" && entry.missingCount > 0) {
      out.missing_count = entry.missingCount;
    }
    filesRecord[path] = out;
  }

  const payload: PrevSyncFile = {
    version: CURRENT_VERSION,
    files: filesRecord,
  };

  await adapter.write(PREV_SYNC_PATH, JSON.stringify(payload, null, 2));
}

// ---------------------------------------------------------------------------
// buildPrevSyncSnapshot
// ---------------------------------------------------------------------------

export interface SnapshotInputs {
  /** Local scan taken AFTER sync actions have been applied. */
  freshLocal: Map<string, { mtime: number; size: number }>;
  /** Paths present remotely at sync start (pre-sync scan). */
  preSyncRemote: Set<string>;
  /** Prior history as loaded at sync start. */
  priorHistory: PrevSyncMap;
  /** Paths whose sync action errored and must NOT lose their history entry. */
  erroredPaths: Set<string>;
  /** Timestamp to stamp on entries (Date.now() at snapshot time). */
  now: number;
}

/**
 * Builds the next prev-sync snapshot.
 *
 * For each locally-present path, records fresh stats and updates `missingCount`:
 *   - reset to 0 if the path was present remotely at sync start
 *   - otherwise incremented from the prior value (Row 3 staleness gate input)
 *
 * For each errored path that is NOT in the fresh local scan but WAS in prior
 * history, the prior entry is carried forward unchanged.  This preserves
 * enough state for the next sync to re-fire the same decision-table row
 * (e.g. retry a failed delete-remote on Row 7) rather than misreading the
 * path as "never-seen" → Row 9 → resurrection.
 */
export function buildPrevSyncSnapshot(inputs: SnapshotInputs): PrevSyncMap {
  const { freshLocal, preSyncRemote, priorHistory, erroredPaths, now } = inputs;
  const snapshot: PrevSyncMap = new Map();

  for (const [path, stat] of freshLocal) {
    const prior = priorHistory.get(path);
    const wasRemoteAtStart = preSyncRemote.has(path);
    const priorMissing = prior?.missingCount ?? 0;
    const missingCount = wasRemoteAtStart ? 0 : priorMissing + 1;
    snapshot.set(path, {
      mtime: stat.mtime,
      size: stat.size,
      lastSyncTs: now,
      missingCount,
    });
  }

  for (const p of erroredPaths) {
    if (!snapshot.has(p)) {
      const prior = priorHistory.get(p);
      if (prior) snapshot.set(p, { ...prior });
    }
  }

  return snapshot;
}
