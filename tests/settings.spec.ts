import {
  DEFAULT_SETTINGS,
  SynologySyncSettings,
  migrateLoadedSettings,
} from "../src/settings";
import { isObfuscated, deobfuscate, obfuscate } from "../src/secret-store";

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

  it("has a 5s jitter default for the mtime gate (matches Synology 1s mtime resolution + small clock skew)", () => {
    expect(DEFAULT_SETTINGS.tombstoneJitterMs).toBe(5000);
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

describe("migrateLoadedSettings", () => {
  it("rewrites legacy 30000ms jitter to the new 5000ms default", () => {
    const s: SynologySyncSettings = { ...DEFAULT_SETTINGS, tombstoneJitterMs: 30000 };
    const changed = migrateLoadedSettings(s);
    expect(changed).toBe(true);
    expect(s.tombstoneJitterMs).toBe(5000);
  });

  it("leaves a custom jitter value untouched", () => {
    const s: SynologySyncSettings = { ...DEFAULT_SETTINGS, tombstoneJitterMs: 15000 };
    const changed = migrateLoadedSettings(s);
    expect(changed).toBe(false);
    expect(s.tombstoneJitterMs).toBe(15000);
  });

  it("leaves the new default untouched", () => {
    const s: SynologySyncSettings = { ...DEFAULT_SETTINGS, tombstoneJitterMs: 5000 };
    const changed = migrateLoadedSettings(s);
    expect(changed).toBe(false);
    expect(s.tombstoneJitterMs).toBe(5000);
  });

  it("obfuscates a legacy plaintext password on first load", () => {
    const s: SynologySyncSettings = { ...DEFAULT_SETTINGS, password: "hunter2" };
    const changed = migrateLoadedSettings(s);
    expect(changed).toBe(true);
    expect(isObfuscated(s.password)).toBe(true);
    expect(deobfuscate(s.password)).toBe("hunter2");
  });

  it("obfuscates a legacy plaintext deviceToken on first load", () => {
    const s: SynologySyncSettings = { ...DEFAULT_SETTINGS, deviceToken: "tok_abc123" };
    const changed = migrateLoadedSettings(s);
    expect(changed).toBe(true);
    expect(isObfuscated(s.deviceToken)).toBe(true);
    expect(deobfuscate(s.deviceToken)).toBe("tok_abc123");
  });

  it("does not re-wrap an already-obfuscated password", () => {
    const wrapped = obfuscate("hunter2");
    const s: SynologySyncSettings = { ...DEFAULT_SETTINGS, password: wrapped };
    const changed = migrateLoadedSettings(s);
    expect(changed).toBe(false);
    expect(s.password).toBe(wrapped);
  });

  it("leaves empty credentials empty (no obfuscation marker churn)", () => {
    const s: SynologySyncSettings = { ...DEFAULT_SETTINGS };
    const changed = migrateLoadedSettings(s);
    expect(changed).toBe(false);
    expect(s.password).toBe("");
    expect(s.deviceToken).toBe("");
  });
});

describe("DEFAULT_SETTINGS exclude patterns", () => {
  it("excludes .obsidian/plugins/ by default", () => {
    // Prevents fresh installs from pulling foreign plugins from a stale or
    // unrelated remote vault on first sync.
    expect(DEFAULT_SETTINGS.excludePatterns).toContain(".obsidian/plugins/");
  });
});
