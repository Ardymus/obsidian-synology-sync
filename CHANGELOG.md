# Changelog

## [Unreleased]

## 2026.0512.1

### feat: Obfuscate credentials at rest in `data.json`

`password` and `deviceToken` were previously stored in plain text. Opening `data.json` in an editor — or, more dangerously, syncing it through this plugin's own remote shard or any vault backup tool — exposed DSM credentials in clear. The values are now wrapped with a versioned obfuscation scheme (`o1:` prefix, XOR + base64) before being written to disk; the plaintext only exists in memory while building the FileStation login config.

This is *obfuscation*, not encryption: anyone with both `data.json` and the plugin source can recover the plaintext. The goal is to defeat casual disclosure (editor open, screenshare, bug-report paste, vault-sync snapshot), not a determined attacker with file access. True at-rest encryption needs a user passphrase or platform keychain; Obsidian's plugin API exposes neither uniformly across desktop and mobile.

- A one-time migration in `migrateLoadedSettings` promotes any pre-existing plaintext `password` or `deviceToken` on first load. Empty values stay empty.
- The settings UI now reads/writes via `obfuscate()`/`deobfuscate()` so the password field continues to display correctly after migration.
- `buildConfig()` and `getFileStation()` deobfuscate at the call site; the comparison for "did the device token change?" runs against the deobfuscated value to avoid write churn.
- Threat model and rotation path documented in `src/secret-store.ts`.

### feat: Surface stale-sync state to the user

When the plugin's expected sync cadence is missed for an extended period — autoSync configured but the loop has stopped advancing `lastSync`, or `syncOnStartup` enabled but every startup sync has been failing — the plugin previously produced no signal. The user only discovered the issue when local edits silently failed to propagate (the failure mode that motivated this release).

- On plugin load, after any `syncOnStartup` attempt completes, `checkSyncFreshness()` evaluates whether `lastSync` is older than the configured cadence expects (2x `syncInterval` if auto-sync is on, 24h if only startup-sync is on).
- If stale, a sticky clickable Notice surfaces: `"Synology Sync: last successful sync was 5d 3h ago. Click to sync now."` Clicking dismisses the notice and triggers a manual sync.
- Users who run manual-only sync (no interval, no startup) are not warned — they own the cadence.

### feat: Validate remote folder path on demand

The `remotePath` setting accepted any string, including paths that did not exist or were not readable by the configured DSM user. A misconfigured path produced silent sync failures, the same failure mode the stale-sync notice now catches downstream. A new `"Validate"` button in the Sync Target section calls `FileStation.listFolder(remotePath)` and surfaces the result as ✓/✗ with the DSM error message, catching the misconfiguration at setup time rather than at sync time.

### feat: Default-exclude `.obsidian/plugins/` on fresh installs

`DEFAULT_SETTINGS.excludePatterns` is now `"^\\.obsidian/plugins/"` instead of an empty string. Enabling sync on a fresh install no longer pulls foreign community-plugin binaries into the vault from a stale or unrelated remote. Existing users whose `excludePatterns` is non-empty are unaffected (the default only applies on first load); other `.obsidian/` files — `app.json`, themes, snippets, hotkeys — continue to sync normally.

## 2026.0505.1

### fix: Tombstone correctness — prevent silent data loss from stale or hostile delete-log shards

- Drop the `tombstoneJitterMs` default from 30000ms to 5000ms. The 30-second window was wider than realistic cross-device clock skew and opened a 30-second band where a live remote file could be classified as a stale tombstone and deleted. A one-time settings migration rewrites the legacy 30000 value to 5000 on next load; users who set a custom value are left untouched.
- Harden the mtime gate in `decision-table.ts` against malformed `deleted_at` values (NaN/Infinity, zero or negative, or implausibly far in the future). When a tombstone is unparseable, the gate now refuses to act on it and routes Rows 4/8/10 down the "live data wins" branch (keep-local / recreate-after-delete) rather than deleting.
- Add cross-device purge propagation via a shared `_cleared.json` marker under `.sync-tombstones/`. When a device keeps a file via Row 6 (`keep-local-purge-tombstone`), it now records a `cleared_at` timestamp that suppresses peer devices' stale shard tombstones for that path. A subsequent genuine delete (`deleted_at > cleared_at`) still wins.

### fix: Mid-sync write protection — don't overwrite or silently mark-clean files the user edited during a sync

- Stamp `syncStartTs` at the top of each `sync()` run and track every stat the sync itself wrote in `syncedLocalStats`. The prev-sync snapshot now refuses to record a file as cleanly synced when its mtime postdates `syncStartTs` and does not match a stat written by this cycle — its prior history is carried forward instead, so the next cycle re-evaluates the file rather than burying the user's edit.
- Re-read live local mtime in `downloadFile` immediately before writing. If the user edited the file between the initial scan and the download, the conflict strategy now decides: `local-wins` always skips, `newer-wins` skips iff the live local mtime exceeds the remote, and `remote-wins` always overwrites. Skipped paths land in `result.conflicts`. A residual TOCTOU window between the live-mtime read and `vault.modifyBinary` remains and is documented in code; closing it would require an Obsidian API change.

### perf: Bounded-concurrency BFS for remote listing

`FileStation.listAllFiles` now fans out folder listings five at a time via `Promise.allSettled` instead of walking the tree one folder per round-trip. A single failed `listFolder` (permission hiccup, transient API error) is logged and the rest of the scan continues.

## 2026.430.5

### fix: Bound QuickConnect server-info lookup — closes #25

Adds explicit logging and a timeout around the initial QuickConnect `Serv.php` lookup so resolution cannot hang after only logging the QuickConnect ID.

## 2026.430.4

### fix: Use entry.cgi with timeout for QuickConnect relay auth — closes #23

Switches relay login to the DSM web-client `entry.cgi` auth endpoint and bounds relay login requests with explicit timeout logging.

## 2026.430.3

### fix: Use QuickConnect relay auth for off-network access — closes #21

Uses the regional QuickConnect relay portal intentionally when direct candidates fail and switches relay login to a portal-compatible POST auth flow.

## 2026.430.2

### fix: Stop QuickConnect unreachable fallback — closes #19

Stops the resolver from attempting auth against candidates that already failed ping-pong and reports a clear no-reachable-endpoint error instead.

### fix: Use BRAT-compatible three-part CalVer — closes #17

Switches release metadata from four-part `YYYY.MM.DD.N` versions to three-part `YYYY.MDD.N` versions so BRAT detects updates reliably.

### fix: Avoid QuickConnect portal HTML auth fallback — closes #13

Prevents browser-only regional QuickConnect portal candidates from being used as unverified File Station API fallbacks and reports HTML/non-JSON auth responses clearly.

## 2026.04.30.1

### fix: QuickConnect regional portal fallback — closes #8

Adds the regional QuickConnect portal host returned by Synology relay metadata to the resolver candidate list, deduplicates candidates, and enforces the intended per-candidate ping timeout.

### docs: Add contributing requirements — closes #10

Adds contributor rules matching the issue-first, architecture-impact, changelog, and CI gates used by `ForkTheGhost/Skills`.

### chore: Release 2026.04.30.1 — closes #12

Updates plugin release metadata and publishes the April 30, 2026 release.

## 2026.04.24.2

### Fixed

- **Issue [#5](https://github.com/ForkTheGhost/obsidian-synology-sync/issues/5) — `prev-sync.json` fails to persist after first write.** `writePrevSync` used a tmp-then-rename pattern, but Obsidian's `DataAdapter.rename` rejects existing destinations with `"Destination file already exists!"`. Every autoSync cycle after the first silently failed the rename, the error was swallowed to the in-memory `debugLog`, and `prev-sync.json` stayed frozen at its first-cycle state — which neutered Row 7 (delete-remote) and prevented the shard-write path from ever firing for deletes made after the first cycle. The fix replaces tmp-then-rename with a single `adapter.write(PREV_SYNC_PATH, …)` call; Obsidian's `DataAdapter.write` is itself atomic (internal tmp+rename on mobile, direct overwrite on desktop). `PrevSyncAdapter` drops the now-unused `rename` and `remove` methods.

## 2026.04.24.1

### Fixed

- **Issue [#3](https://github.com/ForkTheGhost/obsidian-synology-sync/issues/3) — Ghost resurrection of deleted files.** Replaced the stateless filesystem diff in `SyncEngine.sync()` with a 16-row decision table keyed on `(local, remote, history, tombstone)`. Deletes are now tracked by two new state stores:
  - Per-device prev-sync history at `.obsidian/plugins/synology-sync/prev-sync.json` (local JSON, atomic write).
  - Per-device delete-log shards on the NAS at `<remotePath>/.sync-tombstones/<syncIdentityId>.json`. Each device writes only its own shard; all devices read the union at sync time. No write contention by construction.

  Row 7 (local-deleted, remote-exists, in-history) now deletes remote and records a tombstone — this is the single-device fix. Rows 8 and 10 gate on `remote.mtime > tombstone.deleted_at + jitter` to safely distinguish ghosts from legitimate recreate-after-delete — this is the multi-device fix. Row 6 preserves local and purges the stale tombstone by default; `honorTombstoneOnRecreate` (default `false`) opts into the opposite.

### Added

- `settings.syncIdentityId` — UUID generated on first plugin load; stable across sessions; distinct from the DSM 2FA `deviceId` cookie.
- `settings.tombstoneRetentionDays` (default `0` = keep forever).
- `settings.honorTombstoneOnRecreate` (default `false`).
- `settings.tombstoneJitterMs` (default `5000`) — clock-skew tolerance for the mtime gate.
- `settings.remoteAbsenceGraceCycles` (default `2`) — staleness gate for row 3.
- Jest test suite (70+ unit tests) covering all 16 decision-table rows, prev-sync round-trip, corrupt-JSON recovery, and shard union merge semantics.
