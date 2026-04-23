// User preferences for the `incipit` CLI.
//
// Currently this holds only the UI language. The file lives at
// `~/.incipit/config.json` and is the sole trigger for the first-run
// language picker: if the file is missing or does not contain a valid
// `language`, the interactive menu shows the picker once, saves the
// choice here, and never asks again.
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

// User-adjustable feature toggles. Missing keys fall back to defaults.
const DEFAULT_FEATURES = Object.freeze({
  math: true,
  sessionUsage: true,
  toolFold: true,
});

// User-adjustable visual knobs. `bodyFontSize` must match one of the
// discrete options; anything else snaps back to the default.
const BODY_FONT_SIZE_OPTIONS = Object.freeze([12, 13, 14]);
const DEFAULT_THEME = Object.freeze({
  bodyFontSize: 13,
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

function writeConfig(data) {
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
    toolFold: typeof raw.toolFold === 'boolean' ? raw.toolFold : DEFAULT_FEATURES.toolFold,
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
  return { bodyFontSize: size };
}

function setBodyFontSize(size) {
  if (!BODY_FONT_SIZE_OPTIONS.includes(size)) {
    throw new Error(`Unsupported body font size: ${size}`);
  }
  const cfg = readConfig();
  const current = getTheme();
  cfg.theme = { ...current, bodyFontSize: size };
  writeConfig(cfg);
}

function resetConfigurable() {
  const cfg = readConfig();
  delete cfg.features;
  delete cfg.theme;
  writeConfig(cfg);
}

module.exports = {
  CONFIG_DIR,
  CONFIG_PATH,
  SUPPORTED_LANGUAGES,
  DEFAULT_FEATURES,
  DEFAULT_THEME,
  BODY_FONT_SIZE_OPTIONS,
  readConfig,
  writeConfig,
  getLanguage,
  setLanguage,
  getFeatures,
  setFeature,
  getTheme,
  setBodyFontSize,
  resetConfigurable,
};
