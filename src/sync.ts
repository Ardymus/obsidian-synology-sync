import { TFile, Vault, Notice } from "obsidian";
import { FileStation } from "./filestation";
import { debugLog } from "./debug";
import {
  Action,
  ConflictStrategy,
  decideAction,
  DecideConfig,
  HistoryEntry,
  LocalEntry,
  RemoteEntry,
  TombstoneEntry as DecisionTombstoneEntry,
} from "./decision-table";
import {
  PrevSyncAdapter,
  PrevSyncMap,
  buildPrevSyncSnapshot,
  readPrevSync,
  writePrevSync,
} from "./prev-sync";
import {
  TombstoneEntry as ShardTombstoneEntry,
  TombstoneFileStation,
  readAllShards,
  updateOwnShard,
} from "./delete-log";

export type { ConflictStrategy };

export interface SyncResult {
  uploaded: string[];
  downloaded: string[];
  deleted: string[];
  /** Remote files deleted because the local copy was removed (propagates delete). */
  deletedRemote: string[];
  /** Local files deleted because a peer's tombstone said so. */
  deletedLocal: string[];
  /** Files re-created after an earlier delete (mtime gate positive on rows 8/10). */
  recreated: string[];
  /** Row 6: tombstone was stale; local preserved + tombstone purged. */
  preservedLocal: string[];
  conflicts: string[];
  errors: Array<{ path: string; error: string }>;
}

export interface SyncEngineOptions {
  remotePath: string;
  conflictStrategy: ConflictStrategy;
  excludePatterns: string[];
  syncIdentityId: string;
  tombstoneJitterMs: number;
  honorTombstoneOnRecreate: boolean;
  remoteAbsenceGraceCycles: number;
}

export class SyncEngine {
  private vault: Vault;
  private fs: FileStation;
  private adapter: PrevSyncAdapter;
  private remotePath: string;
  private conflictStrategy: ConflictStrategy;
  private excludePatterns: RegExp[];
  private syncIdentityId: string;
  private tombstoneJitterMs: number;
  private honorTombstoneOnRecreate: boolean;
  private remoteAbsenceGraceCycles: number;

  constructor(vault: Vault, fs: FileStation, opts: SyncEngineOptions) {
    this.vault = vault;
    this.fs = fs;
    this.adapter = vault.adapter as unknown as PrevSyncAdapter;
    this.remotePath = opts.remotePath.replace(/\/+$/, "");
    this.conflictStrategy = opts.conflictStrategy;
    this.syncIdentityId = opts.syncIdentityId;
    this.tombstoneJitterMs = opts.tombstoneJitterMs;
    this.honorTombstoneOnRecreate = opts.honorTombstoneOnRecreate;
    this.remoteAbsenceGraceCycles = opts.remoteAbsenceGraceCycles;
    this.excludePatterns = [
      /^\.obsidian\/plugins\/synology-sync\//,
      /^\.trash\//,
      /^\.obsidian\/plugins\/text-extractor\/cache\//,
      /\/\.git\//,
      /^\.obsidian\/workspace-/,
      ...opts.excludePatterns.map((p) => new RegExp(p)),
    ];
  }

  private isExcluded(path: string): boolean {
    return this.excludePatterns.some((re) => re.test(path));
  }

  private async getLocalFiles(): Promise<Map<string, LocalEntry>> {
    const files = new Map<string, LocalEntry>();
    for (const file of this.vault.getFiles()) {
      if (!this.isExcluded(file.path)) {
        files.set(file.path, { mtime: file.stat.mtime, size: file.stat.size });
      }
    }
    return files;
  }

  private async getRemoteFiles(): Promise<Map<string, RemoteEntry & { fullPath: string }>> {
    const files = new Map<string, RemoteEntry & { fullPath: string }>();
    const remoteFiles = await this.fs.listAllFiles(this.remotePath);
    const prefixLen = this.remotePath.length + 1; // +1 for trailing /

    for (const f of remoteFiles) {
      const relativePath = f.path.substring(prefixLen);
      // Exclude the tombstones dir itself from the sync set
      if (relativePath.startsWith(".sync-tombstones/")) continue;
      if (relativePath && !this.isExcluded(relativePath)) {
        files.set(relativePath, {
          mtime: (f.additional?.time?.mtime ?? 0) * 1000, // convert to ms
          size: f.additional?.size ?? 0,
          fullPath: f.path,
        });
      }
    }
    return files;
  }

  async sync(deleteOrphans: boolean = false): Promise<SyncResult> {
    // deleteOrphans is retained for backward compat with callers but is no
    // longer consulted during decisions — delete propagation is now driven by
    // history + tombstones. The flag historically covered the row-7 case;
    // that case is unconditionally honoured now (which is the fix).
    void deleteOrphans;

    const result: SyncResult = {
      uploaded: [],
      downloaded: [],
      deleted: [],
      deletedRemote: [],
      deletedLocal: [],
      recreated: [],
      preservedLocal: [],
      conflicts: [],
      errors: [],
    };

    const local = await this.getLocalFiles();
    const remote = await this.getRemoteFiles();

    // Read per-device history (local JSON) and union of all tombstone shards (NAS).
    const history: PrevSyncMap = await readPrevSync(this.adapter);
    let tombstones: Map<string, DecisionTombstoneEntry>;
    try {
      tombstones = await readAllShards(
        this.fs as unknown as TombstoneFileStation,
        this.remotePath,
      );
    } catch (e) {
      debugLog(`[sync] readAllShards failed, proceeding with empty tombstones: ${(e as Error).message}`);
      tombstones = new Map();
    }

    const pendingShardWrites = new Map<string, ShardTombstoneEntry>();
    const pendingShardPurges = new Set<string>();

    const allPaths = new Set<string>([
      ...local.keys(),
      ...remote.keys(),
      ...history.keys(),
      ...tombstones.keys(),
    ]);

    for (const path of allPaths) {
      if (this.isExcluded(path)) continue;

      const l = local.get(path);
      const r = remote.get(path);
      const h = history.get(path);
      const t = tombstones.get(path);

      const cfg: DecideConfig = {
        conflictStrategy: this.conflictStrategy,
        tombstoneJitterMs: this.tombstoneJitterMs,
        honorTombstoneOnRecreate: this.honorTombstoneOnRecreate,
        remoteAbsenceGraceCycles: this.remoteAbsenceGraceCycles,
        // v1: remote-absence tracking not yet persisted; treat every absence
        // as "within grace" → upload on row 3. Safe default (preserves local).
        remoteAbsenceCount: 0,
      };

      const action = decideAction(
        l as LocalEntry | undefined,
        r as RemoteEntry | undefined,
        h as HistoryEntry | undefined,
        t as DecisionTombstoneEntry | undefined,
        cfg,
      );

      try {
        await this.applyAction(
          action,
          path,
          l,
          r,
          pendingShardWrites,
          pendingShardPurges,
          result,
        );
      } catch (e) {
        const errMsg = (e as Error).message;
        result.errors.push({ path, error: errMsg });
        debugLog(`SYNC ERROR: ${path} - ${errMsg} (action=${action.kind})`);
      }
    }

    // Persist own shard iff anything changed
    if (pendingShardWrites.size > 0 || pendingShardPurges.size > 0) {
      try {
        await updateOwnShard(
          this.fs as unknown as TombstoneFileStation,
          this.remotePath,
          this.syncIdentityId,
          pendingShardWrites,
          pendingShardPurges,
        );
      } catch (e) {
        result.errors.push({ path: "<shard>", error: (e as Error).message });
        debugLog(`SYNC ERROR shard-write: ${(e as Error).message}`);
      }
    }

    // Persist prev-sync history snapshot (post-sync view of local).
    try {
      const freshLocal = await this.getLocalFiles();
      const snapshot = buildPrevSyncSnapshot(freshLocal, Date.now());
      await writePrevSync(this.adapter, snapshot);
    } catch (e) {
      result.errors.push({ path: "<prev-sync>", error: (e as Error).message });
      debugLog(`SYNC ERROR prev-sync-write: ${(e as Error).message}`);
    }

    // Maintain the legacy `deleted` field for any callers / UI that still read it.
    result.deleted = [...result.deletedRemote, ...result.deletedLocal];

    return result;
  }

  // ---------------------------------------------------------------------
  // Action dispatch
  // ---------------------------------------------------------------------
  private async applyAction(
    action: Action,
    path: string,
    local: LocalEntry | undefined,
    remote: (RemoteEntry & { fullPath: string }) | undefined,
    pendingShardWrites: Map<string, ShardTombstoneEntry>,
    pendingShardPurges: Set<string>,
    result: SyncResult,
  ): Promise<void> {
    switch (action.kind) {
      case "upload":
        await this.uploadFile(path);
        result.uploaded.push(path);
        return;

      case "download":
        if (!remote) return;
        await this.downloadFile(path, remote.fullPath);
        result.downloaded.push(path);
        return;

      case "delete-local":
        await this.deleteLocalFile(path);
        result.deletedLocal.push(path);
        return;

      case "delete-remote": {
        // Row 7: we deleted locally; propagate delete and record our own tombstone.
        if (remote) {
          await this.fs.delete(remote.fullPath);
          result.deletedRemote.push(path);
        }
        pendingShardWrites.set(path, { deleted_at: Date.now() });
        return;
      }

      case "delete-remote-stale-tombstone":
        if (remote) {
          await this.fs.delete(remote.fullPath);
          result.deletedRemote.push(path);
        }
        return;

      case "recreate-after-delete":
        // Rows 8 & 10 positive mtime gate: remote (or local) is newer than the
        // tombstone → treat as a legitimate recreate. Keep remote, clear entry.
        if (remote) {
          await this.downloadFile(path, remote.fullPath);
          result.downloaded.push(path);
        }
        pendingShardPurges.add(path);
        result.recreated.push(path);
        return;

      case "keep-local-purge-tombstone":
        await this.uploadFile(path);
        result.uploaded.push(path);
        pendingShardPurges.add(path);
        result.preservedLocal.push(path);
        return;

      case "conflict-resolve":
        await this.conflictResolve(path, local, remote, action.strategy, result);
        if (action.purgeTombstone) pendingShardPurges.add(path);
        return;

      case "history-cleanup":
      case "history-cleanup-keep-tombstone":
        // History cleanup is implicit: we rebuild the snapshot from the fresh
        // local scan at the end of sync; orphan paths disappear naturally.
        return;

      case "noop":
        return;
    }
  }

  private async conflictResolve(
    path: string,
    local: LocalEntry | undefined,
    remote: (RemoteEntry & { fullPath: string }) | undefined,
    strategy: ConflictStrategy,
    result: SyncResult,
  ): Promise<void> {
    if (!local || !remote) return; // defensive — conflict requires both

    // Preserve existing close-mtime same-size short-circuit.
    const timeDiff = Math.abs(local.mtime - remote.mtime);
    if (timeDiff < 2000 && local.size === remote.size) {
      return;
    }

    switch (strategy) {
      case "newer-wins":
        if (local.mtime > remote.mtime) {
          await this.uploadFile(path);
          result.uploaded.push(path);
        } else if (remote.mtime > local.mtime) {
          await this.downloadFile(path, remote.fullPath);
          result.downloaded.push(path);
        }
        return;
      case "local-wins":
        await this.uploadFile(path);
        result.uploaded.push(path);
        return;
      case "remote-wins":
        await this.downloadFile(path, remote.fullPath);
        result.downloaded.push(path);
        return;
      case "skip":
        result.conflicts.push(path);
        return;
    }
  }

  private async deleteLocalFile(relativePath: string): Promise<void> {
    const file = this.vault.getAbstractFileByPath(relativePath);
    if (!file) {
      // File already gone — nothing to do.
      return;
    }
    if (file instanceof TFile) {
      // Send to system trash so the user can recover if needed.
      await this.vault.trash(file, true);
      return;
    }
    // Folders are not sync-tracked as entries; skip.
  }

  private async uploadFile(relativePath: string): Promise<void> {
    const file = this.vault.getAbstractFileByPath(relativePath);
    if (!(file instanceof TFile)) return;

    const content = await this.vault.readBinary(file);
    const parts = relativePath.split("/");
    const fileName = parts.pop()!;
    const remoteDir = parts.length > 0
      ? `${this.remotePath}/${parts.join("/")}`
      : this.remotePath;

    // Ensure remote directory exists (createFolder already ignores "exists" errors)
    if (parts.length > 0) {
      let current = this.remotePath;
      for (const part of parts) {
        try {
          await this.fs.createFolder(current, part);
        } catch {
          // Folder may already exist -- safe to ignore
        }
        current += "/" + part;
      }
    }

    await this.fs.upload(remoteDir, fileName, content, true, file.stat.mtime);
  }

  private async downloadFile(relativePath: string, remoteFullPath: string): Promise<void> {
    const content = await this.fs.download(remoteFullPath);

    // Ensure local directory exists
    const parts = relativePath.split("/");
    parts.pop();
    if (parts.length > 0) {
      const dirPath = parts.join("/");
      const existing = this.vault.getAbstractFileByPath(dirPath);
      if (!existing) {
        try {
          await this.vault.createFolder(dirPath);
        } catch {
          // Folder may have been created by a concurrent download -- ignore
        }
      }
    }

    const existing = this.vault.getAbstractFileByPath(relativePath);
    if (existing instanceof TFile) {
      await this.vault.modifyBinary(existing, content);
    } else {
      // Use adapter.writeBinary for files outside the vault index (e.g. .obsidian/ configs)
      await this.vault.adapter.writeBinary(relativePath, content);
    }
  }
}
