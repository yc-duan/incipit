'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const readline = require('readline');
const { spawn } = require('child_process');

const {
  findLatestClaudeCodeExtension,
  installClaudeCodeVSCodeEnhance,
} = require('./install');
const {
  BACKUP_ROOT,
  DEFAULT_BACKUP_NAME,
  currentBackupDir,
  createBackup,
  listAvailableBackups,
  restoreBackup,
} = require('./backup');
const {
  getLanguage,
  setLanguage,
  SUPPORTED_LANGUAGES,
  readConfig,
  writeConfig,
  getFeatures,
  setFeature,
  getTheme,
  setBodyFontSize,
  setPalette,
  setBodyBold,
  setBodyFontFamily,
  setCodeFontFamily,
  resetConfigurable,
  BODY_FONT_SIZE_OPTIONS,
  BODY_FONT_FAMILY_OPTIONS,
  CODE_FONT_FAMILY_OPTIONS,
  DEFAULT_THEME,
  getStoredTargets,
  setLastUsedTargetId,
  addManualTarget,
  removeManualTarget,
  generateTargetId,
} = require('./config');
const {
  detectAutoTargets,
  identifyFolder,
  validateTargetEntry,
} = require('./host-detect');
const {
  pickFolder,
  isDialogAvailable,
  dialogUnavailableReason,
  DialogUnavailableError,
} = require('./file-dialog');
const { t, setLocale } = require('./i18n');
const {
  Ansi,
  clearScreen,
  color,
  renderConfigureMenu,
  renderLanguagePicker,
  renderMainMenu,
  renderTargetMenu,
  renderAddTargetIntro,
  renderIdentifyResult,
  renderIdentifyFailure,
  renderApplyPicker,
} = require('./frontispiece');
const { keyLoop, withScreenSession, invalidateScreenSession } = require('./select');

function prompt(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, answer => {
      rl.close();
      resolve(answer);
    });
  });
}

async function pause() {
  try { await prompt('\n' + t('menu.press_enter')); } catch (_) {}
}

function resetScreenForPrompt() {
  if (!invalidateScreenSession({ history: true })) clearScreen({ history: true });
}

const PACKAGE_ROOT = path.resolve(__dirname, '..');

function loadPackageVersion() {
  try { return require(path.join(PACKAGE_ROOT, 'package.json')).version || null; }
  catch (_) { return null; }
}
const PACKAGE_VERSION = loadPackageVersion();

const APPLY_TREE_NAME_WIDTH = 26;

const WEBVIEW_FILE_DESC_KEYS = Object.freeze({
  'enhance.js':              'apply.report.desc.enhance_js',
  'enhance_shared.js':       'apply.report.desc.enhance_shared_js',
  'enhance_footer_badge.js': 'apply.report.desc.enhance_footer_badge_js',
  'enhance_thinking.js':     'apply.report.desc.enhance_thinking_js',
  'enhance_typography.js':   'apply.report.desc.enhance_typography_js',
  'enhance_legacy.js':       'apply.report.desc.enhance_legacy_js',
  'host_probe.js':           'apply.report.desc.host_probe_js',
  'host-badge.cjs':          'apply.report.desc.host_badge_cjs',
  'math_tokens.js':          'apply.report.desc.math_tokens_js',
  'math_rewriter.js':        'apply.report.desc.math_rewriter_js',
  'theme.css':               'apply.report.desc.theme_css',
  'warm-white-override.css': 'apply.report.desc.warm_white_css',
});

const ASSET_TREE_DESC_KEYS = Object.freeze({
  katex:          'apply.report.desc.asset_katex',
  hljs:           'apply.report.desc.asset_hljs',
  fonts:          'apply.report.desc.asset_fonts',
  'effort-brain': 'apply.report.desc.asset_effort_brain',
});

async function handleApply({
  silent = false,
  askBackupName = false,
  interactive = false,
  extensionsDir = null,
  settingsPath = null,
  target: explicitTarget = null,
} = {}) {
  // Interactive apply runs the pre-picker first — even when only one
  // target exists, so the user always confirms what they're about to
  // patch. Non-interactive (`incipit apply`) takes one of three paths:
  //   1. explicit --extensions-dir (and optional --settings-path) → validate, use
  //   2. last-used target recorded → use silently
  //   3. exactly one auto target → use silently
  //   4. zero or 2+ targets, no flags → ambiguous error / no-target error
  //
  // Non-interactive never writes lastUsed: scripted runs should be
  // side-effect-free with respect to user config.
  let target = explicitTarget;
  if (!target && interactive) {
    target = await chooseApplyTargetInteractive();
    if (!target) return 0;
  } else if (!target) {
    // Non-interactive path. Three sources of truth, in priority order:
    //   1. explicit --extensions-dir
    //   2. recorded last-used target
    //   3. unambiguous auto-detect (1 valid candidate)
    if (extensionsDir) {
      try {
        validateExplicitTarget(extensionsDir, settingsPath);
      } catch (exc) {
        printValidationError(exc);
        return 1;
      }
      try {
        target = findLatestClaudeCodeExtension({ extensionsDir, settingsPath });
      } catch (exc) {
        console.log(color(t('apply.not_detected', { msg: exc.message }), Ansi.RED));
        return 1;
      }
    } else {
      try {
        const { merged, lastUsedId } = buildMergedTargets();
        const valid = merged.filter(e => e.valid);
        if (lastUsedId) {
          const hit = valid.find(e => e.id === lastUsedId);
          if (hit) {
            target = entryToTarget(hit);
          }
        }
        if (!target) {
          if (valid.length === 1) {
            target = entryToTarget(valid[0]);
          } else if (valid.length === 0) {
            console.log(color(t('cli.no_targets_for_apply'), Ansi.RED));
            return 1;
          } else {
            // 2+ valid targets and no flag, no lastUsed → refuse to guess.
            printAmbiguousTargets(merged);
            return 1;
          }
        }
      } catch (exc) {
        console.log(color(t('apply.not_detected', { msg: exc.message }), Ansi.RED));
        return 1;
      }
    }
  }

  if (!silent) clearScreen({ history: true });

  let backupName = DEFAULT_BACKUP_NAME;
  if (askBackupName) {
    console.log(color(t('apply.title'), Ansi.TERRA));
    console.log();
    console.log(`${t('apply.extension_header').padEnd(18)}: ${target.extensionDir}`);
    console.log(`${t('apply.version_header').padEnd(18)}: ${target.version}`);
    console.log();
    try {
      const raw = (await prompt(t('apply.prompt_backup_name'))).trim();
      if (raw) backupName = raw;
    } catch (_) {}
    console.log();
  }

  let manifest;
  try {
    manifest = createBackup(target, { name: backupName });
  } catch (exc) {
    console.log(color(t('apply.backup_failed', { msg: exc.message }), Ansi.RED));
    if (exc.stack) console.log(exc.stack);
    return 1;
  }
  let result;
  try {
    result = installClaudeCodeVSCodeEnhance(PACKAGE_ROOT, { target });
  } catch (exc) {
    console.log(color(t('apply.apply_failed', { msg: exc.message }), Ansi.RED));
    if (exc.stack) console.log(exc.stack);
    return 1;
  }
  if (!silent) clearScreen({ history: true });
  printApplyReport({
    target,
    manifest,
    backupDir: currentBackupDir(target, manifest.name),
    result,
  });
  return 0;
}

async function chooseApplyTargetInteractive() {
  while (true) {
    const choice = await selectApplyTarget();
    if (choice.action === 'cancel') return null;
    if (choice.action === 'add') {
      try { await runAddTargetWizard(); }
      catch (exc) {
        resetScreenForPrompt();
        console.log(color(t('menu.operation_failed', { msg: exc.message }), Ansi.RED));
        if (exc.stack) console.log(exc.stack);
        await pause();
      }
      continue;
    }
    if (choice.action === 'use' && choice.entry) {
      if (!choice.entry.valid) {
        resetScreenForPrompt();
        console.log(color(t('apply.not_detected', { msg: choice.entry.label }), Ansi.RED));
        await pause();
        continue;
      }
      try {
        const target = entryToTarget(choice.entry);
        // Remember this pick as the default cursor position for the
        // next interactive apply.
        setLastUsedTargetId(choice.entry.id);
        return target;
      } catch (exc) {
        resetScreenForPrompt();
        console.log(color(t('apply.not_detected', { msg: exc.message }), Ansi.RED));
        await pause();
      }
    }
  }
}

// Single source of truth for the palette display label across the apply
// summary, the configure dashboard, and the picker. The third state
// "warm-white (bold body)" is the warm-white palette with the orthogonal
// `bodyBold` flag flipped on — it is NOT a separate palette internally,
// only a presentation choice in the UI.
function paletteDisplayLabel(theme) {
  if (theme.palette !== 'warm-white') return t('configure.palette_warm_black');
  return theme.bodyBold
    ? t('configure.palette_warm_white_bold')
    : t('configure.palette_warm_white');
}

function languageDisplayLabel(lang) {
  return lang === 'zh' ? t('picker.option_zh') : t('picker.option_en');
}

function printApplyReport({ target, manifest, backupDir, result }) {
  const appName = inferHostAppName(target);
  console.log(color(t('apply.title'), Ansi.TERRA));
  console.log();
  console.log(color(`${appName} · Claude Code ${target.version || 'unknown'}`, Ansi.IVORY));
  console.log(color(target.extensionDir, Ansi.GREY));
  console.log();

  printReportSection(t('apply.report.backup_heading'), backupDir);
  printTree(buildBackupTree(manifest));
  console.log();

  printReportSection(t('apply.report.patch_heading'));
  printTree(buildPatchTree(result));
  console.log();

  console.log(formatApplyConfigInline(result.features, result.theme));
  console.log(color(formatApplyChangeSummary(result), Ansi.GREY));
  console.log();

  const reload = color(t('apply.reload_action'), Ansi.TERRA);
  const restart = color(t('apply.restart_action', { app: appName }), Ansi.TERRA);
  console.log(t('apply.done', { app: appName, reload, restart }));
  console.log(color(t('apply.upgrade_hint'), Ansi.GREY));
}

function printReportSection(label, detail = '') {
  const suffix = detail ? '  ' + color(detail, Ansi.GREY) : '';
  console.log(color(label, Ansi.TERRA) + suffix);
}

function printTree(nodes, prefix = '') {
  nodes.forEach((node, index) => {
    const isLast = index === nodes.length - 1;
    const connector = isLast ? '└─ ' : '├─ ';
    console.log(
      color(prefix + connector, Ansi.TERRA) +
      color(padApplyTreeName(node.name), Ansi.IVORY) +
      color(node.desc || '', Ansi.GREY),
    );
    if (node.children && node.children.length) {
      printTree(node.children, prefix + (isLast ? '   ' : '│  '));
    }
  });
}

function padApplyTreeName(name) {
  return String(name || '').padEnd(APPLY_TREE_NAME_WIDTH);
}

function buildBackupTree(manifest) {
  const entries = Array.isArray(manifest && manifest.entries) ? manifest.entries : [];
  return entries.map(e => {
    if (e.logicalName === 'extension.js') {
      return { name: 'extension.js', desc: t('apply.report.backup_extension_desc') };
    }
    if (e.logicalName === 'webview_dir') {
      const files = fileCount(e.files ? e.files.length : 0);
      return { name: 'webview/', desc: t('apply.report.backup_webview_desc', { files }) };
    }
    if (e.logicalName === 'vscode_settings.json') {
      const keys = settingKeyCount(e.keys ? e.keys.length : 0);
      return { name: 'settings.json', desc: t('apply.report.backup_settings_desc', { keys }) };
    }
    return { name: e.logicalName || 'unknown', desc: t('apply.report.backup_generic_desc') };
  });
}

function buildPatchTree(result) {
  const report = result && result.report ? result.report : {};
  const webviewChildren = [
    { name: 'index.js', desc: t('apply.report.desc.webview_index_js') },
    ...(report.rootWebviewFiles || []).map(file => ({
      name: file.name,
      desc: t(WEBVIEW_FILE_DESC_KEYS[file.name] || 'apply.report.desc.webview_file_generic'),
    })),
    ...(report.assetTrees || []).map(tree => {
      const files = fileCount(tree.total || 0);
      return {
        name: `${tree.name}/`,
        desc: t(ASSET_TREE_DESC_KEYS[tree.name] || 'apply.report.desc.asset_generic', { files }),
      };
    }),
  ];

  const fontTotal = report.systemFonts && Number.isFinite(report.systemFonts.total)
    ? report.systemFonts.total
    : 0;
  return [
    { name: 'extension.js', desc: t('apply.report.desc.extension_js') },
    { name: 'webview/', desc: t('apply.report.desc.webview_dir'), children: webviewChildren },
    { name: 'settings.json', desc: t('apply.report.desc.settings_json') },
    { name: 'system fonts', desc: t('apply.report.desc.system_fonts', { files: fileCount(fontTotal) }) },
  ];
}

function formatApplyConfigInline(features, theme) {
  const on = t('apply.summary_on');
  const off = t('apply.summary_off');
  const label = t('apply.report.config_label');
  const separator = label.endsWith('：') ? '' : ' ';
  const bodyFontLabel = fontLabelForKey(theme && theme.bodyFontFamily && theme.bodyFontFamily.key || DEFAULT_THEME.bodyFontFamily, 'body', theme);
  const codeFontLabel = fontLabelForKey(theme && theme.codeFontFamily && theme.codeFontFamily.key || DEFAULT_THEME.codeFontFamily, 'code', theme);
  const parts = [
    `${t('configure.feature_math')} ${features && features.math ? on : off}`,
    `${t('configure.feature_session')} ${features && features.sessionUsage ? on : off}`,
    `${t('configure.param_body_size')} ${theme && theme.bodyFontSize ? theme.bodyFontSize : DEFAULT_THEME.bodyFontSize} px`,
    paletteDisplayLabel(theme || DEFAULT_THEME),
    `${t('configure.param_body_font')} ${bodyFontLabel}`,
    `${t('configure.param_code_font')} ${codeFontLabel}`,
  ];
  return color(label, Ansi.GREY) + separator + color(parts.join(' · '), Ansi.IVORY);
}

function formatApplyChangeSummary(result) {
  const { changed, total } = countApplyReportEntries(result && result.report ? result.report : {});
  if (changed === 0) return t('apply.report.summary_all_current');
  const current = Math.max(0, total - changed);
  if (current === 0) return t('apply.report.summary_changed_no_current', { updated: changed });
  return t('apply.report.summary_changed', { updated: changed, current });
}

function countApplyReportEntries(report) {
  const rootFiles = report.rootWebviewFiles || [];
  const assetTrees = report.assetTrees || [];
  let total = 4 + rootFiles.length + assetTrees.length; // extension.js, webview/index.js, settings, system fonts
  let changed = 0;
  if (report.extensionJs && report.extensionJs.updated) changed++;
  if (report.webviewIndex && report.webviewIndex.updated) changed++;
  changed += rootFiles.filter(file => file.written).length;
  changed += assetTrees.filter(tree => tree.written > 0).length;
  if (report.settings && report.settings.updated) changed++;
  if (report.systemFonts && report.systemFonts.written > 0) changed++;
  if (!Number.isFinite(total) || total < 0) total = changed;
  return { changed, total };
}

function fileCount(count) {
  return t('apply.report.file_count', { count });
}

function settingKeyCount(count) {
  return t('apply.report.setting_key_count', { count });
}

function inferHostAppName(target) {
  const haystack = `${target && target.label || ''} ${target && target.extensionDir || ''} ${target && target.settingsPath || ''}`.toLowerCase();
  if (haystack.includes('antigravity')) return 'Antigravity';
  if (haystack.includes('windsurf')) return 'Windsurf';
  if (haystack.includes('trae cn') || haystack.includes('trae-cn')) return 'Trae CN';
  if (haystack.includes('trae')) return 'Trae';
  if (haystack.includes('kiro')) return 'Kiro';
  if (haystack.includes('cursor-insiders') || haystack.includes('cursor - insiders')) return 'Cursor Insiders';
  if (haystack.includes('cursor')) return 'Cursor';
  if (haystack.includes('code - oss') || haystack.includes('code-oss')) return 'Code - OSS';
  if (haystack.includes('vscodium') || haystack.includes('codium') || haystack.includes('.vscode-oss')) return 'VSCodium';
  if (haystack.includes('insiders') || haystack.includes('code - insiders') || haystack.includes('.vscode-insiders')) {
    return 'VS Code Insiders';
  }
  return 'VS Code';
}

function resolveRestoreTarget({ extensionsDir = null, settingsPath = null, interactive = false } = {}) {
  if (extensionsDir) {
    try {
      validateExplicitTarget(extensionsDir, settingsPath);
    } catch (exc) {
      printValidationError(exc);
      return null;
    }
    return findLatestClaudeCodeExtension({ extensionsDir, settingsPath });
  }

  const { merged, lastUsedId } = buildMergedTargets();
  const valid = merged.filter(e => e.valid);
  if (lastUsedId) {
    const hit = valid.find(e => e.id === lastUsedId);
    if (hit) return entryToTarget(hit);
  }
  if (valid.length === 1) return entryToTarget(valid[0]);
  if (valid.length === 0) {
    console.log(color(t('cli.no_targets_for_restore'), Ansi.RED));
    return null;
  }
  if (interactive) {
    const def = resolveDefaultTarget(merged, lastUsedId);
    if (def) return entryToTarget(def);
  }
  printAmbiguousTargets(merged, 'restore');
  return null;
}

async function handleRestore({
  silent = false,
  extensionsDir = null,
  settingsPath = null,
} = {}) {
  if (!silent) clearScreen({ history: true });
  console.log(color(t('restore.title'), Ansi.CYAN));
  console.log();

  let target;
  try {
    target = resolveRestoreTarget({
      extensionsDir,
      settingsPath,
      interactive: !silent,
    });
  } catch (exc) {
    console.log(color(t('apply.not_detected', { msg: exc.message }), Ansi.RED));
    return 1;
  }
  if (!target) return 1;

  console.log(`${t('apply.extension_header').padEnd(18)}: ${target.extensionDir}`);
  console.log(`${t('apply.version_header').padEnd(18)}: ${target.version}`);
  console.log();

  const backups = listAvailableBackups({ target });
  if (!backups.length) {
    console.log(color(t('restore.none'), Ansi.YELLOW));
    console.log(t('restore.backup_root', { path: BACKUP_ROOT }));
    return 0;
  }

  console.log(t('restore.backup_root', { path: BACKUP_ROOT }));
  console.log();
  console.log(t('restore.available'));
  backups.forEach((b, i) => console.log(`  [${i + 1}] ${b.label}`));
  console.log('  ' + t('restore.cancel_option'));
  console.log();

  const choice = (await prompt(t('restore.pick_prompt'))).trim().toLowerCase();
  if (!choice || choice === 'q' || choice === 'quit') {
    console.log(color(t('restore.cancelled'), Ansi.YELLOW));
    return 0;
  }
  const idx = parseInt(choice, 10) - 1;
  if (Number.isNaN(idx) || idx < 0 || idx >= backups.length) {
    console.log(color(t('restore.invalid_choice'), Ansi.RED));
    return 1;
  }

  const { label, backupDir, manifest } = backups[idx];
  console.log();
  console.log(t('restore.will_restore', { label }));
  console.log(t('restore.backup_dir',   { dir: backupDir }));
  console.log();
  const confirm = (await prompt(t('restore.confirm'))).trim().toLowerCase();
  if (confirm !== 'y' && confirm !== 'yes') {
    console.log(color(t('restore.cancelled'), Ansi.YELLOW));
    return 0;
  }

  let restored, skipped;
  try {
    [restored, skipped] = restoreBackup(manifest, { target });
  } catch (exc) {
    console.log(color(t('menu.operation_failed', { msg: exc.message }), Ansi.RED));
    if (exc.stack) console.log(exc.stack);
    return 1;
  }
  console.log();
  console.log(color(t('restore.done', { restored, skipped }), Ansi.GREEN));
  console.log(color(t('restore.reload_hint'), Ansi.YELLOW));
  return 0;
}

// Main menu rows — one for each action. `id` is returned from the
// keyLoop when the row is activated.
function mainMenuRows() {
  return [
    { id: 'apply',     mark: '1.', label: t('menu.apply') },
    { id: 'restore',   mark: '2.', label: t('menu.restore') },
    { id: 'configure', mark: '3.', label: t('menu.configure') },
    { id: 'target',    mark: '4.', label: t('menu.target') },
    { id: 'language',  mark: '5.', label: t('menu.cli_language') },
    { id: 'quit',      mark: 'q.', label: t('menu.quit') },
  ];
}

// Returns one of:
// 'apply' | 'restore' | 'configure' | 'target' | 'language' | 'quit'.
// The ledger shows the target apply would default to — auto-detected
// and merged with the user's stored manual entries. We try the user's
// last-used target first; if it's invalid (or no last-used is recorded),
// fall back to the first valid entry; if there are none at all the
// ledger renders the "extension missing" message.
async function selectMainMenu() {
  let target = null;
  try {
    const { merged, lastUsedId } = buildMergedTargets();
    const def = resolveDefaultTarget(merged, lastUsedId);
    if (def) {
      target = entryToTarget(def);
    }
  } catch (_) {
    // Fall back to legacy detection so the ledger still shows something
    // sensible if the targets schema or detector throws.
    try { target = findLatestClaudeCodeExtension(); } catch (_) {}
  }

  const rows = mainMenuRows();
  let index = 0;

  const render = () => {
    renderMainMenu({
      target,
      missingText: t('ledger.extension_missing'),
      backupRoot: BACKUP_ROOT,
      version: PACKAGE_VERSION,
      menuItems: rows.map((r, i) => ({
        mark: r.mark,
        label: r.label,
        selected: i === index,
      })),
      hint: t('hint.main'),
    });
  };

  return keyLoop({
    render,
    onKey: (str, key) => {
      if (!key) return;
      if (key.name === 'up' || key.name === 'k') {
        index = (index - 1 + rows.length) % rows.length;
        return;
      }
      if (key.name === 'down' || key.name === 'j') {
        index = (index + 1) % rows.length;
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        return { done: true, result: rows[index].id };
      }
      if (key.name === 'q' || str === 'q') {
        return { done: true, result: 'quit' };
      }
      // Number shortcuts jump straight to the matching row.
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].mark === `${str}.`) {
          return { done: true, result: rows[i].id };
        }
      }
    },
  });
}

// Configure screen rows — kinds: 'toggle' (space flips), 'knob' (enter
// drills), 'action' (enter fires). The rows are static; `index` tracks
// the currently focused row.
async function handleConfigure() {
  let index = 0;
  while (true) {
    const features = getFeatures();
    const theme = getTheme();

    const paletteValue = paletteDisplayLabel(theme);

    const bodyFontLabel = fontLabelForKey(theme.bodyFontFamily.key, 'body', theme);
    const codeFontLabel = fontLabelForKey(theme.codeFontFamily.key, 'code', theme);

    const render = () => renderConfigureMenu({
      version: PACKAGE_VERSION,
      heading: t('configure.heading'),
      features,
      theme,
      selectedIndex: index,
      hint: t('hint.configure'),
      labels: {
        math: t('configure.feature_math'),
        sessionUsage: t('configure.feature_session'),
        bodyFontSize: t('configure.param_body_size'),
        palette: t('configure.param_palette'),
        paletteValue,
        bodyFont: t('configure.param_body_font'),
        bodyFontValue: bodyFontLabel,
        codeFont: t('configure.param_code_font'),
        codeFontValue: codeFontLabel,
        reset: t('configure.reset'),
        back: t('configure.back'),
      },
    });

    // Rows: math, session, bodysize, palette, bodyfont, codefont, reset, back.
    const ROW_COUNT = 8;

    const outcome = await keyLoop({
      render,
      onKey: (str, key) => {
        if (!key) return;
        if (key.name === 'up' || key.name === 'k') {
          index = (index - 1 + ROW_COUNT) % ROW_COUNT;
          return;
        }
        if (key.name === 'down' || key.name === 'j') {
          index = (index + 1) % ROW_COUNT;
          return;
        }
        if (key.name === 'backspace' || key.name === 'escape' ||
            key.name === 'b' || key.name === 'q' ||
            str === 'b' || str === 'q') {
          return { done: true, result: { action: 'back' } };
        }
        // Space: toggle the boolean on rows 0/1.
        if (key.name === 'space' || str === ' ') {
          if (index === 0 || index === 1) {
            return { done: true, result: { action: 'toggle', index } };
          }
          return;
        }
        if (key.name === 'return' || key.name === 'enter') {
          if (index === 0 || index === 1) {
            return { done: true, result: { action: 'toggle', index } };
          }
          if (index === 2) return { done: true, result: { action: 'bodysize' } };
          if (index === 3) return { done: true, result: { action: 'palette' } };
          if (index === 4) return { done: true, result: { action: 'bodyfont' } };
          if (index === 5) return { done: true, result: { action: 'codefont' } };
          if (index === 6) return { done: true, result: { action: 'reset' } };
          if (index === 7) return { done: true, result: { action: 'back' } };
          return;
        }
        // Letter shortcuts (r for reset, number for direct row activation).
        if (key.name === 'r' || str === 'r') {
          return { done: true, result: { action: 'reset' } };
        }
        if (str === '1') { index = 0; return { done: true, result: { action: 'toggle', index: 0 } }; }
        if (str === '2') { index = 1; return { done: true, result: { action: 'toggle', index: 1 } }; }
        if (str === '3') { index = 2; return { done: true, result: { action: 'bodysize' } }; }
        if (str === '4') { index = 3; return { done: true, result: { action: 'palette' } }; }
        if (str === '5') { index = 4; return { done: true, result: { action: 'bodyfont' } }; }
        if (str === '6') { index = 5; return { done: true, result: { action: 'codefont' } }; }
      },
    });

    if (outcome.action === 'back') return;
    if (outcome.action === 'toggle') {
      if (outcome.index === 0) setFeature('math', !features.math);
      else if (outcome.index === 1) setFeature('sessionUsage', !features.sessionUsage);
      continue;
    }
    if (outcome.action === 'bodysize') {
      await chooseBodyFontSize();
      continue;
    }
    if (outcome.action === 'palette') {
      await choosePalette();
      continue;
    }
    if (outcome.action === 'bodyfont') {
      await chooseBodyFontFamily();
      continue;
    }
    if (outcome.action === 'codefont') {
      await chooseCodeFontFamily();
      continue;
    }
    if (outcome.action === 'reset') {
      const confirmed = await confirmReset();
      if (confirmed) {
        resetConfigurable();
        index = 0;
      }
      continue;
    }
  }
}

function normalizeCustomFontInput(raw, fallback) {
  if (!raw) return '';
  const value = String(raw).trim();
  if (!value) return '';
  // Reject characters that cannot appear in a valid font-family value.
  if (/[;{}\r\n]/.test(value)) {
    return '';
  }
  // Already a full CSS stack (contains commas) or ends with a generic family.
  if (/,/.test(value) || /\b(?:serif|sans-serif|monospace|cursive|fantasy|system-ui)\b$/i.test(value)) {
    return value;
  }
  // Single font name: wrap in quotes and append the intended fallback.
  const fb = fallback || 'serif';
  const fontName = value.replace(/^["']|["']$/g, '');
  return `"${fontName}", ${fb}`;
}

function fontLabelForKey(key, kind, theme) {
  if (key === 'custom') {
    const css = theme && (
      kind === 'body'
        ? theme.bodyFontFamily && theme.bodyFontFamily.css
        : theme.codeFontFamily && theme.codeFontFamily.css
    );
    const display = css && css.length > 20 ? css.slice(0, 20) + '...' : css;
    return display
      ? `${t('configure.font_custom_label')} (${display})`
      : t('configure.font_custom_label');
  }
  const map = kind === 'body'
    ? new Map(BODY_FONT_FAMILY_OPTIONS)
    : new Map(CODE_FONT_FAMILY_OPTIONS);
  if (map.has(key)) return t(`configure.font_${key.replace(/-/g, '_')}`);
  return key;
}

// ============================================================
// target merging + default-target resolution
// ============================================================

// Merge auto-detected and stored manual entries into one list. Each
// entry carries:
//   { id, label, extensionsDir, settingsPath, kind, version, valid }
// `version` is the highest extension version visible under
// `extensionsDir` at scan time (or '' if none).
function buildMergedTargets() {
  const stored = getStoredTargets();
  const auto = detectAutoTargets();

  const merged = [];

  // Manual entries first — their order in config drives the picker order.
  for (const m of stored.manual) {
    const validation = validateTargetEntry(m);
    merged.push({
      id: m.id,
      label: m.label,
      extensionsDir: m.extensionsDir,
      settingsPath: m.settingsPath || null,
      kind: 'manual',
      version: validation.valid ? validation.latestVersion : '',
      valid: validation.valid,
    });
  }

  // Then auto entries. A full target is (extensionsDir, settingsPath), not
  // only extensionsDir: VSCodium and Code - OSS can share the same extension
  // root while writing different User/settings.json files. Manual entries
  // still override auto entries with the same extensionsDir, preserving the
  // user's explicit choice.
  const seenTargets = new Set(merged.map(entryTargetKey));
  const manualDirs = new Set(merged.map(m => path.resolve(m.extensionsDir || '')));
  const autoDirCounts = countAutoDirs(auto);
  for (const a of auto) {
    const dirKey = path.resolve(a.extensionsDir);
    if (manualDirs.has(dirKey)) continue;
    const targetKey = entryTargetKey(a);
    if (seenTargets.has(targetKey)) continue;
    seenTargets.add(targetKey);
    merged.push({
      id: autoEntryId(a, autoDirCounts),
      label: a.label,
      extensionsDir: a.extensionsDir,
      settingsPath: a.settingsPath || null,
      kind: 'auto',
      version: a.latestVersion || '',
      valid: true,
    });
  }

  return { merged, lastUsedId: stored.lastUsed };
}

function entryTargetKey(entry) {
  return [
    path.resolve(entry && entry.extensionsDir || ''),
    path.resolve(entry && entry.settingsPath || ''),
  ].join('\0');
}

function countAutoDirs(auto) {
  const counts = new Map();
  for (const entry of auto) {
    const key = path.resolve(entry.extensionsDir || '');
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function autoEntryId(entry, dirCounts) {
  const dirKey = path.resolve(entry.extensionsDir || '');
  if ((dirCounts.get(dirKey) || 0) <= 1) return 'auto:' + dirKey;
  return 'auto:' + dirKey + '|settings:' + path.resolve(entry.settingsPath || '');
}

// Pick the default cursor target. `lastUsedId` is the id the user picked
// last time the apply pre-picker ran — if it's still in the list and
// valid, return it; otherwise fall back to the first valid entry. Used
// both by the ledger (to display "what would apply patch") and by the
// apply pre-picker (to seat the cursor).
function resolveDefaultTarget(merged, lastUsedId) {
  if (lastUsedId) {
    const hit = merged.find(e => e.id === lastUsedId && e.valid);
    if (hit) return hit;
  }
  return merged.find(e => e.valid) || null;
}

// Convert a merged entry into a target object compatible with
// install.js / backup.js.
function entryToTarget(entry) {
  const target = findLatestClaudeCodeExtension({
    extensionsDir: entry.extensionsDir,
    settingsPath: entry.settingsPath,
  });
  target.label = entry.label;
  return target;
}

// ============================================================
// non-interactive helpers — flags, list-targets, multi-host error
// ============================================================

// Normalize a path for human + AI consumption: forward slashes,
// no trailing slash. Windows backslashes get rewritten so the output
// of `incipit list-targets` can be pasted verbatim into `--extensions-dir`
// on any shell (bash / PowerShell / cmd) without escape gymnastics.
function toSlashes(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
}

// Validate a user-supplied --extensions-dir / --settings-path pair.
// Throws an Error tagged with the specific failure mode so the caller
// can route to the right i18n message.
function validateExplicitTarget(extensionsDir, settingsPath) {
  if (!fs.existsSync(extensionsDir)) {
    const e = new Error('extensions-dir-missing');
    e.code = 'EXT_MISSING';
    e.path = extensionsDir;
    throw e;
  }
  let stat;
  try { stat = fs.statSync(extensionsDir); } catch (_) {
    const e = new Error('extensions-dir-stat-failed');
    e.code = 'EXT_MISSING';
    e.path = extensionsDir;
    throw e;
  }
  if (!stat.isDirectory()) {
    const e = new Error('extensions-dir-not-dir');
    e.code = 'EXT_NOT_DIR';
    e.path = extensionsDir;
    throw e;
  }
  // Must contain at least one anthropic.claude-code-* subdirectory.
  let names;
  try { names = fs.readdirSync(extensionsDir); } catch (_) { names = []; }
  const hasCC = names.some(n => n.startsWith('anthropic.claude-code-'));
  if (!hasCC) {
    const e = new Error('extensions-dir-no-claude-code');
    e.code = 'EXT_NO_CC';
    e.path = extensionsDir;
    throw e;
  }
  if (settingsPath) {
    const parent = path.dirname(settingsPath);
    if (!fs.existsSync(parent)) {
      const e = new Error('settings-parent-missing');
      e.code = 'SET_PARENT_MISSING';
      e.path = parent;
      throw e;
    }
  }
}

// Print the merged target list to stdout in a stable, AI-parseable
// format. Returns the exit code (0 if any targets, 1 if empty).
//
// Format contract — `incipit list-targets`:
//
//   * <label> (<kind>, last-used)        ← '* ' prefix on the lastUsed row
//       extensions  <forward-slash path>
//       settings    <forward-slash path>
//       version     <numeric.dotted | unknown>
//
//     <label> (<kind>)
//       extensions  ...
//       ...
//
// The `extensions` value is exactly what `--extensions-dir` accepts
// (forward slashes, no quoting, no trailing slash) so AIs can lift the
// line and pipe it back into the next command without sanitization.
function handleListTargets() {
  const { merged, lastUsedId } = buildMergedTargets();

  if (!merged.length) {
    for (const line of t('cli.list_targets_empty').split('\n')) {
      console.log(line);
    }
    return 1;
  }

  const labelExt = t('cli.list_targets_label_extensions');
  const labelSet = t('cli.list_targets_label_settings');
  const labelVer = t('cli.list_targets_label_version');
  const markerLast = t('cli.list_targets_lastused_marker');
  const kindAuto = t('cli.list_targets_kind_auto');
  const kindManual = t('cli.list_targets_kind_manual');
  const invalidMark = t('cli.list_targets_invalid_marker');

  // Two-space gutter for entry separation; '* ' on lastUsed row, '  ' elsewhere.
  const labelCol = 12;
  for (let i = 0; i < merged.length; i++) {
    const e = merged[i];
    const isLast = e.id === lastUsedId;
    const kind = e.kind === 'auto' ? kindAuto : kindManual;
    const tags = [kind];
    if (isLast) tags.push(markerLast);
    if (!e.valid) tags.push(invalidMark);
    const head = (isLast ? '* ' : '  ') + e.label + '  (' + tags.join(', ') + ')';
    console.log(head);
    console.log('    ' + labelExt.padEnd(labelCol) + toSlashes(e.extensionsDir || ''));
    console.log('    ' + labelSet.padEnd(labelCol) + (e.settingsPath ? toSlashes(e.settingsPath) : '(unknown)'));
    console.log('    ' + labelVer.padEnd(labelCol) + (e.version || 'unknown'));
    if (i < merged.length - 1) console.log();
  }
  return 0;
}

// Translate a `validateExplicitTarget` error into a localized message
// and print it red. Caller returns exit 1.
function printValidationError(exc) {
  if (!exc || typeof exc.code !== 'string') {
    console.log(color(String(exc && exc.message || exc), Ansi.RED));
    return;
  }
  const map = {
    EXT_MISSING:        'cli.bad_extensions_dir_missing',
    EXT_NOT_DIR:        'cli.bad_extensions_dir_not_dir',
    EXT_NO_CC:          'cli.bad_extensions_dir_no_cc',
    SET_PARENT_MISSING: 'cli.bad_settings_parent_missing',
  };
  const key = map[exc.code];
  if (!key) {
    console.log(color(String(exc.message), Ansi.RED));
    return;
  }
  for (const line of t(key, { path: exc.path || '?' }).split('\n')) {
    console.log(color(line, Ansi.RED));
  }
}

// Print the multi-host disambiguation error and the copyable command
// templates, then return exit code 1. Called from non-interactive
// `incipit apply` when 2+ valid targets exist and no --extensions-dir
// was supplied and no lastUsed is recorded.
function printAmbiguousTargets(merged, command = 'apply') {
  const valid = merged.filter(e => e.valid);
  console.log(color(t('cli.ambiguous_targets_heading'), Ansi.RED));
  console.log();
  for (const e of valid) {
    const ver = e.version ? ('v' + e.version) : '';
    console.log('  · ' + e.label.padEnd(20) + '  ' + toSlashes(e.extensionsDir).padEnd(48) + '  ' + ver);
  }
  console.log();
  console.log(color(t('cli.ambiguous_targets_template_heading'), Ansi.IVORY));
  for (const e of valid) {
    console.log(`  incipit ${command} --extensions-dir ` + toSlashes(e.extensionsDir));
  }
  console.log();
  console.log(color(t('cli.ambiguous_targets_or_list'), Ansi.GREY));
}

// ============================================================
// target screen — main "4. Target" entry
// ============================================================

// The manage screen has two modes (see frontispiece.js for the visual
// contract):
//
//   - 'browse': cursor only on action rows (a / d / b). Target rows are
//     read-only display. Pressing 'd' (letter or selecting the row)
//     switches to 'delete' mode if there is at least one manual entry.
//
//   - 'delete': cursor only on target rows. The cursored row gets a
//     single ● glyph and is the row Enter would delete. Esc/b returns
//     to 'browse'. Auto entries are still rendered (the user needs to
//     see the full picture) but Enter on an auto row pops a "cannot
//     remove auto" message and stays in delete mode.
async function handleTarget() {
  let mode = 'browse';
  let selectedAction = 0;          // 0..2 in browse mode (a/d/b)
  let selectedDeleteRow = 0;       // index into merged in delete mode

  while (true) {
    const { merged } = buildMergedTargets();
    const hasManual = merged.some(e => e.kind === 'manual');

    const actions = [
      { mark: 'a.', label: t('target.add_label'),    id: 'add' },
      { mark: 'd.', label: t('target.remove_label'), id: 'remove' },
      { mark: 'b.', label: t('target.back'),         id: 'back' },
    ];

    if (mode === 'delete') {
      // Clamp delete cursor to the current list (entries may have been
      // removed since we entered delete mode).
      if (merged.length === 0) {
        mode = 'browse';
        continue;
      }
      if (selectedDeleteRow >= merged.length) {
        selectedDeleteRow = Math.max(0, merged.length - 1);
      }
    } else {
      if (selectedAction >= actions.length) selectedAction = actions.length - 1;
    }

    const render = () => renderTargetMenu({
      mode,
      version: PACKAGE_VERSION,
      heading: t('target.heading'),
      entries: merged,
      actions,
      selectedIndex: mode === 'delete' ? selectedDeleteRow : selectedAction,
      hint: mode === 'delete' ? t('target.hint_delete') : t('target.hint'),
      listHeading: t('target.list_heading'),
      deleteHeading: t('target.delete_mode_heading'),
      noTargetsText: t('target.no_targets'),
      noTargetsHint: t('target.no_targets_hint'),
      columnLabels: {
        auto:    t('target.column_auto'),
        manual:  t('target.column_manual'),
        invalid: t('target.column_invalid'),
      },
    });

    const outcome = await keyLoop({
      render,
      onKey: (str, key) => {
        if (!key) return;

        if (mode === 'delete') {
          if (key.name === 'up' || key.name === 'k') {
            selectedDeleteRow = (selectedDeleteRow - 1 + merged.length) % merged.length;
            return;
          }
          if (key.name === 'down' || key.name === 'j') {
            selectedDeleteRow = (selectedDeleteRow + 1) % merged.length;
            return;
          }
          if (key.name === 'backspace' || key.name === 'escape' ||
              key.name === 'b' || key.name === 'q' ||
              str === 'b' || str === 'q') {
            return { done: true, result: { action: 'exit-delete' } };
          }
          if (key.name === 'return' || key.name === 'enter') {
            return {
              done: true,
              result: { action: 'delete-confirm', entry: merged[selectedDeleteRow] },
            };
          }
          return;
        }

        // Browse mode.
        if (key.name === 'up' || key.name === 'k') {
          selectedAction = (selectedAction - 1 + actions.length) % actions.length;
          return;
        }
        if (key.name === 'down' || key.name === 'j') {
          selectedAction = (selectedAction + 1) % actions.length;
          return;
        }
        if (key.name === 'backspace' || key.name === 'escape' ||
            key.name === 'b' || key.name === 'q' ||
            str === 'b' || str === 'q') {
          return { done: true, result: { action: 'back' } };
        }
        if (key.name === 'a' || str === 'a') {
          return { done: true, result: { action: 'add' } };
        }
        if (key.name === 'd' || str === 'd') {
          return { done: true, result: { action: 'remove' } };
        }
        if (key.name === 'return' || key.name === 'enter') {
          return { done: true, result: { action: actions[selectedAction].id } };
        }
      },
    });

    if (!outcome) continue;

    if (outcome.action === 'back') return;

    if (outcome.action === 'exit-delete') {
      mode = 'browse';
      continue;
    }

    if (outcome.action === 'delete-confirm') {
      const entry = outcome.entry;
      if (!entry) continue;
      if (entry.kind === 'auto') {
        resetScreenForPrompt();
        console.log();
        console.log('  ' + color(t('target.cannot_remove_auto'), Ansi.YELLOW));
        await pause();
        continue; // stay in delete mode
      }
      const ok = await confirmRemoveTarget();
      if (ok) {
        removeManualTarget(entry.id);
        resetScreenForPrompt();
        console.log();
        console.log('  ' + color(t('target.removed'), Ansi.GREEN));
        await pause();
      }
      // After delete (or after declining), stay in delete mode unless
      // there's nothing left.
      const after = buildMergedTargets().merged;
      if (!after.length) mode = 'browse';
      continue;
    }

    if (outcome.action === 'remove') {
      // Browse mode "× Remove target" — enter delete mode if there is
      // at least one manual entry, otherwise show the "no manual"
      // message and stay in browse.
      if (!hasManual) {
        resetScreenForPrompt();
        console.log();
        console.log('  ' + color(t('target.no_manual_to_delete'), Ansi.YELLOW));
        await pause();
        continue;
      }
      mode = 'delete';
      // Seat delete cursor on the first manual entry for convenience.
      const firstManualIdx = merged.findIndex(e => e.kind === 'manual');
      selectedDeleteRow = firstManualIdx >= 0 ? firstManualIdx : 0;
      continue;
    }
    if (outcome.action === 'add') {
      try {
        await runAddTargetWizard();
      } catch (exc) {
        resetScreenForPrompt();
        console.log(color(t('menu.operation_failed', { msg: exc.message }), Ansi.RED));
        if (exc.stack) console.log(exc.stack);
        await pause();
      }
      continue;
    }
  }
}

async function confirmRemoveTarget() {
  resetScreenForPrompt();
  console.log();
  console.log('  ' + color(t('target.confirm_remove'), Ansi.YELLOW));
  let raw;
  try { raw = await prompt('  '); } catch (_) { return false; }
  return /^y(es)?$/i.test(String(raw || '').trim());
}

// ============================================================
// add-target wizard — intro + folder dialog + identify + confirm
// ============================================================

async function runAddTargetWizard() {
  // Step 1: dialog availability check. Render the unavailable screen
  // and bail before opening anything.
  if (!isDialogAvailable()) {
    await renderDialogUnavailable(dialogUnavailableReason());
    return;
  }

  // Step 2: intro screen. Two actions — proceed (open dialog) / cancel.
  const proceedActions = [
    { mark: '1.', label: t('target.add.proceed'), id: 'proceed' },
    { mark: '2.', label: t('target.add.cancel'),  id: 'cancel' },
  ];
  let selectedIndex = 0;
  const introOutcome = await keyLoop({
    render: () => renderAddTargetIntro({
      version: PACKAGE_VERSION,
      heading: t('target.add.heading'),
      intro: t('target.add.intro'),
      dialogWord: t('target.add.intro_dialog_word'),
      optionA: t('target.add.option_a'),
      optionAEgs: t('target.add.option_a_egs'),
      optionAEgs2: t('target.add.option_a_egs2'),
      optionB: t('target.add.option_b'),
      optionBEgs: t('target.add.option_b_egs'),
      optionBEgs2: t('target.add.option_b_egs2'),
      optionC: t('target.add.option_c'),
      optionCEg: t('target.add.option_c_eg'),
      actions: proceedActions,
      selectedIndex,
      hint: t('hint.picker'),
    }),
    onKey: (str, key) => {
      if (!key) return;
      if (key.name === 'up' || key.name === 'k') {
        selectedIndex = (selectedIndex - 1 + proceedActions.length) % proceedActions.length;
        return;
      }
      if (key.name === 'down' || key.name === 'j') {
        selectedIndex = (selectedIndex + 1) % proceedActions.length;
        return;
      }
      if (key.name === 'backspace' || key.name === 'escape' ||
          key.name === 'b' || key.name === 'q' ||
          str === 'b' || str === 'q') {
        return { done: true, result: 'cancel' };
      }
      if (key.name === 'return' || key.name === 'enter') {
        return { done: true, result: proceedActions[selectedIndex].id };
      }
      if (str === '1') return { done: true, result: 'proceed' };
      if (str === '2') return { done: true, result: 'cancel' };
    },
  });
  if (introOutcome !== 'proceed') return;

  // Step 3: open the folder dialog. The dialog runs synchronously and
  // blocks the terminal until the user picks/cancels.
  let pickedPath;
  try {
    pickedPath = pickFolder({ title: t('target.add.dialog_title') });
  } catch (exc) {
    if (exc instanceof DialogUnavailableError) {
      await renderDialogUnavailable(exc.code);
      return;
    }
    resetScreenForPrompt();
    console.log();
    console.log('  ' + color(t('target.add.dialog_failed', { msg: exc.message }), Ansi.RED));
    await pause();
    return;
  }
  if (!pickedPath) {
    resetScreenForPrompt();
    console.log();
    console.log('  ' + color(t('target.add.cancelled'), Ansi.GREY));
    await pause();
    return;
  }

  // Step 4: identify. Loop on failure so the user can re-pick.
  let identification = identifyFolder(pickedPath);
  while (identification.kind === 'unknown' || identification.kind === 'standard_install_root') {
    const repick = await renderIdentifyFailureAndChoose(pickedPath, identification);
    if (repick !== 'repick') return;
    let nextPicked;
    try {
      nextPicked = pickFolder({ title: t('target.add.dialog_title') });
    } catch (exc) {
      if (exc instanceof DialogUnavailableError) {
        await renderDialogUnavailable(exc.code);
        return;
      }
      resetScreenForPrompt();
      console.log();
      console.log('  ' + color(t('target.add.dialog_failed', { msg: exc.message }), Ansi.RED));
      await pause();
      return;
    }
    if (!nextPicked) {
      resetScreenForPrompt();
      console.log();
      console.log('  ' + color(t('target.add.cancelled'), Ansi.GREY));
      await pause();
      return;
    }
    pickedPath = nextPicked;
    identification = identifyFolder(pickedPath);
  }

  // Step 5: identify success — show the result, capture an optional
  // label, save. The label is collected via a one-shot readline prompt
  // rendered after the keyLoop confirms "save".
  const result = await reviewIdentifyAndSave(identification);
  if (result && result.status === 'saved') {
    resetScreenForPrompt();
    console.log();
    console.log('  ' + color(
      t('target.added', { label: result.label || pickedPath }),
      Ansi.GREEN,
    ));
    await pause();
  }
}

async function renderDialogUnavailable(reasonCode) {
  let bodyKey = 'target.add.dialog_unavailable_other';
  if (reasonCode === 'no-display') bodyKey = 'target.add.dialog_unavailable_no_display';
  else if (reasonCode === 'no-zenity-no-kdialog') bodyKey = 'target.add.dialog_unavailable_no_zk';

  resetScreenForPrompt();
  console.log();
  console.log('  ' + color(t('target.add.dialog_unavailable_title'), Ansi.YELLOW));
  console.log();
  for (const line of t(bodyKey).split('\n')) {
    console.log('  ' + color(line, Ansi.IVORY));
  }
  console.log();
  await pause();
}

async function renderIdentifyFailureAndChoose(picked, identification) {
  const actions = [
    { mark: '1.', label: t('target.identify.fail_repick'), id: 'repick' },
    { mark: '2.', label: t('target.identify.fail_back'),   id: 'back' },
  ];
  const isStandardInstall = identification.kind === 'standard_install_root';
  const body = isStandardInstall
    ? t('target.identify.fail_standard_install')
    : t('target.identify.fail_unknown');

  let selectedIndex = 0;
  const outcome = await keyLoop({
    render: () => renderIdentifyFailure({
      version: PACKAGE_VERSION,
      heading: t('target.identify.fail_heading'),
      picked,
      body,
      labelPicked: t('target.identify.fail_picked'),
      actions,
      selectedIndex,
      hint: t('hint.picker'),
    }),
    onKey: (str, key) => {
      if (!key) return;
      if (key.name === 'up' || key.name === 'k') {
        selectedIndex = (selectedIndex - 1 + actions.length) % actions.length;
        return;
      }
      if (key.name === 'down' || key.name === 'j') {
        selectedIndex = (selectedIndex + 1) % actions.length;
        return;
      }
      if (key.name === 'backspace' || key.name === 'escape' ||
          key.name === 'b' || key.name === 'q' ||
          str === 'b' || str === 'q') {
        return { done: true, result: 'back' };
      }
      if (key.name === 'return' || key.name === 'enter') {
        return { done: true, result: actions[selectedIndex].id };
      }
      if (str === '1') return { done: true, result: 'repick' };
      if (str === '2') return { done: true, result: 'back' };
    },
  });
  return outcome;
}

async function reviewIdentifyAndSave(identification) {
  const kindLabelKey = `target.identify.kind_${identification.kind}`;
  const kindLabel = t(kindLabelKey);
  const emptyDataWarn = identification.kind === 'portable_data_empty'
    ? t('target.identify.empty_data_warn')
    : null;
  const settingsInferred = identification.settingsPath
    ? null
    : t('target.identify.no_settings_inferred');

  const actions = [
    { mark: '1.', label: t('target.identify.save'),   id: 'save' },
    { mark: '2.', label: t('target.identify.repick'), id: 'repick' },
    { mark: '3.', label: t('target.identify.cancel'), id: 'cancel' },
  ];

  let selectedIndex = 0;
  const outcome = await keyLoop({
    render: () => renderIdentifyResult({
      version: PACKAGE_VERSION,
      heading: t('target.add.heading'),
      kindLabel,
      extensionsDir: identification.extensionsDir,
      settingsPath: identification.settingsPath,
      latestVersion: identification.latestVersion,
      settingsInferred,
      emptyDataWarn,
      actions,
      selectedIndex,
      hint: t('hint.picker'),
      labels: {
        recognized: t('target.identify.recognized'),
        kind:       t('target.identify.label_kind'),
        extensions: t('target.identify.label_extensions'),
        settings:   t('target.identify.label_settings'),
        version:    t('target.identify.label_version'),
      },
    }),
    onKey: (str, key) => {
      if (!key) return;
      if (key.name === 'up' || key.name === 'k') {
        selectedIndex = (selectedIndex - 1 + actions.length) % actions.length;
        return;
      }
      if (key.name === 'down' || key.name === 'j') {
        selectedIndex = (selectedIndex + 1) % actions.length;
        return;
      }
      if (key.name === 'backspace' || key.name === 'escape' ||
          key.name === 'b' || key.name === 'q' ||
          str === 'b' || str === 'q') {
        return { done: true, result: 'cancel' };
      }
      if (key.name === 'return' || key.name === 'enter') {
        return { done: true, result: actions[selectedIndex].id };
      }
      if (str === '1') return { done: true, result: 'save' };
      if (str === '2') return { done: true, result: 'repick' };
      if (str === '3') return { done: true, result: 'cancel' };
    },
  });

  if (outcome !== 'save') return { status: outcome };

  // Collect optional label via readline.
  resetScreenForPrompt();
  console.log();
  console.log('  ' + color(t('target.identify.prompt_label'), Ansi.GREY));
  let raw;
  try { raw = await prompt('  > '); } catch (_) { raw = ''; }
  const userLabel = String(raw || '').trim();
  const finalLabel = userLabel || defaultLabelForIdentification(identification);

  const id = generateTargetId();
  addManualTarget({
    id,
    label: finalLabel,
    extensionsDir: identification.extensionsDir,
    settingsPath: identification.settingsPath || null,
  });
  // Seat the next apply's cursor on the freshly-added target — that's
  // what the user is here for.
  setLastUsedTargetId(id);
  return { status: 'saved', label: finalLabel, id };
}

function defaultLabelForIdentification(identification) {
  if (identification.kind === 'extension_version' && identification.latestExtName) {
    return identification.latestExtName;
  }
  if (identification.extensionsDir) {
    return path.basename(path.dirname(identification.extensionsDir)) || 'Custom target';
  }
  return 'Custom target';
}

// ============================================================
// apply pre-picker — invoked once before each interactive apply
// ============================================================

// Returns one of: { action: 'use', entry } | { action: 'add' } |
// { action: 'cancel' }.
//
// The cursor seats on the last-used target (or the first valid entry
// when the saved id is gone), the dot in renderApplyPicker tracks the
// cursor, and Enter on a target row commits to that single entry.
// One apply, one target — no multi-select.
async function selectApplyTarget() {
  const { merged, lastUsedId } = buildMergedTargets();
  const def = resolveDefaultTarget(merged, lastUsedId);

  // Keep merged order — manual entries first, then auto. Single source
  // of truth for the row order between the manage screen and the picker.
  const orderedEntries = merged.slice();

  const actions = [
    { mark: 'a.', label: t('target.add_label'),                 id: 'add' },
    { mark: 'b.', label: t('target.apply_picker.cancel_label'), id: 'cancel' },
  ];

  const totalRows = orderedEntries.length + actions.length;

  // Seat the cursor on the default target. If there are no entries the
  // cursor lands on the first action row instead.
  let selectedIndex = 0;
  if (def) {
    const idx = orderedEntries.findIndex(e => e.id === def.id);
    if (idx >= 0) selectedIndex = idx;
  } else if (!orderedEntries.length) {
    selectedIndex = 0;
  }

  const outcome = await keyLoop({
    render: () => renderApplyPicker({
      version: PACKAGE_VERSION,
      heading: t('target.apply_picker.heading'),
      entries: orderedEntries,
      actions,
      selectedIndex,
      hint: t('hint.picker'),
      noActiveText: t('target.apply_picker.no_active'),
      columnLabels: {
        auto:   t('target.column_auto'),
        manual: t('target.column_manual'),
      },
    }),
    onKey: (str, key) => {
      if (!key) return;
      if (key.name === 'up' || key.name === 'k') {
        selectedIndex = (selectedIndex - 1 + totalRows) % totalRows;
        return;
      }
      if (key.name === 'down' || key.name === 'j') {
        selectedIndex = (selectedIndex + 1) % totalRows;
        return;
      }
      if (key.name === 'backspace' || key.name === 'escape' ||
          key.name === 'b' || key.name === 'q' ||
          str === 'b' || str === 'q') {
        return { done: true, result: { action: 'cancel' } };
      }
      if (key.name === 'a' || str === 'a') {
        return { done: true, result: { action: 'add' } };
      }
      if (key.name === 'return' || key.name === 'enter') {
        if (selectedIndex < orderedEntries.length) {
          return { done: true, result: { action: 'use', entry: orderedEntries[selectedIndex] } };
        }
        const actionIdx = selectedIndex - orderedEntries.length;
        if (actionIdx >= 0 && actionIdx < actions.length) {
          return { done: true, result: { action: actions[actionIdx].id } };
        }
      }
    },
  });

  return outcome || { action: 'cancel' };
}

// Reset confirmation exits raw mode and uses a simple readline [y/N]
// prompt — same pattern as the startup update prompt.
async function confirmReset() {
  resetScreenForPrompt();
  console.log();
  console.log('  ' + color(t('configure.reset_confirm'), Ansi.YELLOW));
  let raw;
  try { raw = await prompt('  '); } catch (_) { return false; }
  const yes = /^y(es)?$/i.test(raw.trim());
  if (yes) {
    console.log();
    console.log('  ' + color(t('configure.reset_done'), Ansi.GREEN));
    await pause();
  }
  return yes;
}

async function chooseBodyFontSize() {
  const defaultMark = t('configure.body_size_default_mark');
  const current = getTheme().bodyFontSize;
  let index = Math.max(0, BODY_FONT_SIZE_OPTIONS.indexOf(current));

  const render = () => {
    const options = BODY_FONT_SIZE_OPTIONS.map((size, idx) => ({
      mark: `${idx + 1}.`,
      label: `${size} px` +
        (size === DEFAULT_THEME.bodyFontSize ? `  ${defaultMark}` : ''),
      selected: idx === index,
    }));
    options.push({ mark: 'b.', label: t('configure.back'), selected: index === BODY_FONT_SIZE_OPTIONS.length });
    renderLanguagePicker({
      version: PACKAGE_VERSION,
      heading: t('configure.body_size_heading'),
      optionsList: options,
      hint: t('hint.picker'),
    });
  };

  const total = BODY_FONT_SIZE_OPTIONS.length + 1;  // options + back row
  const outcome = await keyLoop({
    render,
    onKey: (str, key) => {
      if (!key) return;
      if (key.name === 'up' || key.name === 'k') {
        index = (index - 1 + total) % total;
        return;
      }
      if (key.name === 'down' || key.name === 'j') {
        index = (index + 1) % total;
        return;
      }
      if (key.name === 'backspace' || key.name === 'escape' ||
          key.name === 'b' || key.name === 'q' ||
          str === 'b' || str === 'q') {
        return { done: true, result: { back: true } };
      }
      if (key.name === 'return' || key.name === 'enter') {
        if (index < BODY_FONT_SIZE_OPTIONS.length) {
          return { done: true, result: { pick: BODY_FONT_SIZE_OPTIONS[index] } };
        }
        return { done: true, result: { back: true } };
      }
      // Number shortcut: 1/2/3 immediately pick that size.
      const n = parseInt(str, 10);
      if (Number.isFinite(n) && n >= 1 && n <= BODY_FONT_SIZE_OPTIONS.length) {
        return { done: true, result: { pick: BODY_FONT_SIZE_OPTIONS[n - 1] } };
      }
    },
  });

  if (outcome.pick != null) setBodyFontSize(outcome.pick);
}

async function choosePalette() {
  const defaultMark = t('configure.body_size_default_mark');
  const current = getTheme();

  // The picker exposes three rows but writes to two orthogonal config
  // fields (palette + bodyBold). "Warm white (bold body)" is the same
  // warm-white palette with the body-weight gate enabled, NOT a third
  // palette — keeping it factored this way means future warm-white CSS /
  // Monaco theme / hljs work flows to both states automatically.
  const PICKS = [
    { palette: 'warm-black', bodyBold: false, key: 'warm-black' },
    { palette: 'warm-white', bodyBold: false, key: 'warm-white' },
    { palette: 'warm-white', bodyBold: true,  key: 'warm-white-bold' },
  ];

  const labelFor = pick => {
    if (pick.palette !== 'warm-white') return t('configure.palette_warm_black');
    return pick.bodyBold
      ? t('configure.palette_warm_white_bold')
      : t('configure.palette_warm_white');
  };

  const isCurrent = pick =>
    pick.palette === current.palette && pick.bodyBold === current.bodyBold;
  let index = Math.max(0, PICKS.findIndex(isCurrent));

  const render = () => {
    const options = PICKS.map((pick, idx) => ({
      mark: `${idx + 1}.`,
      label: labelFor(pick) +
        (pick.palette === DEFAULT_THEME.palette &&
         pick.bodyBold === DEFAULT_THEME.bodyBold
          ? `  ${defaultMark}` : ''),
      selected: idx === index,
    }));
    options.push({ mark: 'b.', label: t('configure.back'), selected: index === PICKS.length });
    renderLanguagePicker({
      version: PACKAGE_VERSION,
      heading: t('configure.palette_heading'),
      optionsList: options,
      hint: t('hint.picker'),
    });
  };

  const total = PICKS.length + 1;  // options + back row
  const outcome = await keyLoop({
    render,
    onKey: (str, key) => {
      if (!key) return;
      if (key.name === 'up' || key.name === 'k') {
        index = (index - 1 + total) % total;
        return;
      }
      if (key.name === 'down' || key.name === 'j') {
        index = (index + 1) % total;
        return;
      }
      if (key.name === 'backspace' || key.name === 'escape' ||
          key.name === 'b' || key.name === 'q' ||
          str === 'b' || str === 'q') {
        return { done: true, result: { back: true } };
      }
      if (key.name === 'return' || key.name === 'enter') {
        if (index < PICKS.length) {
          return { done: true, result: { pick: PICKS[index] } };
        }
        return { done: true, result: { back: true } };
      }
      const n = parseInt(str, 10);
      if (Number.isFinite(n) && n >= 1 && n <= PICKS.length) {
        return { done: true, result: { pick: PICKS[n - 1] } };
      }
    },
  });

  if (outcome.pick != null) {
    setPalette(outcome.pick.palette);
    setBodyBold(outcome.pick.bodyBold);
  }
}

async function chooseBodyFontFamily() {
  const defaultMark = t('configure.body_size_default_mark');
  const current = getTheme().bodyFontFamily;
  const presets = BODY_FONT_FAMILY_OPTIONS.map(([key]) => ({ key, label: t(`configure.font_${key.replace(/-/g, '_')}`) }));
  const rows = [
    ...presets.map((p, idx) => ({ mark: `${idx + 1}.`, ...p })),
    { mark: `${presets.length + 1}.`, key: 'custom', label: t('configure.font_custom_label') },
  ];
  let index = Math.max(0, rows.findIndex(r => r.key === current.key));
  if (index < 0) index = rows.length - 1; // custom

  const render = () => {
    const options = rows.map((row, idx) => ({
      mark: row.mark,
      label: row.label + (row.key === DEFAULT_THEME.bodyFontFamily ? `  ${defaultMark}` : ''),
      selected: idx === index,
    }));
    options.push({ mark: 'b.', label: t('configure.back'), selected: index === rows.length });
    renderLanguagePicker({
      version: PACKAGE_VERSION,
      heading: t('configure.body_font_heading'),
      optionsList: options,
      hint: t('hint.picker'),
    });
  };

  const total = rows.length + 1;
  const outcome = await keyLoop({
    render,
    onKey: (str, key) => {
      if (!key) return;
      if (key.name === 'up' || key.name === 'k') {
        index = (index - 1 + total) % total;
        return;
      }
      if (key.name === 'down' || key.name === 'j') {
        index = (index + 1) % total;
        return;
      }
      if (key.name === 'backspace' || key.name === 'escape' ||
          key.name === 'b' || key.name === 'q' ||
          str === 'b' || str === 'q') {
        return { done: true, result: { back: true } };
      }
      if (key.name === 'return' || key.name === 'enter') {
        if (index < rows.length) {
          return { done: true, result: { pick: rows[index].key } };
        }
        return { done: true, result: { back: true } };
      }
      const n = parseInt(str, 10);
      if (Number.isFinite(n) && n >= 1 && n <= rows.length) {
        return { done: true, result: { pick: rows[n - 1].key } };
      }
    },
  });

  if (outcome.pick === 'custom') {
    resetScreenForPrompt();
    console.log();
    console.log('  ' + color(t('configure.font_custom_prompt'), Ansi.GREY));
    let raw;
    try { raw = await prompt('  > '); } catch (_) { raw = ''; }
    const css = normalizeCustomFontInput(String(raw || '').trim(), 'serif');
    if (css) setBodyFontFamily(css);
    return;
  }
  if (outcome.pick != null) setBodyFontFamily(outcome.pick);
}

async function chooseCodeFontFamily() {
  const defaultMark = t('configure.body_size_default_mark');
  const current = getTheme().codeFontFamily;
  const presets = CODE_FONT_FAMILY_OPTIONS.map(([key]) => ({ key, label: t(`configure.font_${key.replace(/-/g, '_')}`) }));
  const rows = [
    ...presets.map((p, idx) => ({ mark: `${idx + 1}.`, ...p })),
    { mark: `${presets.length + 1}.`, key: 'custom', label: t('configure.font_custom_label') },
  ];
  let index = Math.max(0, rows.findIndex(r => r.key === current.key));
  if (index < 0) index = rows.length - 1;

  const render = () => {
    const options = rows.map((row, idx) => ({
      mark: row.mark,
      label: row.label + (row.key === DEFAULT_THEME.codeFontFamily ? `  ${defaultMark}` : ''),
      selected: idx === index,
    }));
    options.push({ mark: 'b.', label: t('configure.back'), selected: index === rows.length });
    renderLanguagePicker({
      version: PACKAGE_VERSION,
      heading: t('configure.code_font_heading'),
      optionsList: options,
      hint: t('hint.picker'),
    });
  };

  const total = rows.length + 1;
  const outcome = await keyLoop({
    render,
    onKey: (str, key) => {
      if (!key) return;
      if (key.name === 'up' || key.name === 'k') {
        index = (index - 1 + total) % total;
        return;
      }
      if (key.name === 'down' || key.name === 'j') {
        index = (index + 1) % total;
        return;
      }
      if (key.name === 'backspace' || key.name === 'escape' ||
          key.name === 'b' || key.name === 'q' ||
          str === 'b' || str === 'q') {
        return { done: true, result: { back: true } };
      }
      if (key.name === 'return' || key.name === 'enter') {
        if (index < rows.length) {
          return { done: true, result: { pick: rows[index].key } };
        }
        return { done: true, result: { back: true } };
      }
      const n = parseInt(str, 10);
      if (Number.isFinite(n) && n >= 1 && n <= rows.length) {
        return { done: true, result: { pick: rows[n - 1].key } };
      }
    },
  });

  if (outcome.pick === 'custom') {
    resetScreenForPrompt();
    console.log();
    console.log('  ' + color(t('configure.font_custom_prompt'), Ansi.GREY));
    let raw;
    try { raw = await prompt('  > '); } catch (_) { raw = ''; }
    const css = normalizeCustomFontInput(String(raw || '').trim(), 'monospace');
    if (css) setCodeFontFamily(css);
    return;
  }
  if (outcome.pick != null) setCodeFontFamily(outcome.pick);
}

async function chooseCliLanguage() {
  const current = getLanguage() || 'en';
  const rows = SUPPORTED_LANGUAGES.map((lang, idx) => ({
    mark: `${idx + 1}.`,
    lang,
    label: languageDisplayLabel(lang),
  }));
  let index = Math.max(0, rows.findIndex(row => row.lang === current));

  const render = () => {
    const options = rows.map((row, idx) => ({
      mark: row.mark,
      label: row.label,
      selected: idx === index,
    }));
    options.push({ mark: 'b.', label: t('configure.back'), selected: index === rows.length });
    renderLanguagePicker({
      version: PACKAGE_VERSION,
      heading: t('language.heading'),
      optionsList: options,
      hint: t('hint.picker'),
    });
  };

  const total = rows.length + 1;  // languages + back row
  const outcome = await keyLoop({
    render,
    onKey: (str, key) => {
      if (!key) return;
      if (key.name === 'up' || key.name === 'k') {
        index = (index - 1 + total) % total;
        return;
      }
      if (key.name === 'down' || key.name === 'j') {
        index = (index + 1) % total;
        return;
      }
      if (key.name === 'backspace' || key.name === 'escape' ||
          key.name === 'b' || key.name === 'q' ||
          str === 'b' || str === 'q') {
        return { done: true, result: { back: true } };
      }
      if (key.name === 'return' || key.name === 'enter') {
        if (index < rows.length) {
          return { done: true, result: { pick: rows[index].lang } };
        }
        return { done: true, result: { back: true } };
      }
      const n = parseInt(str, 10);
      if (Number.isFinite(n) && n >= 1 && n <= rows.length) {
        return { done: true, result: { pick: rows[n - 1].lang } };
      }
    },
  });

  if (outcome.pick) {
    setLanguage(outcome.pick);
    setLocale(outcome.pick);
  }
}

function printHelp() {
  const brand = color('incipit', `${Ansi.TERRA}${Ansi.BOLD}`);
  const tagline = color('a quiet typesetting patch for long-form reading', `${Ansi.GREY}${Ansi.ITALIC}`);
  const usage = color(t('help.usage_heading'), Ansi.GREY);
  const flags = color('flags', `${Ansi.GREY}${Ansi.ITALIC}`);
  const cmd = value => color(value, Ansi.IVORY);
  console.log(`
  ${brand}  ${tagline}

  ${usage}
    ${cmd('incipit')}                                   ${t('help.cmd_default')}
    ${cmd('incipit apply')}                             ${t('help.cmd_apply')}
    ${cmd('incipit restore')}                           ${t('help.cmd_restore')}
    ${cmd('incipit list-targets')}                      ${t('help.cmd_list_targets')}
    ${cmd('incipit --version')}                         ${t('help.cmd_version')}

  ${usage} (${flags})
    ${cmd('incipit apply|restore --extensions-dir <path>')}  ${t('help.cmd_extensions_dir')}
    ${cmd('              --settings-path  <path>')}     ${t('help.cmd_settings_path')}
    ${cmd('incipit --lang zh|en')}                      ${t('help.cmd_lang')}
    ${cmd('incipit --no-update-check')}                 ${t('help.cmd_no_update_check')}
    ${cmd('incipit --help')}                            ${t('help.cmd_help')}

  ${t('help.reload_hint')}
  ${t('help.upgrade_hint')}
`);
}

async function showLanguagePicker() {
  const rows = [
    { id: 'zh', mark: '1.', label: '中文' },
    { id: 'en', mark: '2.', label: 'English' },
  ];
  let index = 0;

  const render = () => {
    renderLanguagePicker({
      heading: 'Please choose your language  /  请选择语言',
      version: PACKAGE_VERSION,
      optionsList: rows.map((r, i) => ({
        mark: r.mark, label: r.label, selected: i === index,
      })),
      hint: t('hint.picker'),
    });
  };

  return keyLoop({
    render,
    onKey: (str, key) => {
      if (!key) return;
      if (key.name === 'up' || key.name === 'k') {
        index = (index - 1 + rows.length) % rows.length;
        return;
      }
      if (key.name === 'down' || key.name === 'j') {
        index = (index + 1) % rows.length;
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        return { done: true, result: rows[index].id };
      }
      if (str === '1') return { done: true, result: 'zh' };
      if (str === '2') return { done: true, result: 'en' };
    },
  });
}

async function resolveLocale({ interactive, forcedLang }) {
  if (forcedLang && SUPPORTED_LANGUAGES.includes(forcedLang)) {
    setLanguage(forcedLang);
    setLocale(forcedLang);
    return forcedLang;
  }
  const saved = getLanguage();
  if (saved) {
    setLocale(saved);
    return saved;
  }
  if (!interactive) {
    setLocale('en');
    return 'en';
  }
  const picked = await showLanguagePicker();
  try { setLanguage(picked); } catch (_) {}
  setLocale(picked);
  return picked;
}

function extractFlags(args) {
  let forcedLang = null;
  let noUpdateCheck = false;
  let extensionsDir = null;
  let settingsPath = null;
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--lang' && i + 1 < args.length) {
      forcedLang = args[i + 1];
      i += 1;
      continue;
    }
    const langEq = /^--lang=(.+)$/.exec(a);
    if (langEq) {
      forcedLang = langEq[1];
      continue;
    }
    if (a === '--no-update-check') {
      noUpdateCheck = true;
      continue;
    }
    if (a === '--extensions-dir' && i + 1 < args.length) {
      extensionsDir = args[i + 1];
      i += 1;
      continue;
    }
    const extEq = /^--extensions-dir=(.+)$/.exec(a);
    if (extEq) {
      extensionsDir = extEq[1];
      continue;
    }
    if (a === '--settings-path' && i + 1 < args.length) {
      settingsPath = args[i + 1];
      i += 1;
      continue;
    }
    const setEq = /^--settings-path=(.+)$/.exec(a);
    if (setEq) {
      settingsPath = setEq[1];
      continue;
    }
    rest.push(a);
  }
  return { forcedLang, noUpdateCheck, extensionsDir, settingsPath, rest };
}

// Update-check pipeline. Two cooperating concerns live here:
//
//   1. Cache in `~/.incipit/config.json` under `lastUpdateCheck` (epoch ms)
//      and `lastKnownLatest` (version string). A cold run HTTPs the npm
//      registry; warm runs within 12h reuse the cached verdict unless the
//      cached verdict would show an upgrade prompt. Prompt text should not
//      lag behind a just-published release, so outdated cached installs get
//      one fresh registry probe before we ask the user to upgrade.
//   2. Opt-out channels — config flag `updateCheck: false`, env var
//      `INCIPIT_NO_UPDATE_CHECK=1`, and CLI flag `--no-update-check`.
//      Any one of them skips the check entirely (returns `reason: disabled`).
//
// Network and JSON errors are swallowed silently; a failed check is not a
// reason to block the CLI. Callers branch only on `info.outdated === true`.
const UPDATE_CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const UPDATE_CHECK_TIMEOUT_MS = 2500;

function isUpdateCheckDisabled() {
  if (process.env.INCIPIT_NO_UPDATE_CHECK === '1') return true;
  try {
    const cfg = readConfig();
    if (cfg && cfg.updateCheck === false) return true;
  } catch (_) {}
  return false;
}

// Integer compare with prerelease suffix stripped. Suffices for 0.x.y
// numeric bumps; will need proper semver only once we start emitting
// prerelease channels that coexist with stable.
function compareVersions(a, b) {
  const parse = v => String(v || '').split('-')[0].split('.').map(n => parseInt(n, 10) || 0);
  const sa = parse(a), sb = parse(b);
  const len = Math.max(sa.length, sb.length);
  for (let i = 0; i < len; i += 1) {
    const x = sa[i] || 0, y = sb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

function fetchLatestVersion(pkgName, timeoutMs) {
  return new Promise(resolve => {
    let settled = false;
    const finish = v => { if (!settled) { settled = true; resolve(v); } };
    let req;
    try {
      req = https.get(
        `https://registry.npmjs.org/${pkgName}/latest`,
        { headers: { Accept: 'application/json' }, timeout: timeoutMs },
        res => {
          if (res.statusCode !== 200) { res.resume(); finish(null); return; }
          let body = '';
          res.on('data', c => { body += c; });
          res.on('end', () => {
            try {
              const data = JSON.parse(body);
              finish(typeof data.version === 'string' ? data.version : null);
            } catch (_) { finish(null); }
          });
          res.on('error', () => finish(null));
        },
      );
      req.on('error', () => finish(null));
      req.on('timeout', () => { try { req.destroy(); } catch (_) {} finish(null); });
    } catch (_) { finish(null); }
  });
}

async function checkForUpdate() {
  let pkg;
  try {
    pkg = require(path.join(PACKAGE_ROOT, 'package.json'));
  } catch (_) {
    return { current: null, latest: null, outdated: false, reason: 'no-version' };
  }
  const current = pkg.version;

  if (isUpdateCheckDisabled()) {
    return { current, latest: null, outdated: false, reason: 'disabled' };
  }

  const cfg = readConfig() || {};
  const now = Date.now();
  const cachedLatest = typeof cfg.lastKnownLatest === 'string' ? cfg.lastKnownLatest : null;
  const cachedAt = typeof cfg.lastUpdateCheck === 'number' ? cfg.lastUpdateCheck : 0;
  const cacheFresh = cachedLatest && (now - cachedAt) < UPDATE_CACHE_MAX_AGE_MS;

  if (cacheFresh) {
    const cachedOutdated = compareVersions(current, cachedLatest) < 0;
    if (cachedOutdated) {
      const latest = await fetchLatestVersion(pkg.name, UPDATE_CHECK_TIMEOUT_MS);
      if (latest) {
        try {
          const next = readConfig() || {};
          next.lastUpdateCheck = now;
          next.lastKnownLatest = latest;
          writeConfig(next);
        } catch (_) {}
        return {
          current,
          latest,
          outdated: compareVersions(current, latest) < 0,
          reason: 'fresh',
        };
      }
    }
    return {
      current,
      latest: cachedLatest,
      outdated: cachedOutdated,
      reason: 'cache',
    };
  }

  const latest = await fetchLatestVersion(pkg.name, UPDATE_CHECK_TIMEOUT_MS);
  if (!latest) {
    // Network error or stale cache: fall back to whatever we last knew.
    if (cachedLatest) {
      return {
        current,
        latest: cachedLatest,
        outdated: compareVersions(current, cachedLatest) < 0,
        reason: 'cache-stale',
      };
    }
    return { current, latest: null, outdated: false, reason: 'network' };
  }

  try {
    const next = readConfig() || {};
    next.lastUpdateCheck = now;
    next.lastKnownLatest = latest;
    writeConfig(next);
  } catch (_) {}

  return {
    current,
    latest,
    outdated: compareVersions(current, latest) < 0,
    reason: 'fresh',
  };
}

function printUpdateNotice(info) {
  if (!info || !info.outdated) return;
  console.log();
  console.log(color(
    t('update.available', { current: info.current, latest: info.latest }),
    Ansi.YELLOW,
  ));
  console.log(color(t('update.command'), Ansi.GREY));
}

function beginUpdateCheck(disabled) {
  return disabled ? Promise.resolve(null) : checkForUpdate();
}

async function finishWithUpdateNotice(code, updatePromise) {
  printUpdateNotice(await updatePromise);
  return code;
}

// Spawns `npm install -g incipit@latest`, pipes stdio straight to the
// terminal so the user sees npm's own progress output, and resolves with
// the exit code. `shell: true` lets Windows `npm.cmd` and Unix `npm`
// resolve through the system shell without platform-specific forks.
function runNpmUpdate() {
  return new Promise(resolve => {
    try {
      const child = spawn('npm install -g incipit@latest', {
        stdio: 'inherit',
        shell: true,
      });
      child.on('exit', code => resolve(code == null ? -1 : code));
      child.on('error', () => resolve(-1));
    } catch (_) {
      resolve(-1);
    }
  });
}

// Interactive update prompt. Called once at the start of an interactive
// session when `checkForUpdate` flagged an outdated install. Returns:
//   'exit'   — user accepted, upgrade succeeded; caller should exit 0
//   'skip'   — user declined; caller should continue into the menu
//   'failed' — user accepted but upgrade failed; caller should continue
async function handleUpdatePrompt(info) {
  clearScreen({ history: true });
  console.log();
  console.log('  ' + color(
    t('update.available', { current: info.current, latest: info.latest }),
    Ansi.YELLOW,
  ));
  console.log();

  let raw = '';
  try { raw = await prompt('  ' + t('update.prompt')); } catch (_) { return 'skip'; }
  const ans = (raw || '').trim().toLowerCase();
  if (ans !== '' && ans !== 'y' && ans !== 'yes') {
    console.log();
    console.log('  ' + color(t('update.skipped'), Ansi.GREY));
    console.log();
    return 'skip';
  }

  console.log();
  console.log('  ' + color(t('update.upgrading'), Ansi.CYAN));
  console.log();
  const code = await runNpmUpdate();
  console.log();
  if (code === 0) {
    console.log('  ' + color(t('update.upgrade_succeeded'), Ansi.GREEN));
    console.log();
    return 'exit';
  }
  console.log('  ' + color(t('update.upgrade_failed'), Ansi.RED));
  console.log();
  return 'failed';
}

async function runInteractiveScreenLoop() {
  while (true) {
    const action = await selectMainMenu();
    if (action === 'quit' || (action && action.action === 'back')) return 'quit';
    if (action === 'apply') {
      const target = await chooseApplyTargetInteractive();
      if (!target) continue;
      return { action: 'apply', target };
    }
    if (action === 'restore') return { action: 'restore' };
    if (action === 'configure') {
      await handleConfigure();
    } else if (action === 'target') {
      await handleTarget();
    } else if (action === 'language') {
      await chooseCliLanguage();
    }
  }
}

async function main(argv) {
  const {
    forcedLang, noUpdateCheck, extensionsDir, settingsPath,
    rest: args,
  } = extractFlags(argv.slice(2));
  const interactive = !(
    args.includes('--help') || args.includes('-h') ||
    args.includes('--version') || args.includes('-v') ||
    args[0] === 'apply' || args[0] === 'restore' || args[0] === 'list-targets'
  );

  await resolveLocale({ interactive, forcedLang });
  // Locale must be resolved before any update prose is printed. With a
  // saved CLI language we honor it even for non-interactive commands;
  // without one, non-interactive commands default to English.
  const updatePromise = beginUpdateCheck(noUpdateCheck);

  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return finishWithUpdateNotice(0, updatePromise);
  }
  if (args.includes('--version') || args.includes('-v')) {
    console.log(PACKAGE_VERSION || 'unknown');
    return finishWithUpdateNotice(0, updatePromise);
  }
  if (args[0] === 'apply') {
    const code = await handleApply({ silent: true, extensionsDir, settingsPath });
    return finishWithUpdateNotice(code, updatePromise);
  }
  if (args[0] === 'restore') {
    const code = await handleRestore({ silent: true, extensionsDir, settingsPath });
    return finishWithUpdateNotice(code, updatePromise);
  }
  if (args[0] === 'list-targets') {
    const code = handleListTargets();
    return finishWithUpdateNotice(code, updatePromise);
  }

  // Interactive path requires a TTY. Piping into `incipit` without
  // subcommand is a scripting mistake — tell the user which command to
  // reach for instead of silently falling back to a degraded input.
  if (!process.stdin.isTTY) {
    console.error(color(t('menu.tty_required'), Ansi.RED));
    console.error(color(t('menu.tty_hint'), Ansi.GREY));
    return finishWithUpdateNotice(1, updatePromise);
  }

  const updateInfo = await updatePromise;
  if (updateInfo && updateInfo.outdated) {
    const outcome = await handleUpdatePrompt(updateInfo);
    if (outcome === 'exit') return 0;
  }

  while (true) {
    let action;
    try {
      action = await withScreenSession(runInteractiveScreenLoop);
    } catch (exc) {
      console.log(color(t('menu.operation_failed', { msg: exc.message }), Ansi.RED));
      if (exc.stack) console.log(exc.stack);
      return 1;
    }
    if (action === 'quit' || (action && action.action === 'back')) return 0;
    if (action && action.action === 'apply') {
      try { await handleApply({ askBackupName: true, target: action.target }); }
      catch (exc) {
        console.log(color(t('menu.operation_failed', { msg: exc.message }), Ansi.RED));
        if (exc.stack) console.log(exc.stack);
      }
      await pause();
    } else if (action && action.action === 'restore') {
      try { await handleRestore(); }
      catch (exc) {
        console.log(color(t('menu.operation_failed', { msg: exc.message }), Ansi.RED));
        if (exc.stack) console.log(exc.stack);
      }
      await pause();
    }
  }
}

module.exports = { main };
