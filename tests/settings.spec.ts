import { DEFAULT_SETTINGS, SynologySyncSettings } from "../src/settings";

describe("DEFAULT_SETTINGS", () => {
  it("has syncIdentityId empty by default (bootstrapped on first load)", () => {
    expect(DEFAULT_SETTINGS.syncIdentityId).toBe("");
  });

  it("has tombstone retention 0 (forever) by default", () => {
    expect(DEFAULT_SETTINGS.tombstoneRetentionDays).toBe(0);
  });

  it("defaults honorTombstoneOnRecreate off (preserve-local wins)", () => {
    expect(DEFAULT_SETTINGS.honorTombstoneOnRecreate).toBe(false);
  });

  it("has a 30s jitter default for the mtime gate (absorbs cross-device clock skew)", () => {
    expect(DEFAULT_SETTINGS.tombstoneJitterMs).toBe(30000);
  });

  it("has remoteAbsenceGraceCycles=2 by default", () => {
    expect(DEFAULT_SETTINGS.remoteAbsenceGraceCycles).toBe(2);
  });

  it("keeps deleteOrphans false by default (safe)", () => {
    expect(DEFAULT_SETTINGS.deleteOrphans).toBe(false);
  });

  it("leaves deviceId untouched (it is the DSM 2FA cookie, not sync identity)", () => {
    // deviceId and syncIdentityId are distinct fields with distinct purposes.
    const s: SynologySyncSettings = { ...DEFAULT_SETTINGS };
    expect("deviceId" in s).toBe(true);
    expect("syncIdentityId" in s).toBe(true);
    expect(s.deviceId).toBe("");
    expect(s.syncIdentityId).toBe("");
  });
});
