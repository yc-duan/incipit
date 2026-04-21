// Core installer for `incipit`.
//
// This module locates the local Claude Code extension, patches
// `extension.js` and `webview/index.js`, syncs webview assets, installs
// system fonts, and writes `chat.fontFamily` / `chat.fontSize` into
// VS Code `settings.json`. The regex anchors target the minified bundle
// shape and may need to move when the extension updates.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const { HOST_BADGE_COMM_ATTACH } = require('./badge-iife');

// ============================================================
// constants
// ============================================================

const CLAUDE_CODE_EXTENSION_PREFIX = 'anthropic.claude-code-';
const ENHANCE_TARGET_NAME = 'enhance.js';

// Root-level webview files as `[sourceRelativePath, targetFileName]`.
// `theme.css` stays separate from the JS template string so CSS comments and
// backticks cannot terminate the template by accident.
const ROOT_WEBVIEW_FILES = [
  [path.join('data', 'claude_code_enhance.js'), ENHANCE_TARGET_NAME],
  [path.join('data', 'host_probe.js'),           'host_probe.js'],
  [path.join('data', 'host-badge.cjs'),          'host-badge.cjs'],
  [path.join('data', 'math_tokens.js'),         'math_tokens.js'],
  [path.join('data', 'math_rewriter.js'),       'math_rewriter.js'],
  [path.join('data', 'theme.css'),              'theme.css'],
];

const CDN_HOST = 'https://cdnjs.cloudflare.com';
const IMPORT_MARKER =
  'import("./enhance.js").catch(e=>console.error("[incipit] enhance.js import failed",e));';
// Local asset subtrees copied from `data/<name>/` to `webview/<name>/`.
// Sync the whole subtree so math, highlighting, and fonts work offline.
const LOCAL_ASSET_TREES = ['katex', 'hljs', 'fonts'];
// Asset subtrees we used to ship but no longer need. `apply` wipes these on
// sight so upgrades never leave dead bytes behind in the host webview folder.
const LEGACY_ASSET_TREES = ['mathjax'];

// Files copied into the user font directory. Only the Latin serif family is
// installed here. CJK faces are left to the system fallback stack.
const SYSTEM_FONT_FILES = [
  ['IBMPlexSerif-Regular.ttf',  'ibm-plex-serif', 'IBM Plex Serif Regular (TrueType)'],
  ['IBMPlexSerif-SemiBold.ttf', 'ibm-plex-serif', 'IBM Plex Serif SemiBold (TrueType)'],
];

// The chat input font is configured only through `settings.json`.
// `theme.css` does not style the real contenteditable input because CSS
// overrides there can trigger caret drift in Chromium.
const CHAT_FONT_FAMILY_STACK =
  "'IBM Plex Serif', Georgia, " +
  "'Microsoft YaHei UI', 'Microsoft YaHei', " +
  "'PingFang SC', system-ui, serif";
const CHAT_FONT_SIZE = 13;

// The complete list of VS Code user settings keys that `setChatFontToSerif`
// may write. Exposed for the backup module so that it can snapshot these
// keys surgically (capturing each key's pre-apply value, or a tombstone
// marking "did not exist") instead of storing the entire settings.json
// as a blob. Keeping this list here — next to the code that actually
// writes the keys — is how we guarantee backup and apply stay in sync.
const CHAT_FONT_SETTING_KEYS = Object.freeze(['chat.fontFamily', 'chat.fontSize']);

// ============================================================
// regexes
// ============================================================

const VERSION_RE = /anthropic\.claude-code-(\d+(?:\.\d+)+)/;

const STYLE_CSP_PATTERN =
  /style-src \$\{[^}]+\} 'unsafe-inline'(?! https:\/\/cdnjs\.cloudflare\.com)/;
const STYLE_CSP_PATCHED_RE =
  /style-src \$\{[^}]+\} 'unsafe-inline' https:\/\/cdnjs\.cloudflare\.com/;

const SCRIPT_CSP_PATTERN =
  /script-src 'nonce-\$\{[^}]+\}'(?! https:\/\/cdnjs\.cloudflare\.com)/;
const SCRIPT_CSP_PATCHED_RE =
  /script-src 'nonce-\$\{[^}]+\}' https:\/\/cdnjs\.cloudflare\.com/;

const FONT_CSP_PATTERN =
  /font-src \$\{[^}]+\}(?! https:\/\/cdnjs\.cloudflare\.com data:)/;
const FONT_CSP_PATCHED_RE =
  /font-src \$\{[^}]+\} https:\/\/cdnjs\.cloudflare\.com data:/;

const STATIC_IMPORT_RE = /(?:\r?\n)?import\s+['"]\.\/enhance\.js['"];?(?:\r?\n)?/;
const DYNAMIC_IMPORT_RE =
  /(?:\r?\n)?import\(\s*['"]\.\/enhance\.js['"]\s*\)(?:\.catch\([^)]*\))?;?(?:\r?\n)?/;

// Patch the final "markdown string -> file.value" handoff in the bundled
// `react-markdown` wrapper instead of relying on the exact compiled children
// initializer (`$.children || ""`), which is more volatile across builds.
const MARKDOWN_ASSIGN_PATTERN =
  /if\(typeof ([A-Za-z_$][\w$]*)==="string"\)([A-Za-z_$][\w$]*)\.value=\1;else ([A-Za-z_$][\w$]*)\("Unexpected value `"\+\1\+"` for `children` prop, expected `string`"\)/g;
const MARKDOWN_LEGACY_CHILDREN_RE =
  /([A-Za-z_$][\w$]*)=window\.__CLAUDE_ENHANCE_PREPROCESS_MARKDOWN__\?window\.__CLAUDE_ENHANCE_PREPROCESS_MARKDOWN__\(\$\.children\|\|""\):\(\$\.children\|\|""\)/g;
const MARKDOWN_ASSIGN_PATCHED_RE =
  /if\(typeof [A-Za-z_$][\w$]*==="string"\)\{if\(window\.__CLAUDE_ENHANCE_PREPROCESS_MARKDOWN__\)[A-Za-z_$][\w$]*=window\.__CLAUDE_ENHANCE_PREPROCESS_MARKDOWN__\([A-Za-z_$][\w$]*\);[A-Za-z_$][\w$]*\.value=[A-Za-z_$][\w$]*;\}else [A-Za-z_$][\w$]*\("Unexpected value `"\+[A-Za-z_$][\w$]*\+"` for `children` prop, expected `string`"\)/;

const ENHANCE_SCRIPT_TAG_RE =
  /<script nonce="\$\{[^}]+\}" src="\$\{[^}]*enhance\.js[^}]*\}"(?: type="module")?><\/script>/g;

// Remove any previous badge IIFE from the old view/panel paths before
// reinjecting at the centralized `Z5` comm constructor.
const BADGE_STRIP_VIEW_RE =
  /(resolveWebviewView\(K,V,B\)\{let j=\{isVisible:\(\)=>K\.visible\};this\.webviews\.add\(j\),)\(\(\)=>\{[\s\S]*?__cceBadge[\s\S]*?\}\)\(\),(?=K\.webview\.options=)/;
const BADGE_STRIP_PANEL_RE =
  /(setupPanel\(K,V,B,j\)\{let G=\{isVisible:\(\)=>K\.visible\};this\.webviews\.add\(G\);)\(\(\)=>\{[\s\S]*?__cceBadge[\s\S]*?\}\)\(\);/;
const BADGE_REQUIRE_VIEW_RE =
  /(resolveWebviewView\(K,V,B\)\{let j=\{isVisible:\(\)=>K\.visible\};this\.webviews\.add\(j\),)require\("\.\/webview\/host-badge\.cjs"\)\.attach\(K(?:,P0)?\),/;
const BADGE_REQUIRE_PANEL_RE =
  /(setupPanel\(K,V,B,j\)\{let G=\{isVisible:\(\)=>K\.visible\};this\.webviews\.add\(G\);)require\("\.\/webview\/host-badge\.cjs"\)\.attach\(K(?:,P0)?\);/;
const BADGE_COMM_ATTACH_PATTERN = /this\.webview=[A-Za-z_$][\w$]*;/g;
const BADGE_COMM_ATTACH_PATCHED_RE =
  /this\.webview=[A-Za-z_$][\w$]*;require\("\.\/webview\/host-badge\.cjs"\)\.attachComm\(this\);/;

// Remove the legacy module-load diagnostic probe.
const LEGACY_MODLOAD_RE =
  /try\{require\('fs'\)\.appendFileSync\([^)]*MODULE LOADED[^)]*\)\}catch\(e\)\{\};/g;

// ============================================================
// platform paths
// ============================================================

function extensionRoot(home) {
  return path.join(home || os.homedir(), '.vscode', 'extensions');
}

function vscodeUserSettingsPath() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA || home;
    return path.join(appdata, 'Code', 'User', 'settings.json');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Code', 'User', 'settings.json');
  }
  // Linux, FreeBSD, and other XDG-style platforms.
  const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return path.join(xdg, 'Code', 'User', 'settings.json');
}

function userFontDir() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const lad = process.env.LOCALAPPDATA || home;
    return path.join(lad, 'Microsoft', 'Windows', 'Fonts');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Fonts');
  }
  return path.join(home, '.local', 'share', 'fonts');
}

// ============================================================
// extension discovery
// ============================================================

function parseVersion(dirName) {
  const m = dirName.match(VERSION_RE);
  if (!m) return [];
  return m[1].split('.').map(x => parseInt(x, 10));
}

function compareVersionTuples(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] === undefined ? 0 : a[i];
    const bv = b[i] === undefined ? 0 : b[i];
    if (av !== bv) return av - bv;
  }
  return 0;
}

function buildTarget(extensionDir) {
  const extensionJsPath = path.join(extensionDir, 'extension.js');
  const webviewIndexJsPath = path.join(extensionDir, 'webview', 'index.js');
  if (!fs.existsSync(extensionJsPath)) {
    throw new Error(`未找到 Claude Code 扩展入口文件:${extensionJsPath}`);
  }
  if (!fs.existsSync(webviewIndexJsPath)) {
    throw new Error(`未找到 Claude Code WebView 入口文件:${webviewIndexJsPath}`);
  }
  const v = parseVersion(path.basename(extensionDir));
  return {
    extensionDir,
    extensionJsPath,
    webviewIndexJsPath,
    enhanceJsPath: path.join(extensionDir, 'webview', ENHANCE_TARGET_NAME),
    version: v.length ? v.join('.') : 'unknown',
  };
}

function findLatestClaudeCodeExtension(home) {
  const root = extensionRoot(home);
  if (!fs.existsSync(root)) {
    throw new Error(`未找到 VS Code 扩展目录:${root}`);
  }
  const names = fs.readdirSync(root)
    .filter(n => n.startsWith(CLAUDE_CODE_EXTENSION_PREFIX));
  const candidates = [];
  for (const n of names) {
    const p = path.join(root, n);
    try {
      if (fs.statSync(p).isDirectory()) candidates.push(p);
    } catch (_) {}
  }
  if (!candidates.length) {
    throw new Error('未检测到 Claude Code for VS Code 扩展。');
  }
  candidates.sort((a, b) => {
    const cmp = compareVersionTuples(
      parseVersion(path.basename(a)),
      parseVersion(path.basename(b)),
    );
    if (cmp !== 0) return cmp;
    return fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs;
  });
  return buildTarget(candidates[candidates.length - 1]);
}

// ============================================================
// asset copying
// ============================================================

function resourceFilePath(resourceRoot, relativePath) {
  const p = path.join(resourceRoot, relativePath);
  if (!fs.existsSync(p)) {
    throw new Error(`未找到内置资源文件:${p}`);
  }
  return p;
}

// Copy by content. Preserve mtime and return whether a write occurred.
//
// Fast path: if the destination already exists with the same size and mtime
// as the source, skip reading both files entirely. Previously this function
// always read both files in full on every install, which multiplied the
// hundred-plus KaTeX / hljs / font bundle files into hundreds of megabytes
// of redundant I/O on the common "nothing changed" path.
function copyIfChanged(srcPath, dstPath) {
  fs.mkdirSync(path.dirname(dstPath), { recursive: true });
  let srcStat;
  try { srcStat = fs.statSync(srcPath); } catch { srcStat = null; }
  if (srcStat && fs.existsSync(dstPath)) {
    try {
      const dstStat = fs.statSync(dstPath);
      // Use a 1-second tolerance. Windows NTFS stores timestamps at 100ns
      // resolution but Node's `utimesSync` rounds through floating-point
      // milliseconds, and FAT32/exFAT only have 2-second granularity.
      if (dstStat.size === srcStat.size &&
          Math.abs(dstStat.mtimeMs - srcStat.mtimeMs) < 1000) {
        return false;
      }
    } catch { /* fall through to byte compare */ }
  }
  const srcBytes = fs.readFileSync(srcPath);
  if (fs.existsSync(dstPath)) {
    try {
      const dstBytes = fs.readFileSync(dstPath);
      if (dstBytes.equals(srcBytes)) {
        // Content identical but stat differs — refresh mtime so the fast
        // path catches it next run.
        if (srcStat) {
          try { fs.utimesSync(dstPath, srcStat.atime, srcStat.mtime); } catch (_) {}
        }
        return false;
      }
    } catch { /* fall through to write */ }
  }
  fs.writeFileSync(dstPath, srcBytes);
  if (srcStat) {
    try { fs.utimesSync(dstPath, srcStat.atime, srcStat.mtime); } catch (_) {}
  }
  return true;
}

// Recursively list all files relative to `root`.
function walkFiles(root) {
  const out = [];
  function walk(dir, rel) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) walk(full, r);
      else if (e.isFile()) out.push(r);
    }
  }
  walk(root, '');
  return out;
}

function syncAssetTree(sourceRoot, targetRoot) {
  if (!fs.existsSync(sourceRoot)) {
    throw new Error(`未找到内置资源目录:${sourceRoot}`);
  }
  const rels = walkFiles(sourceRoot);
  const wanted = new Set(rels.map(rel => rel.split(path.sep).join('/')));
  let written = 0;
  for (const rel of rels) {
    const src = path.join(sourceRoot, rel);
    const dst = path.join(targetRoot, rel);
    if (copyIfChanged(src, dst)) written++;
  }
  // Prune any file under `targetRoot` that is no longer in the source set.
  // This is how we cleanly remove bundle files that past versions shipped
  // but the current release does not (e.g. `tex-svg-full.js` after we
  // switched to `tex-chtml-full.js`).
  if (fs.existsSync(targetRoot)) {
    const existing = walkFiles(targetRoot);
    for (const rel of existing) {
      const key = rel.split(path.sep).join('/');
      if (!wanted.has(key)) {
        try { fs.unlinkSync(path.join(targetRoot, rel)); } catch { /* best-effort */ }
      }
    }
    pruneEmptyDirs(targetRoot);
  }
  return [written, rels.length];
}

function pruneEmptyDirs(root) {
  if (!fs.existsSync(root)) return;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const child = path.join(root, entry.name);
      pruneEmptyDirs(child);
      try {
        if (fs.readdirSync(child).length === 0) fs.rmdirSync(child);
      } catch { /* best-effort */ }
    }
  }
}

// ============================================================
// system font installation
// ============================================================

// Left-pad status labels to a shared width. Treat common CJK glyphs as double width.
function padLabel(label, width = 16) {
  let w = 0;
  for (const ch of label) {
    // Count BMP CJK blocks and common full-width punctuation as double width.
    const c = ch.codePointAt(0);
    if (
      (c >= 0x1100 && c <= 0x115F) ||
      (c >= 0x2E80 && c <= 0x9FFF) ||
      (c >= 0xAC00 && c <= 0xD7A3) ||
      (c >= 0xF900 && c <= 0xFAFF) ||
      (c >= 0xFE30 && c <= 0xFE4F) ||
      (c >= 0xFF00 && c <= 0xFF60) ||
      (c >= 0xFFE0 && c <= 0xFFE6)
    ) w += 2;
    else w += 1;
  }
  if (w >= width) return label;
  return label + ' '.repeat(width - w);
}

function installSerifSystemFonts(resourceRoot) {
  const fontDir = userFontDir();
  try {
    fs.mkdirSync(fontDir, { recursive: true });
  } catch (_) {
    return 0;
  }

  let written = 0;
  const installedPaths = [];
  for (const [fileName, subdir, displayName] of SYSTEM_FONT_FILES) {
    const src = path.join(resourceRoot, 'data', 'system-fonts', subdir, fileName);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(fontDir, fileName);
    const srcBytes = fs.readFileSync(src);
    let same = false;
    if (fs.existsSync(dst)) {
      try {
        same = fs.readFileSync(dst).equals(srcBytes);
      } catch (_) {}
    }
    if (!same) {
      fs.writeFileSync(dst, srcBytes);
      written++;
    }
    installedPaths.push([displayName, dst]);

    // Register fonts under `HKCU\...\Fonts` so admin rights are not required.
    if (process.platform === 'win32') {
      try {
        cp.execFileSync(
          'reg',
          [
            'add',
            'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
            '/v', displayName,
            '/t', 'REG_SZ',
            '/d', dst,
            '/f',
          ],
          { stdio: 'ignore' },
        );
      } catch (_) {}
    }
  }

  // Refresh the Linux font cache when `fc-cache` is available.
  if (process.platform === 'linux' && written > 0) {
    try {
      cp.execFileSync('fc-cache', ['-f', fontDir], { stdio: 'ignore' });
    } catch (_) {
      // Missing `fc-cache` is acceptable. Most desktop environments will
      // rescan `~/.local/share/fonts/` later.
    }
  }

  // macOS does not require an explicit refresh.

  return written;
}

// ============================================================
// settings.json: `chat.fontFamily` / `chat.fontSize`
// ============================================================

// Return whether either setting changed.
function setChatFontToSerif() {
  const settingsPath = vscodeUserSettingsPath();
  const parent = path.dirname(settingsPath);
  if (!fs.existsSync(parent)) {
    // Skip when the VS Code user settings directory does not exist yet.
    return false;
  }

  let data = {};
  if (fs.existsSync(settingsPath)) {
    try {
      const text = fs.readFileSync(settingsPath, 'utf8');
      data = text.trim() ? JSON.parse(text) : {};
    } catch (_) {
      // Skip JSONC or other non-JSON content rather than overwriting it.
      return false;
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      return false;
    }
  }

  if (
    data['chat.fontFamily'] === CHAT_FONT_FAMILY_STACK &&
    data['chat.fontSize'] === CHAT_FONT_SIZE
  ) {
    return false;
  }

  data['chat.fontFamily'] = CHAT_FONT_FAMILY_STACK;
  data['chat.fontSize'] = CHAT_FONT_SIZE;
  fs.mkdirSync(parent, { recursive: true });
  fs.writeFileSync(
    settingsPath,
    JSON.stringify(data, null, 4) + '\n',
    'utf8',
  );
  return true;
}

// ============================================================
// `extension.js` / `webview/index.js` patching
// ============================================================

function patchRequiredPattern(content, { pattern, alreadyPattern, label, replacementSuffix }) {
  if (pattern.test(content)) {
    const updated = content.replace(pattern, m => m + replacementSuffix);
    return [updated, `${padLabel(label)}: 已写入`];
  }
  if (alreadyPattern.test(content)) {
    return [content, `${padLabel(label)}: 已存在`];
  }
  throw new Error(`Claude Code 扩展结构已变化,未找到 ${label} 的可补丁位置。`);
}

function patchUniqueReplace(content, { pattern, alreadyPattern, label, replace }) {
  if (alreadyPattern.test(content)) {
    return [content, `${padLabel(label)}: 已存在`];
  }
  const matches = content.match(pattern) || [];
  if (matches.length !== 1) {
    throw new Error(`Claude Code 扩展结构已变化,未找到唯一的 ${label} 可补丁位置。`);
  }
  const updated = replace(content);
  return [updated, `${padLabel(label)}: 已写入`];
}

function patchExtensionJs(content) {
  let updated = content;
  const statusLines = [];

  // Remove any legacy `<script src="enhance.js">` injection residue.
  const legacyCount = (updated.match(ENHANCE_SCRIPT_TAG_RE) || []).length;
  updated = updated.replace(ENHANCE_SCRIPT_TAG_RE, '');
  statusLines.push(
    legacyCount > 0
      ? `${padLabel('旧脚本注入清理')}: 已移除`
      : `${padLabel('旧脚本注入清理')}: 未发现`,
  );

  // Extend `style-src`, `script-src`, and `font-src` with `cdnjs`.
  let status;
  [updated, status] = patchRequiredPattern(updated, {
    pattern: STYLE_CSP_PATTERN,
    alreadyPattern: STYLE_CSP_PATCHED_RE,
    label: 'style-src',
    replacementSuffix: ` ${CDN_HOST}`,
  });
  statusLines.push(status);

  [updated, status] = patchRequiredPattern(updated, {
    pattern: SCRIPT_CSP_PATTERN,
    alreadyPattern: SCRIPT_CSP_PATCHED_RE,
    label: 'script-src',
    replacementSuffix: ` ${CDN_HOST}`,
  });
  statusLines.push(status);

  [updated, status] = patchRequiredPattern(updated, {
    pattern: FONT_CSP_PATTERN,
    alreadyPattern: FONT_CSP_PATCHED_RE,
    label: 'font-src',
    replacementSuffix: ` ${CDN_HOST} data:`,
  });
  statusLines.push(status);

  // Remove the legacy module-load diagnostic probe.
  updated = updated.replace(LEGACY_MODLOAD_RE, '');

  // Replace the cache badge IIFE on both injection paths.
  updated = updated.replace(BADGE_STRIP_VIEW_RE, '$1');
  updated = updated.replace(BADGE_STRIP_PANEL_RE, '$1');
  updated = updated.replace(BADGE_REQUIRE_VIEW_RE, '$1');
  updated = updated.replace(BADGE_REQUIRE_PANEL_RE, '$1');
  let statusBadge;
  [updated, statusBadge] = patchUniqueReplace(updated, {
    pattern: BADGE_COMM_ATTACH_PATTERN,
    alreadyPattern: BADGE_COMM_ATTACH_PATCHED_RE,
    label: '徽章注入(comm)',
    replace(text) {
      return text.replace(
        /this\.webview=([A-Za-z_$][\w$]*);/,
        match => match + HOST_BADGE_COMM_ATTACH,
      );
    },
  });
  statusLines.push(statusBadge);

  return [updated, statusLines];
}

function patchMarkdownChildren(content) {
  const stripped = content.replace(
    MARKDOWN_LEGACY_CHILDREN_RE,
    '$1=$.children||""',
  );
  return patchUniqueReplace(stripped, {
    pattern: MARKDOWN_ASSIGN_PATTERN,
    alreadyPattern: MARKDOWN_ASSIGN_PATCHED_RE,
    label: 'markdown 预处理',
    replace(text) {
      return text.replace(
        MARKDOWN_ASSIGN_PATTERN,
        'if(typeof $1==="string"){if(window.__CLAUDE_ENHANCE_PREPROCESS_MARKDOWN__)$1=window.__CLAUDE_ENHANCE_PREPROCESS_MARKDOWN__($1);$2.value=$1;}else $3("Unexpected value `"+$1+"` for `children` prop, expected `string`")',
      );
    },
  });
}

function patchWebviewIndex(content) {
  let [updated, markdownStatus] = patchMarkdownChildren(content);
  const statusLines = [markdownStatus];

  // Remove the legacy `acquireVsCodeApi` idempotency wrapper that earlier
  // development builds prepended to this file. Its only consumer has been
  // removed, so the line is stripped if present.
  updated = updated.replace(
    /\(function\(\)\{if\(window\.__cceApiWrap\)[\s\S]*?\}\)\(\);\n/,
    '',
  );

  const hasDynamicImport = DYNAMIC_IMPORT_RE.test(updated);
  const hasStaticImport = STATIC_IMPORT_RE.test(updated);

  if (hasStaticImport) {
    updated = updated.replace(STATIC_IMPORT_RE, '\n');
  }

  if (hasDynamicImport) {
    statusLines.push(`${padLabel('enhance.js 注入')}: 已存在`);
    return [updated, statusLines];
  }
  updated = updated.replace(/\s+$/, '') + '\n' + IMPORT_MARKER + '\n';
  statusLines.push(
    `${padLabel('enhance.js 注入')}: ${hasStaticImport ? '已替换旧版' : '已写入'}`,
  );
  return [updated, statusLines];
}

// ============================================================
// main install flow
// ============================================================

function installClaudeCodeVSCodeEnhance(resourceRoot, options = {}) {
  const { home = null } = options;
  const target = findLatestClaudeCodeExtension(home);
  const webviewDir = path.dirname(target.webviewIndexJsPath);

  const rootResourceStatuses = [];
  let enhanceScriptWritten = false;
  for (const [relativePath, targetName] of ROOT_WEBVIEW_FILES) {
    const src = resourceFilePath(resourceRoot, relativePath);
    const dst = path.join(webviewDir, targetName);
    const written = copyIfChanged(src, dst);
    if (targetName === ENHANCE_TARGET_NAME) enhanceScriptWritten = written;
    const label = `${targetName} 复制`;
    rootResourceStatuses.push(
      written
        ? `${padLabel(label)}: 已写入`
        : `${padLabel(label)}: 已存在`,
    );
  }

  // Prune any legacy asset subtrees that earlier versions used to ship.
  for (const legacy of LEGACY_ASSET_TREES) {
    const legacyDir = path.join(webviewDir, legacy);
    if (fs.existsSync(legacyDir)) {
      fs.rmSync(legacyDir, { recursive: true, force: true });
    }
  }

  // Local asset subtrees: `mathjax`, `hljs`, and `fonts`.
  let assetWrittenTotal = 0;
  let assetTotal = 0;
  const assetStatusLines = [];
  for (const treeName of LOCAL_ASSET_TREES) {
    const srcTree = path.join(resourceRoot, 'data', treeName);
    const dstTree = path.join(webviewDir, treeName);
    const [written, total] = syncAssetTree(srcTree, dstTree);
    assetWrittenTotal += written;
    assetTotal += total;
    const label = `${treeName} 资源`;
    assetStatusLines.push(
      written === 0
        ? `${padLabel(label)}: 已存在 (${total} 个)`
        : `${padLabel(label)}: 已写入 ${written}/${total}`,
    );
  }

  // `extension.js`
  const extJsOriginal = fs.readFileSync(target.extensionJsPath, 'utf8');
  const [extJsUpdatedText, extStatusLines] = patchExtensionJs(extJsOriginal);
  const extJsUpdated = extJsUpdatedText !== extJsOriginal;
  if (extJsUpdated) {
    fs.writeFileSync(target.extensionJsPath, extJsUpdatedText, 'utf8');
  }

  // `webview/index.js`
  const webviewOriginal = fs.readFileSync(target.webviewIndexJsPath, 'utf8');
  const [webviewUpdatedText, webviewStatusLines] = patchWebviewIndex(webviewOriginal);
  const webviewUpdated = webviewUpdatedText !== webviewOriginal;
  if (webviewUpdated) {
    fs.writeFileSync(target.webviewIndexJsPath, webviewUpdatedText, 'utf8');
  }

  // System fonts plus `chat.fontFamily` / `chat.fontSize`.
  const serifWritten = installSerifSystemFonts(resourceRoot);
  const chatFontUpdated = setChatFontToSerif();
  const serifStatus = serifWritten > 0
    ? `已写入 ${serifWritten}/${SYSTEM_FONT_FILES.length}`
    : `已存在 (${SYSTEM_FONT_FILES.length} 个)`;
  const chatFontStatus = chatFontUpdated ? `已更新 → Plex Serif ${CHAT_FONT_SIZE}px` : '已是目标值';

  const statusLines = [
    ...rootResourceStatuses,
    ...assetStatusLines,
    ...extStatusLines,
    ...webviewStatusLines,
    `${padLabel('serif 系统字体')}: ${serifStatus}`,
    `${padLabel('chat.fontFamily')}: ${chatFontStatus}`,
  ];

  return {
    target,
    enhanceScriptWritten,
    extensionJsUpdated: extJsUpdated,
    webviewIndexUpdated: webviewUpdated,
    assetFilesWritten: assetWrittenTotal,
    assetFilesTotal: assetTotal,
    serifFontsInstalled: serifWritten,
    chatFontSettingUpdated: chatFontUpdated,
    statusLines,
  };
}

module.exports = {
  CLAUDE_CODE_EXTENSION_PREFIX,
  SYSTEM_FONT_FILES,
  CHAT_FONT_SETTING_KEYS,
  extensionRoot,
  vscodeUserSettingsPath,
  userFontDir,
  findLatestClaudeCodeExtension,
  installClaudeCodeVSCodeEnhance,
  padLabel,
};
