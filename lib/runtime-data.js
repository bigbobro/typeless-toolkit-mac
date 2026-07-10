'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MARKER_NAME = '.runtime-data-migration-v1.json';
const MARKER_TYPE = 'typeless-toolkit-runtime-data-migration';
const DEFAULT_MASTER_CSV = 'Typeless词库主清单.csv';

class RuntimeDataError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'RuntimeDataError';
    this.code = code;
    Object.assign(this, details);
  }
}

function expandHome(value, homeDir) {
  return String(value).replace(/^~(?=$|\/|\\)/, homeDir);
}

function ensurePrivateDirectory(dirPath) {
  if (fs.existsSync(dirPath)) {
    const stat = fs.lstatSync(dirPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new RuntimeDataError(
        `Runtime data path is not a private directory: ${dirPath}`,
        'RUNTIME_DATA_PATH_INVALID',
        { path: dirPath },
      );
    }
  } else {
    fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  }
  fs.chmodSync(dirPath, 0o700);
}

function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function inspectEntry(entryPath, relative = '') {
  const stat = fs.lstatSync(entryPath);
  if (stat.isSymbolicLink()) {
    throw new RuntimeDataError(
      `Runtime data migration refuses symbolic links: ${entryPath}`,
      'RUNTIME_DATA_ENTRY_UNSUPPORTED',
      { path: entryPath },
    );
  }
  if (stat.isFile()) {
    return [{ type: 'file', path: relative, size: stat.size, sha256: hashFile(entryPath) }];
  }
  if (!stat.isDirectory()) {
    throw new RuntimeDataError(
      `Runtime data migration only supports files and directories: ${entryPath}`,
      'RUNTIME_DATA_ENTRY_UNSUPPORTED',
      { path: entryPath },
    );
  }

  const entries = [{ type: 'directory', path: relative }];
  for (const name of fs.readdirSync(entryPath).sort()) {
    const childRelative = relative ? path.posix.join(relative, name) : name;
    entries.push(...inspectEntry(path.join(entryPath, name), childRelative));
  }
  return entries;
}

function snapshotsEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function snapshotDigest(snapshot) {
  return crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

function copyPrivateEntry(source, destination) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) {
    throw new RuntimeDataError(
      `Runtime data migration refuses symbolic links: ${source}`,
      'RUNTIME_DATA_ENTRY_UNSUPPORTED',
      { path: source },
    );
  }
  if (stat.isFile()) {
    fs.copyFileSync(source, destination);
    fs.chmodSync(destination, 0o600);
    return;
  }
  if (!stat.isDirectory()) {
    throw new RuntimeDataError(
      `Runtime data migration only supports files and directories: ${source}`,
      'RUNTIME_DATA_ENTRY_UNSUPPORTED',
      { path: source },
    );
  }

  ensurePrivateDirectory(destination);
  for (const name of fs.readdirSync(source).sort()) {
    copyPrivateEntry(path.join(source, name), path.join(destination, name));
  }
}

function secureEntry(entryPath) {
  if (!fs.existsSync(entryPath)) return;
  const stat = fs.lstatSync(entryPath);
  if (stat.isSymbolicLink()) {
    throw new RuntimeDataError(
      `Runtime data contains a symbolic link: ${entryPath}`,
      'RUNTIME_DATA_ENTRY_UNSUPPORTED',
      { path: entryPath },
    );
  }
  if (stat.isFile()) {
    fs.chmodSync(entryPath, 0o600);
    return;
  }
  if (!stat.isDirectory()) {
    throw new RuntimeDataError(
      `Runtime data contains an unsupported entry: ${entryPath}`,
      'RUNTIME_DATA_ENTRY_UNSUPPORTED',
      { path: entryPath },
    );
  }
  fs.chmodSync(entryPath, 0o700);
  for (const name of fs.readdirSync(entryPath)) secureEntry(path.join(entryPath, name));
}

function secureKnownRuntimeEntries(dataDir, masterCsvName) {
  ensurePrivateDirectory(dataDir);
  const names = new Set([
    ...migrationItems(masterCsvName),
    'patch-backups',
    MARKER_NAME,
  ]);
  if (fs.existsSync(dataDir)) {
    for (const name of fs.readdirSync(dataDir)) {
      if (/^accounts\.json(?:\.corrupt-[A-Za-z0-9_.-]+)?\.bak$/.test(name)) names.add(name);
    }
  }
  for (const name of names) secureEntry(path.join(dataDir, name));
}

function writePrivateJson(filePath, value) {
  const tempPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
    fs.chmodSync(tempPath, 0o600);
    fs.renameSync(tempPath, filePath);
  } finally {
    try { fs.rmSync(tempPath, { force: true }); } catch (_) {}
  }
}

function migrationItems(masterCsvName) {
  if (!masterCsvName || path.basename(masterCsvName) !== masterCsvName) {
    throw new RuntimeDataError(
      `Invalid master CSV filename: ${masterCsvName}`,
      'RUNTIME_DATA_MASTER_NAME_INVALID',
    );
  }
  return [
    'accounts.json',
    'profiles',
    'runtime-backups',
    masterCsvName,
    'config.local.json',
    'typeless-version.json',
  ];
}

function discoverMigrationItems(codeDir, masterCsvName) {
  const names = new Set(migrationItems(masterCsvName));
  if (fs.existsSync(codeDir)) {
    for (const name of fs.readdirSync(codeDir)) {
      if (/^accounts\.json(?:\.corrupt-[A-Za-z0-9_.-]+)?\.bak$/.test(name)) names.add(name);
    }
  }
  return [...names];
}

function readCompletedMarker(markerPath, dataDir) {
  if (!fs.existsSync(markerPath)) return null;
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch (cause) {
    throw new RuntimeDataError(
      `Runtime data migration marker is invalid: ${markerPath}`,
      'RUNTIME_DATA_MARKER_INVALID',
      { path: markerPath, cause },
    );
  }
  if (
    marker.type !== MARKER_TYPE ||
    marker.version !== 1 ||
    marker.status !== 'complete' ||
    path.resolve(marker.destination_dir || '') !== dataDir
  ) {
    throw new RuntimeDataError(
      `Runtime data migration marker is invalid: ${markerPath}`,
      'RUNTIME_DATA_MARKER_INVALID',
      { path: markerPath },
    );
  }
  fs.chmodSync(markerPath, 0o600);
  return marker;
}

function hasCanonicalUserData(dataDir, masterCsvName) {
  return [
    'accounts.json',
    'profiles',
    'runtime-backups',
    masterCsvName,
  ].some((name) => fs.existsSync(path.join(dataDir, name)));
}

function migrateLegacyData({ codeDir, dataDir, masterCsvName, now }) {
  const markerPath = path.join(dataDir, MARKER_NAME);
  const items = discoverMigrationItems(codeDir, masterCsvName)
    .map((name) => ({ name, source: path.join(codeDir, name), destination: path.join(dataDir, name) }))
    .filter((item) => fs.existsSync(item.source));
  const existingMarker = readCompletedMarker(markerPath, dataDir);
  if (existingMarker) {
    const userDataNames = new Set(['accounts.json', 'profiles', 'runtime-backups', masterCsvName]);
    const markerHasSourceData = Array.isArray(existingMarker.items)
      && existingMarker.items.some((item) => userDataNames.has(item && item.name));
    // An empty first run may have happened from a freshly extracted folder.
    // While the canonical vault still has no user data, allow a later launch
    // from the real legacy folder to perform the one-time migration.
    if (markerHasSourceData || hasCanonicalUserData(dataDir, masterCsvName) || !items.length) {
      return { status: 'already_migrated', marker: existingMarker, marker_path: markerPath };
    }
  }
  const missing = [];
  const identical = [];
  const snapshots = new Map();

  // Inspect every source and destination before writing anything.
  for (const item of items) {
    const sourceSnapshot = inspectEntry(item.source);
    snapshots.set(item.name, sourceSnapshot);
    if (!fs.existsSync(item.destination)) {
      missing.push(item);
      continue;
    }
    const destinationSnapshot = inspectEntry(item.destination);
    if (!snapshotsEqual(sourceSnapshot, destinationSnapshot)) {
      throw new RuntimeDataError(
        `Runtime data migration conflict: ${item.name}`,
        'RUNTIME_DATA_CONFLICT',
        { item: item.name, source: item.source, destination: item.destination },
      );
    }
    identical.push(item);
  }

  const stagingDir = path.join(
    dataDir,
    `.runtime-data-migration-${process.pid}-${crypto.randomBytes(5).toString('hex')}.tmp`,
  );
  try {
    if (missing.length) ensurePrivateDirectory(stagingDir);
    for (const item of missing) {
      const staged = path.join(stagingDir, item.name);
      copyPrivateEntry(item.source, staged);
      const sourceAfterCopy = inspectEntry(item.source);
      const stagedSnapshot = inspectEntry(staged);
      if (
        !snapshotsEqual(snapshots.get(item.name), sourceAfterCopy) ||
        !snapshotsEqual(sourceAfterCopy, stagedSnapshot)
      ) {
        throw new RuntimeDataError(
          `Runtime data changed or failed verification during migration: ${item.name}`,
          'RUNTIME_DATA_VERIFY_FAILED',
          { item: item.name },
        );
      }
    }

    for (const item of missing) {
      const staged = path.join(stagingDir, item.name);
      if (fs.existsSync(item.destination)) {
        if (!snapshotsEqual(inspectEntry(staged), inspectEntry(item.destination))) {
          throw new RuntimeDataError(
            `Runtime data migration conflict: ${item.name}`,
            'RUNTIME_DATA_CONFLICT',
            { item: item.name, source: item.source, destination: item.destination },
          );
        }
        fs.rmSync(staged, { recursive: true, force: true });
      } else {
        fs.renameSync(staged, item.destination);
      }
      secureEntry(item.destination);
    }
    for (const item of identical) secureEntry(item.destination);
    // The legacy source remains as a recovery copy, but must not keep broad
    // default permissions after credentials have moved to the stable vault.
    for (const item of items) secureEntry(item.source);

    const marker = {
      type: MARKER_TYPE,
      version: 1,
      status: 'complete',
      source_dir: codeDir,
      destination_dir: dataDir,
      completed_at: now.toISOString(),
      items: items.map((item) => {
        const snapshot = snapshots.get(item.name);
        return {
          name: item.name,
          sha256: snapshotDigest(snapshot),
          entries: snapshot.length,
        };
      }),
    };
    writePrivateJson(markerPath, marker);
    return {
      status: items.length ? 'migrated' : 'no_legacy_data',
      copied: missing.map((item) => item.name),
      reused: identical.map((item) => item.name),
      marker,
      marker_path: markerPath,
    };
  } finally {
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch (_) {}
  }
}

/**
 * Resolve and prepare the toolkit runtime data directory. The environment
 * override is treated as an explicit choice, so legacy migration is skipped.
 */
function initializeRuntimeData(options = {}) {
  const codeDir = path.resolve(options.codeDir || path.join(__dirname, '..'));
  const homeDir = path.resolve(options.homeDir || os.homedir());
  const env = options.env || process.env;
  const masterCsvName = options.masterCsvName || DEFAULT_MASTER_CSV;
  const override = typeof env.TYPELESS_DATA_DIR === 'string' && env.TYPELESS_DATA_DIR.trim()
    ? env.TYPELESS_DATA_DIR.trim()
    : null;
  const dataDir = path.resolve(
    override
      ? expandHome(override, homeDir)
      : path.join(homeDir, 'Library', 'Application Support', 'Typeless Toolkit'),
  );

  ensurePrivateDirectory(dataDir);
  if (override) {
    secureKnownRuntimeEntries(dataDir, masterCsvName);
    return {
      dataDir,
      codeDir,
      overridden: true,
      migration: { status: 'skipped_override' },
    };
  }
  if (dataDir === codeDir) {
    secureKnownRuntimeEntries(dataDir, masterCsvName);
    return {
      dataDir,
      codeDir,
      overridden: false,
      migration: { status: 'skipped_same_directory' },
    };
  }

  const migration = migrateLegacyData({
    codeDir,
    dataDir,
    masterCsvName,
    now: options.now || new Date(),
  });
  secureEntry(dataDir);
  return { dataDir, codeDir, overridden: false, migration };
}

module.exports = {
  RuntimeDataError,
  initializeRuntimeData,
};
