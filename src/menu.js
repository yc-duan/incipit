'use strict';

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
} = require('./config');
const { t, setLocale } = require('./i18n');
const {
  Ansi,
  clearScreen,
  color,
  promptPrefix,
  renderLanguagePicker,
  renderMainMenu,
} = require('./frontispiece');

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

const PACKAGE_ROOT = path.resolve(__dirname, '..');

async function handleApply({ silent = false, askBackupName = false } = {}) {
  if (!silent) clearScreen();
  console.log(color(t('apply.title'), Ansi.CYAN));
  console.log();

  let target;
  try {
    target = findLatestClaudeCodeExtension();
  } catch (exc) {
    console.log(color(t('apply.not_detected', { msg: exc.message }), Ansi.RED));
    return 1;
  }
  console.log(`${t('apply.extension_header').padEnd(18)}: ${target.extensionDir}`);
  console.log(`${t('apply.version_header').padEnd(18)}: ${target.version}`);
  console.log();

  let backupName = DEFAULT_BACKUP_NAME;
  if (askBackupName) {
    try {
      const raw = (await prompt(t('apply.prompt_backup_name'))).trim();
      if (raw) backupName = raw;
    } catch (_) {}
    console.log();
  }

  console.log(color(t('apply.backing_up'), Ansi.YELLOW));
  let manifest;
  try {
    manifest = createBackup(target, { name: backupName });
  } catch (exc) {
    console.log(color(t('apply.backup_failed', { msg: exc.message }), Ansi.RED));
    if (exc.stack) console.log(exc.stack);
    return 1;
  }
  console.log(color(
    t('apply.backup_path', { path: currentBackupDir(target, manifest.name) }),
    Ansi.GREEN,
  ));
  for (const e of manifest.entries) {
    const mark = entryStatusMark(e);
    console.log(`  ${e.logicalName.padEnd(24)}${mark}`);
  }
  console.log();

  console.log(color(t('apply.applying'), Ansi.YELLOW));
  let result;
  try {
    result = installClaudeCodeVSCodeEnhance(PACKAGE_ROOT);
  } catch (exc) {
    console.log(color(t('apply.apply_failed', { msg: exc.message }), Ansi.RED));
    if (exc.stack) console.log(exc.stack);
    return 1;
  }
  console.log();
  for (const line of result.statusLines) console.log(line);
  console.log();
  console.log(color(t('apply.done'),          Ansi.GREEN));
  console.log(color(t('apply.upgrade_hint'),  Ansi.YELLOW));
  return 0;
}

function entryStatusMark(e) {
  if (e.type === 'sparse_json') {
    const n = e.keys ? e.keys.length : 0;
    return `(${n} keys)`;
  }
  return e.existedBefore ? '✓' : t('apply.missing_original');
}

async function handleRestore({ silent = false } = {}) {
  if (!silent) clearScreen();
  console.log(color(t('restore.title'), Ansi.CYAN));
  console.log();

  const backups = listAvailableBackups();
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
    [restored, skipped] = restoreBackup(manifest);
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

function renderMenu() {
  let target = null;
  try {
    target = findLatestClaudeCodeExtension();
  } catch (_) {}

  renderMainMenu({
    target,
    missingText: t('ledger.extension_missing'),
    backupRoot: BACKUP_ROOT,
    menuItems: [
      { mark: '1.', label: t('menu.apply') },
      { mark: '2.', label: t('menu.restore') },
      { mark: 'q.', label: t('menu.quit') },
    ],
  });
}

function printHelp() {
  console.log(`
  ${Ansi.TERRA}${Ansi.BOLD}incipit${Ansi.RESET}  ${Ansi.GREY}${Ansi.ITALIC}a quiet typesetting patch for long-form reading${Ansi.RESET}

  ${Ansi.GREY}${t('help.usage_heading')}${Ansi.RESET}
    ${Ansi.IVORY}incipit${Ansi.RESET}              ${t('help.cmd_default')}
    ${Ansi.IVORY}incipit apply${Ansi.RESET}        ${t('help.cmd_apply')}
    ${Ansi.IVORY}incipit restore${Ansi.RESET}      ${t('help.cmd_restore')}
    ${Ansi.IVORY}incipit --help${Ansi.RESET}            ${t('help.cmd_help')}
    ${Ansi.IVORY}incipit --lang zh|en${Ansi.RESET}      ${t('help.cmd_lang')}
    ${Ansi.IVORY}incipit --no-update-check${Ansi.RESET} ${t('help.cmd_no_update_check')}

  ${t('help.reload_hint')}
  ${t('help.upgrade_hint')}
`);
}

async function showLanguagePicker() {
  while (true) {
    renderLanguagePicker({
      heading: 'Please choose your language  /  请选择语言',
      optionsList: [
        { mark: '1.', label: '中文' },
        { mark: '2.', label: 'English' },
      ],
    });
    let raw;
    try { raw = (await prompt(promptPrefix())); } catch (_) { return 'en'; }
    const choice = raw.trim().toLowerCase();
    if (choice === '1' || choice === 'i' || choice === 'zh' || choice === '中文') {
      return 'zh';
    }
    if (choice === '2' || choice === 'ii' || choice === 'en' || choice === 'english') {
      return 'en';
    }
  }
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
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--lang' && i + 1 < args.length) {
      forcedLang = args[i + 1];
      i += 1;
      continue;
    }
    const m = /^--lang=(.+)$/.exec(a);
    if (m) {
      forcedLang = m[1];
      continue;
    }
    if (a === '--no-update-check') {
      noUpdateCheck = true;
      continue;
    }
    rest.push(a);
  }
  return { forcedLang, noUpdateCheck, rest };
}

// Update-check pipeline. Two cooperating concerns live here:
//
//   1. Cache in `~/.incipit/config.json` under `lastUpdateCheck` (epoch ms)
//      and `lastKnownLatest` (version string). A cold run HTTPs the npm
//      registry; warm runs within 12h reuse the cached verdict.
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
    return {
      current,
      latest: cachedLatest,
      outdated: compareVersions(current, cachedLatest) < 0,
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
  clearScreen();
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

async function main(argv) {
  const { forcedLang, noUpdateCheck, rest: args } = extractFlags(argv.slice(2));
  const interactive = !(
    args.includes('--help') || args.includes('-h') ||
    args[0] === 'apply' || args[0] === 'restore'
  );

  // Fire-and-forget the update check so it overlaps with locale resolution
  // and command execution. In non-interactive paths we print a notice at
  // the end; in interactive we await before rendering the menu so the
  // prompt comes first, while the user is still at the entry screen.
  const updatePromise = noUpdateCheck ? Promise.resolve(null) : checkForUpdate();

  await resolveLocale({ interactive, forcedLang });

  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    printUpdateNotice(await updatePromise);
    return 0;
  }
  if (args[0] === 'apply') {
    const code = await handleApply({ silent: true });
    printUpdateNotice(await updatePromise);
    return code;
  }
  if (args[0] === 'restore') {
    const code = await handleRestore({ silent: true });
    printUpdateNotice(await updatePromise);
    return code;
  }

  const updateInfo = await updatePromise;
  if (updateInfo && updateInfo.outdated) {
    const outcome = await handleUpdatePrompt(updateInfo);
    if (outcome === 'exit') return 0;
  }

  while (true) {
    renderMenu();
    let choice;
    try {
      choice = (await prompt(promptPrefix())).trim().toLowerCase();
    } catch (_) {
      console.log();
      return 0;
    }
    if (choice === 'q' || choice === 'quit' || choice === 'exit') return 0;
    if (choice === '1' || choice === 'i') {
      try { await handleApply({ askBackupName: true }); }
      catch (exc) {
        console.log(color(t('menu.operation_failed', { msg: exc.message }), Ansi.RED));
        if (exc.stack) console.log(exc.stack);
      }
      await pause();
    } else if (choice === '2' || choice === 'ii') {
      try { await handleRestore(); }
      catch (exc) {
        console.log(color(t('menu.operation_failed', { msg: exc.message }), Ansi.RED));
        if (exc.stack) console.log(exc.stack);
      }
      await pause();
    } else {
      console.log(color(t('menu.invalid'), Ansi.RED));
      await pause();
    }
  }
}

module.exports = { main };
