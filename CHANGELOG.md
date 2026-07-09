# Changelog

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
