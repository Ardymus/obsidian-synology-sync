// Pure, side-effect-free sync decision function.
// No I/O, no Obsidian imports, no async. Data in → Action out.

export type ConflictStrategy = "newer-wins" | "local-wins" | "remote-wins" | "skip";

export type Action =
  | { kind: "upload" }
  | { kind: "download" }
  | { kind: "delete-local" }
  | { kind: "delete-remote"; writeTombstone: true }
  | { kind: "delete-remote-stale-tombstone" }
  | { kind: "recreate-after-delete"; purgeTombstone: true }
  | { kind: "keep-local-purge-tombstone" }
  | { kind: "conflict-resolve"; strategy: ConflictStrategy; purgeTombstone?: boolean }
  | { kind: "history-cleanup" }
  | { kind: "history-cleanup-keep-tombstone" }
  | { kind: "noop" };

export interface LocalEntry   { mtime: number; size: number }
export interface RemoteEntry  { mtime: number; size: number }
export interface HistoryEntry {
  mtime: number;
  size: number;
  lastSyncTs: number;
  /**
   * Consecutive syncs this path has been present in history but absent remotely.
   * Used by the Row 3 staleness gate.
   */
  missingCount?: number;
}
export interface TombstoneEntry { deleted_at: number }

export interface DecideConfig {
  conflictStrategy: ConflictStrategy;
  tombstoneJitterMs: number;
  honorTombstoneOnRecreate: boolean;
  remoteAbsenceGraceCycles: number;
  /** Consecutive cycles this path has been absent remotely while in history. */
  remoteAbsenceCount: number;
}

// ---------------------------------------------------------------------------
// Helper: mtime gate — returns true when `mtime` is newer than the delete
// event (with jitter tolerance), meaning the file was re-created.
//
// A malformed `deleted_at` (non-finite, zero/negative, or implausibly far in
// the future) is untrustworthy and we refuse to act on it.  Returning `true`
// in those cases routes Rows 4/8/10 down the "live-data wins" branches
// (keep-local-purge-tombstone / recreate-after-delete) so that a corrupt or
// hostile shard cannot trick the engine into deleting a real file.
// ---------------------------------------------------------------------------
function mtimeBeatsTombstone(
  mtime: number,
  tombstone: TombstoneEntry,
  jitterMs: number,
): boolean {
  const d = tombstone.deleted_at;
  if (!Number.isFinite(d) || d <= 0 || d > Date.now() + 60_000) {
    return true;
  }
  return mtime > d + jitterMs;
}

// ---------------------------------------------------------------------------
// Decision table — 16 rows keyed by (L, R, H, T) presence booleans.
// Rows 15 and 16 (L R with tombstone) are checked first because they add
// purgeTombstone:true to the conflict-resolve outcome.
// ---------------------------------------------------------------------------
export function decideAction(
  local:     LocalEntry     | undefined,
  remote:    RemoteEntry    | undefined,
  history:   HistoryEntry   | undefined,
  tombstone: TombstoneEntry | undefined,
  cfg:       DecideConfig,
): Action {
  const L = local     !== undefined;
  const R = remote    !== undefined;
  const H = history   !== undefined;
  const T = tombstone !== undefined;

  // Row 15: L R H T → conflict-resolve + purgeTombstone:true
  if (L && R && H && T) {
    return { kind: "conflict-resolve", strategy: cfg.conflictStrategy, purgeTombstone: true };
  }

  // Row 16: L R — T → conflict-resolve + purgeTombstone:true
  if (L && R && !H && T) {
    return { kind: "conflict-resolve", strategy: cfg.conflictStrategy, purgeTombstone: true };
  }

  // Row 1: L R H — → conflict-resolve (no purge)
  if (L && R && H && !T) {
    return { kind: "conflict-resolve", strategy: cfg.conflictStrategy };
  }

  // Row 2: L R — — → conflict-resolve (no purge)
  if (L && R && !H && !T) {
    return { kind: "conflict-resolve", strategy: cfg.conflictStrategy };
  }

  // Row 3: L — H — → staleness gate
  if (L && !R && H && !T) {
    if (cfg.remoteAbsenceCount < cfg.remoteAbsenceGraceCycles) {
      return { kind: "upload" };
    }
    return { kind: "delete-local" };
  }

  // Row 4: L — H T → local-mtime gate.
  // If the local file has been modified AFTER the tombstone (beyond jitter),
  // the user edited it post-peer-delete; treat as a live file rather than
  // silently deleting their changes. Fall through to conflict-resolve with
  // the tombstone purged. Otherwise, honor the tombstone and delete-local.
  if (L && !R && H && T) {
    if (mtimeBeatsTombstone((local as LocalEntry).mtime, tombstone as TombstoneEntry, cfg.tombstoneJitterMs)) {
      return { kind: "keep-local-purge-tombstone" };
    }
    return { kind: "delete-local" };
  }

  // Row 5: L — — — → upload (new local file)
  if (L && !R && !H && !T) {
    return { kind: "upload" };
  }

  // Row 6: L — — T → honor tombstone or default keep-local
  if (L && !R && !H && T) {
    if (cfg.honorTombstoneOnRecreate) {
      return { kind: "delete-local" };
    }
    return { kind: "keep-local-purge-tombstone" };
  }

  // Row 7: — R H — → delete-remote (single-device ghost-resurrection fix)
  if (!L && R && H && !T) {
    return { kind: "delete-remote", writeTombstone: true };
  }

  // Row 8: — R H T → mtime gate
  if (!L && R && H && T) {
    if (mtimeBeatsTombstone((remote as RemoteEntry).mtime, tombstone as TombstoneEntry, cfg.tombstoneJitterMs)) {
      return { kind: "recreate-after-delete", purgeTombstone: true };
    }
    return { kind: "delete-remote-stale-tombstone" };
  }

  // Row 9: — R — — → download (new remote file)
  if (!L && R && !H && !T) {
    return { kind: "download" };
  }

  // Row 10: — R — T → mtime gate (multi-device ghost-resurrection fix)
  if (!L && R && !H && T) {
    if (mtimeBeatsTombstone((remote as RemoteEntry).mtime, tombstone as TombstoneEntry, cfg.tombstoneJitterMs)) {
      return { kind: "recreate-after-delete", purgeTombstone: true };
    }
    return { kind: "delete-remote-stale-tombstone" };
  }

  // Row 11: — — H — → history-cleanup
  if (!L && !R && H && !T) {
    return { kind: "history-cleanup" };
  }

  // Row 12: — — H T → history-cleanup-keep-tombstone
  if (!L && !R && H && T) {
    return { kind: "history-cleanup-keep-tombstone" };
  }

  // Row 13: — — — T → noop (keep tombstone)
  if (!L && !R && !H && T) {
    return { kind: "noop" };
  }

  // Row 14: — — — — → noop (should never be reached in practice)
  return { kind: "noop" };
}
