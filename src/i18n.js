// Minimal i18n for the `incipit` CLI.
//
// All user-facing prose in menu.js goes through `t(key, vars)`. The
// active locale is a module-level variable set once by `setLocale`
// (called from the menu bootstrap after reading config.js). Keys are
// flat dotted strings so they are greppable without tooling.
//
// Intentionally NOT translated:
//   - the frontispiece tagline ("a quiet typesetting patch / for
//     long-form reading") — it is the project's brand-level identity
//     and is meant to read as a literary epigraph, not UI copy
//   - the ledger labels (Target / Extension / Backup) — these are
//     typography/administration terms, not prose
//
// When `setLocale` has not been called yet, `t()` falls back to
// English — this matches the non-interactive subcommand behaviour
// (`incipit apply`, `incipit restore`, `incipit --help`) for users who have
// never run the interactive menu.

'use strict';

const DEFAULT_LOCALE = 'en';
let currentLocale = DEFAULT_LOCALE;

const STRINGS = {
  en: {
    // --- help ---
    'help.usage_heading':       'Usage',
    'help.cmd_default':         'open the interactive frontispiece menu (default)',
    'help.cmd_apply':           'apply the typesetting patch without entering the menu',
    'help.cmd_restore':         'open the backup restore menu',
    'help.cmd_help':            'show this help',
    'help.cmd_lang':            'reset the saved UI language',
    'help.reload_hint':         'After applying, run Developer: Reload Window in VS Code to reload the extension.',
    'help.upgrade_hint':        'When Claude Code upgrades, the patch is overwritten — just run incipit again.',

    // --- ledger (the three lines under the title) ---
    'ledger.extension_missing': 'Claude Code extension not detected',

    // --- menu table of contents ---
    'menu.apply':               'Apply typesetting patch',
    'menu.restore':             'Restore backup',
    'menu.quit':                'Quit',
    'menu.invalid':             'Invalid input.',
    'menu.operation_failed':    'Operation failed: {msg}',
    'menu.press_enter':         'Press Enter to continue ...',

    // --- apply flow ---
    'apply.title':              '[ Apply Claude Code typesetting patch ]',
    'apply.extension_header':   'Claude Code extension',
    'apply.version_header':     'Detected version',
    'apply.prompt_backup_name': "Name this backup (default 'latest'): ",
    'apply.backing_up':         'Backing up files that will change ...',
    'apply.backup_failed':      'Backup failed: {msg}',
    'apply.backup_path':        'Backup path: {path}',
    'apply.missing_original':   '(original file does not exist)',
    'apply.applying':           'Applying typesetting patch ...',
    'apply.apply_failed':       'Patch failed: {msg}',
    'apply.done':               'Done. Run Developer: Reload Window in VS Code to reload the extension.',
    'apply.upgrade_hint':       'Hint: when Claude Code upgrades, the patch is overwritten — run incipit again.',
    'apply.not_detected':       'Claude Code extension not detected: {msg}',

    // --- restore flow ---
    'restore.title':            '[ Restore from backup ]',
    'restore.none':              'No backups found.',
    'restore.backup_root':      'Backup root: {path}',
    'restore.available':        'Available backups:',
    'restore.cancel_option':    '[Q] Cancel',
    'restore.pick_prompt':      'Pick a backup number: ',
    'restore.cancelled':        'Cancelled.',
    'restore.invalid_choice':   'Invalid choice.',
    'restore.will_restore':     'About to restore: {label}',
    'restore.backup_dir':       'Backup directory: {dir}',
    'restore.confirm':          'Confirm restore? (y/N): ',
    'restore.done':             'Restored {restored} files, skipped {skipped}.',
    'restore.reload_hint':      'Run Developer: Reload Window in VS Code to reload.',

    // --- update check ---
    'update.available':         'Update available: {current} → {latest}',
    'update.command':           'Run: npm install -g incipit',

    // --- first-run language picker ---
    'picker.heading':           'Please choose your language  /  请选择语言',
    'picker.option_zh':         '中文',
    'picker.option_en':         'English',
    'picker.prompt':            '1 / 2 : ',
  },
  zh: {
    // --- help ---
    'help.usage_heading':       '用法',
    'help.cmd_default':         '交互式扉页菜单(默认)',
    'help.cmd_apply':           '直接应用排版补丁，不进菜单',
    'help.cmd_restore':         '打开备份还原菜单',
    'help.cmd_help':            '显示本帮助',
    'help.cmd_lang':            '重置已保存的界面语言',
    'help.reload_hint':         '应用后请在 VS Code 里执行 Developer: Reload Window 让扩展重载。',
    'help.upgrade_hint':        'Claude Code 扩展升级后补丁会被覆盖,再跑一次 incipit 即可。',

    'ledger.extension_missing': '未检测到 Claude Code 扩展',

    'menu.apply':               '应用排版补丁',
    'menu.restore':             '还原备份',
    'menu.quit':                '退出',
    'menu.invalid':             '无效输入。',
    'menu.operation_failed':    '操作失败：{msg}',
    'menu.press_enter':         '按回车继续...',

    'apply.title':              '[应用 Claude Code 排版补丁]',
    'apply.extension_header':   'Claude Code 扩展',
    'apply.version_header':     '检测版本',
    'apply.prompt_backup_name': '给这次备份起个名字（留空则为 latest）：',
    'apply.backing_up':         '正在备份将被修改的文件 ...',
    'apply.backup_failed':      '备份失败：{msg}',
    'apply.backup_path':        '备份路径：{path}',
    'apply.missing_original':   '(原文件不存在)',
    'apply.applying':           '正在应用排版补丁 ...',
    'apply.apply_failed':       '应用失败：{msg}',
    'apply.done':               '已完成。请在 VS Code 里执行 Developer: Reload Window 让扩展重新加载。',
    'apply.upgrade_hint':       '提示：Claude Code 扩展更新后补丁会被覆盖，届时再跑一次 incipit 即可。',
    'apply.not_detected':       '未检测到 Claude Code 扩展：{msg}',

    'restore.title':            '[还原备份]',
    'restore.none':             '未找到任何备份。',
    'restore.backup_root':      '备份根目录：{path}',
    'restore.available':        '可用备份：',
    'restore.cancel_option':    '[Q] 取消',
    'restore.pick_prompt':      '请选择要还原的备份编号：',
    'restore.cancelled':        '已取消。',
    'restore.invalid_choice':   '无效的选择。',
    'restore.will_restore':     '将要还原：{label}',
    'restore.backup_dir':       '备份目录：{dir}',
    'restore.confirm':          '确认还原？(y/N)：',
    'restore.done':             '已还原 {restored} 个文件,跳过 {skipped} 个。',
    'restore.reload_hint':      '请在 VS Code 里执行 Developer: Reload Window 以生效。',

    // --- update check ---
    'update.available':         '发现新版本：{current} → {latest}',
    'update.command':           '运行：npm install -g incipit',

    'picker.heading':           'Please choose your language  /  请选择语言',
    'picker.option_zh':         '中文',
    'picker.option_en':         'English',
    'picker.prompt':            '1 / 2 : ',
  },
};

function setLocale(lang) {
  if (STRINGS[lang]) currentLocale = lang;
}

function getLocale() {
  return currentLocale;
}

// `vars` is an optional `{name: value}` map for `{name}` placeholder
// substitution. Missing keys fall through to English, then to the raw
// key string — the CLI must never crash on a missing translation.
function t(key, vars) {
  const table = STRINGS[currentLocale] || STRINGS[DEFAULT_LOCALE];
  const raw =
    (table && table[key]) ||
    (STRINGS[DEFAULT_LOCALE] && STRINGS[DEFAULT_LOCALE][key]) ||
    key;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (m, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m,
  );
}

module.exports = { setLocale, getLocale, t };
