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
    'help.cmd_no_update_check': 'skip the npm-registry update check for this run',
    'help.reload_hint':         'After applying, run Developer: Reload Window in VS Code to reload the extension.',
    'help.upgrade_hint':        'When Claude Code upgrades, the patch is overwritten — just run incipit again.',

    // --- ledger (the three lines under the title) ---
    'ledger.extension_missing': 'Claude Code extension not detected',

    // --- menu table of contents ---
    'menu.apply':               'Apply typesetting patch',
    'menu.restore':             'Restore backup',
    'menu.configure':           'Configure',
    'menu.quit':                'Quit',
    'menu.invalid':             'Invalid input.',
    'menu.operation_failed':    'Operation failed: {msg}',
    'menu.press_enter':         'Press Enter to continue ...',
    'menu.tty_required':        'Interactive menu requires a terminal.',
    'menu.tty_hint':            'For non-interactive use, pass one of: incipit apply / incipit restore / incipit --help',

    // --- interactive keyboard hints (shown at the bottom of each screen) ---
    'hint.main':                '↑↓ move · Enter select · q quit',
    'hint.configure':           '↑↓ move · Space toggle · Enter open · b back',
    'hint.picker':              '↑↓ move · Enter confirm · b back',

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
    'update.available':         'A new version is available: {current} → {latest}',
    'update.command':           'Run: npm install -g incipit@latest',
    'update.prompt':            'Update now? [Y/n]: ',
    'update.skipped':           'Continuing with the current version.',
    'update.upgrading':         'Running: npm install -g incipit@latest',
    'update.upgrade_succeeded': 'Upgrade complete. Please re-run incipit.',
    'update.upgrade_failed':    'Upgrade failed. You can retry manually with: npm install -g incipit@latest',

    // --- first-run language picker ---
    'picker.heading':           'Please choose your language  /  请选择语言',
    'picker.option_zh':         '中文',
    'picker.option_en':         'English',
    'picker.prompt':            '1 / 2 : ',

    // --- configure menu ---
    'configure.heading':        '── Configure ──',
    'configure.feature_math':   'Math formula rendering',
    'configure.feature_session':'Session usage',
    'configure.feature_tool_fold':'Tool-call fold',
    'configure.param_body_size':'Body font size',
    'configure.reset':          'Reset defaults',
    'configure.back':           'Back',
    'configure.on':             'on',
    'configure.off':            'off',
    'configure.reset_confirm':  'Reset features and body font size to defaults? (y/N): ',
    'configure.reset_done':     'Configuration reset.',
    'configure.saved_hint':     'Saved. Re-run 1. Apply to activate.',
    'configure.body_size_heading':'Body font size',
    'configure.body_size_default_mark':'(default)',

    // --- apply result summary ---
    'apply.summary_heading':    'Current configuration',
    'apply.summary_on':         'on',
    'apply.summary_off':        'off',
    'apply.summary_hint':       "Use '3. Configure' to adjust; re-run '1. Apply' to activate.",
  },
  zh: {
    // --- help ---
    'help.usage_heading':       '用法',
    'help.cmd_default':         '交互式扉页菜单(默认)',
    'help.cmd_apply':           '直接应用排版补丁，不进菜单',
    'help.cmd_restore':         '打开备份还原菜单',
    'help.cmd_help':            '显示本帮助',
    'help.cmd_lang':            '重置已保存的界面语言',
    'help.cmd_no_update_check': '本次运行跳过 npm 源的新版本检查',
    'help.reload_hint':         '应用后请在 VS Code 里执行 Developer: Reload Window 让扩展重载。',
    'help.upgrade_hint':        'Claude Code 扩展升级后补丁会被覆盖,再跑一次 incipit 即可。',

    'ledger.extension_missing': '未检测到 Claude Code 扩展',

    'menu.apply':               '应用排版补丁',
    'menu.restore':             '还原备份',
    'menu.configure':           '配置',
    'menu.quit':                '退出',
    'menu.invalid':             '无效输入。',
    'menu.operation_failed':    '操作失败：{msg}',
    'menu.press_enter':         '按回车继续...',
    'menu.tty_required':        '交互菜单需在终端中运行。',
    'menu.tty_hint':            '非交互场景请使用：incipit apply / incipit restore / incipit --help',

    // --- interactive keyboard hints (shown at the bottom of each screen) ---
    'hint.main':                '↑↓ 移动 · 回车 确认 · q 退出',
    'hint.configure':           '↑↓ 移动 · 空格 切换 · 回车 进入 · b 返回',
    'hint.picker':              '↑↓ 移动 · 回车 确认 · b 返回',

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
    'update.command':           '运行：npm install -g incipit@latest',
    'update.prompt':            '现在升级？[Y/n]：',
    'update.skipped':           '继续使用当前版本。',
    'update.upgrading':         '正在执行：npm install -g incipit@latest',
    'update.upgrade_succeeded': '升级完成。请重新运行 incipit。',
    'update.upgrade_failed':    '升级失败。可手动执行：npm install -g incipit@latest',

    'picker.heading':           'Please choose your language  /  请选择语言',
    'picker.option_zh':         '中文',
    'picker.option_en':         'English',
    'picker.prompt':            '1 / 2 : ',

    // --- configure menu ---
    'configure.heading':        '── 配置 ──',
    'configure.feature_math':   '数学公式渲染',
    'configure.feature_session':'会话用量',
    'configure.feature_tool_fold':'工具调用折叠',
    'configure.param_body_size':'正文字号',
    'configure.reset':          '重置默认',
    'configure.back':           '返回',
    'configure.on':             '启用',
    'configure.off':            '关闭',
    'configure.reset_confirm':  '将功能开关和正文字号重置为默认？(y/N)：',
    'configure.reset_done':     '已重置。',
    'configure.saved_hint':     '已保存。重跑 1. 应用排版补丁 使更改生效。',
    'configure.body_size_heading':'正文字号',
    'configure.body_size_default_mark':'(默认)',

    // --- apply result summary ---
    'apply.summary_heading':    '当前配置',
    'apply.summary_on':         '启用',
    'apply.summary_off':        '关闭',
    'apply.summary_hint':       '提示：`3. 配置` 可调整，改动后重跑 `1. 应用排版补丁` 生效。',
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
