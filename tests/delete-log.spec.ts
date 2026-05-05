import {
  shardPath,
  readAllShards,
  updateOwnShard,
  mergeShards,
  TOMBSTONES_DIR_NAME,
  CLEARED_MARKER_NAME,
  ClearedDoc,
  TombstoneFileStation,
  ShardDoc,
  TombstoneEntry,
} from "../src/delete-log";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeShardDoc(
  id: string,
  tombstones: Record<string, TombstoneEntry>,
): ShardDoc {
  return { version: 1, syncIdentityId: id, tombstones, last_updated: Date.now() };
}

function encodeDoc(doc: ShardDoc): ArrayBuffer {
  return new TextEncoder().encode(JSON.stringify(doc)).buffer;
}

function encodeClearedDoc(doc: ClearedDoc): ArrayBuffer {
  return new TextEncoder().encode(JSON.stringify(doc)).buffer;
}

function makeFsStub(overrides: Partial<TombstoneFileStation> = {}): TombstoneFileStation {
  return {
    listAllFiles: jest.fn().mockResolvedValue([]),
    download: jest.fn().mockRejectedValue(new Error("not found")),
    upload: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
    createFolder: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// shardPath
// ---------------------------------------------------------------------------

describe("shardPath", () => {
  it("builds the correct path", () => {
    expect(shardPath("/volume1/vault", "device-abc")).toBe(
      "/volume1/vault/.sync-tombstones/device-abc.json",
    );
  });

  it("trims trailing slash from remotePath", () => {
    expect(shardPath("/volume1/vault/", "device-abc")).toBe(
      "/volume1/vault/.sync-tombstones/device-abc.json",
    );
  });

  it("trims multiple trailing slashes", () => {
    expect(shardPath("/volume1/vault///", "device-abc")).toBe(
      "/volume1/vault/.sync-tombstones/device-abc.json",
    );
  });

  it("uses TOMBSTONES_DIR_NAME constant in the path", () => {
    const result = shardPath("/vault", "id");
    expect(result).toContain(TOMBSTONES_DIR_NAME);
  });
});

// ---------------------------------------------------------------------------
// mergeShards (pure)
// ---------------------------------------------------------------------------

describe("mergeShards", () => {
  it("returns empty map for empty input", () => {
    expect(mergeShards([])).toEqual(new Map());
  });

  it("includes all paths from a single shard", () => {
    const doc = makeShardDoc("d1", {
      "a.md": { deleted_at: 100 },
      "b.md": { deleted_at: 200 },
    });
    const result = mergeShards([doc]);
    expect(result.size).toBe(2);
    expect(result.get("a.md")).toEqual({ deleted_at: 100 });
    expect(result.get("b.md")).toEqual({ deleted_at: 200 });
  });

  it("unions disjoint paths from two shards", () => {
    const d1 = makeShardDoc("d1", { "a.md": { deleted_at: 100 } });
    const d2 = makeShardDoc("d2", { "b.md": { deleted_at: 200 } });
    const result = mergeShards([d1, d2]);
    expect(result.size).toBe(2);
    expect(result.get("a.md")).toEqual({ deleted_at: 100 });
    expect(result.get("b.md")).toEqual({ deleted_at: 200 });
  });

  it("same path across two docs → keeps the later deleted_at", () => {
    const d1 = makeShardDoc("d1", { "x.md": { deleted_at: 1000 } });
    const d2 = makeShardDoc("d2", { "x.md": { deleted_at: 2000 } });
    const result = mergeShards([d1, d2]);
    expect(result.get("x.md")).toEqual({ deleted_at: 2000 });
  });

  it("same path across three docs resolves to latest deleted_at", () => {
    const d1 = makeShardDoc("d1", { "x.md": { deleted_at: 1000 } });
    const d2 = makeShardDoc("d2", { "x.md": { deleted_at: 3000 } });
    const d3 = makeShardDoc("d3", { "x.md": { deleted_at: 2000 } });
    const result = mergeShards([d1, d2, d3]);
    expect(result.get("x.md")).toEqual({ deleted_at: 3000 });
  });
});

// ---------------------------------------------------------------------------
// readAllShards
// ---------------------------------------------------------------------------

describe("readAllShards", () => {
  const REMOTE = "/volume1/vault";
  const TOMBSTONES_PATH = `${REMOTE}/${TOMBSTONES_DIR_NAME}`;

  it("returns empty map when listAllFiles throws (missing dir)", async () => {
    const fs = makeFsStub({
      listAllFiles: jest.fn().mockRejectedValue(new Error("no such dir")),
    });
    const result = await readAllShards(fs, REMOTE);
    expect(result.size).toBe(0);
  });

  it("returns empty map when listAllFiles returns empty array", async () => {
    const fs = makeFsStub({
      listAllFiles: jest.fn().mockResolvedValue([]),
    });
    const result = await readAllShards(fs, REMOTE);
    expect(result.size).toBe(0);
  });

  it("unions two shards with disjoint paths", async () => {
    const doc1 = makeShardDoc("d1", { "a.md": { deleted_at: 100 } });
    const doc2 = makeShardDoc("d2", { "b.md": { deleted_at: 200 } });

    const fs = makeFsStub({
      listAllFiles: jest.fn().mockResolvedValue([
        { path: `${TOMBSTONES_PATH}/d1.json`, name: "d1.json" },
        { path: `${TOMBSTONES_PATH}/d2.json`, name: "d2.json" },
      ]),
      download: jest
        .fn()
        .mockImplementation((p: string) => {
          if (p.endsWith("d1.json")) return Promise.resolve(encodeDoc(doc1));
          if (p.endsWith("d2.json")) return Promise.resolve(encodeDoc(doc2));
          return Promise.reject(new Error("unknown"));
        }),
    });

    const result = await readAllShards(fs, REMOTE);
    expect(result.size).toBe(2);
    expect(result.get("a.md")).toEqual({ deleted_at: 100 });
    expect(result.get("b.md")).toEqual({ deleted_at: 200 });
  });

  it("same path in two shards → winner is LATER timestamp", async () => {
    const doc1 = makeShardDoc("d1", { "shared.md": { deleted_at: 1000 } });
    const doc2 = makeShardDoc("d2", { "shared.md": { deleted_at: 9999 } });

    const fs = makeFsStub({
      listAllFiles: jest.fn().mockResolvedValue([
        { path: `${TOMBSTONES_PATH}/d1.json`, name: "d1.json" },
        { path: `${TOMBSTONES_PATH}/d2.json`, name: "d2.json" },
      ]),
      download: jest.fn().mockImplementation((p: string) => {
        if (p.endsWith("d1.json")) return Promise.resolve(encodeDoc(doc1));
        if (p.endsWith("d2.json")) return Promise.resolve(encodeDoc(doc2));
        return Promise.reject(new Error("unknown"));
      }),
    });

    const result = await readAllShards(fs, REMOTE);
    expect(result.get("shared.md")).toEqual({ deleted_at: 9999 });
  });

  it("1 valid + 1 corrupt shard → valid entries returned, no throw", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const validDoc = makeShardDoc("d1", { "good.md": { deleted_at: 500 } });

    const fs = makeFsStub({
      listAllFiles: jest.fn().mockResolvedValue([
        { path: `${TOMBSTONES_PATH}/d1.json`, name: "d1.json" },
        { path: `${TOMBSTONES_PATH}/d2.json`, name: "d2.json" },
      ]),
      download: jest.fn().mockImplementation((p: string) => {
        if (p.endsWith("d1.json")) return Promise.resolve(encodeDoc(validDoc));
        if (p.endsWith("d2.json")) {
          // Invalid JSON
          const buf = new TextEncoder().encode("{not valid json}}}").buffer;
          return Promise.resolve(buf);
        }
        return Promise.reject(new Error("unknown"));
      }),
    });

    const result = await readAllShards(fs, REMOTE);
    expect(result.get("good.md")).toEqual({ deleted_at: 500 });
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it("ignores non-.json files in the tombstones directory", async () => {
    const doc1 = makeShardDoc("d1", { "a.md": { deleted_at: 100 } });

    const downloadMock = jest.fn().mockImplementation((p: string) => {
      if (p.endsWith("d1.json")) return Promise.resolve(encodeDoc(doc1));
      return Promise.reject(new Error("should not be called"));
    });

    const fs = makeFsStub({
      listAllFiles: jest.fn().mockResolvedValue([
        { path: `${TOMBSTONES_PATH}/d1.json`, name: "d1.json" },
        { path: `${TOMBSTONES_PATH}/README.txt`, name: "README.txt" },
        { path: `${TOMBSTONES_PATH}/.DS_Store`, name: ".DS_Store" },
      ]),
      download: downloadMock,
    });

    const result = await readAllShards(fs, REMOTE);
    expect(result.size).toBe(1);
    // download should only have been called for the .json file
    expect(downloadMock).toHaveBeenCalledTimes(1);
    expect(downloadMock).toHaveBeenCalledWith(`${TOMBSTONES_PATH}/d1.json`);
  });

  it("warns and skips a shard where download fails", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const doc1 = makeShardDoc("d1", { "a.md": { deleted_at: 100 } });

    const fs = makeFsStub({
      listAllFiles: jest.fn().mockResolvedValue([
        { path: `${TOMBSTONES_PATH}/d1.json`, name: "d1.json" },
        { path: `${TOMBSTONES_PATH}/d2.json`, name: "d2.json" },
      ]),
      download: jest.fn().mockImplementation((p: string) => {
        if (p.endsWith("d1.json")) return Promise.resolve(encodeDoc(doc1));
        return Promise.reject(new Error("network error"));
      }),
    });

    const result = await readAllShards(fs, REMOTE);
    expect(result.size).toBe(1);
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// updateOwnShard
// ---------------------------------------------------------------------------

describe("updateOwnShard", () => {
  const REMOTE = "/volume1/vault";
  const ID = "device-xyz";
  const TOMBSTONES_PATH = `${REMOTE}/${TOMBSTONES_DIR_NAME}`;
  const OWN_SHARD_PATH = `${TOMBSTONES_PATH}/${ID}.json`;

  it("uploads a ShardDoc with the written entry when prior shard is absent", async () => {
    const uploadMock = jest.fn().mockResolvedValue(undefined);
    const fs = makeFsStub({
      download: jest.fn().mockRejectedValue(new Error("not found")),
      upload: uploadMock,
    });

    const writes = new Map([["new-file.md", { deleted_at: 1234 }]]);
    const purges = new Set<string>();

    await updateOwnShard(fs, REMOTE, ID, writes, purges);

    expect(uploadMock).toHaveBeenCalledTimes(1);
    const [dir, fileName, buf, overwrite] = uploadMock.mock.calls[0];
    expect(dir).toBe(TOMBSTONES_PATH);
    expect(fileName).toBe(`${ID}.json`);
    expect(overwrite).toBe(true);

    const text = new TextDecoder().decode(buf as ArrayBuffer);
    const doc: ShardDoc = JSON.parse(text);
    expect(doc.version).toBe(1);
    expect(doc.syncIdentityId).toBe(ID);
    expect(doc.tombstones["new-file.md"]).toEqual({ deleted_at: 1234 });
  });

  it("merges writes and applies purges over a prior shard correctly", async () => {
    const prior = makeShardDoc(ID, {
      "keep-me.md": { deleted_at: 100 },
      "purge-me.md": { deleted_at: 200 },
      "also-keep.md": { deleted_at: 300 },
    });
    const uploadMock = jest.fn().mockResolvedValue(undefined);

    const fs = makeFsStub({
      download: jest.fn().mockImplementation((p: string) => {
        if (p === OWN_SHARD_PATH) return Promise.resolve(encodeDoc(prior));
        return Promise.reject(new Error("unknown"));
      }),
      upload: uploadMock,
    });

    const writes = new Map([["new-entry.md", { deleted_at: 999 }]]);
    const purges = new Set(["purge-me.md"]);

    await updateOwnShard(fs, REMOTE, ID, writes, purges);

    // First call writes the shard; second writes the cleared marker because purges
    // are non-empty (cross-device suppression of stale tombstones).
    expect(uploadMock).toHaveBeenCalledTimes(2);
    const shardCall = uploadMock.mock.calls.find(
      (c) => c[1] === `${ID}.json`,
    );
    expect(shardCall).toBeDefined();
    const buf = shardCall![2] as ArrayBuffer;
    const doc: ShardDoc = JSON.parse(new TextDecoder().decode(buf));

    // 2 prior kept + 1 new = 3 total; purged one gone
    expect(Object.keys(doc.tombstones)).toHaveLength(3);
    expect(doc.tombstones["keep-me.md"]).toEqual({ deleted_at: 100 });
    expect(doc.tombstones["also-keep.md"]).toEqual({ deleted_at: 300 });
    expect(doc.tombstones["new-entry.md"]).toEqual({ deleted_at: 999 });
    expect(doc.tombstones["purge-me.md"]).toBeUndefined();
  });

  it("calls createFolder best-effort and swallows 'already exists' errors", async () => {
    const createFolderMock = jest
      .fn()
      .mockRejectedValue(new Error("already exists"));
    const uploadMock = jest.fn().mockResolvedValue(undefined);

    const fs = makeFsStub({
      createFolder: createFolderMock,
      download: jest.fn().mockRejectedValue(new Error("not found")),
      upload: uploadMock,
    });

    // Should not throw even though createFolder rejects
    await expect(
      updateOwnShard(
        fs,
        REMOTE,
        ID,
        new Map([["f.md", { deleted_at: 1 }]]),
        new Set(),
      ),
    ).resolves.not.toThrow();

    expect(createFolderMock).toHaveBeenCalledWith(REMOTE, TOMBSTONES_DIR_NAME);
    // Upload should still proceed
    expect(uploadMock).toHaveBeenCalledTimes(1);
  });

  it("uploads with overwrite=true", async () => {
    const uploadMock = jest.fn().mockResolvedValue(undefined);
    const fs = makeFsStub({
      download: jest.fn().mockRejectedValue(new Error("not found")),
      upload: uploadMock,
    });

    await updateOwnShard(
      fs,
      REMOTE,
      ID,
      new Map([["f.md", { deleted_at: 42 }]]),
      new Set(),
    );

    const overwrite = uploadMock.mock.calls[0][3];
    expect(overwrite).toBe(true);
  });

  it("only downloads its own shard (never lists peer shards)", async () => {
    const listMock = jest.fn().mockResolvedValue([]);
    const downloadMock = jest.fn().mockRejectedValue(new Error("not found"));
    const fs = makeFsStub({
      listAllFiles: listMock,
      download: downloadMock,
      upload: jest.fn().mockResolvedValue(undefined),
    });

    await updateOwnShard(
      fs,
      REMOTE,
      ID,
      new Map([["f.md", { deleted_at: 1 }]]),
      new Set(),
    );

    // listAllFiles must NOT be called — that is readAllShards territory
    expect(listMock).not.toHaveBeenCalled();

    // download should only ever be called with this device's own shard path
    for (const call of downloadMock.mock.calls) {
      expect(call[0]).toBe(OWN_SHARD_PATH);
    }
  });

  it("includes syncIdentityId in the uploaded ShardDoc", async () => {
    const uploadMock = jest.fn().mockResolvedValue(undefined);
    const fs = makeFsStub({
      download: jest.fn().mockRejectedValue(new Error("not found")),
      upload: uploadMock,
    });

    await updateOwnShard(
      fs,
      REMOTE,
      ID,
      new Map([["f.md", { deleted_at: 1 }]]),
      new Set(),
    );

    const buf = uploadMock.mock.calls[0][2] as ArrayBuffer;
    const doc: ShardDoc = JSON.parse(new TextDecoder().decode(buf));
    expect(doc.syncIdentityId).toBe(ID);
    expect(doc.version).toBe(1);
    expect(typeof doc.last_updated).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// Cross-device purge propagation via _cleared.json
// ---------------------------------------------------------------------------

describe("readAllShards: _cleared.json suppression", () => {
  const REMOTE = "/volume1/vault";
  const TOMBSTONES_PATH = `${REMOTE}/${TOMBSTONES_DIR_NAME}`;
  const MARKER_PATH = `${TOMBSTONES_PATH}/${CLEARED_MARKER_NAME}`;

  it("suppresses a tombstone whose deleted_at is older than the cleared_at marker", async () => {
    const shard = makeShardDoc("d1", { "kept.md": { deleted_at: 1000 } });
    const cleared: ClearedDoc = {
      version: 1,
      clears: { "kept.md": { cleared_at: 2000 } },
      last_updated: 2000,
    };

    const fs = makeFsStub({
      listAllFiles: jest.fn().mockResolvedValue([
        { path: `${TOMBSTONES_PATH}/d1.json`, name: "d1.json" },
        { path: MARKER_PATH, name: CLEARED_MARKER_NAME },
      ]),
      download: jest.fn().mockImplementation((p: string) => {
        if (p.endsWith("d1.json")) return Promise.resolve(encodeDoc(shard));
        if (p === MARKER_PATH) return Promise.resolve(encodeClearedDoc(cleared));
        return Promise.reject(new Error("unknown"));
      }),
    });

    const result = await readAllShards(fs, REMOTE);
    expect(result.has("kept.md")).toBe(false);
  });

  it("suppresses a tombstone with deleted_at equal to cleared_at (boundary, <=)", async () => {
    const shard = makeShardDoc("d1", { "boundary.md": { deleted_at: 5000 } });
    const cleared: ClearedDoc = {
      version: 1,
      clears: { "boundary.md": { cleared_at: 5000 } },
      last_updated: 5000,
    };

    const fs = makeFsStub({
      listAllFiles: jest.fn().mockResolvedValue([
        { path: `${TOMBSTONES_PATH}/d1.json`, name: "d1.json" },
        { path: MARKER_PATH, name: CLEARED_MARKER_NAME },
      ]),
      download: jest.fn().mockImplementation((p: string) => {
        if (p.endsWith("d1.json")) return Promise.resolve(encodeDoc(shard));
        if (p === MARKER_PATH) return Promise.resolve(encodeClearedDoc(cleared));
        return Promise.reject(new Error("unknown"));
      }),
    });

    const result = await readAllShards(fs, REMOTE);
    expect(result.has("boundary.md")).toBe(false);
  });

  it("a newer tombstone still wins — deleted_at > cleared_at survives the marker", async () => {
    const shard = makeShardDoc("d1", { "winning.md": { deleted_at: 9000 } });
    const cleared: ClearedDoc = {
      version: 1,
      clears: { "winning.md": { cleared_at: 5000 } },
      last_updated: 5000,
    };

    const fs = makeFsStub({
      listAllFiles: jest.fn().mockResolvedValue([
        { path: `${TOMBSTONES_PATH}/d1.json`, name: "d1.json" },
        { path: MARKER_PATH, name: CLEARED_MARKER_NAME },
      ]),
      download: jest.fn().mockImplementation((p: string) => {
        if (p.endsWith("d1.json")) return Promise.resolve(encodeDoc(shard));
        if (p === MARKER_PATH) return Promise.resolve(encodeClearedDoc(cleared));
        return Promise.reject(new Error("unknown"));
      }),
    });

    const result = await readAllShards(fs, REMOTE);
    expect(result.get("winning.md")).toEqual({ deleted_at: 9000 });
  });

  it("ignores a corrupt _cleared.json without throwing or suppressing tombstones", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const shard = makeShardDoc("d1", { "live.md": { deleted_at: 1000 } });

    const fs = makeFsStub({
      listAllFiles: jest.fn().mockResolvedValue([
        { path: `${TOMBSTONES_PATH}/d1.json`, name: "d1.json" },
        { path: MARKER_PATH, name: CLEARED_MARKER_NAME },
      ]),
      download: jest.fn().mockImplementation((p: string) => {
        if (p.endsWith("d1.json")) return Promise.resolve(encodeDoc(shard));
        if (p === MARKER_PATH) {
          // Wrong shape — missing `clears`
          return Promise.resolve(
            new TextEncoder().encode(JSON.stringify({ version: 1, last_updated: 1 })).buffer,
          );
        }
        return Promise.reject(new Error("unknown"));
      }),
    });

    const result = await readAllShards(fs, REMOTE);
    expect(result.get("live.md")).toEqual({ deleted_at: 1000 });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("updateOwnShard: _cleared.json write on purge", () => {
  const REMOTE = "/volume1/vault";
  const ID = "device-xyz";
  const TOMBSTONES_PATH = `${REMOTE}/${TOMBSTONES_DIR_NAME}`;

  it("writes _cleared.json when purges are non-empty", async () => {
    const uploadMock = jest.fn().mockResolvedValue(undefined);
    const fs = makeFsStub({
      download: jest.fn().mockRejectedValue(new Error("not found")),
      upload: uploadMock,
    });

    await updateOwnShard(
      fs,
      REMOTE,
      ID,
      new Map(),
      new Set(["purged.md"]),
    );

    const markerCall = uploadMock.mock.calls.find(
      (c) => c[1] === CLEARED_MARKER_NAME,
    );
    expect(markerCall).toBeDefined();
    expect(markerCall![0]).toBe(TOMBSTONES_PATH);

    const marker: ClearedDoc = JSON.parse(
      new TextDecoder().decode(markerCall![2] as ArrayBuffer),
    );
    expect(marker.version).toBe(1);
    expect(marker.clears["purged.md"]).toBeDefined();
    expect(typeof marker.clears["purged.md"].cleared_at).toBe("number");
  });

  it("does NOT write _cleared.json when purges are empty", async () => {
    const uploadMock = jest.fn().mockResolvedValue(undefined);
    const fs = makeFsStub({
      download: jest.fn().mockRejectedValue(new Error("not found")),
      upload: uploadMock,
    });

    await updateOwnShard(
      fs,
      REMOTE,
      ID,
      new Map([["new.md", { deleted_at: 1 }]]),
      new Set(),
    );

    const markerCall = uploadMock.mock.calls.find(
      (c) => c[1] === CLEARED_MARKER_NAME,
    );
    expect(markerCall).toBeUndefined();
  });

  it("merges new purges into an existing _cleared.json without dropping prior clears", async () => {
    const MARKER_PATH = `${TOMBSTONES_PATH}/${CLEARED_MARKER_NAME}`;
    const OWN_SHARD_PATH = `${TOMBSTONES_PATH}/${ID}.json`;
    const existingMarker: ClearedDoc = {
      version: 1,
      clears: { "old-clear.md": { cleared_at: 100 } },
      last_updated: 100,
    };

    const uploadMock = jest.fn().mockResolvedValue(undefined);
    const fs = makeFsStub({
      download: jest.fn().mockImplementation((p: string) => {
        if (p === MARKER_PATH) return Promise.resolve(encodeClearedDoc(existingMarker));
        if (p === OWN_SHARD_PATH) return Promise.reject(new Error("not found"));
        return Promise.reject(new Error("unknown"));
      }),
      upload: uploadMock,
    });

    await updateOwnShard(
      fs,
      REMOTE,
      ID,
      new Map(),
      new Set(["new-clear.md"]),
    );

    const markerCall = uploadMock.mock.calls.find(
      (c) => c[1] === CLEARED_MARKER_NAME,
    );
    expect(markerCall).toBeDefined();
    const marker: ClearedDoc = JSON.parse(
      new TextDecoder().decode(markerCall![2] as ArrayBuffer),
    );
    expect(marker.clears["old-clear.md"]).toEqual({ cleared_at: 100 });
    expect(marker.clears["new-clear.md"]).toBeDefined();
  });
});
