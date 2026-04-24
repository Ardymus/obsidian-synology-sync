/**
 * prev-sync.spec.ts — unit tests for the prev-sync history module.
 *
 * Uses a fake in-memory PrevSyncAdapter (Map<string, string> store) so
 * no real filesystem or Obsidian runtime is needed.
 */

import {
  PREV_SYNC_PATH,
  PrevSyncAdapter,
  PrevSyncEntry,
  PrevSyncMap,
  buildPrevSyncSnapshot,
  readPrevSync,
  writePrevSync,
} from "../src/prev-sync";

// ---------------------------------------------------------------------------
// Fake adapter factory
// ---------------------------------------------------------------------------

interface CallRecord {
  method: string;
  args: unknown[];
}

/** Builds a simple in-memory adapter with a call log for sequence assertions. */
function makeFakeAdapter(initial?: Record<string, string>): {
  adapter: PrevSyncAdapter;
  store: Map<string, string>;
  calls: CallRecord[];
} {
  const store = new Map<string, string>(Object.entries(initial ?? {}));
  const calls: CallRecord[] = [];

  const adapter: PrevSyncAdapter = {
    async exists(p: string): Promise<boolean> {
      calls.push({ method: "exists", args: [p] });
      return store.has(p);
    },
    async read(p: string): Promise<string> {
      calls.push({ method: "read", args: [p] });
      const val = store.get(p);
      if (val === undefined) throw new Error(`File not found: ${p}`);
      return val;
    },
    async write(p: string, data: string): Promise<void> {
      calls.push({ method: "write", args: [p, data] });
      store.set(p, data);
    },
    async rename(from: string, to: string): Promise<void> {
      calls.push({ method: "rename", args: [from, to] });
      const val = store.get(from);
      if (val === undefined) throw new Error(`rename source not found: ${from}`);
      store.set(to, val);
      store.delete(from);
    },
    async remove(p: string): Promise<void> {
      calls.push({ method: "remove", args: [p] });
      store.delete(p);
    },
  };

  return { adapter, store, calls };
}

/** Serialises a valid v1 prev-sync document to JSON. */
function makeValidJson(
  filesObj: Record<string, { mtime: number; size: number; last_sync_ts: number }> = {},
): string {
  return JSON.stringify({ version: 1, files: filesObj });
}

// ---------------------------------------------------------------------------
// readPrevSync
// ---------------------------------------------------------------------------

describe("readPrevSync", () => {
  it("returns empty Map when file does not exist", async () => {
    const { adapter } = makeFakeAdapter();
    const result = await readPrevSync(adapter);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  it("returns empty Map when file exists but is empty string", async () => {
    const { adapter } = makeFakeAdapter({ [PREV_SYNC_PATH]: "" });
    const result = await readPrevSync(adapter);
    expect(result.size).toBe(0);
  });

  it("returns empty Map (no throw) when file contains corrupt JSON", async () => {
    const { adapter } = makeFakeAdapter({ [PREV_SYNC_PATH]: "not valid json {{" });
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    // Should not throw — await directly and verify return value
    const result = await readPrevSync(adapter);
    expect(result.size).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("prev-sync"),
    );
    warnSpy.mockRestore();
  });

  it("returns populated Map for a valid file", async () => {
    const filesObj = {
      "path/to/note.md": { mtime: 1713456789000, size: 4096, last_sync_ts: 1713456790000 },
      "another/file.md": { mtime: 1713400000000, size: 256, last_sync_ts: 1713400001000 },
    };
    const { adapter } = makeFakeAdapter({ [PREV_SYNC_PATH]: makeValidJson(filesObj) });

    const result = await readPrevSync(adapter);

    expect(result.size).toBe(2);

    const entry1 = result.get("path/to/note.md") as PrevSyncEntry;
    expect(entry1.mtime).toBe(1713456789000);
    expect(entry1.size).toBe(4096);
    expect(entry1.lastSyncTs).toBe(1713456790000);

    const entry2 = result.get("another/file.md") as PrevSyncEntry;
    expect(entry2.mtime).toBe(1713400000000);
    expect(entry2.size).toBe(256);
    expect(entry2.lastSyncTs).toBe(1713400001000);
  });

  it("returns empty Map for version: 99 (unknown version)", async () => {
    const json = JSON.stringify({ version: 99, files: { "note.md": { mtime: 1, size: 1, last_sync_ts: 1 } } });
    const { adapter } = makeFakeAdapter({ [PREV_SYNC_PATH]: json });
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const result = await readPrevSync(adapter);

    expect(result.size).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("prev-sync"));
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// writePrevSync
// ---------------------------------------------------------------------------

describe("writePrevSync", () => {
  it("writes to .tmp first, then renames tmp → final", async () => {
    const { adapter, calls } = makeFakeAdapter();
    const entries: PrevSyncMap = new Map([
      ["notes/a.md", { mtime: 1000, size: 512, lastSyncTs: 2000 }],
    ]);

    await writePrevSync(adapter, entries);

    const writeCalls = calls.filter((c) => c.method === "write");
    const renameCalls = calls.filter((c) => c.method === "rename");

    // Only one write call, targeting .tmp
    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0].args[0]).toBe(PREV_SYNC_PATH + ".tmp");

    // One rename from .tmp to final
    expect(renameCalls).toHaveLength(1);
    expect(renameCalls[0].args[0]).toBe(PREV_SYNC_PATH + ".tmp");
    expect(renameCalls[0].args[1]).toBe(PREV_SYNC_PATH);

    // write must come before rename
    const writeIdx = calls.indexOf(writeCalls[0]);
    const renameIdx = calls.indexOf(renameCalls[0]);
    expect(writeIdx).toBeLessThan(renameIdx);
  });

  it("writes a valid empty-files doc when entries map is empty", async () => {
    const { adapter, store } = makeFakeAdapter();
    const entries: PrevSyncMap = new Map();

    await writePrevSync(adapter, entries);

    // After atomic rename, final path exists and tmp is gone
    expect(store.has(PREV_SYNC_PATH)).toBe(true);
    expect(store.has(PREV_SYNC_PATH + ".tmp")).toBe(false);

    const doc = JSON.parse(store.get(PREV_SYNC_PATH) as string);
    expect(doc.version).toBe(1);
    expect(doc.files).toEqual({});
  });

  it("removes .tmp file if rename throws, then re-throws original error", async () => {
    const { adapter, calls } = makeFakeAdapter();

    // Override rename to throw
    const originalRename = adapter.rename.bind(adapter);
    const renameError = new Error("rename failed");
    adapter.rename = async (from: string, to: string): Promise<void> => {
      calls.push({ method: "rename", args: [from, to] });
      throw renameError;
    };

    const entries: PrevSyncMap = new Map([
      ["note.md", { mtime: 1, size: 1, lastSyncTs: 1 }],
    ]);

    // The error must propagate
    await expect(writePrevSync(adapter, entries)).rejects.toThrow("rename failed");

    // A remove call for the .tmp path must have happened
    const removeCalls = calls.filter((c) => c.method === "remove");
    expect(removeCalls).toHaveLength(1);
    expect(removeCalls[0].args[0]).toBe(PREV_SYNC_PATH + ".tmp");

    // Suppress unused-variable warning — originalRename kept for intent clarity
    void originalRename;
  });
});

// ---------------------------------------------------------------------------
// buildPrevSyncSnapshot
// ---------------------------------------------------------------------------

describe("buildPrevSyncSnapshot", () => {
  it("stamps every entry with the provided syncCompletedAt as lastSyncTs", () => {
    const localFiles = new Map([
      ["docs/one.md", { mtime: 111, size: 222 }],
      ["docs/two.md", { mtime: 333, size: 444 }],
    ]);
    const syncTs = 9999999;

    const result = buildPrevSyncSnapshot(localFiles, syncTs);

    expect(result.size).toBe(2);

    const e1 = result.get("docs/one.md") as PrevSyncEntry;
    expect(e1.mtime).toBe(111);
    expect(e1.size).toBe(222);
    expect(e1.lastSyncTs).toBe(syncTs);

    const e2 = result.get("docs/two.md") as PrevSyncEntry;
    expect(e2.mtime).toBe(333);
    expect(e2.size).toBe(444);
    expect(e2.lastSyncTs).toBe(syncTs);
  });

  it("returns empty Map for empty input", () => {
    const result = buildPrevSyncSnapshot(new Map(), 12345);
    expect(result.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Round-trip
// ---------------------------------------------------------------------------

describe("round-trip: write then read", () => {
  it("reads back identical contents to what was written", async () => {
    const { adapter } = makeFakeAdapter();

    const original: PrevSyncMap = new Map([
      ["vault/alpha.md", { mtime: 100, size: 200, lastSyncTs: 300 }],
      ["vault/beta.md", { mtime: 400, size: 500, lastSyncTs: 600 }],
    ]);

    await writePrevSync(adapter, original);
    const recovered = await readPrevSync(adapter);

    expect(recovered.size).toBe(original.size);

    for (const [path, expected] of original) {
      const actual = recovered.get(path) as PrevSyncEntry;
      expect(actual).toBeDefined();
      expect(actual.mtime).toBe(expected.mtime);
      expect(actual.size).toBe(expected.size);
      expect(actual.lastSyncTs).toBe(expected.lastSyncTs);
    }
  });
});
