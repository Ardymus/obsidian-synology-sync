// delete-log.ts — per-device tombstone shard module
// Each device writes ONLY its own shard under <remotePath>/.sync-tombstones/<syncIdentityId>.json
// At sync time all shards are read and unioned; latest deleted_at wins on conflict.

export interface TombstoneFileStation {
  listAllFiles(dir: string): Promise<Array<{ path: string; name?: string }>>;
  download(fullPath: string): Promise<ArrayBuffer>;
  upload(
    remoteDir: string,
    fileName: string,
    data: ArrayBuffer,
    overwrite: boolean,
    mtime?: number,
  ): Promise<void>;
  delete(fullPath: string): Promise<void>;
  createFolder(parentDir: string, name: string): Promise<void>;
}

export interface TombstoneEntry {
  deleted_at: number;
}

export type TombstoneMap = Map<string, TombstoneEntry>;

export interface ShardDoc {
  version: 1;
  syncIdentityId: string;
  tombstones: Record<string, TombstoneEntry>;
  last_updated: number;
}

export const TOMBSTONES_DIR_NAME = ".sync-tombstones";

/**
 * Returns `${remotePath}/.sync-tombstones/${syncIdentityId}.json`,
 * normalising away any trailing slash on remotePath.
 */
export function shardPath(remotePath: string, syncIdentityId: string): string {
  const base = remotePath.replace(/\/+$/, "");
  return `${base}/${TOMBSTONES_DIR_NAME}/${syncIdentityId}.json`;
}

/**
 * Pure merge: given an array of ShardDocs, return a TombstoneMap where each
 * path keeps the entry with the greatest deleted_at value.
 */
export function mergeShards(docs: ShardDoc[]): TombstoneMap {
  const result: TombstoneMap = new Map();
  for (const doc of docs) {
    for (const [filePath, entry] of Object.entries(doc.tombstones)) {
      const existing = result.get(filePath);
      if (!existing || entry.deleted_at > existing.deleted_at) {
        result.set(filePath, { deleted_at: entry.deleted_at });
      }
    }
  }
  return result;
}

/**
 * Reads and merges all *.json files under <remotePath>/.sync-tombstones/.
 * - Missing dir (listAllFiles throws or returns empty) → empty Map, no throw.
 * - Corrupt shard → skip that shard, console.warn, continue others.
 * - Non-JSON files are ignored.
 * - Union rule: for each path, keep the entry with the latest deleted_at.
 */
export async function readAllShards(
  fs: TombstoneFileStation,
  remotePath: string,
): Promise<TombstoneMap> {
  const base = remotePath.replace(/\/+$/, "");
  const tombstonesDir = `${base}/${TOMBSTONES_DIR_NAME}`;

  let files: Array<{ path: string; name?: string }>;
  try {
    files = await fs.listAllFiles(tombstonesDir);
  } catch {
    // Directory missing or any list error → treat as no tombstones
    return new Map();
  }

  if (!files || files.length === 0) {
    return new Map();
  }

  const docs: ShardDoc[] = [];

  for (const file of files) {
    // Only process .json files
    const name = file.name ?? file.path.split("/").pop() ?? "";
    if (!name.endsWith(".json")) {
      continue;
    }

    let buf: ArrayBuffer;
    try {
      buf = await fs.download(file.path);
    } catch (err) {
      console.warn(
        `[delete-log] Failed to download shard ${file.path}, skipping:`,
        err,
      );
      continue;
    }

    let doc: unknown;
    try {
      const text = new TextDecoder().decode(buf);
      doc = JSON.parse(text);
    } catch (err) {
      console.warn(
        `[delete-log] Corrupt shard (parse error) ${file.path}, skipping:`,
        err,
      );
      continue;
    }

    if (!isShardDoc(doc)) {
      console.warn(
        `[delete-log] Corrupt shard (invalid shape) ${file.path}, skipping.`,
      );
      continue;
    }

    docs.push(doc);
  }

  return mergeShards(docs);
}

/**
 * Writes this device's own shard.
 * - Loads this device's prior shard first (if any), applies writes + purges, then uploads.
 * - Creates the .sync-tombstones/ dir if needed (swallows "already exists" errors).
 * - Never touches other devices' shards.
 * - Always uploads with overwrite=true (shard-per-device has no contention).
 *
 * @param writes  Paths to add/update with their deleted_at timestamp.
 * @param purges  Paths to remove from this device's shard (e.g. after recreate-after-delete).
 */
export async function updateOwnShard(
  fs: TombstoneFileStation,
  remotePath: string,
  syncIdentityId: string,
  writes: Map<string, TombstoneEntry>,
  purges: Set<string>,
): Promise<void> {
  const base = remotePath.replace(/\/+$/, "");
  const tombstonesDir = `${base}/${TOMBSTONES_DIR_NAME}`;
  const fileName = `${syncIdentityId}.json`;
  const fullPath = `${tombstonesDir}/${fileName}`;

  // Ensure the directory exists (best-effort; swallow "already exists" errors)
  try {
    await fs.createFolder(base, TOMBSTONES_DIR_NAME);
  } catch {
    // Ignore — likely already exists
  }

  // Load this device's prior shard if available
  const prior: Record<string, TombstoneEntry> = {};
  try {
    const buf = await fs.download(fullPath);
    const text = new TextDecoder().decode(buf);
    const parsed: unknown = JSON.parse(text);
    if (isShardDoc(parsed)) {
      Object.assign(prior, parsed.tombstones);
    }
  } catch {
    // No prior shard or parse failure — start fresh
  }

  // Apply purges first, then writes
  for (const p of purges) {
    delete prior[p];
  }
  for (const [filePath, entry] of writes) {
    prior[filePath] = { deleted_at: entry.deleted_at };
  }

  const doc: ShardDoc = {
    version: 1,
    syncIdentityId,
    tombstones: prior,
    last_updated: Date.now(),
  };

  const encoded = new TextEncoder().encode(JSON.stringify(doc)).buffer;
  await fs.upload(tombstonesDir, fileName, encoded, true);
}

// ---------------------------------------------------------------------------
// Internal type guard
// ---------------------------------------------------------------------------

function isShardDoc(val: unknown): val is ShardDoc {
  if (typeof val !== "object" || val === null) return false;
  const obj = val as Record<string, unknown>;
  if (obj["version"] !== 1) return false;
  if (typeof obj["syncIdentityId"] !== "string") return false;
  if (typeof obj["last_updated"] !== "number") return false;
  if (typeof obj["tombstones"] !== "object" || obj["tombstones"] === null)
    return false;
  // Validate each tombstone entry
  const tombstones = obj["tombstones"] as Record<string, unknown>;
  for (const entry of Object.values(tombstones)) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as Record<string, unknown>)["deleted_at"] !== "number"
    ) {
      return false;
    }
  }
  return true;
}
