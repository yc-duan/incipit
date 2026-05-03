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

const {
  getFeatures,
  getTheme,
  getLanguage,
  pruneRetiredConfigKeys,
  BODY_FONT_SIZE_OPTIONS,
} = require('./config');
const { t } = require('./i18n');

const CLAUDE_CODE_EXTENSION_PREFIX = 'anthropic.claude-code-';
const ENHANCE_TARGET_NAME = 'enhance.js';
const THEME_TARGET_NAME = 'theme.css';

// Root-level webview files as `[sourceRelativePath, targetFileName]`.
// `theme.css` stays separate from the JS template string so CSS comments and
// backticks cannot terminate the template by accident.
const ROOT_WEBVIEW_FILES = [
  [path.join('data', 'claude_code_enhance.js'), ENHANCE_TARGET_NAME],
  [path.join('data', 'enhance_shared.js'),      'enhance_shared.js'],
  [path.join('data', 'enhance_footer_badge.js'), 'enhance_footer_badge.js'],
  [path.join('data', 'enhance_thinking.js'),    'enhance_thinking.js'],
  [path.join('data', 'enhance_typography.js'),  'enhance_typography.js'],
  [path.join('data', 'enhance_legacy.js'),      'enhance_legacy.js'],
  [path.join('data', 'host_probe.js'),           'host_probe.js'],
  [path.join('data', 'host-badge.cjs'),          'host-badge.cjs'],
  [path.join('data', 'math_tokens.js'),         'math_tokens.js'],
  [path.join('data', 'math_rewriter.js'),       'math_rewriter.js'],
  [path.join('data', 'theme.css'),              THEME_TARGET_NAME],
  // Warm-white palette overrides. Always copied so users can flip the
  // setting without re-running apply just to ship the CSS file. enhance.js
  // only loads this stylesheet when `theme.palette === 'warm-white'`.
  [path.join('data', 'warm-white-override.css'), 'warm-white-override.css'],
];

const CDN_HOST = 'https://cdnjs.cloudflare.com';
const IMPORT_MARKER =
  'import("./enhance.js").catch(e=>console.error("[incipit] enhance.js import failed",e));';
// Local asset subtrees copied from `data/<name>/` to `webview/<name>/`.
// Sync the whole subtree so math, highlighting, and fonts work offline.
const LOCAL_ASSET_TREES = ['katex', 'hljs', 'fonts', 'effort-brain'];
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
const CHAT_FONT_SIZE = 13;

// Default chat input font stack, used when theme bodyFontFamily is unavailable.
const CHAT_FONT_FAMILY_STACK_DEFAULT =
  "'IBM Plex Serif', Georgia, " +
  "'Microsoft YaHei UI', 'Microsoft YaHei', " +
  "'PingFang SC', system-ui, serif";

function sanitizeFontFamilyValue(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // Reject characters that can terminate or corrupt a single persisted
  // font-family setting value when forwarded into settings.json or CSS.
  if (/[;{}\r\n]/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function buildChatFontFamilyStack(theme) {
  const bodyCss = theme && theme.bodyFontFamily && theme.bodyFontFamily.css;
  const sanitized = sanitizeFontFamilyValue(bodyCss);
  if (sanitized) {
    return sanitized;
  }
  return CHAT_FONT_FAMILY_STACK_DEFAULT;
}

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

// Give the host's Monaco diff editor an incipit-owned theme, font, and gutter.
// Claude Code 2.1.x hard-codes both inline and expanded Edit diff editors to
// `theme:"vs-dark"` and `fontSize:12`, which makes warm-white render a dark
// Monaco island using the default editor font, and `lineNumbers:"off"`, which
// leaves inline diff rows with `--` placeholders instead of a useful gutter.
// We patch those options to use a bundled GitHub-like Monaco theme, Rec Mono
// Linear, Monaco's native line-number geometry, and a zero-width
// `lineDecorationsWidth` lane. That last option removes the 10px +/- glyph
// column Monaco keeps between the line numbers and code; with incipit's own
// diff gutter overlay, leaving the lane in place creates an uncolored seam in
// changed rows. The theme helper is installed in the generated webview preamble
// and falls back to Monaco's built-in `vs` / `vs-dark` themes if the private
// bundle shape changes.
const WEBVIEW_CONFIG_RE =
  /^\/\/ incipit webview config \(generated at apply; do not edit\)\r?\n[\s\S]*?\r?\n\r?\n/;
const MONACO_DIFF_LIGHT_THEME = 'incipit-github-light';
const MONACO_DIFF_DARK_THEME = 'incipit-github-dark';
const MONACO_DIFF_THEME_FALLBACK_EXPR =
  '(globalThis.__incipitConfig&&globalThis.__incipitConfig.theme&&globalThis.__incipitConfig.theme.palette==="warm-white"?"vs":"vs-dark")';
const MONACO_DIFF_THEME_EXPR =
  `(globalThis.__incipitPickMonacoDiffTheme?globalThis.__incipitPickMonacoDiffTheme(m$):${MONACO_DIFF_THEME_FALLBACK_EXPR})`;
const MONACO_DIFF_THEME_HARDCODED_RE = /theme:"vs-dark"/g;
const MONACO_DIFF_THEME_LEGACY_PATCHED_RE =
  /theme:\(globalThis\.__incipitConfig&&globalThis\.__incipitConfig\.theme&&globalThis\.__incipitConfig\.theme\.palette==="warm-white"\?"vs":"vs-dark"\)/g;
const MONACO_DIFF_THEME_PATCHED_RE =
  /theme:\(globalThis\.__incipitPickMonacoDiffTheme\?globalThis\.__incipitPickMonacoDiffTheme\(m\$\):\(globalThis\.__incipitConfig&&globalThis\.__incipitConfig\.theme&&globalThis\.__incipitConfig\.theme\.palette==="warm-white"\?"vs":"vs-dark"\)\)/g;
const MONACO_DIFF_FONT_OPTIONS =
  'fontSize:12,fontFamily:"\'Rec Mono Linear\', Consolas, Monaco, \'Courier New\', monospace",fontLigatures:false,fontVariations:"\\"MONO\\" 1, \\"CASL\\" 0, \\"slnt\\" 0"';
const MONACO_DIFF_FONT_LAYOUT_OPTIONS =
  `${MONACO_DIFF_FONT_OPTIONS},lineNumbers:"on",lineDecorationsWidth:0`;
const MONACO_DIFF_FONT_HARDCODED_RE = /fontSize:12,lineNumbers:"off"/g;
const MONACO_DIFF_FONT_LEGACY_PATCHED_RE =
  /fontSize:12,fontFamily:"'Rec Mono Linear', Consolas, Monaco, 'Courier New', monospace",fontLigatures:false,fontVariations:"\\"MONO\\" 1, \\"CASL\\" 0, \\"slnt\\" 0",lineNumbers:"off"/g;
const MONACO_DIFF_FONT_OLD_PATCHED_RE =
  /fontSize:12,fontFamily:"'Rec Mono Linear', Consolas, Monaco, 'Courier New', monospace",fontLigatures:false,fontVariations:"\\"MONO\\" 1, \\"CASL\\" 0, \\"slnt\\" 0",lineNumbers:"on"(?!,lineDecorationsWidth:0)/g;
const MONACO_DIFF_FONT_PATCHED_RE =
  /fontSize:12,fontFamily:"'Rec Mono Linear', Consolas, Monaco, 'Courier New', monospace",fontLigatures:false,fontVariations:"\\"MONO\\" 1, \\"CASL\\" 0, \\"slnt\\" 0",lineNumbers:"on",lineDecorationsWidth:0/g;
const MONACO_DIFF_WORD_WRAP_HARDCODED_RE = /wordWrap:"on",wrappingIndent:"same"/g;
const MONACO_DIFF_WORD_WRAP_PATCHED_RE = /wordWrap:"off",wrappingIndent:"same"/g;
const MONACO_DIFF_OVERVIEW_HARDCODED_RE =
  /readOnly:!0,renderSideBySide:!0,renderOverviewRuler:!0/g;
const MONACO_DIFF_OVERVIEW_PATCHED_RE =
  /readOnly:!0,renderSideBySide:!0,renderOverviewRuler:!1/g;
const MONACO_DIFF_OVERVIEW_INLINE_LAYOUT_PATCHED_RE =
  /readOnly:!0,renderSideBySide:!1,renderOverviewRuler:!1/g;
const MONACO_DIFF_INLINE_LAYOUT_HARDCODED_RE =
  /([\w$]+\.createDiffEditor\([^,]+,\{readOnly:!0,)renderSideBySide:!0(,renderOverviewRuler:!1,[\s\S]{0,1800}?lightbulb:\{enabled:[\w$]+\.ShowLightbulbIconMode\.Off\})/g;
const MONACO_DIFF_INLINE_LAYOUT_PATCHED_RE =
  /[\w$]+\.createDiffEditor\([^,]+,\{readOnly:!0,renderSideBySide:!1,renderOverviewRuler:!1,[\s\S]{0,1800}?lightbulb:\{enabled:[\w$]+\.ShowLightbulbIconMode\.Off\}/g;
const MONACO_DIFF_INLINE_RESIZE_HARDCODED_RE =
  /([\w$]+)\(!([\w$]+)\),([\w$]+)\.updateOptions\(\{renderSideBySide:\2\}\)/g;
const MONACO_DIFF_INLINE_RESIZE_PATCHED_RE =
  /[\w$]+\(!0\),[\w$]+\.updateOptions\(\{renderSideBySide:!1\}\)/g;
const MONACO_DIFF_MODAL_LAYOUT_HARDCODED_RE =
  /([\w$]+\.createDiffEditor\([^,]+,\{readOnly:!0,)renderSideBySide:!0(,renderOverviewRuler:!1,[\s\S]{0,1800}?scrollbar:\{vertical:"auto",horizontal:"(?:auto|hidden)"\})/g;
const MONACO_DIFF_MODAL_LAYOUT_PATCHED_RE =
  /[\w$]+\.createDiffEditor\([^,]+,\{readOnly:!0,renderSideBySide:!1,renderOverviewRuler:!1,[\s\S]{0,1800}?scrollbar:\{vertical:"auto",horizontal:"(?:auto|hidden)"\}/g;
const MONACO_DIFF_MODAL_SCROLLBAR_HARDCODED_RE =
  /scrollbar:\{vertical:"auto",horizontal:"auto"\}/g;
const MONACO_DIFF_MODAL_SCROLLBAR_LEGACY_HIDDEN_RE =
  /scrollbar:\{vertical:"auto",horizontal:"hidden"\}/g;
const MONACO_DIFF_THEMES = Object.freeze({
  [MONACO_DIFF_LIGHT_THEME]: {
    base: 'vs',
    inherit: true,
    rules: [
      // Syntax foregrounds mirror highlight.js `vs.min.css`; diff line and
      // char backgrounds below intentionally stay GitHub-like. Do not use
      // pure #ff0000 for attributes here: it collapses on removed-char red.
      { token: '', foreground: '000000' },
      // Monaco's built-in `vs` theme styles Markdown `strong` as bold and
      // `emphasis` as italic. Diff editors show source text, not rendered
      // Markdown, so reset typographic token styles to regular weight/slant.
      { token: 'strong', fontStyle: '' },
      { token: 'emphasis', fontStyle: '' },
      { token: 'bold', fontStyle: '' },
      { token: 'italic', fontStyle: '' },
      { token: 'markup.bold', fontStyle: '' },
      { token: 'markup.italic', fontStyle: '' },
      { token: 'markup.heading', fontStyle: '' },
      { token: 'heading', fontStyle: '' },
      { token: 'comment', foreground: '008000' },
      { token: 'quote', foreground: '008000' },
      { token: 'variable', foreground: '008000' },
      { token: 'variable.predefined', foreground: '008000' },
      { token: 'keyword', foreground: '0000ff' },
      { token: 'operator', foreground: '0000ff' },
      { token: 'name', foreground: '0000ff' },
      { token: 'tag', foreground: '0000ff' },
      { token: 'selector', foreground: '0000ff' },
      { token: 'constant', foreground: 'a31515' },
      { token: 'literal', foreground: 'a31515' },
      { token: 'number', foreground: 'a31515' },
      { token: 'string', foreground: 'a31515' },
      { token: 'type', foreground: 'a31515' },
      { token: 'class', foreground: 'a31515' },
      { token: 'interface', foreground: 'a31515' },
      { token: 'namespace', foreground: 'a31515' },
      { token: 'function', foreground: 'a31515' },
      { token: 'attribute.name', foreground: 'a31515' },
      { token: 'attribute.value', foreground: 'a31515' },
      { token: 'regexp', foreground: 'a31515' },
      { token: 'meta', foreground: '2b91af' },
      { token: 'delimiter', foreground: '000000' },
    ],
    colors: {
      'editor.background': '#fafaf5',
      'editor.foreground': '#1f2328',
      'editorGutter.background': '#fafaf5',
      'editorLineNumber.foreground': '#6e7781',
      'editorLineNumber.activeForeground': '#24292f',
      'editor.lineHighlightBackground': '#00000000',
      'editor.lineHighlightBorder': '#00000000',
      'editor.selectionBackground': '#0969da30',
      'editor.inactiveSelectionBackground': '#0969da20',
      'editorIndentGuide.background1': '#00000000',
      'editorIndentGuide.activeBackground1': '#00000000',
      'editorWhitespace.foreground': '#6e778155',
      'diffEditor.insertedLineBackground': '#dafbe180',
      'diffEditor.removedLineBackground': '#ffebe980',
      'diffEditor.insertedTextBackground': '#aceebb99',
      'diffEditor.removedTextBackground': '#ff818266',
      'diffEditor.border': '#d0d7de',
      'diffEditor.diagonalFill': '#d0d7de33',
      'scrollbarSlider.background': '#b0b0ae80',
      'scrollbarSlider.hoverBackground': '#8a8a8880',
      'scrollbarSlider.activeBackground': '#6f6f6d99',
    },
  },
  [MONACO_DIFF_DARK_THEME]: {
    base: 'vs-dark',
    inherit: true,
    rules: [
      // Syntax foregrounds mirror highlight.js `vs2015.min.css`; diff line
      // and char backgrounds below intentionally stay GitHub-like.
      { token: '', foreground: 'dcdcdc' },
      // Monaco's built-in `vs-dark` theme styles Markdown `strong` as bold
      // and `emphasis` as italic. Diff editors show source text, not rendered
      // Markdown, so reset typographic token styles to regular weight/slant.
      { token: 'strong', fontStyle: '' },
      { token: 'emphasis', fontStyle: '' },
      { token: 'bold', fontStyle: '' },
      { token: 'italic', fontStyle: '' },
      { token: 'markup.bold', fontStyle: '' },
      { token: 'markup.italic', fontStyle: '' },
      { token: 'markup.heading', fontStyle: '' },
      { token: 'heading', fontStyle: '' },
      { token: 'comment', foreground: '57a64a' },
      { token: 'quote', foreground: '57a64a' },
      { token: 'doctag', foreground: '608b4e' },
      { token: 'keyword', foreground: '569cd6' },
      { token: 'operator', foreground: '569cd6' },
      { token: 'literal', foreground: '569cd6' },
      { token: 'name', foreground: '569cd6' },
      { token: 'symbol', foreground: '569cd6' },
      { token: 'link', foreground: '569cd6' },
      { token: 'type', foreground: '4ec9b0' },
      { token: 'type.identifier', foreground: '4ec9b0' },
      { token: 'number', foreground: 'b8d7a3' },
      { token: 'class', foreground: 'b8d7a3' },
      { token: 'interface', foreground: 'b8d7a3' },
      { token: 'namespace', foreground: 'b8d7a3' },
      { token: 'string', foreground: 'd69d85' },
      { token: 'regexp', foreground: '9a5334' },
      { token: 'tag', foreground: '9b9b9b' },
      { token: 'meta', foreground: '9b9b9b' },
      { token: 'attribute.name', foreground: '9cdcfe' },
      { token: 'attribute.value', foreground: 'd69d85' },
      { token: 'variable', foreground: 'bd63c5' },
      { token: 'variable.predefined', foreground: 'bd63c5' },
      { token: 'function', foreground: 'dcdcdc' },
      { token: 'delimiter', foreground: 'dcdcdc' },
    ],
    colors: {
      'editor.background': '#1f1f1e',
      'editor.foreground': '#e6edf3',
      'editorGutter.background': '#1f1f1e',
      'editorLineNumber.foreground': '#8b949e',
      'editorLineNumber.activeForeground': '#e6edf3',
      'editor.lineHighlightBackground': '#ffffff08',
      'editor.lineHighlightBorder': '#00000000',
      'editor.selectionBackground': '#2f81f766',
      'editor.inactiveSelectionBackground': '#2f81f733',
      'editorIndentGuide.background1': '#00000000',
      'editorIndentGuide.activeBackground1': '#00000000',
      'editorWhitespace.foreground': '#8b949e55',
      'diffEditor.insertedLineBackground': '#23863633',
      'diffEditor.removedLineBackground': '#da363333',
      'diffEditor.insertedTextBackground': '#2ea04366',
      'diffEditor.removedTextBackground': '#f8514966',
      'diffEditor.border': '#30363d',
      'diffEditor.diagonalFill': '#30363d66',
      'scrollbarSlider.background': '#3c3c3c80',
      'scrollbarSlider.hoverBackground': '#5a5a5a80',
      'scrollbarSlider.activeBackground': '#6a6a6a99',
    },
  },
});

// Remove the legacy module-load diagnostic probe.
const LEGACY_MODLOAD_RE =
  /try\{require\('fs'\)\.appendFileSync\([^)]*MODULE LOADED[^)]*\)\}catch\(e\)\{\};/g;

// ============================================================
// platform paths
// ============================================================

function extensionRoot(home) {
  return path.join(home || os.homedir(), '.vscode', 'extensions');
}

// Default location of the host's user settings.json — used only as a
// fallback when no explicit `settingsPath` is threaded through. With the
// new multi-target system the explicit path is the norm; this default
// remains as a backstop for early callers and for the legacy
// "single host, default VS Code" detection path.
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

function buildTarget(extensionDir, settingsPath) {
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
    settingsPath: settingsPath || vscodeUserSettingsPath(),
    version: v.length ? v.join('.') : 'unknown',
  };
}

// Locate the latest Claude Code extension under a given extensions root.
//
// Accepts:
//   - a string (legacy positional `home` arg): treated as the user's HOME
//     directory; extensions are looked up under `<home>/.vscode/extensions`.
//   - an object `{ extensionsDir, settingsPath, home }`: explicit
//     extensions directory takes priority; `home` is the legacy fallback.
//
// The returned target carries `settingsPath` from the supplied options
// (or the platform-default `vscodeUserSettingsPath()` if absent), which
// is then threaded into apply / backup / restore.
function findLatestClaudeCodeExtension(arg) {
  let extensionsDir = null;
  let settingsPath = null;
  let home = null;
  if (typeof arg === 'string') {
    home = arg;
  } else if (arg && typeof arg === 'object') {
    extensionsDir = arg.extensionsDir || null;
    settingsPath = arg.settingsPath || null;
    home = arg.home || null;
  }
  const root = extensionsDir || extensionRoot(home);
  if (!fs.existsSync(root)) {
    throw new Error(`未找到扩展目录:${root}`);
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
    throw new Error('未检测到 Claude Code 扩展。');
  }
  candidates.sort((a, b) => {
    const cmp = compareVersionTuples(
      parseVersion(path.basename(a)),
      parseVersion(path.basename(b)),
    );
    if (cmp !== 0) return cmp;
    return fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs;
  });
  return buildTarget(candidates[candidates.length - 1], settingsPath);
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

// Copy with a text transform. Used for enhance.js (prepends a frozen
// `globalThis.__incipitConfig` preamble) and theme.css (appends a `:root`
// block carrying the body font-size). Transforms are pure functions of
// source content + user config, so destination equality with the
// transformed string is a perfect idempotency check.
function copyWithTransform(srcPath, dstPath, transform) {
  const srcContent = fs.readFileSync(srcPath, 'utf8');
  const transformed = transform(srcContent);
  if (fs.existsSync(dstPath)) {
    try {
      const existing = fs.readFileSync(dstPath, 'utf8');
      if (existing === transformed) return false;
    } catch (_) { /* fall through to write */ }
  }
  fs.mkdirSync(path.dirname(dstPath), { recursive: true });
  fs.writeFileSync(dstPath, transformed, 'utf8');
  return true;
}

function normalizeConfigLanguage(language) {
  return language === 'zh' ? 'zh' : 'en';
}

function buildIncipitConfigJSON(features, theme, language) {
  return JSON.stringify({
    features,
    theme: theme || {},
    language: normalizeConfigLanguage(language),
  });
}

function buildEnhancePreamble(features, theme, language) {
  // `theme` may be undefined for legacy callers that haven't been updated;
  // enhance.js reads `palette` defensively so missing fields fall back to
  // the dark default. Bundling theme into the same frozen config object
  // keeps a single read site in the webview.
  const json = buildIncipitConfigJSON(features, theme, language);
  return '// incipit user config (generated at apply; do not edit)\n' +
         `globalThis.__incipitConfig = Object.freeze(${json});\n\n`;
}

function buildWebviewConfigPreamble(features, theme, language) {
  // Unlike enhance.js, the host bundle can create Monaco diff editors before
  // our dynamic import has finished. Put the same config at the top of
  // webview/index.js so the patched `createDiffEditor({ theme: ... })` sees
  // the palette synchronously during first render. The Monaco theme helper is
  // also defined here because the `m$` Monaco editor namespace is local to the
  // host bundle; the patched `theme:` option passes it in lazily.
  const json = buildIncipitConfigJSON(features, theme, language);
  const diffThemes = JSON.stringify(MONACO_DIFF_THEMES);
  return '// incipit webview config (generated at apply; do not edit)\n' +
         `globalThis.__incipitConfig = Object.freeze(${json});\n` +
         `globalThis.__incipitMonacoDiffThemes = Object.freeze(${diffThemes});\n` +
         '(function(){try{var raw=globalThis.acquireVsCodeApi;if(typeof raw==="function"&&!globalThis.__incipitGetVsCodeApi){var cached=null;globalThis.__incipitGetVsCodeApi=function(){if(cached)return cached;cached=raw();return cached;};globalThis.acquireVsCodeApi=function(){return globalThis.__incipitGetVsCodeApi();};}}catch(_){}})();\n' +
         'globalThis.__incipitEnsureMonacoDiffTheme = function(monaco){try{if(!monaco||typeof monaco.defineTheme!=="function")return false;if(globalThis.__incipitMonacoDiffThemesReady)return true;var themes=globalThis.__incipitMonacoDiffThemes||{};for(var name in themes)if(Object.prototype.hasOwnProperty.call(themes,name))monaco.defineTheme(name,themes[name]);globalThis.__incipitMonacoDiffThemesReady=true;if(!globalThis.__incipitMonacoDiffFontsReady&&typeof document!=="undefined"&&document.fonts&&document.fonts.ready){globalThis.__incipitMonacoDiffFontsReady=true;document.fonts.ready.then(function(){try{if(monaco&&typeof monaco.remeasureFonts==="function")monaco.remeasureFonts();}catch(_){}});}return true;}catch(e){try{console.warn("[incipit] Monaco diff theme setup failed",e);}catch(_){}return false;}};\n' +
         `globalThis.__incipitPickMonacoDiffTheme = function(monaco){var light=globalThis.__incipitConfig&&globalThis.__incipitConfig.theme&&globalThis.__incipitConfig.theme.palette==="warm-white";var ok=globalThis.__incipitEnsureMonacoDiffTheme&&globalThis.__incipitEnsureMonacoDiffTheme(monaco);return ok?(light?"${MONACO_DIFF_LIGHT_THEME}":"${MONACO_DIFF_DARK_THEME}"):(light?"vs":"vs-dark");};\n\n`;
}

function buildThemeOverrideBlock(theme) {
  const rawBody = theme.bodyFontFamily && theme.bodyFontFamily.css;
  const rawCode = theme.codeFontFamily && theme.codeFontFamily.css;
  const bodyFont = sanitizeFontFamilyValue(rawBody)
    || "'Reading', 'IBM Plex Serif', 'Noto Sans SC', 'Microsoft YaHei UI', 'Microsoft YaHei', 'PingFang SC', system-ui, serif";
  const codeFont = sanitizeFontFamilyValue(rawCode)
    || "'Rec Mono Linear', 'Noto Sans SC', 'Microsoft YaHei UI', 'Microsoft YaHei', Consolas, Monaco, 'Courier New', monospace";
  return '\n\n/* incipit user theme overrides (generated at apply; do not edit) */\n' +
         ':root {\n' +
         `  --incipit-body-size: ${theme.bodyFontSize}px;\n` +
         `  --incipit-body-font: ${bodyFont};\n` +
         `  --incipit-code-font: ${codeFont};\n` +
         '}\n';
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

// Return whether either setting changed. `fontSize` must be one of the
// discrete body-size options; the caller is expected to pass `getTheme()
// .bodyFontSize` but a stray value falls back to the default. `theme` is
// used to read the configured body font family for the chat input stack.
// Explicit `settingsPath` overrides the platform-default fallback — that
// is how custom (Cursor / Scoop / portable) targets get their settings.json.
function setChatFontToSerif(fontSize, theme, settingsPath) {
  const size = BODY_FONT_SIZE_OPTIONS.includes(fontSize) ? fontSize : CHAT_FONT_SIZE;
  const fontFamily = buildChatFontFamilyStack(theme);
  const path_ = settingsPath || vscodeUserSettingsPath();
  return writeChatFontSettings(path_, size, fontFamily);
}

function writeChatFontSettings(settingsPath, size, fontFamily) {
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
    data['chat.fontFamily'] === fontFamily &&
    data['chat.fontSize'] === size
  ) {
    return false;
  }

  data['chat.fontFamily'] = fontFamily;
  data['chat.fontSize'] = size;
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

// Render-blocking CSS at HTML-template level.
//
// Without this, theme.css is only injected after `enhance.js` finishes
// importing and runs `injectStyles()`. By that time the host has already
// painted with its own default theme, producing a 100 ms – 1.5 s flash
// of host-default styling on every webview open. Patching the HTML
// template adds head links that load in parallel with the host's
// own `index.css`, so the very first paint already wears incipit's
// colours.
//
// Anchor: the host template contains exactly one
//   <link href="${H}" rel="stylesheet">
// where `H` is the `vscode.Uri` for `webview/index.css`. We append our
// own links right after it; their hrefs reuse `H.toString().replace(...)`
// so we never depend on a minified-variable name beyond `H` itself
// (which is the same name the anchor already uses).
//
// Strip-and-reinject pattern: a prior apply may have written one
// palette's links; if the user later switched palette and re-runs apply,
// we strip any prior `H.toString().replace(...)` link block back to the
// bare anchor before injecting the active palette's set. Idempotent
// when the active palette already matches.
function patchExtensionHtmlHead(content, theme) {
  const palette = (theme && theme.palette) === 'warm-white' ? 'warm-white' : 'warm-black';
  const wantWarmWhite = palette === 'warm-white';

  const ANCHOR = '<link href="${H}" rel="stylesheet">';
  // Match anchor + 1..N of our own injected links (each carries the
  // unique `H.toString().replace` marker).
  const STRIP_RE =
    /(<link href="\$\{H\}" rel="stylesheet">)(?:<link [^>]*\$\{H\.toString\(\)\.replace[^>]*>)+/;
  // Single-anchor sanity check after stripping.
  const ANCHOR_RE = /<link href="\$\{H\}" rel="stylesheet">/g;

  // The replace regexes anchor to end-of-string (with optional `?` /
  // `#`) so we only match the filename segment, never a parent path
  // that happens to contain the literal "index.css".
  // Reuse the same ids that `enhance.js > injectStyles()` checks. Without
  // these ids, the first-paint head links work, but enhance.js later appends a
  // duplicate copy of the same stylesheet, forcing an avoidable CSS parse /
  // cascade pass right in the boot window.
  const themeLink =
    '<link id="claude-enhance-styles-link" href="${H.toString().replace(/index\\.css(?=$|[?#])/,\'theme.css\')}" rel="stylesheet">';
  const wwLink = wantWarmWhite
    ? '<link id="incipit-warm-white-link" href="${H.toString().replace(/index\\.css(?=$|[?#])/,\'warm-white-override.css\')}" rel="stylesheet">'
    : '';
  // NOTE — `modulepreload` was tried as a third hint to start fetching
  // enhance.js in parallel with index.js, but webview CSP is
  // `script-src 'nonce-${D}' https://cdnjs.cloudflare.com` (no 'self'),
  // so a `<link rel="modulepreload">` without a nonce is blocked by
  // CSP. Chromium then poisons the module cache for that URL, and the
  // subsequent dynamic `import('./enhance.js')` from inside index.js
  // also fails — enhance.js never runs, host_probe never sets
  // `data-incipit-*` attributes, and theme.css's selectors fail to
  // match, leaving the page looking like the host default. Do not
  // re-add modulepreload here unless we also write the per-request
  // nonce into the link tag (currently we have no clean way to thread
  // `${D}` into the patched fragment without more parser surgery).

  const desired = ANCHOR + themeLink + wwLink;

  // Always strip-and-reinject. Using `content.includes(desired)` as
  // the "already" check was wrong because `desired` could be a prefix
  // of the actual patched block (e.g., a previous apply added an
  // extra link after `desired`); `includes` would return true and
  // the stale extra link would be left in place. Strip first, then
  // compare the stripped text to "what would be patched fresh" — if
  // they're equivalent we report 已存在 without writing.
  const stripped = content.replace(STRIP_RE, '$1');
  const baseMatches = stripped.match(ANCHOR_RE) || [];
  if (baseMatches.length !== 1) {
    throw new Error(
      `HTML head anchor not unique after strip (found ${baseMatches.length}); ` +
      'aborting head-link patch.',
    );
  }

  const updated = stripped.replace(ANCHOR, desired);
  if (updated === content) {
    return [content, `${padLabel('HTML head 提速')}: 已存在 (${palette})`];
  }
  return [updated, `${padLabel('HTML head 提速')}: 已写入 (${palette})`];
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

function patchWebviewConfig(content, features, theme, language) {
  const preamble = buildWebviewConfigPreamble(features, theme, language);
  const hadPreamble = WEBVIEW_CONFIG_RE.test(content);
  const stripped = content.replace(WEBVIEW_CONFIG_RE, '');
  const updated = preamble + stripped;
  if (updated === content) {
    return [content, `${padLabel('webview config')}: 已存在`];
  }
  return [
    updated,
    `${padLabel('webview config')}: ${hadPreamble ? '已更新' : '已写入'}`,
  ];
}

function patchMonacoDiffTheme(content) {
  const hardcoded = (content.match(MONACO_DIFF_THEME_HARDCODED_RE) || []).length;
  const legacyPatched = (content.match(MONACO_DIFF_THEME_LEGACY_PATCHED_RE) || []).length;
  const patched = (content.match(MONACO_DIFF_THEME_PATCHED_RE) || []).length;
  if (hardcoded === 0 && legacyPatched === 0 && patched === 2) {
    return [content, `${padLabel('diff 主题')}: 已存在`];
  }
  if (hardcoded + legacyPatched + patched !== 2) {
    throw new Error(`Claude Code 扩展结构已变化,未找到唯一的 diff 主题可补丁位置。`);
  }
  const updated = content
    .replace(MONACO_DIFF_THEME_HARDCODED_RE, `theme:${MONACO_DIFF_THEME_EXPR}`)
    .replace(MONACO_DIFF_THEME_LEGACY_PATCHED_RE, `theme:${MONACO_DIFF_THEME_EXPR}`);
  return [
    updated,
    `${padLabel('diff 主题')}: 已写入`,
  ];
}

function patchMonacoDiffFont(content) {
  const hardcoded = (content.match(MONACO_DIFF_FONT_HARDCODED_RE) || []).length;
  const legacyPatched = (content.match(MONACO_DIFF_FONT_LEGACY_PATCHED_RE) || []).length;
  const oldPatched = (content.match(MONACO_DIFF_FONT_OLD_PATCHED_RE) || []).length;
  const patched = (content.match(MONACO_DIFF_FONT_PATCHED_RE) || []).length;
  if (hardcoded === 0 && legacyPatched === 0 && oldPatched === 0 && patched === 2) {
    return [content, `${padLabel('diff 字体/行号')}: 已存在`];
  }
  if (hardcoded + legacyPatched + oldPatched + patched !== 2) {
    throw new Error(`Claude Code 扩展结构已变化,未找到唯一的 diff 字体/行号可补丁位置。`);
  }
  return [
    content
      .replace(MONACO_DIFF_FONT_HARDCODED_RE, MONACO_DIFF_FONT_LAYOUT_OPTIONS)
      .replace(MONACO_DIFF_FONT_LEGACY_PATCHED_RE, MONACO_DIFF_FONT_LAYOUT_OPTIONS)
      .replace(MONACO_DIFF_FONT_OLD_PATCHED_RE, MONACO_DIFF_FONT_LAYOUT_OPTIONS),
    `${padLabel('diff 字体/行号')}: 已写入`,
  ];
}

function patchMonacoDiffWordWrap(content) {
  const hardcoded = (content.match(MONACO_DIFF_WORD_WRAP_HARDCODED_RE) || []).length;
  const patched = (content.match(MONACO_DIFF_WORD_WRAP_PATCHED_RE) || []).length;
  if (hardcoded === 0 && patched === 2) {
    return [content, `${padLabel('diff 换行')}: 已存在`];
  }
  if (hardcoded + patched !== 2) {
    throw new Error(`Claude Code 扩展结构已变化,未找到唯一的 diff 换行可补丁位置。`);
  }
  return [
    content.replace(MONACO_DIFF_WORD_WRAP_HARDCODED_RE, 'wordWrap:"off",wrappingIndent:"same"'),
    `${padLabel('diff 换行')}: 已写入`,
  ];
}

function patchMonacoDiffOverview(content) {
  const hardcoded = (content.match(MONACO_DIFF_OVERVIEW_HARDCODED_RE) || []).length;
  const patched = (content.match(MONACO_DIFF_OVERVIEW_PATCHED_RE) || []).length;
  const inlineLayoutPatched = (content.match(MONACO_DIFF_OVERVIEW_INLINE_LAYOUT_PATCHED_RE) || []).length;
  // The inline diff editor already ships with `renderOverviewRuler:!1`; the
  // expanded modal is the single `!0` we migrate. Therefore the final patched
  // state has two `!1` matches for this option prefix. The inline preview may
  // later be forced into single-column mode (`renderSideBySide:!1`), so accept
  // that as one of the two overview-patched diff editors.
  if (hardcoded === 0 && patched + inlineLayoutPatched === 2) {
    return [content, `${padLabel('diff 概览条')}: 已存在`];
  }
  if (hardcoded !== 1 || patched + inlineLayoutPatched !== 1) {
    throw new Error(`Claude Code 扩展结构已变化,未找到唯一的 diff 概览条可补丁位置。`);
  }
  return [
    content.replace(MONACO_DIFF_OVERVIEW_HARDCODED_RE, 'readOnly:!0,renderSideBySide:!0,renderOverviewRuler:!1'),
    `${padLabel('diff 概览条')}: 已写入`,
  ];
}

function patchMonacoDiffInlineLayout(content) {
  const layoutHardcoded = (content.match(MONACO_DIFF_INLINE_LAYOUT_HARDCODED_RE) || []).length;
  const layoutPatched = (content.match(MONACO_DIFF_INLINE_LAYOUT_PATCHED_RE) || []).length;
  const resizeHardcoded = (content.match(MONACO_DIFF_INLINE_RESIZE_HARDCODED_RE) || []).length;
  const resizePatched = (content.match(MONACO_DIFF_INLINE_RESIZE_PATCHED_RE) || []).length;

  if (layoutHardcoded === 0 && layoutPatched === 1 && resizeHardcoded === 0 && resizePatched === 1) {
    return [content, `${padLabel('diff inline 布局')}: 已存在`];
  }
  if (layoutHardcoded + layoutPatched !== 1 || resizeHardcoded + resizePatched !== 1) {
    throw new Error(`Claude Code 扩展结构已变化,未找到唯一的 inline diff 布局可补丁位置。`);
  }

  const updated = content
    .replace(
      MONACO_DIFF_INLINE_LAYOUT_HARDCODED_RE,
      '$1renderSideBySide:!1$2',
    )
    .replace(
      MONACO_DIFF_INLINE_RESIZE_HARDCODED_RE,
      '$1(!0),$3.updateOptions({renderSideBySide:!1})',
    );
  return [
    updated,
    `${padLabel('diff inline 布局')}: 已写入`,
  ];
}

function patchMonacoDiffModalLayout(content) {
  const hardcoded = (content.match(MONACO_DIFF_MODAL_LAYOUT_HARDCODED_RE) || []).length;
  const patched = (content.match(MONACO_DIFF_MODAL_LAYOUT_PATCHED_RE) || []).length;

  if (hardcoded === 0 && patched === 1) {
    return [content, `${padLabel('diff modal 布局')}: 已存在`];
  }
  if (hardcoded + patched !== 1) {
    throw new Error(`Claude Code 扩展结构已变化,未找到唯一的 modal diff 布局可补丁位置。`);
  }
  return [
    content.replace(
      MONACO_DIFF_MODAL_LAYOUT_HARDCODED_RE,
      '$1renderSideBySide:!1$2',
    ),
    `${padLabel('diff modal 布局')}: 已写入`,
  ];
}

function patchMonacoDiffModalScrollbar(content) {
  const hardcoded = (content.match(MONACO_DIFF_MODAL_SCROLLBAR_HARDCODED_RE) || []).length;
  const legacyHidden = (content.match(MONACO_DIFF_MODAL_SCROLLBAR_LEGACY_HIDDEN_RE) || []).length;
  if (hardcoded === 1 && legacyHidden === 0) {
    return [content, `${padLabel('diff 横向滚动')}: 已存在`];
  }
  if (hardcoded === 0 && legacyHidden === 1) {
    return [
      content.replace(MONACO_DIFF_MODAL_SCROLLBAR_LEGACY_HIDDEN_RE, 'scrollbar:{vertical:"auto",horizontal:"auto"}'),
      `${padLabel('diff 横向滚动')}: 已恢复`,
    ];
  }
  if (hardcoded + legacyHidden !== 1) {
    throw new Error(`Claude Code 扩展结构已变化,未找到唯一的 diff 横向滚动可补丁位置。`);
  }
  return [content, `${padLabel('diff 横向滚动')}: 已存在`];
}

function patchWebviewIndex(content, features, theme, language) {
  let [updated, configStatus] = patchWebviewConfig(content, features, theme, language);
  let markdownStatus;
  [updated, markdownStatus] = patchMarkdownChildren(updated);
  const statusLines = [configStatus, markdownStatus];

  // Remove the legacy `acquireVsCodeApi` idempotency wrapper that earlier
  // development builds prepended to this file. Its only consumer has been
  // removed, so the line is stripped if present.
  updated = updated.replace(
    /\(function\(\)\{if\(window\.__cceApiWrap\)[\s\S]*?\}\)\(\);\n/,
    '',
  );

  let diffThemeStatus;
  [updated, diffThemeStatus] = patchMonacoDiffTheme(updated);
  statusLines.push(diffThemeStatus);

  let diffFontStatus;
  [updated, diffFontStatus] = patchMonacoDiffFont(updated);
  statusLines.push(diffFontStatus);

  let diffWrapStatus;
  [updated, diffWrapStatus] = patchMonacoDiffWordWrap(updated);
  statusLines.push(diffWrapStatus);

  let diffOverviewStatus;
  [updated, diffOverviewStatus] = patchMonacoDiffOverview(updated);
  statusLines.push(diffOverviewStatus);

  let diffInlineLayoutStatus;
  [updated, diffInlineLayoutStatus] = patchMonacoDiffInlineLayout(updated);
  statusLines.push(diffInlineLayoutStatus);

  let diffModalLayoutStatus;
  [updated, diffModalLayoutStatus] = patchMonacoDiffModalLayout(updated);
  statusLines.push(diffModalLayoutStatus);

  let diffScrollbarStatus;
  [updated, diffScrollbarStatus] = patchMonacoDiffModalScrollbar(updated);
  statusLines.push(diffScrollbarStatus);

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
  // Caller may supply a pre-resolved `target` (from the new multi-target
  // picker flow); otherwise we fall back to legacy "find the latest
  // ~/.vscode/extensions/anthropic.claude-code-*" detection. Either path
  // produces a target that already carries `settingsPath`.
  const { home = null, target: presetTarget = null, extensionsDir = null, settingsPath = null } = options;
  const target = presetTarget || findLatestClaudeCodeExtension({ home, extensionsDir, settingsPath });
  const webviewDir = path.dirname(target.webviewIndexJsPath);

  pruneRetiredConfigKeys();
  const features = getFeatures();
  const theme = getTheme();
  const language = getLanguage() || 'en';
  const enhancePreamble = buildEnhancePreamble(features, theme, language);
  const themeOverrideBlock = buildThemeOverrideBlock(theme);

  const rootResourceStatuses = [];
  const rootWebviewFiles = [];
  let enhanceScriptWritten = false;
  for (const [relativePath, targetName] of ROOT_WEBVIEW_FILES) {
    const src = resourceFilePath(resourceRoot, relativePath);
    const dst = path.join(webviewDir, targetName);
    let written;
    if (targetName === ENHANCE_TARGET_NAME) {
      written = copyWithTransform(src, dst, content => enhancePreamble + content);
    } else if (targetName === THEME_TARGET_NAME) {
      written = copyWithTransform(src, dst, content => content + themeOverrideBlock);
    } else {
      written = copyIfChanged(src, dst);
    }
    if (targetName === ENHANCE_TARGET_NAME) enhanceScriptWritten = written;
    rootWebviewFiles.push({
      name: targetName,
      path: dst,
      written,
    });
    const label = `${targetName} 复制`;
    rootResourceStatuses.push(
      written
        ? `${padLabel(label)}: 已写入`
        : `${padLabel(label)}: 已存在`,
    );
  }

  // Prune any legacy asset subtrees that earlier versions used to ship.
  let legacyAssetTreesPruned = 0;
  for (const legacy of LEGACY_ASSET_TREES) {
    const legacyDir = path.join(webviewDir, legacy);
    if (fs.existsSync(legacyDir)) {
      fs.rmSync(legacyDir, { recursive: true, force: true });
      legacyAssetTreesPruned++;
    }
  }

  // Local asset subtrees: `mathjax`, `hljs`, and `fonts`.
  let assetWrittenTotal = 0;
  let assetTotal = 0;
  const assetStatusLines = [];
  const assetTrees = [];
  for (const treeName of LOCAL_ASSET_TREES) {
    const srcTree = path.join(resourceRoot, 'data', treeName);
    const dstTree = path.join(webviewDir, treeName);
    const [written, total] = syncAssetTree(srcTree, dstTree);
    assetWrittenTotal += written;
    assetTotal += total;
    assetTrees.push({
      name: treeName,
      path: dstTree,
      written,
      total,
    });
    const label = `${treeName} 资源`;
    assetStatusLines.push(
      written === 0
        ? `${padLabel(label)}: 已存在 (${total} 个)`
        : `${padLabel(label)}: 已写入 ${written}/${total}`,
    );
  }

  // `extension.js`
  const extJsOriginal = fs.readFileSync(target.extensionJsPath, 'utf8');
  let [extJsUpdatedText, extStatusLines] = patchExtensionJs(extJsOriginal);
  let extJsHeadStatus;
  [extJsUpdatedText, extJsHeadStatus] = patchExtensionHtmlHead(extJsUpdatedText, theme);
  extStatusLines.push(extJsHeadStatus);
  const extJsUpdated = extJsUpdatedText !== extJsOriginal;
  if (extJsUpdated) {
    fs.writeFileSync(target.extensionJsPath, extJsUpdatedText, 'utf8');
  }

  // `webview/index.js`
  const webviewOriginal = fs.readFileSync(target.webviewIndexJsPath, 'utf8');
  const [webviewUpdatedText, webviewStatusLines] = patchWebviewIndex(webviewOriginal, features, theme, language);
  const webviewUpdated = webviewUpdatedText !== webviewOriginal;
  if (webviewUpdated) {
    fs.writeFileSync(target.webviewIndexJsPath, webviewUpdatedText, 'utf8');
  }

  // System fonts plus `chat.fontFamily` / `chat.fontSize`. The settings
  // path comes from the resolved target so custom Cursor / Scoop /
  // portable installs write into the right `User/settings.json`.
  const serifWritten = installSerifSystemFonts(resourceRoot);
  const chatFontUpdated = setChatFontToSerif(theme.bodyFontSize, theme, target.settingsPath);
  const serifStatus = serifWritten > 0
    ? `已写入 ${serifWritten}/${SYSTEM_FONT_FILES.length}`
    : `已存在 (${SYSTEM_FONT_FILES.length} 个)`;
  const chatFontKey = theme.bodyFontFamily && theme.bodyFontFamily.key;
  const chatFontLabel = chatFontKey === 'custom'
    ? t('apply.font_custom_value')
    : chatFontKey || 'plex-serif';
  const chatFontStatus = chatFontUpdated
    ? `已更新 → ${chatFontLabel} ${theme.bodyFontSize}px`
    : '已是目标值';

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
    report: {
      webviewDir,
      rootWebviewFiles,
      assetTrees,
      extensionJs: {
        path: target.extensionJsPath,
        updated: extJsUpdated,
        statusLines: extStatusLines,
      },
      webviewIndex: {
        path: target.webviewIndexJsPath,
        updated: webviewUpdated,
        statusLines: webviewStatusLines,
      },
      settings: {
        path: target.settingsPath,
        updated: chatFontUpdated,
      },
      systemFonts: {
        written: serifWritten,
        total: SYSTEM_FONT_FILES.length,
      },
      legacyAssetTreesPruned,
    },
    statusLines,
    features,
    theme,
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
