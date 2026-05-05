import { decideAction, Action, DecideConfig } from "../src/decision-table";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const L = { mtime: 1000, size: 100 };
const R = { mtime: 2000, size: 200 };
const H = { mtime: 1000, size: 100, lastSyncTs: 900 };
const T = { deleted_at: 1500 };

const baseCfg: DecideConfig = {
  conflictStrategy: "newer-wins",
  tombstoneJitterMs: 5000,
  honorTombstoneOnRecreate: false,
  remoteAbsenceGraceCycles: 3,
  remoteAbsenceCount: 0,
};

// ---------------------------------------------------------------------------
// Row 1: L R H — → conflict-resolve (no tombstone purge)
// ---------------------------------------------------------------------------
describe("Row 1: L R H —", () => {
  it("returns conflict-resolve with strategy, no purgeTombstone", () => {
    const result = decideAction(L, R, H, undefined, baseCfg);
    expect(result).toEqual<Action>({
      kind: "conflict-resolve",
      strategy: "newer-wins",
    });
  });
});

// ---------------------------------------------------------------------------
// Row 2: L R — — → conflict-resolve (no tombstone purge)
// ---------------------------------------------------------------------------
describe("Row 2: L R — —", () => {
  it("returns conflict-resolve with strategy, no purgeTombstone", () => {
    const result = decideAction(L, R, undefined, undefined, baseCfg);
    expect(result).toEqual<Action>({
      kind: "conflict-resolve",
      strategy: "newer-wins",
    });
  });
});

// ---------------------------------------------------------------------------
// Row 3: L — H — → staleness gate
// ---------------------------------------------------------------------------
describe("Row 3: L — H —", () => {
  it("returns upload when remoteAbsenceCount < graceCycles", () => {
    const cfg = { ...baseCfg, remoteAbsenceCount: 1, remoteAbsenceGraceCycles: 3 };
    const result = decideAction(L, undefined, H, undefined, cfg);
    expect(result).toEqual<Action>({ kind: "upload" });
  });

  it("returns delete-local when remoteAbsenceCount >= graceCycles", () => {
    const cfg = { ...baseCfg, remoteAbsenceCount: 3, remoteAbsenceGraceCycles: 3 };
    const result = decideAction(L, undefined, H, undefined, cfg);
    expect(result).toEqual<Action>({ kind: "delete-local" });
  });
});

// ---------------------------------------------------------------------------
// Row 4: L — H T → local-mtime gate.
//   If local.mtime > tombstone.deleted_at + jitter → keep-local-purge-tombstone
//   (user edited file after peer's delete; preserve their changes).
//   Otherwise → delete-local (tombstone confirms deletion).
// ---------------------------------------------------------------------------
describe("Row 4: L — H T", () => {
  it("returns delete-local when local was unchanged since before the tombstone", () => {
    // L.mtime=1000, T.deleted_at=1500, jitter=5000 → 1000 > 6500? No.
    const result = decideAction(L, undefined, H, T, baseCfg);
    expect(result).toEqual<Action>({ kind: "delete-local" });
  });

  it("returns keep-local-purge-tombstone when local.mtime > deleted_at + jitter (post-delete edit)", () => {
    // User edited the file AFTER a peer's delete propagated; preserve their work.
    const localEdited = { mtime: 10000, size: 100 };
    const tombstone = { deleted_at: 1000 };
    const cfg = { ...baseCfg, tombstoneJitterMs: 5000 };
    const result = decideAction(localEdited, undefined, H, tombstone, cfg);
    expect(result).toEqual<Action>({ kind: "keep-local-purge-tombstone" });
  });

  it("returns delete-local on boundary (local.mtime === deleted_at + jitter, strict >)", () => {
    const localBoundary = { mtime: 6000, size: 100 };
    const tombstone = { deleted_at: 1000 };
    const cfg = { ...baseCfg, tombstoneJitterMs: 5000 };
    const result = decideAction(localBoundary, undefined, H, tombstone, cfg);
    expect(result).toEqual<Action>({ kind: "delete-local" });
  });
});

// ---------------------------------------------------------------------------
// Row 5: L — — — → upload (new local file)
// ---------------------------------------------------------------------------
describe("Row 5: L — — —", () => {
  it("returns upload", () => {
    const result = decideAction(L, undefined, undefined, undefined, baseCfg);
    expect(result).toEqual<Action>({ kind: "upload" });
  });
});

// ---------------------------------------------------------------------------
// Row 6: L — — T → default: keep-local-purge-tombstone (or delete-local if honorTombstoneOnRecreate)
// ---------------------------------------------------------------------------
describe("Row 6: L — — T", () => {
  it("returns keep-local-purge-tombstone by default", () => {
    const result = decideAction(L, undefined, undefined, T, baseCfg);
    expect(result).toEqual<Action>({ kind: "keep-local-purge-tombstone" });
  });

  it("returns delete-local when honorTombstoneOnRecreate is true", () => {
    const cfg = { ...baseCfg, honorTombstoneOnRecreate: true };
    const result = decideAction(L, undefined, undefined, T, cfg);
    expect(result).toEqual<Action>({ kind: "delete-local" });
  });
});

// ---------------------------------------------------------------------------
// Row 7: — R H — → delete-remote with writeTombstone:true
// ---------------------------------------------------------------------------
describe("Row 7: — R H —", () => {
  it("returns delete-remote with writeTombstone:true", () => {
    const result = decideAction(undefined, R, H, undefined, baseCfg);
    expect(result).toEqual<Action>({ kind: "delete-remote", writeTombstone: true });
  });
});

// ---------------------------------------------------------------------------
// Row 8: — R H T → mtime gate
// ---------------------------------------------------------------------------
describe("Row 8: — R H T", () => {
  it("returns recreate-after-delete when remote mtime > deleted_at + jitter", () => {
    // R.mtime=2000, T.deleted_at=1500, jitter=5000 → 2000 > 6500? No.
    // Use values where it passes: deleted_at=1000, jitter=500, R.mtime=2000
    const tombstone = { deleted_at: 1000 };
    const cfg = { ...baseCfg, tombstoneJitterMs: 500 };
    const result = decideAction(undefined, R, H, tombstone, cfg);
    expect(result).toEqual<Action>({ kind: "recreate-after-delete", purgeTombstone: true });
  });

  it("returns delete-remote-stale-tombstone when remote mtime <= deleted_at + jitter (strict >)", () => {
    // R.mtime=2000, T.deleted_at=1500, jitter=500 → 2000 > 2000? No (equal, not strictly greater)
    const tombstone = { deleted_at: 1500 };
    const cfg = { ...baseCfg, tombstoneJitterMs: 500 };
    const result = decideAction(undefined, R, H, tombstone, cfg);
    expect(result).toEqual<Action>({ kind: "delete-remote-stale-tombstone" });
  });
});

// ---------------------------------------------------------------------------
// Row 9: — R — — → download (new remote file)
// ---------------------------------------------------------------------------
describe("Row 9: — R — —", () => {
  it("returns download", () => {
    const result = decideAction(undefined, R, undefined, undefined, baseCfg);
    expect(result).toEqual<Action>({ kind: "download" });
  });
});

// ---------------------------------------------------------------------------
// Row 10: — R — T → mtime gate (multi-device ghost-resurrection fix)
// ---------------------------------------------------------------------------
describe("Row 10: — R — T", () => {
  it("returns recreate-after-delete when remote mtime > deleted_at + jitter", () => {
    const tombstone = { deleted_at: 1000 };
    const cfg = { ...baseCfg, tombstoneJitterMs: 500 };
    const result = decideAction(undefined, R, undefined, tombstone, cfg);
    expect(result).toEqual<Action>({ kind: "recreate-after-delete", purgeTombstone: true });
  });

  it("returns delete-remote-stale-tombstone when remote mtime not strictly greater", () => {
    const tombstone = { deleted_at: 1500 };
    const cfg = { ...baseCfg, tombstoneJitterMs: 500 };
    // R.mtime=2000, deleted_at=1500, jitter=500 → 2000 > 2000? No
    const result = decideAction(undefined, R, undefined, tombstone, cfg);
    expect(result).toEqual<Action>({ kind: "delete-remote-stale-tombstone" });
  });
});

// ---------------------------------------------------------------------------
// Row 11: — — H — → history-cleanup
// ---------------------------------------------------------------------------
describe("Row 11: — — H —", () => {
  it("returns history-cleanup", () => {
    const result = decideAction(undefined, undefined, H, undefined, baseCfg);
    expect(result).toEqual<Action>({ kind: "history-cleanup" });
  });
});

// ---------------------------------------------------------------------------
// Row 12: — — H T → history-cleanup-keep-tombstone
// ---------------------------------------------------------------------------
describe("Row 12: — — H T", () => {
  it("returns history-cleanup-keep-tombstone", () => {
    const result = decideAction(undefined, undefined, H, T, baseCfg);
    expect(result).toEqual<Action>({ kind: "history-cleanup-keep-tombstone" });
  });
});

// ---------------------------------------------------------------------------
// Row 13: — — — T → noop
// ---------------------------------------------------------------------------
describe("Row 13: — — — T", () => {
  it("returns noop (keep tombstone)", () => {
    const result = decideAction(undefined, undefined, undefined, T, baseCfg);
    expect(result).toEqual<Action>({ kind: "noop" });
  });
});

// ---------------------------------------------------------------------------
// Row 14: — — — — → noop
// ---------------------------------------------------------------------------
describe("Row 14: — — — —", () => {
  it("returns noop", () => {
    const result = decideAction(undefined, undefined, undefined, undefined, baseCfg);
    expect(result).toEqual<Action>({ kind: "noop" });
  });
});

// ---------------------------------------------------------------------------
// Row 15: L R H T → conflict-resolve with purgeTombstone:true
// ---------------------------------------------------------------------------
describe("Row 15: L R H T", () => {
  it("returns conflict-resolve with purgeTombstone:true", () => {
    const result = decideAction(L, R, H, T, baseCfg);
    expect(result).toEqual<Action>({
      kind: "conflict-resolve",
      strategy: "newer-wins",
      purgeTombstone: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Row 16: L R — T → conflict-resolve with purgeTombstone:true
// ---------------------------------------------------------------------------
describe("Row 16: L R — T", () => {
  it("returns conflict-resolve with purgeTombstone:true", () => {
    const result = decideAction(L, R, undefined, T, baseCfg);
    expect(result).toEqual<Action>({
      kind: "conflict-resolve",
      strategy: "newer-wins",
      purgeTombstone: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Additional edge-case tests (named per spec)
// ---------------------------------------------------------------------------

describe("Edge: Row 3 with remoteAbsenceCount=0, grace=2 → upload", () => {
  it("uploads when count=0 < grace=2", () => {
    const cfg = { ...baseCfg, remoteAbsenceCount: 0, remoteAbsenceGraceCycles: 2 };
    const result = decideAction(L, undefined, H, undefined, cfg);
    expect(result).toEqual<Action>({ kind: "upload" });
  });
});

describe("Edge: Row 3 with remoteAbsenceCount=5, grace=2 → delete-local", () => {
  it("deletes-local when count=5 >= grace=2", () => {
    const cfg = { ...baseCfg, remoteAbsenceCount: 5, remoteAbsenceGraceCycles: 2 };
    const result = decideAction(L, undefined, H, undefined, cfg);
    expect(result).toEqual<Action>({ kind: "delete-local" });
  });
});

describe("Edge: Row 6 default → keep-local-purge-tombstone", () => {
  it("returns keep-local-purge-tombstone without honorTombstoneOnRecreate", () => {
    const cfg = { ...baseCfg, honorTombstoneOnRecreate: false };
    const result = decideAction(L, undefined, undefined, T, cfg);
    expect(result).toEqual<Action>({ kind: "keep-local-purge-tombstone" });
  });
});

describe("Edge: Row 6 with honorTombstoneOnRecreate=true → delete-local", () => {
  it("returns delete-local", () => {
    const cfg = { ...baseCfg, honorTombstoneOnRecreate: true };
    const result = decideAction(L, undefined, undefined, T, cfg);
    expect(result).toEqual<Action>({ kind: "delete-local" });
  });
});

describe("Edge: Row 8 mtime gate positive (remote 10s after deleted_at, jitter=5s)", () => {
  it("returns recreate-after-delete", () => {
    // remote mtime = 11000, deleted_at = 1000, jitter = 5000 → 11000 > 6000 ✓
    const rEntry = { mtime: 11000, size: 100 };
    const tombstone = { deleted_at: 1000 };
    const cfg = { ...baseCfg, tombstoneJitterMs: 5000 };
    const result = decideAction(undefined, rEntry, H, tombstone, cfg);
    expect(result).toEqual<Action>({ kind: "recreate-after-delete", purgeTombstone: true });
  });
});

describe("Edge: Row 8 mtime gate boundary (remote exactly deleted_at + jitter) → delete-remote-stale-tombstone", () => {
  it("returns delete-remote-stale-tombstone (strict >) when equal", () => {
    // remote mtime = 6000, deleted_at = 1000, jitter = 5000 → 6000 > 6000? No
    const rEntry = { mtime: 6000, size: 100 };
    const tombstone = { deleted_at: 1000 };
    const cfg = { ...baseCfg, tombstoneJitterMs: 5000 };
    const result = decideAction(undefined, rEntry, H, tombstone, cfg);
    expect(result).toEqual<Action>({ kind: "delete-remote-stale-tombstone" });
  });
});

describe("Edge: Row 10 mtime gate positive → recreate-after-delete", () => {
  it("returns recreate-after-delete", () => {
    const rEntry = { mtime: 11000, size: 100 };
    const tombstone = { deleted_at: 1000 };
    const cfg = { ...baseCfg, tombstoneJitterMs: 5000 };
    const result = decideAction(undefined, rEntry, undefined, tombstone, cfg);
    expect(result).toEqual<Action>({ kind: "recreate-after-delete", purgeTombstone: true });
  });
});

describe("Edge: Row 10 mtime gate negative → delete-remote-stale-tombstone", () => {
  it("returns delete-remote-stale-tombstone", () => {
    const rEntry = { mtime: 5000, size: 100 };
    const tombstone = { deleted_at: 1000 };
    const cfg = { ...baseCfg, tombstoneJitterMs: 5000 };
    const result = decideAction(undefined, rEntry, undefined, tombstone, cfg);
    expect(result).toEqual<Action>({ kind: "delete-remote-stale-tombstone" });
  });
});

describe("Edge: Row 15 → conflict-resolve + purgeTombstone:true", () => {
  it("returns conflict-resolve with purgeTombstone:true for L R H T", () => {
    const cfg = { ...baseCfg, conflictStrategy: "local-wins" as const };
    const result = decideAction(L, R, H, T, cfg);
    expect(result).toEqual<Action>({
      kind: "conflict-resolve",
      strategy: "local-wins",
      purgeTombstone: true,
    });
  });
});

describe("Edge: Row 16 → conflict-resolve + purgeTombstone:true", () => {
  it("returns conflict-resolve with purgeTombstone:true for L R — T", () => {
    const cfg = { ...baseCfg, conflictStrategy: "remote-wins" as const };
    const result = decideAction(L, R, undefined, T, cfg);
    expect(result).toEqual<Action>({
      kind: "conflict-resolve",
      strategy: "remote-wins",
      purgeTombstone: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Hardened mtimeBeatsTombstone: malformed `deleted_at` must NOT trick the
// engine into deleting a real file.  In every gated row the safe outcome is
// the "live data wins" branch:
//   Row 4  (L — H T)   → keep-local-purge-tombstone
//   Row 8  (— R H T)   → recreate-after-delete
//   Row 10 (— R — T)   → recreate-after-delete
// ---------------------------------------------------------------------------
describe("mtimeBeatsTombstone hardening: malformed deleted_at", () => {
  const cfg = { ...baseCfg, tombstoneJitterMs: 5000 };

  it("Row 4: deleted_at=0 → keep-local-purge-tombstone (refuses to act on bogus tombstone)", () => {
    const tombstone = { deleted_at: 0 };
    const result = decideAction(L, undefined, H, tombstone, cfg);
    expect(result).toEqual<Action>({ kind: "keep-local-purge-tombstone" });
  });

  it("Row 4: deleted_at=-1 → keep-local-purge-tombstone", () => {
    const tombstone = { deleted_at: -1 };
    const result = decideAction(L, undefined, H, tombstone, cfg);
    expect(result).toEqual<Action>({ kind: "keep-local-purge-tombstone" });
  });

  it("Row 4: deleted_at far in the future → keep-local-purge-tombstone", () => {
    const tombstone = { deleted_at: Date.now() + 120_000 };
    const result = decideAction(L, undefined, H, tombstone, cfg);
    expect(result).toEqual<Action>({ kind: "keep-local-purge-tombstone" });
  });

  it("Row 4: NaN deleted_at → keep-local-purge-tombstone", () => {
    const tombstone = { deleted_at: Number.NaN };
    const result = decideAction(L, undefined, H, tombstone, cfg);
    expect(result).toEqual<Action>({ kind: "keep-local-purge-tombstone" });
  });

  it("Row 8: deleted_at=0 → recreate-after-delete", () => {
    const tombstone = { deleted_at: 0 };
    const result = decideAction(undefined, R, H, tombstone, cfg);
    expect(result).toEqual<Action>({ kind: "recreate-after-delete", purgeTombstone: true });
  });

  it("Row 8: deleted_at far in the future → recreate-after-delete", () => {
    const tombstone = { deleted_at: Date.now() + 120_000 };
    const result = decideAction(undefined, R, H, tombstone, cfg);
    expect(result).toEqual<Action>({ kind: "recreate-after-delete", purgeTombstone: true });
  });

  it("Row 10: deleted_at=-1 → recreate-after-delete", () => {
    const tombstone = { deleted_at: -1 };
    const result = decideAction(undefined, R, undefined, tombstone, cfg);
    expect(result).toEqual<Action>({ kind: "recreate-after-delete", purgeTombstone: true });
  });

  it("Row 10: Infinity deleted_at → recreate-after-delete", () => {
    const tombstone = { deleted_at: Number.POSITIVE_INFINITY };
    const result = decideAction(undefined, R, undefined, tombstone, cfg);
    expect(result).toEqual<Action>({ kind: "recreate-after-delete", purgeTombstone: true });
  });

  it("valid past deleted_at still gates normally (Row 8)", () => {
    // Sanity: a well-formed tombstone with mtime <= deleted_at + jitter still
    // routes to delete-remote-stale-tombstone.
    const past = Date.now() - 60_000;
    const tombstone = { deleted_at: past };
    const rEntry = { mtime: past - 1000, size: 100 };
    const result = decideAction(undefined, rEntry, H, tombstone, cfg);
    expect(result).toEqual<Action>({ kind: "delete-remote-stale-tombstone" });
  });
});
