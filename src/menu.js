'use strict';

const path = require('path');
const https = require('https');
const readline = require('readline');

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
const { getLanguage, setLanguage, SUPPORTED_LANGUAGES } = require('./config');
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
    ${Ansi.IVORY}incipit --help${Ansi.RESET}       ${t('help.cmd_help')}
    ${Ansi.IVORY}incipit --lang zh|en${Ansi.RESET} ${t('help.cmd_lang')}

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

function extractLangFlag(args) {
  let forcedLang = null;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--lang' && i + 1 < args.length) {
      forcedLang = args[i + 1];
      i++;
      continue;
    }
    const m = /^--lang=(.+)$/.exec(a);
    if (m) {
      forcedLang = m[1];
      continue;
    }
    rest.push(a);
  }
  return { forcedLang, rest };
}

function checkForUpdate() {
  const pkg = require(path.join(PACKAGE_ROOT, 'package.json'));
  const current = pkg.version;
  return new Promise(resolve => {
    const req = https.get(
      `https://registry.npmjs.org/${pkg.name}/latest`,
      { headers: { Accept: 'application/json' }, timeout: 4000 },
      res => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try {
            const latest = JSON.parse(body).version;
            if (latest && latest !== current) {
              resolve({ current, latest });
            } else {
              resolve(null);
            }
          } catch (_) { resolve(null); }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function printUpdateNotice(info) {
  if (!info) return;
  console.log();
  console.log(color(
    t('update.available', { current: info.current, latest: info.latest }),
    Ansi.YELLOW,
  ));
  console.log(color(t('update.command'), Ansi.GREY));
}

async function main(argv) {
  const { forcedLang, rest: args } = extractLangFlag(argv.slice(2));
  const interactive = !(
    args.includes('--help') || args.includes('-h') ||
    args[0] === 'apply' || args[0] === 'restore'
  );

  const updateCheck = checkForUpdate();

  await resolveLocale({ interactive, forcedLang });

  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    printUpdateNotice(await updateCheck);
    return 0;
  }
  if (args[0] === 'apply') {
    const code = await handleApply({ silent: true });
    printUpdateNotice(await updateCheck);
    return code;
  }
  if (args[0] === 'restore') {
    const code = await handleRestore({ silent: true });
    printUpdateNotice(await updateCheck);
    return code;
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
