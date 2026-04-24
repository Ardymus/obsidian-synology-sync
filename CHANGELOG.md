# Changelog

## Unreleased

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
