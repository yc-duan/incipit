// backup / restore
//
// What gets backed up, and why restore still understands one legacy entry:
//
//   1. `extension.js` and the whole `webview/` directory live under
//      Claude Code's extension directory. We rewrite `extension.js`, patch
//      `webview/index.js`, and copy/prune many webview-side assets. For the
//      extension payload, full snapshot +
//      full restore is the only correct operation: restoring only the
//      patched entry files would leave incipit-owned webview assets behind.
//
//   2. Older incipit builds also created a sparse `settings.json` entry for
//      `chat.fontFamily` / `chat.fontSize`. Current apply no longer writes
//      those VS Code user settings and current backups do not create that
//      entry, but restore keeps the sparse-json path so old backups can
//      surgically roll back only the keys incipit previously touched.
//
// Layout on disk:
//   ~/.incipit-backup/
//     <extension-version>/
//       <name>/                       user-supplied name, default "latest"
//         manifest.json
//         extension.js                (if it existed at backup time)
//         webview_dir/                full pre-apply webview directory
//       _history-<timestamp>/         auto-renamed when a name collides
//
// `_history-` prefix (leading underscore) is reserved for the collision
// mover so it cannot clash with a user-supplied name.
//
// Atomicity: every write goes through `atomicWrite`, which writes to a
// temp file in the same directory and then renames. A crash mid-write
// leaves either the old file or the new file intact, never a torn one.
//
// Verification: full-file entries carry a sha256 captured at backup
// time. Directory entries carry a sorted file list with sha256 hashes
// plus empty-directory names. Restore verifies the backup bytes before
// swapping anything into place and skips the entry if the hashes disagree.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const BACKUP_ROOT = path.join(os.homedir(), '.incipit-backup');
const BACKUP_MANIFEST_NAME = 'manifest.json';
const HISTORY_PREFIX = '_history-';
const DEFAULT_BACKUP_NAME = 'latest';

// ------------------------------ helpers ------------------------------

function sha256Bytes(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function timestampSlug() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    '-' +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

// Sanitize a user-supplied backup name. Accepts [A-Za-z0-9._-]; anything
// else collapses to `-`. Leading/trailing dashes and dots are trimmed,
// and the result is capped at 40 chars. Reserved `_history-` prefix is
// stripped so a user cannot forge an auto-history directory. Empty or
// unusable names fall back to DEFAULT_BACKUP_NAME.
function sanitizeBackupName(raw) {
  if (raw === undefined || raw === null) return DEFAULT_BACKUP_NAME;
  let s = String(raw).trim();
  if (!s) return DEFAULT_BACKUP_NAME;
  s = s.replace(/[^A-Za-z0-9._-]+/g, '-');
  s = s.replace(/^[-.]+|[-.]+$/g, '');
  if (!s) return DEFAULT_BACKUP_NAME;
  if (s.length > 40) s = s.slice(0, 40).replace(/[-.]+$/g, '');
  if (s.startsWith('_history-') || s === '_history') s = s.replace(/^_+/, '');
  if (!s) return DEFAULT_BACKUP_NAME;
  return s;
}

function atomicWrite(targetPath, data) {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(targetPath)}.tmp-${process.pid}-${Date.now()}`,
  );
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, targetPath);
  } catch (exc) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw exc;
  }
}

function moveDirSync(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try {
    fs.renameSync(src, dst);
    return;
  } catch (_) {
    // `rename` can fail across volumes or when a file is locked.
  }
  fs.cpSync(src, dst, { recursive: true });
  fs.rmSync(src, { recursive: true, force: true });
}

function toManifestPath(relPath) {
  return relPath.split(path.sep).join('/');
}

function canonicalPath(p) {
  if (!p) return '';
  let out = path.resolve(p);
  try { out = fs.realpathSync(out); } catch (_) {}
  return process.platform === 'win32' ? out.toLowerCase() : out;
}

function samePath(a, b) {
  return canonicalPath(a) === canonicalPath(b);
}

function manifestClaudeCodeVersion(manifest) {
  return String(
    manifest.claudeCodeVersion ||
    manifest.extensionVersion ||
    '',
  );
}

function targetClaudeCodeVersion(target) {
  return String(target && target.version ? target.version : '');
}

function isManifestCompatibleWithTarget(manifest, target) {
  if (!target) return true;
  const manifestVersion = manifestClaudeCodeVersion(manifest);
  const targetVersion = targetClaudeCodeVersion(target);
  if (manifestVersion && targetVersion && manifestVersion !== targetVersion) {
    return false;
  }
  if (manifest.extensionDir && target.extensionDir &&
      !samePath(manifest.extensionDir, target.extensionDir)) {
    return false;
  }
  if (target.settingsPath && Array.isArray(manifest.entries)) {
    const settingsEntry = manifest.entries.find(e =>
      e && e.type === 'sparse_json' && e.logicalName === 'vscode_settings.json'
    );
    if (settingsEntry && settingsEntry.originalPath &&
        !samePath(settingsEntry.originalPath, target.settingsPath)) {
      return false;
    }
  }
  return true;
}

function assertManifestCompatibleWithTarget(manifest, target) {
  if (!target || isManifestCompatibleWithTarget(manifest, target)) return;
  const manifestVersion = manifestClaudeCodeVersion(manifest) || 'unknown';
  const targetVersion = targetClaudeCodeVersion(target) || 'unknown';
  if (manifestVersion !== targetVersion) {
    throw new Error(
      `Backup belongs to Claude Code ${manifestVersion}; current target is ${targetVersion}.`,
    );
  }
  throw new Error('Backup belongs to a different Claude Code target.');
}

// Recursively list a directory's exact shape. Directory entries are tracked
// separately so an empty upstream directory can be restored as empty, not
// silently dropped by a file-only manifest.
function directoryShape(root) {
  const files = [];
  const dirs = [];
  function walk(dir, rel) {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      const manifestRel = toManifestPath(childRel);
      if (entry.isDirectory()) {
        dirs.push(manifestRel);
        walk(full, childRel);
      } else if (entry.isFile()) {
        const buf = fs.readFileSync(full);
        files.push({
          path: manifestRel,
          size: buf.length,
          sha256: sha256Bytes(buf),
        });
      }
    }
  }
  walk(root, '');
  files.sort((a, b) => a.path.localeCompare(b.path));
  dirs.sort((a, b) => a.localeCompare(b));
  return { files, dirs };
}

function directoryMatchesManifest(root, entry) {
  if (!fs.existsSync(root)) return false;
  let stat;
  try { stat = fs.statSync(root); } catch (_) { return false; }
  if (!stat.isDirectory()) return false;
  let shape;
  try { shape = directoryShape(root); } catch (_) { return false; }
  const expectedFiles = entry.files || [];
  const expectedDirs = entry.dirs || [];
  if (shape.files.length !== expectedFiles.length ||
      shape.dirs.length !== expectedDirs.length) {
    return false;
  }
  for (let i = 0; i < expectedDirs.length; i += 1) {
    if (shape.dirs[i] !== expectedDirs[i]) return false;
  }
  for (let i = 0; i < expectedFiles.length; i += 1) {
    const actual = shape.files[i];
    const expected = expectedFiles[i];
    if (!actual || !expected) return false;
    if (actual.path !== expected.path ||
        actual.size !== expected.size ||
        actual.sha256 !== expected.sha256) {
      return false;
    }
  }
  return true;
}

// --------------------------- manifest I/O ---------------------------

function writeManifest(backupDir, manifest) {
  const data = {
    version: 3,                         // schema version, not extension version
    created_at: manifest.createdAt,
    name: manifest.name,
    claude_code_version: manifest.claudeCodeVersion || manifest.extensionVersion,
    extension_version: manifest.extensionVersion,
    extension_dir: manifest.extensionDir,
    entries: manifest.entries.map(serializeEntry),
  };
  atomicWrite(
    path.join(backupDir, BACKUP_MANIFEST_NAME),
    JSON.stringify(data, null, 2),
  );
}

function serializeEntry(e) {
  if (e.type === 'file') {
    return {
      type: 'file',
      logical_name: e.logicalName,
      original_path: e.originalPath,
      backup_file: e.backupFile,       // basename, relative to backup dir
      existed_before: e.existedBefore,
      sha256: e.sha256,
    };
  }
  if (e.type === 'directory') {
    return {
      type: 'directory',
      logical_name: e.logicalName,
      original_path: e.originalPath,
      backup_dir: e.backupDirName,
      existed_before: e.existedBefore,
      dirs: e.dirs || [],
      files: e.files || [],
    };
  }
  if (e.type === 'sparse_json') {
    return {
      type: 'sparse_json',
      logical_name: e.logicalName,
      original_path: e.originalPath,
      keys: e.keys.map(k => ({
        key: k.key,
        had_before: k.hadBefore,
        old_value: k.hadBefore ? k.oldValue : undefined,
      })),
    };
  }
  throw new Error(`Unknown backup entry type: ${e.type}`);
}

function readManifest(backupDir) {
  const p = path.join(backupDir, BACKUP_MANIFEST_NAME);
  if (!fs.existsSync(p)) return null;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return null;
  }
  const entries = (data.entries || [])
    .map(e => deserializeEntry(e, backupDir))
    .filter(Boolean);
  return {
    schemaVersion:    data.version || 1,
    createdAt:        data.created_at || '',
    name:             data.name || path.basename(backupDir),
    claudeCodeVersion: data.claude_code_version || data.extension_version || '',
    extensionVersion: data.extension_version || '',
    extensionDir:     data.extension_dir || '',
    entries,
  };
}

function deserializeEntry(e, backupDir) {
  if (!e || !e.type) {
    // v1 manifest: untyped entries were always whole-file. Migrate.
    if (e && e.logical_name && e.original_path) {
      return {
        type:          'file',
        logicalName:   e.logical_name,
        originalPath:  e.original_path,
        backupFile:    path.basename(e.backup_path || ''),
        backupPath:    e.backup_path || path.join(backupDir, path.basename(e.backup_path || '')),
        existedBefore: Boolean(e.existed_before),
        sha256:        e.sha256 || '',
      };
    }
    return null;
  }
  if (e.type === 'file') {
    return {
      type:          'file',
      logicalName:   e.logical_name,
      originalPath:  e.original_path,
      backupFile:    e.backup_file,
      backupPath:    path.join(backupDir, e.backup_file),
      existedBefore: Boolean(e.existed_before),
      sha256:        e.sha256 || '',
    };
  }
  if (e.type === 'directory') {
    const backupDirName = path.basename(e.backup_dir || e.logical_name || '');
    return {
      type:          'directory',
      logicalName:   e.logical_name,
      originalPath:  e.original_path,
      backupDirName,
      backupPath:    path.join(backupDir, backupDirName),
      existedBefore: Boolean(e.existed_before),
      dirs:          Array.isArray(e.dirs) ? e.dirs.slice().sort() : [],
      files:         Array.isArray(e.files)
        ? e.files
          .filter(f => f && typeof f.path === 'string')
          .map(f => ({
            path: f.path,
            size: Number.isFinite(f.size) ? f.size : 0,
            sha256: typeof f.sha256 === 'string' ? f.sha256 : '',
          }))
          .sort((a, b) => a.path.localeCompare(b.path))
        : [],
    };
  }
  if (e.type === 'sparse_json') {
    return {
      type:         'sparse_json',
      logicalName:  e.logical_name,
      originalPath: e.original_path,
      keys: (e.keys || []).map(k => ({
        key:       k.key,
        hadBefore: Boolean(k.had_before),
        oldValue:  k.had_before ? k.old_value : undefined,
      })),
    };
  }
  return null;
}

// --------------------------- backup creation ---------------------------

function snapshotFile(logicalName, src, backupDir) {
  if (!fs.existsSync(src)) {
    return {
      type:          'file',
      logicalName,
      originalPath:  src,
      backupFile:    logicalName,
      backupPath:    path.join(backupDir, logicalName),
      existedBefore: false,
      sha256:        '',
    };
  }
  const buf = fs.readFileSync(src);
  const dst = path.join(backupDir, logicalName);
  atomicWrite(dst, buf);
  return {
    type:          'file',
    logicalName,
    originalPath:  src,
    backupFile:    logicalName,
    backupPath:    dst,
    existedBefore: true,
    sha256:        sha256Bytes(buf),
  };
}

function snapshotDirectory(logicalName, src, backupDir) {
  const dst = path.join(backupDir, logicalName);
  if (!fs.existsSync(src)) {
    return {
      type:          'directory',
      logicalName,
      originalPath:  src,
      backupDirName: logicalName,
      backupPath:    dst,
      existedBefore: false,
      dirs:          [],
      files:         [],
    };
  }
  const stat = fs.statSync(src);
  if (!stat.isDirectory()) {
    throw new Error(`Expected directory for backup: ${src}`);
  }
  if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(src, dst, { recursive: true, preserveTimestamps: true });
  const shape = directoryShape(dst);
  return {
    type:          'directory',
    logicalName,
    originalPath:  src,
    backupDirName: logicalName,
    backupPath:    dst,
    existedBefore: true,
    dirs:          shape.dirs,
    files:         shape.files,
  };
}

function createBackup(target, opts = {}) {
  const name = sanitizeBackupName(opts.name);
  const versionDir = path.join(BACKUP_ROOT, String(target.version));
  const backupDir = path.join(versionDir, name);
  if (fs.existsSync(backupDir)) {
    const historyDir = path.join(versionDir, `${HISTORY_PREFIX}${timestampSlug()}`);
    moveDirSync(backupDir, historyDir);
  }
  fs.mkdirSync(backupDir, { recursive: true });

  const entries = [
    snapshotFile('extension.js',      target.extensionJsPath,     backupDir),
    snapshotDirectory('webview_dir',  path.dirname(target.webviewIndexJsPath), backupDir),
  ];

  const manifest = {
    createdAt:        new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    name,
    claudeCodeVersion: target.version,
    extensionVersion: target.version,
    extensionDir:     target.extensionDir,
    entries,
  };
  writeManifest(backupDir, manifest);
  return manifest;
}

function currentBackupDir(target, name = DEFAULT_BACKUP_NAME) {
  return path.join(BACKUP_ROOT, String(target.version), sanitizeBackupName(name));
}

// --------------------------- backup listing ---------------------------

function listAvailableBackups(options = {}) {
  const target = options.target || null;
  const results = [];
  if (!fs.existsSync(BACKUP_ROOT)) return results;
  const versionDirs = fs.readdirSync(BACKUP_ROOT).filter(n => {
    try { return fs.statSync(path.join(BACKUP_ROOT, n)).isDirectory(); }
    catch (_) { return false; }
  });
  for (const vd of versionDirs) {
    if (target && target.version && vd !== String(target.version)) continue;
    const vPath = path.join(BACKUP_ROOT, vd);
    const subDirs = fs.readdirSync(vPath).filter(n => {
      try { return fs.statSync(path.join(vPath, n)).isDirectory(); }
      catch (_) { return false; }
    });
    for (const sd of subDirs) {
      const bd = path.join(vPath, sd);
      const m = readManifest(bd);
      if (!m) continue;
      if (!isManifestCompatibleWithTarget(m, target)) continue;
      results.push({
        label:     `v${manifestClaudeCodeVersion(m)} / ${sd}  (${m.createdAt})`,
        backupDir: bd,
        manifest:  m,
        sortKey:   m.createdAt || '',
      });
    }
  }
  // Newest first, chronologically. createdAt is an ISO string so plain
  // string comparison sorts correctly.
  results.sort((a, b) => (a.sortKey < b.sortKey ? 1 : a.sortKey > b.sortKey ? -1 : 0));
  return results;
}

// --------------------------- restore ---------------------------

function restoreBackup(manifest, options = {}) {
  assertManifestCompatibleWithTarget(manifest, options.target || null);
  let restored = 0;
  let skipped = 0;
  for (const e of manifest.entries) {
    try {
      if (e.type === 'file') {
        if (restoreFileEntry(e)) restored++;
        else skipped++;
      } else if (e.type === 'directory') {
        if (restoreDirectoryEntry(e)) restored++;
        else skipped++;
      } else if (e.type === 'sparse_json') {
        if (restoreSparseJsonEntry(e)) restored++;
        else skipped++;
      } else {
        skipped++;
      }
    } catch (_) {
      skipped++;
    }
  }
  return [restored, skipped];
}

function restoreFileEntry(e) {
  if (e.existedBefore) {
    if (!fs.existsSync(e.backupPath)) return false;
    const buf = fs.readFileSync(e.backupPath);
    // sha256 gate: refuse to write corrupted backup bytes back to disk.
    if (e.sha256 && sha256Bytes(buf) !== e.sha256) return false;
    fs.mkdirSync(path.dirname(e.originalPath), { recursive: true });
    atomicWrite(e.originalPath, buf);
    return true;
  }
  // The file did not exist at backup time. If it exists now, delete it
  // so the patched payload matches the pre-apply state. settings.json is
  // always a sparse_json entry and never takes this path.
  if (fs.existsSync(e.originalPath)) {
    try {
      fs.unlinkSync(e.originalPath);
      return true;
    } catch (_) {
      return false;
    }
  }
  return false;
}

function restoreDirectoryEntry(e) {
  if (e.existedBefore) {
    if (!directoryMatchesManifest(e.backupPath, e)) return false;
    fs.mkdirSync(path.dirname(e.originalPath), { recursive: true });

    const parent = path.dirname(e.originalPath);
    const base = path.basename(e.originalPath);
    const stamp = `${process.pid}-${Date.now()}`;
    const stage = path.join(parent, `.${base}.incipit-restore-${stamp}`);
    const old = path.join(parent, `.${base}.incipit-old-${stamp}`);
    try {
      if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true });
      if (fs.existsSync(old)) fs.rmSync(old, { recursive: true, force: true });
      fs.cpSync(e.backupPath, stage, { recursive: true, preserveTimestamps: true });
      if (!directoryMatchesManifest(stage, e)) {
        fs.rmSync(stage, { recursive: true, force: true });
        return false;
      }
      if (fs.existsSync(e.originalPath)) {
        fs.renameSync(e.originalPath, old);
      }
      fs.renameSync(stage, e.originalPath);
      if (fs.existsSync(old)) fs.rmSync(old, { recursive: true, force: true });
      return true;
    } catch (_) {
      try {
        if (!fs.existsSync(e.originalPath) && fs.existsSync(old)) {
          fs.renameSync(old, e.originalPath);
        }
      } catch (_) {}
      try { if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true }); } catch (_) {}
      try { if (fs.existsSync(old)) fs.rmSync(old, { recursive: true, force: true }); } catch (_) {}
      return false;
    }
  }

  if (fs.existsSync(e.originalPath)) {
    try {
      fs.rmSync(e.originalPath, { recursive: true, force: true });
      return true;
    } catch (_) {
      return false;
    }
  }
  return false;
}

function restoreSparseJsonEntry(e) {
  // Read the CURRENT settings.json. We deliberately do not touch the
  // file we snapshotted — we roll back against the user's latest state.
  let current = {};
  let fileExists = fs.existsSync(e.originalPath);
  if (fileExists) {
    try {
      const text = fs.readFileSync(e.originalPath, 'utf8');
      current = text.trim() ? JSON.parse(text) : {};
    } catch (_) {
      // JSONC or corrupted — don't touch it. User's file, user's problem.
      return false;
    }
    if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      return false;
    }
  }

  let mutated = false;
  for (const slot of e.keys) {
    if (slot.hadBefore) {
      // Key existed before apply: put the old value back.
      if (current[slot.key] !== slot.oldValue) {
        current[slot.key] = slot.oldValue;
        mutated = true;
      }
    } else {
      // Key did not exist before apply: remove it.
      if (Object.prototype.hasOwnProperty.call(current, slot.key)) {
        delete current[slot.key];
        mutated = true;
      }
    }
  }

  if (!mutated) return false;
  // If the file didn't exist and rollback would only remove keys (which
  // are absent anyway), the `mutated` flag would already be false and
  // we'd have returned. So if we reach here and the file doesn't exist,
  // the user must have legitimate content in it — write the rolled-back
  // object back.
  fs.mkdirSync(path.dirname(e.originalPath), { recursive: true });
  atomicWrite(e.originalPath, JSON.stringify(current, null, 4) + '\n');
  return true;
}

module.exports = {
  BACKUP_ROOT,
  DEFAULT_BACKUP_NAME,
  sanitizeBackupName,
  currentBackupDir,
  createBackup,
  listAvailableBackups,
  restoreBackup,
};
