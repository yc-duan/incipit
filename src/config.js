// User preferences for the `incipit` CLI.
//
// The file lives at `~/.incipit/config.json` and stores the UI language,
// feature toggles, visual theme, and target metadata. `language` is still
// the sole trigger for the first-run picker: if it is missing or invalid,
// the interactive menu asks once and saves the choice here.
//
// Write path is atomic (tmp + rename) so a crash mid-write cannot
// corrupt the config.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_DIR  = path.join(os.homedir(), '.incipit');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const SUPPORTED_LANGUAGES = Object.freeze(['zh', 'en']);
const RETIRED_FEATURE_KEYS = Object.freeze([
  'fileDropReferences',
  'toolFold',
]);

// User-adjustable feature toggles. Missing keys fall back to defaults.
const DEFAULT_FEATURES = Object.freeze({
  math: true,
  sessionUsage: true,
});

// User-adjustable visual knobs. `bodyFontSize` must match one of the
// discrete options; anything else snaps back to the default. `palette`
// switches the entire color scheme between the dark `warm-black` (default)
// and the light `warm-white` ivory-paper variant. `bodyBold` is an
// orthogonal opt-in that swaps the warm-white body face from `Reading`
// (Plex Serif 400) to `PaperReading` (Plex Serif 500 real cuts) to fight
// irradiation thinning on light surfaces — meaningful only on warm-white,
// which the UI enforces at pick time and `getTheme()` enforces at read time
// so warm-black always reports `bodyBold: false`.
const BODY_FONT_SIZE_OPTIONS = Object.freeze([12, 13, 14]);
const PALETTE_OPTIONS = Object.freeze(['warm-black', 'warm-white']);

// Preset font-family options. Each entry is [labelKey, cssValue].
// The labelKey is looked up via i18n; cssValue is the raw font-family stack.
const BODY_FONT_FAMILY_OPTIONS = Object.freeze([
  ['plex-serif', "'Reading', 'IBM Plex Serif', 'Noto Sans SC', 'Microsoft YaHei UI', 'Microsoft YaHei', 'PingFang SC', system-ui, serif"],
]);
const RETIRED_BODY_FONT_FAMILY_KEYS = Object.freeze(['georgia', 'system-serif']);
const CODE_FONT_FAMILY_OPTIONS = Object.freeze([
  ['rec-mono', "'Rec Mono Linear', 'Noto Sans SC', 'Microsoft YaHei UI', 'Microsoft YaHei', Consolas, Monaco, 'Courier New', monospace"],
  ['jetbrains-mono', "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei UI', 'Microsoft YaHei', Consolas, Monaco, 'Courier New', monospace"],
  ['system-mono', "Consolas, Monaco, 'Courier New', 'Noto Sans SC', 'Microsoft YaHei UI', 'Microsoft YaHei', monospace"],
]);

const DEFAULT_THEME = Object.freeze({
  bodyFontSize: 13,
  palette: 'warm-black',
  bodyBold: false,
  bodyFontFamily: 'plex-serif',
  codeFontFamily: 'rec-mono',
});

function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try {
    const text = fs.readFileSync(CONFIG_PATH, 'utf8');
    const data = text.trim() ? JSON.parse(text) : {};
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return {};
    return data;
  } catch (_) {
    // Corrupt JSON is treated as "no config" rather than aborting the
    // CLI. Next successful write overwrites it.
    return {};
  }
}

function removeRetiredFeatureKeys(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const raw = data.features;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  let changed = false;
  for (const key of RETIRED_FEATURE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      delete raw[key];
      changed = true;
    }
  }
  if (changed && Object.keys(raw).length === 0) {
    delete data.features;
  }
  return changed;
}

function writeConfig(data) {
  removeRetiredFeatureKeys(data);
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = path.join(
    CONFIG_DIR,
    `.config.json.tmp-${process.pid}-${Date.now()}`,
  );
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  try {
    fs.renameSync(tmp, CONFIG_PATH);
  } catch (exc) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw exc;
  }
}

function pruneRetiredConfigKeys() {
  const cfg = readConfig();
  if (!removeRetiredFeatureKeys(cfg)) return false;
  writeConfig(cfg);
  return true;
}

function getLanguage() {
  const cfg = readConfig();
  const lang = cfg.language;
  if (typeof lang === 'string' && SUPPORTED_LANGUAGES.includes(lang)) return lang;
  return null;
}

function setLanguage(lang) {
  if (!SUPPORTED_LANGUAGES.includes(lang)) {
    throw new Error(`Unsupported language: ${lang}`);
  }
  const cfg = readConfig();
  cfg.language = lang;
  writeConfig(cfg);
}

function getFeatures() {
  const cfg = readConfig();
  const raw = (cfg && cfg.features && typeof cfg.features === 'object') ? cfg.features : {};
  return {
    math: typeof raw.math === 'boolean' ? raw.math : DEFAULT_FEATURES.math,
    sessionUsage: typeof raw.sessionUsage === 'boolean' ? raw.sessionUsage : DEFAULT_FEATURES.sessionUsage,
  };
}

function setFeature(key, value) {
  if (!(key in DEFAULT_FEATURES)) {
    throw new Error(`Unknown feature: ${key}`);
  }
  if (typeof value !== 'boolean') {
    throw new Error(`Feature ${key} must be boolean`);
  }
  const cfg = readConfig();
  const current = getFeatures();
  cfg.features = { ...current, [key]: value };
  writeConfig(cfg);
}

function getTheme() {
  const cfg = readConfig();
  const raw = (cfg && cfg.theme && typeof cfg.theme === 'object') ? cfg.theme : {};
  const size = BODY_FONT_SIZE_OPTIONS.includes(raw.bodyFontSize)
    ? raw.bodyFontSize
    : DEFAULT_THEME.bodyFontSize;
  const palette = PALETTE_OPTIONS.includes(raw.palette)
    ? raw.palette
    : DEFAULT_THEME.palette;
  // bodyBold only takes effect on warm-white. Coerce to false when the
  // active palette is warm-black so a stale `bodyBold:true` left in the
  // config from a previous warm-white session can never spuriously
  // activate the PaperReading gate after the user switched themes.
  const bodyBold = (palette === 'warm-white' && raw.bodyBold === true);
  const bodyFontFamily = resolveBodyFontFamily(raw.bodyFontFamily);
  const codeFontFamily = resolveCodeFontFamily(raw.codeFontFamily);
  return { bodyFontSize: size, palette, bodyBold, bodyFontFamily, codeFontFamily };
}

function resolveBodyFontFamily(saved) {
  const preset = BODY_FONT_FAMILY_OPTIONS.find(([key]) => key === saved);
  if (preset) return { key: saved, css: preset[1] };
  if (RETIRED_BODY_FONT_FAMILY_KEYS.includes(saved)) {
    const def = BODY_FONT_FAMILY_OPTIONS[0];
    return { key: def[0], css: def[1] };
  }
  // Custom or missing: fall back to default if no valid custom string.
  if (typeof saved === 'string' && saved.trim().length > 0) {
    return { key: 'custom', css: saved.trim() };
  }
  const def = BODY_FONT_FAMILY_OPTIONS[0];
  return { key: def[0], css: def[1] };
}

function resolveCodeFontFamily(saved) {
  const preset = CODE_FONT_FAMILY_OPTIONS.find(([key]) => key === saved);
  if (preset) return { key: saved, css: preset[1] };
  if (typeof saved === 'string' && saved.trim().length > 0) {
    return { key: 'custom', css: saved.trim() };
  }
  const def = CODE_FONT_FAMILY_OPTIONS[0];
  return { key: def[0], css: def[1] };
}

function setBodyFontSize(size) {
  if (!BODY_FONT_SIZE_OPTIONS.includes(size)) {
    throw new Error(`Unsupported body font size: ${size}`);
  }
  const cfg = readConfig();
  const raw = (cfg.theme && typeof cfg.theme === 'object') ? cfg.theme : {};
  cfg.theme = { ...raw, bodyFontSize: size };
  writeConfig(cfg);
}

function setPalette(palette) {
  if (!PALETTE_OPTIONS.includes(palette)) {
    throw new Error(`Unsupported palette: ${palette}`);
  }
  const cfg = readConfig();
  const raw = (cfg.theme && typeof cfg.theme === 'object') ? cfg.theme : {};
  cfg.theme = { ...raw, palette };
  writeConfig(cfg);
}

function setBodyBold(value) {
  if (typeof value !== 'boolean') {
    throw new Error('bodyBold must be boolean');
  }
  const cfg = readConfig();
  const raw = (cfg.theme && typeof cfg.theme === 'object') ? cfg.theme : {};
  cfg.theme = { ...raw, bodyBold: value };
  writeConfig(cfg);
}

function setBodyFontFamily(keyOrCss) {
  const cfg = readConfig();
  const raw = (cfg.theme && typeof cfg.theme === 'object') ? cfg.theme : {};
  cfg.theme = { ...raw, bodyFontFamily: keyOrCss };
  writeConfig(cfg);
}

function setCodeFontFamily(keyOrCss) {
  const cfg = readConfig();
  const raw = (cfg.theme && typeof cfg.theme === 'object') ? cfg.theme : {};
  cfg.theme = { ...raw, codeFontFamily: keyOrCss };
  writeConfig(cfg);
}

function resetConfigurable() {
  const cfg = readConfig();
  delete cfg.features;
  delete cfg.theme;
  writeConfig(cfg);
}

// ============================================================
// targets — Claude Code installation locations
// ============================================================
//
// Schema under `cfg.targets`:
//   {
//     lastUsed: '<id>' | null,        // id of the most recent apply target
//     manual:   [
//       { id, label, extensionsDir, settingsPath }
//     ]
//   }
//
// Only `manual` entries are persisted — `auto` entries are re-detected on
// every CLI launch (host-detect.js) and merged in memory. `lastUsed` is
// recorded each time a user picks a target in the apply pre-picker; it
// drives the cursor's default landing position the next time apply runs,
// nothing else. The "manage" screen has no notion of an active target.
//
// Field migration: an older build stored the same id under `active`. We
// silently fall through to that key on read so existing configs still
// resolve, but never write it back — first write through the new path
// removes it.

function readLastUsedField(targets) {
  if (typeof targets.lastUsed === 'string') return targets.lastUsed;
  // Legacy field name (pre-rename). Treat as last-used so the user's
  // previous selection is preserved across the upgrade.
  if (typeof targets.active === 'string') return targets.active;
  return null;
}

function getStoredTargets() {
  const cfg = readConfig();
  const raw = (cfg && cfg.targets && typeof cfg.targets === 'object') ? cfg.targets : {};
  const manualRaw = Array.isArray(raw.manual) ? raw.manual : [];
  const manual = [];
  for (const m of manualRaw) {
    if (!m || typeof m !== 'object') continue;
    if (typeof m.id !== 'string') continue;
    if (typeof m.extensionsDir !== 'string') continue;
    manual.push({
      id: m.id,
      label: typeof m.label === 'string' ? m.label : 'Custom target',
      extensionsDir: m.extensionsDir,
      settingsPath: typeof m.settingsPath === 'string' ? m.settingsPath : null,
    });
  }
  return { lastUsed: readLastUsedField(raw), manual };
}

function setLastUsedTargetId(id) {
  const cfg = readConfig();
  const targets = (cfg.targets && typeof cfg.targets === 'object') ? cfg.targets : {};
  cfg.targets = {
    lastUsed: typeof id === 'string' ? id : null,
    manual: Array.isArray(targets.manual) ? targets.manual : [],
  };
  writeConfig(cfg);
}

function addManualTarget(entry) {
  if (!entry || typeof entry !== 'object') {
    throw new Error('addManualTarget: entry required');
  }
  if (typeof entry.extensionsDir !== 'string' || !entry.extensionsDir) {
    throw new Error('addManualTarget: extensionsDir required');
  }
  const cfg = readConfig();
  const targets = (cfg.targets && typeof cfg.targets === 'object') ? cfg.targets : {};
  const manual = Array.isArray(targets.manual) ? [...targets.manual] : [];
  const id = entry.id || generateTargetId();
  const next = {
    id,
    label: entry.label || 'Custom target',
    extensionsDir: entry.extensionsDir,
    settingsPath: entry.settingsPath || null,
  };
  // Replace any existing entry with the same id; otherwise append.
  const idx = manual.findIndex(m => m.id === id);
  if (idx >= 0) manual[idx] = next;
  else manual.push(next);
  cfg.targets = {
    lastUsed: readLastUsedField(targets),
    manual,
  };
  writeConfig(cfg);
  return next;
}

function removeManualTarget(id) {
  const cfg = readConfig();
  const targets = (cfg.targets && typeof cfg.targets === 'object') ? cfg.targets : {};
  const manual = Array.isArray(targets.manual) ? targets.manual.filter(m => m.id !== id) : [];
  let lastUsed = readLastUsedField(targets);
  if (lastUsed === id) lastUsed = null;
  cfg.targets = { lastUsed, manual };
  writeConfig(cfg);
}

function generateTargetId() {
  // Short random hex; collision-resistant enough for a config file that
  // tops out at maybe a dozen entries.
  return 'm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

module.exports = {
  CONFIG_DIR,
  CONFIG_PATH,
  SUPPORTED_LANGUAGES,
  DEFAULT_FEATURES,
  DEFAULT_THEME,
  BODY_FONT_SIZE_OPTIONS,
  PALETTE_OPTIONS,
  BODY_FONT_FAMILY_OPTIONS,
  CODE_FONT_FAMILY_OPTIONS,
  readConfig,
  writeConfig,
  pruneRetiredConfigKeys,
  getLanguage,
  setLanguage,
  getFeatures,
  setFeature,
  getTheme,
  setBodyFontSize,
  setPalette,
  setBodyBold,
  setBodyFontFamily,
  setCodeFontFamily,
  resetConfigurable,
  getStoredTargets,
  setLastUsedTargetId,
  addManualTarget,
  removeManualTarget,
  generateTargetId,
};
