# Changelog

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
