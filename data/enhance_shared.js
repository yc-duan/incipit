/**
 * Shared runtime helpers for incipit webview modules.
 *
 * This file is deliberately small and side-effect-light. `enhance.js` imports
 * it on the critical path, while lazy modules reuse the same config, asset
 * resolver, DOM freeze, and app-var helpers.
 */

export const CFG = (() => {
  const raw = (typeof globalThis !== 'undefined' && globalThis.__incipitConfig) || {};
  const f = (raw && typeof raw.features === 'object') ? raw.features : {};
  const t = (raw && typeof raw.theme === 'object') ? raw.theme : {};
  const palette = t.palette === 'warm-white' ? 'warm-white' : 'warm-black';
  const language = raw.language === 'zh' ? 'zh' : 'en';
  const bodyBold = (palette === 'warm-white' && t.bodyBold === true);
  return Object.freeze({
    math: f.math !== false,
    sessionUsage: f.sessionUsage !== false,
    language,
    palette,
    bodyBold,
  });
})();

export const DEBUG = (() => {
  try { return localStorage.getItem('claudeEnhanceDebug') === '1'; } catch { return false; }
})();

export const log  = (...a) => console.log('[Claude Enhance]', ...a);
export const warn = (...a) => console.warn('[Claude Enhance]', ...a);
export const dbg  = (...a) => { if (DEBUG) console.log('[Claude Enhance:dbg]', ...a); };

export const BASE_URL = (() => {
  try {
    return new URL('./', import.meta.url);
  } catch {
    const s = document.currentScript;
    if (s && s.src) return new URL('./', s.src);
    return new URL('./', location.href);
  }
})();

export const assetURL = (rel) => new URL(rel, BASE_URL).href;

export function pageNonce() {
  const el = document.querySelector('script[nonce]');
  return el ? (el.nonce || el.getAttribute('nonce') || '') : '';
}

export function loadCSS(href) {
  return new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.onload = () => resolve();
    link.onerror = () => reject(new Error('CSS load failed: ' + href));
    document.head.appendChild(link);
  });
}

export function loadJS(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    const nonce = pageNonce();
    if (nonce) { s.nonce = nonce; s.setAttribute('nonce', nonce); }
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('JS load failed: ' + src));
    document.head.appendChild(s);
  });
}

export function ensureDomFreeze() {
  const key = '__incipitDomFreeze';
  const existing = globalThis[key];
  if (existing &&
      existing.nativeSet &&
      existing.nativeRemove &&
      existing.nativeToggle) {
    return existing;
  }

  const nativeSet = Element.prototype.setAttribute;
  const nativeRemove = Element.prototype.removeAttribute;
  const nativeToggle = Element.prototype.toggleAttribute;
  let nativeOpenGet = null;
  let nativeOpenSet = null;

  Element.prototype.setAttribute = function(name, value) {
    if (name === 'open' && this.__claudeFrozen) return;
    return nativeSet.call(this, name, value);
  };
  Element.prototype.removeAttribute = function(name) {
    if (name === 'open' && this.__claudeFrozen) return;
    return nativeRemove.call(this, name);
  };
  Element.prototype.toggleAttribute = function(name, force) {
    if (name === 'open' && this.__claudeFrozen) return this.hasAttribute('open');
    return nativeToggle.call(this, name, force);
  };

  if (typeof HTMLDetailsElement !== 'undefined') {
    const desc = Object.getOwnPropertyDescriptor(HTMLDetailsElement.prototype, 'open');
    if (desc && desc.set) {
      nativeOpenGet = desc.get || null;
      nativeOpenSet = desc.set;
      Object.defineProperty(HTMLDetailsElement.prototype, 'open', {
        configurable: true,
        get: desc.get,
        set: function(value) {
          if (this.__claudeFrozen) return;
          nativeOpenSet.call(this, value);
        },
      });
    }
  }

  const freeze = Object.freeze({
    nativeSet,
    nativeRemove,
    nativeToggle,
    nativeOpenGet,
    nativeOpenSet,
  });
  try {
    Object.defineProperty(globalThis, key, {
      value: freeze,
      configurable: false,
      enumerable: false,
      writable: false,
    });
  } catch (_) {
    globalThis[key] = freeze;
  }
  return freeze;
}

const SOFT_BG   = CFG.palette === 'warm-white' ? '#f8f8f6' : '#1f1f1e';
const SOFT_FG   = CFG.palette === 'warm-white' ? '#0d0d0d' : '#f8f8f6';
const SOFT_FG_2 = CFG.palette === 'warm-white' ? '#797569' : '#bcbcb9';
const MENTION_CHIP_BG = CFG.palette === 'warm-white' ? '#ead8cf' : '#3d312d';
const MENTION_CHIP_FG = CFG.palette === 'warm-white' ? '#8f452b' : '#e0a18b';

export const APP_VAR_OVERRIDES = {
  '--app-background': SOFT_BG,
  '--app-primary-background': SOFT_BG,
  '--app-root-background': SOFT_BG,
  '--app-secondary-background': SOFT_BG,
  '--app-tool-background': SOFT_BG,
  '--app-header-background': SOFT_BG,
  '--app-input-background': SOFT_BG,
  '--app-input-secondary-background': SOFT_BG,
  '--app-menu-background': SOFT_BG,
  '--app-primary-foreground': SOFT_FG,
  '--app-input-foreground': SOFT_FG,
  '--app-input-secondary-foreground': SOFT_FG,
  '--app-menu-foreground': SOFT_FG,
  '--app-secondary-foreground': SOFT_FG_2,
  '--app-secondary-text': SOFT_FG_2,
  '--app-mention-chip-background': MENTION_CHIP_BG,
  '--app-mention-chip-foreground': MENTION_CHIP_FG,
  '--app-monospace-font-family': 'var(--incipit-code-font)',
};

let appVarApplyScheduled = false;
let appVarSelfWriting = false;

export function applyAppVarOverrides() {
  appVarSelfWriting = true;
  try {
    writeAppVarsTo(document.documentElement);
    if (document.body) writeAppVarsTo(document.body);
  } finally {
    appVarSelfWriting = false;
  }
}

function writeAppVarsTo(el) {
  if (!el || !el.style) return;
  const style = el.style;
  for (const [k, v] of Object.entries(APP_VAR_OVERRIDES)) {
    if (style.getPropertyValue(k) === v && style.getPropertyPriority(k) === 'important') continue;
    style.setProperty(k, v, 'important');
  }
}

function scheduleApplyAppVarOverrides() {
  if (appVarApplyScheduled) return;
  appVarApplyScheduled = true;
  requestAnimationFrame(() => {
    appVarApplyScheduled = false;
    applyAppVarOverrides();
  });
}

export function setupAppVarObserver() {
  if (globalThis.__incipitAppVarObserverInstalled) return;
  const observer = new MutationObserver(() => {
    if (appVarSelfWriting) return;
    scheduleApplyAppVarOverrides();
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });
  globalThis.__incipitAppVarObserverInstalled = true;
  globalThis.__incipitAppVarObserver = observer;
}

export function applyBodyBoldFlag() {
  const root = document.documentElement;
  if (!root) return;
  if (CFG.bodyBold) root.setAttribute('data-incipit-body-bold', '');
  else root.removeAttribute('data-incipit-body-bold');
}

export function injectStyles() {
  if (!document.getElementById('claude-enhance-styles-link')) {
    const link = document.createElement('link');
    link.id = 'claude-enhance-styles-link';
    link.rel = 'stylesheet';
    link.href = assetURL('theme.css');
    document.head.appendChild(link);
  }
  if (CFG.palette === 'warm-white' &&
      !document.getElementById('incipit-warm-white-link')) {
    const overrideLink = document.createElement('link');
    overrideLink.id = 'incipit-warm-white-link';
    overrideLink.rel = 'stylesheet';
    overrideLink.href = assetURL('warm-white-override.css');
    document.head.appendChild(overrideLink);
  }
}

export function whenDOMReady(fn) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fn, { once: true });
  } else {
    fn();
  }
}
