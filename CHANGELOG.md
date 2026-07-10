# Changelog

## macos-v2.3.0 - 2026-07-10

### Security

- Protect every local `/api/*` request except the product-specific health check with a random per-process session secret injected into the manager page; reject non-loopback Host, mismatched Origin, and cross-site Fetch Metadata requests.
- Remove wildcard CORS, add no-store / anti-framing / nosniff security headers, and make the launcher identify the manager through a public product-specific `/api/health` response.
- Stop returning account tokens from `/api/accounts`, `/api/current`, and `/api/capture`. Captured credentials now stay on the backend behind a short-lived, single-use `capture_id`.
- Parse JSON strictly with content-type and size limits; malformed JSON now returns 400 instead of silently becoming `{}` and potentially clearing the master dictionary.
- Require object-shaped JSON for object APIs, returning `400 INVALID_INPUT` for `null`, arrays, and scalars instead of leaking `TypeError` as 500.
- Deep-whitelist live usage and personalization DTOs before they reach the browser, dropping unknown nested fields and normalizing non-finite numbers.
- Whitelist dictionary rows and normalize every remote count before rendering; word mutation endpoints no longer pass upstream response objects through to the browser.
- Return 400 for malformed HTTP request targets without terminating the manager process.
- Remove dynamic inline event strings for account IDs and dictionary terms, expand HTML escaping, and validate account IDs before they become profile paths.

### Changed

- Move the default runtime data root to `~/Library/Application Support/Typeless Toolkit/` while preserving `TYPELESS_DATA_DIR` as an explicit portable/test override.
- On first start, copy legacy accounts, profiles, runtime backups, master CSV, local config, version state, and account backups through a verified staging migration. Preserve the source, fail closed on conflicts, and mark completed migration idempotently.
- Create an immediate `post-migration` runtime backup in the stable vault so the migrated generation starts in a visibly protected state.
- If the first launch came from an empty fresh folder, allow a later launch from the real legacy folder to complete migration while the stable vault is still empty; once the vault has imported or newly created user data, it remains authoritative.
- Enforce `0700` on runtime directories and `0600` on credential/profile/backup files, including the retained legacy recovery copy.
- Replace fixed `app.asar.bak` / `Info.plist.bak` rollback with versioned patch transactions under `patch-backups/`. Each transaction verifies its before-image, atomically replaces candidates, validates plist integrity and codesign, and restores only its own backup on failure.
- Persist `committing` before the first live patch write and recover interrupted patch transactions during the next manager start. Prepared transactions fail closed if Typeless updated the live files, and manifest-write failures no longer hide the verified/failed rollback result.
- Remove the duplicate route-level patch restore. A rollback verification failure is now reported as `recovery_required` instead of claiming recovery succeeded.
- Publish runtime backups only after staging, per-file SHA-256 verification, and a complete manifest; incomplete or legacy unverified directories no longer produce a false “已备份” state.
- Restore imported backup bundles as a journaled runtime-data generation. Invalid base64, duplicate paths, and path conflicts are rejected before commit; exceptions and process interruption restore the prior accounts/master/profiles generation on the next startup.
- Rename the ambiguous "启动 Typeless" action to "连接 Typeless" and separate management-connection state from account/API availability. Connecting now shows progress, automatically re-detects the current account, and restores the chip/button state without a manual refresh.
- Make CDP startup fail explicitly after its timeout instead of returning a false "ready" response; the standalone debug launcher now uses the same verified restart-and-connect flow.
- Treat a CDP endpoint as Typeless only when it exposes the main window from the configured `app.asar`; remove the arbitrary-page fallback and bound HTTP, WebSocket, and command waits.

### Tests

- Add local API guard tests, a real loopback manager security integration test, runtime migration/permission/conflict tests, and patch transaction fault-injection tests.
- Add deep DTO, object-body, management-connection, CDP timeout, backup staging, restore-journal, crash-recovery, and manifest-failure regression tests.
- Full zero-dependency suite now contains 78 tests.

## macos-v2.2.0 - 2026-07-09

### Added

- Show each account's remaining token validity ("token 剩余 N 天") on its card, decoded from the JWT `exp` claim; warns amber under 30 days and red once expired.
- Show snapshot freshness ("快照已存 · N 天前") next to the existing 快照已存/未存快照 label.
- Support batch word add: a "批量" toggle in the dictionary tab reveals a multi-line textarea that submits through the same `bulk-import` API the sync features already use, via a new `POST /api/accounts/:id/words` route.
- Replace 「全部同步」's single summary toast with a step-by-step results panel (reusing the 诊断 panel's progress-bar/row style), showing each account's exported/imported/master counts or error as it completes.
- Add Typeless version-drift detection: record the last-seen `CFBundleShortVersionString` and, when Typeless auto-updates to a new version, surface a top banner warning that capabilities coupled to the app internals (token capture / paywall patch / path detection) may need re-verifying. Detection and warning only — nothing is re-run automatically. Clicking 知道了 records the new version as baseline (`GET /api/version-status`, `POST /api/version-ack`, state in gitignored `typeless-version.json`).

### Changed

- Replace every native `confirm()` (切号/重置设备/打补丁/删词/移除账号/导出导入备份) with an in-theme confirm modal; message text is unchanged, only the chrome changed. Esc and backdrop-click both resolve as Cancel.
- Replace `copyFrom()`'s native `prompt()` (type the nickname) with a modal dropdown listing the other accounts.
- Disable the relevant buttons (切换到此号/解除设备限制/解除弹窗提示/全部同步/同步本账号) while one of them is running, so double-clicks can't overlap the kill→restore→launch sequence or run two syncs at once.
- Toasts now carry a success/failure border color instead of being visually identical either way.
- All open modals close on Esc, not just backdrop click.
- Reserve space so the floating boot-status pill doesn't overlap the header subtitle when it wraps to two lines; below 760px viewport width the pill drops back into normal document flow beneath the title instead of floating.

### Notes

- Backend additions are additive only: `/api/accounts` now also returns `snapshot_mtime` / `token_expires_at` / `token_days_left`; the new `/words` and `/api/version-*` routes are new endpoints; no existing route's behavior changed.
- Added `test/token-expiry.test.js` (5 tests, JWT decode + expiry math) and `test/version-drift.test.js` (6 tests, drift comparison + version-state round-trip); full suite is 23 tests.

## macos-v2.1.1 - 2026-07-09

### Changed

- Move the on-open boot detection into a floating status pill pinned to the header's empty top-right, so its progress → done → fade no longer reflows the page (previously the in-flow progress bar shifted the content below when it appeared and collapsed).
- Stop showing the current login three times: the ephemeral "当前 Typeless 登录" confirmation now floats and fades, while the persistent `当前:` chip and the highlighted account card stay the single source of truth. The 未收录 case still shows a persistent in-flow banner to guide 添加当前账号.
- When a Typeless auto-update has reverted the 去弹窗补丁, the boot pill fades out without flashing "✓ 检查完成"; only the persistent warning banner remains.

## macos-v2.1.0 - 2026-07-09

### Added

- Add a "诊断 / 健康检查" panel (toolbar → 诊断): a read-only `/api/diagnostics` aggregate showing Typeless paths, debug port, current login, 去弹窗补丁 status, and the data directory, revealed step-by-step with a progress bar.
- Show the on-open auto-detection as one unified progress bar (加载账号 → 检测当前登录 → 自检去弹窗补丁 → 完成), so each step is legible instead of several indicators flashing independently.
- Self-check the 去弹窗补丁 on open and warn when a Typeless auto-update has reverted it.
- Add zero-dependency `node:test` coverage for the runtime backup-bundle round-trip and the dictionary dedup/diff logic (`node --test`, 12 tests).

### Changed

- Surface the actual failure reason in add-word / delete-word / save-account / save-master toasts instead of a bare "失败".
- Anchor the boot progress bar at the top with a fixed height so revealing other banners no longer shifts it.

### Notes

- The diagnostics endpoint is read-only; `manager.js` API behavior is otherwise unchanged.
- `docs/architecture.md` (internal notes on patch internals) is kept local via `.gitignore`.

## macos-v2.0.0 - 2026-07-09

### Changed

- Redesign the manager UI with a monospace "terminal deck" visual language (warm paper, emerald accent), keeping every existing label and wording unchanged.
- Restyle account cards as aligned record panels: a two-line header with an inline `当前` marker, consistent cross-card layout, and a bottom-pinned footer.
- Replace the weekly-quota bar with a bordered-track progress bar that stays readable at 0% and when full, with green / amber / red usage levels.
- Rebuild the dictionary tab as a dense multi-column grid with `全部` / `自动` / `手动` filters and a live word count, so large dictionaries are scannable at a glance.
- Visualize the usage tab with a quota ring, stat cards, a speed meter, and a highlighted time-saved figure (seconds shown as minutes / hours).

### Added

- Add hover tooltips to every action, explaining what it does and its consequences.
- Make previously ambiguous controls read as buttons: the `检测当前登录账号` chip, the card click-through hint, segmented tabs, and icon delete.

### Notes

- Visual and interaction refresh only; `manager.js` and all API behavior are unchanged.

## macos-v1.5.1 - 2026-07-09

### Fixed

- Fix `CDP_PORT is not defined` in the manager launch route.

### Added

- Add visible runtime backup status in the manager.
- Add manual local runtime backup for `accounts.json`, `profiles/`, and the master CSV.
- Add export/import backup package support for moving data across folders or machines.
- Add automatic runtime data backup before device reset, paywall patch, and backup restore.
- Warn users that exported backup packages contain Typeless login information, account tokens, and profile snapshots.

### Safety

- Keep `runtime-backups/` ignored by git.
- Write `accounts.json` atomically and keep `accounts.json.bak`.
- Stop treating a corrupted `accounts.json` as an empty account list; preserve a `.corrupt-*.bak` copy instead.

## macos-v1.5.0 - 2026-07-09

### Changed

- Support Typeless `2.0.0` / `2.0.0.114`.
- Improve paywall renderer bundle auto-detection for Typeless 2.0.
- Prefer renderer files that contain `type === 'paywall'` and notification/session-interrupt handlers instead of the first file that happens to contain the word `paywall`.
- Keep paywall replacement detection automatic, with no required `config.json` changes for Typeless 2.0.

### Verified

- Typeless app path, user data path, device cache path, `app.asar`, and `Info.plist` still match the macOS defaults.
- CDP token capture still works on port `9222`.
- User info and dictionary APIs still return successfully.
- `app.asar` integrity hash and macOS codesign verification still pass before patching.

### Notes

- Device reset was not executed during compatibility testing.
- Paywall patch status was tested, but app file mutation is still an explicit user action from the manager.

## macos-v1.0.0 - 2026-07-05

### Added

- Initial macOS-only release.
- Local web manager as the primary workflow.
- Multi-account saving, login snapshot switching, dictionary sync, single-word operations, device reset implementation, and paywall patch support for macOS.
- macOS `.command` launchers for the manager, Typeless debug-port launch, and optional dictionary sync.
- README workflow for first use, adding accounts, switching accounts, and optional CLI usage.

### Changed

- Removed Windows `.bat` entry points and Windows-only patch guide.
- Switched default paths to macOS Typeless locations.
- Added project-level ignores for local runtime data such as `accounts.json`, `profiles/`, CSV files, backups, logs, `CPA/`, and `SUB2/`.
