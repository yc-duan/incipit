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
    'help.cmd_list_targets':    'list every known Claude Code target and exit',
    'help.cmd_version':         'print the CLI version',
    'help.cmd_help':            'show this help',
    'help.cmd_lang':            'set the saved CLI language',
    'help.cmd_no_update_check': 'skip the npm-registry update check for this run',
    'help.cmd_extensions_dir':  'use this extensions directory for apply/restore instead of the saved default',
    'help.cmd_settings_path':   'use this settings.json path instead of auto-deriving (paired with --extensions-dir)',
    'help.reload_hint':         'After applying, run Developer: Reload Window in VS Code to reload the extension.',
    'help.upgrade_hint':        'When Claude Code upgrades, the patch is overwritten — just run incipit again.',

    // --- ledger (the three lines under the title) ---
    'ledger.extension_missing': 'Claude Code extension not detected',

    // --- menu table of contents ---
    'menu.apply':               'Apply typesetting patch',
    'menu.restore':             'Restore backup',
    'menu.configure':           'Configure',
    'menu.target':              'Manage Claude Code targets',
    'menu.cli_language':        'CLI language',
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
    'apply.reload_action':      'Developer: Reload Window',
    'apply.restart_action':     'restart {app}',
    'apply.done':               'Done. In {app}, run {reload}, or {restart}.',
    'apply.upgrade_hint':       'Hint: when Claude Code upgrades, the patch is overwritten — run incipit again.',
    'apply.not_detected':       'Claude Code extension not detected: {msg}',
    'apply.report.backup_heading': 'Backup',
    'apply.report.patch_heading':  'Patch',
    'apply.report.config_label':   'Current configuration:',
    'apply.report.file_count':     '{count} files',
    'apply.report.setting_key_count': '{count} settings',
    'apply.report.summary_all_current': 'All patch files are already current.',
    'apply.report.summary_changed': 'Updated {updated} patch entries; {current} already current.',
    'apply.report.summary_changed_no_current': 'Updated {updated} patch entries.',
    'apply.report.backup_extension_desc': 'save the extension entrypoint',
    'apply.report.backup_webview_desc': 'save a full webview snapshot, {files}',
    'apply.report.backup_settings_desc': 'save previous {keys}',
    'apply.report.backup_generic_desc': 'save original bytes for restore',
    'apply.report.desc.extension_js': 'allow local webview assets, preload incipit styles, connect the badge bridge',
    'apply.report.desc.webview_dir': 'webview runtime and reading resources',
    'apply.report.desc.webview_index_js': 'write CLI config, math preprocessing, diff editor patches, and the runtime loader',
    'apply.report.desc.enhance_js': 'start the incipit runtime',
    'apply.report.desc.enhance_shared_js': 'share config, styles, and DOM guards',
    'apply.report.desc.enhance_footer_badge_js': 'footer badge and status display',
    'apply.report.desc.enhance_thinking_js': 'thinking block typesetting',
    'apply.report.desc.enhance_typography_js': 'math, code highlighting, and CJK punctuation typography',
    'apply.report.desc.enhance_legacy_js': 'tool fold, diff island, and local-history actions',
    'apply.report.desc.host_probe_js': 'tag host DOM for incipit styles and interactions',
    'apply.report.desc.host_badge_cjs': 'local-history bridge between the host and webview',
    'apply.report.desc.math_tokens_js': 'math source tokenizer',
    'apply.report.desc.math_rewriter_js': 'formula rendering handoff',
    'apply.report.desc.theme_css': 'warm-black reading theme',
    'apply.report.desc.warm_white_css': 'warm-white theme override',
    'apply.report.desc.webview_file_generic': 'incipit webview runtime file',
    'apply.report.desc.asset_katex': 'formula rendering assets, {files}',
    'apply.report.desc.asset_hljs': 'code highlighting assets, {files}',
    'apply.report.desc.asset_fonts': 'webview font assets, {files}',
    'apply.report.desc.asset_effort_brain': 'effort brain icons, {files}',
    'apply.report.desc.asset_generic': 'webview asset tree, {files}',
    'apply.report.desc.settings_json': 'set the Claude Code input font family and size',
    'apply.report.desc.system_fonts': 'install IBM Plex Serif, {files}',

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
    'language.heading':         'CLI language',

    // --- target screen ---
    'target.heading':           '── Manage Claude Code targets ──',
    'target.scanning':          'Scanning for Claude Code installations...',
    'target.no_targets':        'No Claude Code installation detected.',
    'target.no_targets_hint':   "Use '+ Add target' below to point at one manually.",
    'target.list_heading':      'Known targets',
    'target.add_label':         '+ Add target (folder dialog)',
    'target.remove_label':      '× Remove target',
    'target.back':              'Back',
    'target.column_auto':       'auto',
    'target.column_manual':     'manual',
    'target.column_invalid':    'invalid',
    'target.confirm_remove':    'Remove this manual target? (y/N): ',
    'target.removed':           'Target removed.',
    'target.added':             'Target added: {label}',
    'target.cannot_remove_auto':'Auto-detected entries cannot be removed; remove the underlying installation instead.',
    'target.no_manual_to_delete':'No manual targets to delete (auto-detected entries cannot be removed).',
    'target.delete_mode_heading':'Pick a target to remove',
    'target.hint':              'a add · d remove · b back',
    'target.hint_delete':       '↑↓ pick · Enter remove · Esc cancel',

    // --- add target wizard ---
    'target.add.heading':       '── Add Claude Code installation ──',
    'target.add.intro':         'A system folder dialog will open next. Pick any of the following:',
    'target.add.intro_dialog_word': 'folder',
    'target.add.option_a':      'A VS Code-family extensions directory',
    'target.add.option_a_egs':  'e.g.  ~/.vscode/extensions',
    'target.add.option_a_egs2': '      ~/.cursor/extensions',
    'target.add.option_b':      'A portable / Scoop data directory',
    'target.add.option_b_egs':  'e.g.  ~/scoop/apps/vscode/current/data',
    'target.add.option_b_egs2': '      ~/scoop/persist/vscode/data or <unzipped>/data',
    'target.add.option_c':      'A specific anthropic.claude-code-X.Y.Z directory',
    'target.add.option_c_eg':   '(use this to pin a single version)',
    'target.add.proceed':       'Open folder dialog',
    'target.add.cancel':        'Cancel',
    'target.add.dialog_title':  'Select VS Code data or extensions folder',
    'target.add.dialog_unavailable_title': 'Folder dialog not available',
    'target.add.dialog_unavailable_no_display':
                                'No graphical display detected ($DISPLAY / $WAYLAND_DISPLAY are unset). incipit cannot open a folder dialog on a headless host.',
    'target.add.dialog_unavailable_no_zk':
                                'Neither zenity nor kdialog is installed. Install one of them, or run incipit from a machine with a graphical desktop.',
    'target.add.dialog_unavailable_other':
                                'No GUI folder picker is reachable on this platform.',
    'target.add.dialog_failed': 'Folder dialog failed: {msg}',
    'target.add.cancelled':     'Cancelled.',

    // --- identify outcomes ---
    'target.identify.kind_extension_version':  'Single extension version',
    'target.identify.kind_extensions_dir':     'Extensions directory',
    'target.identify.kind_portable_data':      'Portable data directory',
    'target.identify.kind_portable_data_empty':'Portable data directory (no Claude Code yet)',
    'target.identify.recognized':              'Recognized',
    'target.identify.label_kind':              'Kind',
    'target.identify.label_extensions':        'Extensions dir',
    'target.identify.label_settings':          'settings.json',
    'target.identify.label_version':           'Latest version found',
    'target.identify.prompt_label':            'Give this target a name (optional):',
    'target.identify.save':                    'Save',
    'target.identify.repick':                  'Pick another folder',
    'target.identify.cancel':                  'Cancel',
    'target.identify.no_settings_inferred':    '(could not auto-derive; will prompt for it on first apply)',
    'target.identify.empty_data_warn':         'No anthropic.claude-code-* extension was found here yet. The target will be saved, but apply will refuse until Claude Code is installed under it.',

    // --- identify failures ---
    'target.identify.fail_heading':            'Could not recognize this folder',
    'target.identify.fail_picked':             'You picked',
    'target.identify.fail_unknown':
        'This folder does not look like a VS Code-family installation. It must satisfy one of:\n' +
        '  · contain an anthropic.claude-code-* subfolder\n' +
        '  · contain both extensions/ and user-data/\n' +
        '  · be a portable install root containing a data/ folder',
    'target.identify.fail_standard_install':
        'You picked a VS Code-family program installation directory, but on this machine\n' +
        'that host appears to run in standard (non-portable) mode: extensions and settings\n' +
        'live in the system default user location, NOT inside the program directory. The\n' +
        'standard install should appear in the auto-detected list if Claude Code is installed.\n' +
        '\n' +
        'If you meant to add a portable or Scoop copy, confirm its install folder\n' +
        'contains a data/ subfolder (with data/extensions and data/user-data inside),\n' +
        'then pick that data/ folder instead of the program root.',
    'target.identify.fail_repick':             'Pick another folder',
    'target.identify.fail_back':               'Back',

    // --- apply pre-picker ---
    'target.apply_picker.heading':             '── Confirm target for apply ──',
    'target.apply_picker.use_label':           'Use this target',
    'target.apply_picker.change_label':        'Use a different target',
    'target.apply_picker.cancel_label':        'Cancel',
    'target.apply_picker.no_active':
        'No active target is set. Run \'4. Target\' from the main menu first.',

    // --- non-interactive apply / restore / list-targets ---
    'cli.no_targets_for_apply':
        'No Claude Code installation detected for apply. Run "incipit" interactively to add a target, or pass --extensions-dir explicitly.',
    'cli.no_targets_for_restore':
        'No Claude Code installation detected for restore. Run "incipit" interactively to add a target, or pass --extensions-dir explicitly.',
    'cli.ambiguous_targets_heading':
        'Multiple Claude Code installations detected. Pick one explicitly:',
    'cli.ambiguous_targets_template_heading':
        'Run one of:',
    'cli.ambiguous_targets_or_list':
        'Or:  incipit list-targets    # see full candidates',
    'cli.bad_extensions_dir_missing':
        'extensions directory does not exist: {path}',
    'cli.bad_extensions_dir_not_dir':
        'extensions directory is not a folder: {path}',
    'cli.bad_extensions_dir_no_cc':
        'no anthropic.claude-code-* found under: {path}',
    'cli.bad_settings_parent_missing':
        'parent directory of settings-path does not exist: {path}\n  (this usually means the host VS Code has never been launched on this machine)',
    'cli.list_targets_empty':
        'No Claude Code installations detected.\nRun "incipit" interactively and use "+ Add target" to register one.',
    'cli.list_targets_lastused_marker':
        'last-used',
    'cli.list_targets_kind_auto':
        'auto',
    'cli.list_targets_kind_manual':
        'manual',
    'cli.list_targets_label_extensions':
        'extensions',
    'cli.list_targets_label_settings':
        'settings',
    'cli.list_targets_label_version':
        'version',
    'cli.list_targets_invalid_marker':
        'invalid (extensions directory missing or has no Claude Code)',

    // --- configure menu ---
    'configure.heading':        '── Configure ──',
    'configure.feature_math':   'Math formula rendering',
    'configure.feature_session':'Session usage',
    'configure.param_body_size':'Body font size',
    'configure.reset':          'Reset defaults',
    'configure.back':           'Back',
    'configure.on':             'on',
    'configure.off':            'off',
    'configure.reset_confirm':  'Reset features and appearance to defaults? (y/N): ',
    'configure.reset_done':     'Configuration reset.',
    'configure.saved_hint':     'Saved. Re-run 1. Apply to activate.',
    'configure.body_size_heading':'Body font size',
    'configure.body_size_default_mark':'(default)',
    'configure.param_palette':  'Palette',
    'configure.palette_heading':'Palette',
    'configure.palette_warm_black':'Warm black',
    'configure.palette_warm_white':'Warm white',
    'configure.palette_warm_white_bold':'Warm white (bold body)',
    'configure.param_body_font':  'Body font',
    'configure.param_code_font':  'Code font',
    'configure.body_font_heading':'Body font',
    'configure.code_font_heading':'Code font',
    'configure.font_custom_prompt':'Enter CSS font-family (e.g. \'LXGW WenKai\', serif): ',
    'configure.font_custom_label':'Custom',
    'configure.font_plex_serif':  'IBM Plex Serif',
    'configure.font_georgia':     'Georgia',
    'configure.font_system_serif':'System serif',
    'configure.font_rec_mono':    'Rec Mono Linear',
    'configure.font_jetbrains_mono':'JetBrains Mono',
    'configure.font_system_mono': 'System mono',
    'configure.font_custom':      'Custom',
    'apply.font_custom_value':    'Custom',

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
    'help.cmd_list_targets':    '列出所有已知 Claude Code 目标后退出',
    'help.cmd_version':         '显示 CLI 版本',
    'help.cmd_help':            '显示本帮助',
    'help.cmd_lang':            '设置已保存的 CLI 界面语言',
    'help.cmd_no_update_check': '本次运行跳过 npm 源的新版本检查',
    'help.cmd_extensions_dir':  '指定 apply/restore 使用的扩展目录，覆盖默认目标',
    'help.cmd_settings_path':   '搭配 --extensions-dir 使用，显式指定 settings.json 路径',
    'help.reload_hint':         '应用后请在 VS Code 里执行 Developer: Reload Window 让扩展重载。',
    'help.upgrade_hint':        'Claude Code 扩展升级后补丁会被覆盖,再跑一次 incipit 即可。',

    'ledger.extension_missing': '未检测到 Claude Code 扩展',

    'menu.apply':               '应用排版补丁',
    'menu.restore':             '还原备份',
    'menu.configure':           '配置',
    'menu.target':              '管理 Claude Code 目标位置',
    'menu.cli_language':        'CLI 界面语言',
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
    'apply.reload_action':      'Developer: Reload Window',
    'apply.restart_action':     '重启 {app}',
    'apply.done':               '已完成。请在 {app} 里执行 {reload}，或{restart}。',
    'apply.upgrade_hint':       '提示：Claude Code 扩展更新后补丁会被覆盖，届时再跑一次 incipit 即可。',
    'apply.not_detected':       '未检测到 Claude Code 扩展：{msg}',
    'apply.report.backup_heading': 'Backup',
    'apply.report.patch_heading':  'Patch',
    'apply.report.config_label':   '当前配置：',
    'apply.report.file_count':     '{count} 个文件',
    'apply.report.setting_key_count': '{count} 项设置',
    'apply.report.summary_all_current': '所有补丁文件已是最新。',
    'apply.report.summary_changed': '更新 {updated} 项，其余 {current} 项已是最新。',
    'apply.report.summary_changed_no_current': '更新 {updated} 项。',
    'apply.report.backup_extension_desc': '保存扩展入口原件',
    'apply.report.backup_webview_desc': '保存 webview 完整快照，{files}',
    'apply.report.backup_settings_desc': '保存原有 {keys}',
    'apply.report.backup_generic_desc': '保存原始内容以便还原',
    'apply.report.desc.extension_js': '允许本地 webview 资源、提前加载 incipit 样式、接入 badge bridge',
    'apply.report.desc.webview_dir': 'webview runtime 与阅读资源',
    'apply.report.desc.webview_index_js': '写入 CLI 配置、数学预处理、diff 编辑器补丁、runtime loader',
    'apply.report.desc.enhance_js': '启动 incipit runtime',
    'apply.report.desc.enhance_shared_js': '共享配置、样式与 DOM guard',
    'apply.report.desc.enhance_footer_badge_js': 'footer badge 与状态显示',
    'apply.report.desc.enhance_thinking_js': 'thinking block 排版',
    'apply.report.desc.enhance_typography_js': '数学、代码高亮、CJK 标点排版',
    'apply.report.desc.enhance_legacy_js': 'tool fold、diff island、本地历史动作',
    'apply.report.desc.host_probe_js': '标记宿主 DOM，供样式和交互定位',
    'apply.report.desc.host_badge_cjs': '本地历史与 webview 通信',
    'apply.report.desc.math_tokens_js': '数学源码切分',
    'apply.report.desc.math_rewriter_js': '公式渲染交接',
    'apply.report.desc.theme_css': '暖黑阅读主题',
    'apply.report.desc.warm_white_css': '暖白主题覆盖',
    'apply.report.desc.webview_file_generic': 'incipit webview runtime 文件',
    'apply.report.desc.asset_katex': '公式渲染资源，{files}',
    'apply.report.desc.asset_hljs': '代码高亮资源，{files}',
    'apply.report.desc.asset_fonts': 'webview 字体资源，{files}',
    'apply.report.desc.asset_effort_brain': 'effort 大脑图标，{files}',
    'apply.report.desc.asset_generic': 'webview 资源目录，{files}',
    'apply.report.desc.settings_json': '设置 Claude Code 输入框字体与字号',
    'apply.report.desc.system_fonts': '安装 IBM Plex Serif，{files}',

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
    'language.heading':         'CLI 界面语言',

    // --- target screen ---
    'target.heading':           '── 管理 Claude Code 目标位置 ──',
    'target.scanning':          '正在扫描 Claude Code 安装位置 ...',
    'target.no_targets':        '未检测到任何 Claude Code 安装。',
    'target.no_targets_hint':   '可使用下方"+ 添加新目标"手动指定。',
    'target.list_heading':      '已知目标',
    'target.add_label':         '+ 添加新目标 (文件夹对话框)',
    'target.remove_label':      '× 删除目标',
    'target.back':              '返回',
    'target.column_auto':       '自动',
    'target.column_manual':     '手动',
    'target.column_invalid':    '已失效',
    'target.confirm_remove':    '删除这个手动添加的目标？(y/N)：',
    'target.removed':           '已删除。',
    'target.added':             '已添加目标：{label}',
    'target.cannot_remove_auto':'自动探测到的项不能删除——请直接卸载对应的安装。',
    'target.no_manual_to_delete':'当前没有可删除的手动目标(自动探测项不能从这里删除)。',
    'target.delete_mode_heading':'请选择要删除的目标',
    'target.hint':              'a 添加 · d 删除 · b 返回',
    'target.hint_delete':       '↑↓ 选择 · 回车 删除 · Esc 取消',

    // --- add target wizard ---
    'target.add.heading':       '── 添加 Claude Code 安装目标 ──',
    'target.add.intro':         '接下来会弹出系统{folder}选择对话框。请挑以下任意一种：',
    'target.add.intro_dialog_word': '文件夹',
    'target.add.option_a':      'VS Code 系宿主的 extensions 扩展目录',
    'target.add.option_a_egs':  '典型位置：~/.vscode/extensions',
    'target.add.option_a_egs2': '          ~/.cursor/extensions',
    'target.add.option_b':      'portable / Scoop 安装的 data 目录',
    'target.add.option_b_egs':  '典型位置：~/scoop/apps/vscode/current/data',
    'target.add.option_b_egs2': '          ~/scoop/persist/vscode/data 或 <解压目录>/data',
    'target.add.option_c':      '单个 anthropic.claude-code-X.Y.Z 子目录',
    'target.add.option_c_eg':   '(钉死某一个版本时用)',
    'target.add.proceed':       '打开文件夹对话框',
    'target.add.cancel':        '取消',
    'target.add.dialog_title':  '选择 VS Code 安装目录或扩展目录',
    'target.add.dialog_unavailable_title': '系统对话框不可用',
    'target.add.dialog_unavailable_no_display':
                                '当前环境检测不到图形界面 (DISPLAY / WAYLAND_DISPLAY 都未设置)。incipit 无法在 headless 主机上弹出文件夹对话框。',
    'target.add.dialog_unavailable_no_zk':
                                '系统中既没有 zenity 也没有 kdialog。请安装其中之一,或在带有图形界面的机器上运行 incipit。',
    'target.add.dialog_unavailable_other':
                                '当前平台无可用的图形文件夹选择器。',
    'target.add.dialog_failed': '文件夹对话框失败：{msg}',
    'target.add.cancelled':     '已取消。',

    // --- identify outcomes ---
    'target.identify.kind_extension_version':  '单个扩展版本目录',
    'target.identify.kind_extensions_dir':     '扩展根目录',
    'target.identify.kind_portable_data':      'portable data 目录',
    'target.identify.kind_portable_data_empty':'portable data 目录 (尚未装 Claude Code)',
    'target.identify.recognized':              '已识别',
    'target.identify.label_kind':              '类型',
    'target.identify.label_extensions':        '扩展目录',
    'target.identify.label_settings':          'settings.json',
    'target.identify.label_version':           '最高版本',
    'target.identify.prompt_label':            '给这个目标起一个名称(可选)：',
    'target.identify.save':                    '保存',
    'target.identify.repick':                  '重新选择',
    'target.identify.cancel':                  '取消',
    'target.identify.no_settings_inferred':    '(无法自动推断,首次 apply 时会再问一次)',
    'target.identify.empty_data_warn':         '此目录下尚未发现 anthropic.claude-code-* 扩展。目标会被保存,但在该目录下装上 Claude Code 之前 apply 会拒绝执行。',

    // --- identify failures ---
    'target.identify.fail_heading':            '无法识别这个文件夹',
    'target.identify.fail_picked':             '你选的是',
    'target.identify.fail_unknown':
        '这个文件夹不像 VS Code 系的安装位置。它需要满足以下任一条件：\n' +
        '  · 内含 anthropic.claude-code-* 子目录\n' +
        '  · 同时有 extensions/ 和 user-data/ 两个子目录\n' +
        '  · 是 portable 解压版的安装根 (含 data/ 子目录)',
    'target.identify.fail_standard_install':
        '你选的是 VS Code 系宿主的程序安装目录,但这台机器上它看起来走的是标准模式——\n' +
        '扩展和设置实际**不在**程序目录下,而是在系统标准的用户目录里。如果已经安装 Claude Code,\n' +
        '它应该会出现在自动探测列表里 (回到上一屏即可看到)。\n' +
        '\n' +
        '如果你想加的是 portable 或 Scoop 版,请确认它的安装目录里有 data/ 子文件夹\n' +
        '(里面同时有 data/extensions 和 data/user-data),然后选 data/ 那个文件夹,\n' +
        '不是程序根目录。',
    'target.identify.fail_repick':             '重新选择',
    'target.identify.fail_back':               '返回',

    // --- apply pre-picker ---
    'target.apply_picker.heading':             '── 确认 apply 目标 ──',
    'target.apply_picker.use_label':           '使用此目标',
    'target.apply_picker.change_label':        '换一个目标',
    'target.apply_picker.cancel_label':        '取消',
    'target.apply_picker.no_active':
        '当前没有设定 active 目标。请先在主菜单里通过 "4. 目标 Claude Code 安装" 选一个。',

    // --- non-interactive apply / restore / list-targets ---
    'cli.no_targets_for_apply':
        '未检测到任何 Claude Code 安装。请先跑交互式 incipit 添加一个目标，或显式传 --extensions-dir。',
    'cli.no_targets_for_restore':
        '未检测到任何 Claude Code 安装，无法还原。请先跑交互式 incipit 添加一个目标，或显式传 --extensions-dir。',
    'cli.ambiguous_targets_heading':
        '检测到多个 Claude Code 安装，请明确指定:',
    'cli.ambiguous_targets_template_heading':
        '任选其一:',
    'cli.ambiguous_targets_or_list':
        '或:  incipit list-targets    # 查看完整候选',
    'cli.bad_extensions_dir_missing':
        '扩展目录不存在: {path}',
    'cli.bad_extensions_dir_not_dir':
        '扩展目录不是文件夹: {path}',
    'cli.bad_extensions_dir_no_cc':
        '该目录下没有 anthropic.claude-code-*: {path}',
    'cli.bad_settings_parent_missing':
        'settings-path 的父目录不存在: {path}\n  (通常意味着这台机器还没启动过对应的 VS Code)',
    'cli.list_targets_empty':
        '未检测到任何 Claude Code 安装。\n请跑交互式 incipit，用"+ 添加新目标"注册一个。',
    'cli.list_targets_lastused_marker':
        '上次用过',
    'cli.list_targets_kind_auto':
        '自动',
    'cli.list_targets_kind_manual':
        '手动',
    'cli.list_targets_label_extensions':
        'extensions',
    'cli.list_targets_label_settings':
        'settings',
    'cli.list_targets_label_version':
        'version',
    'cli.list_targets_invalid_marker':
        '已失效 (扩展目录缺失或无 Claude Code)',

    // --- configure menu ---
    'configure.heading':        '── 配置 ──',
    'configure.feature_math':   '数学公式渲染',
    'configure.feature_session':'会话用量',
    'configure.param_body_size':'正文字号',
    'configure.reset':          '重置默认',
    'configure.back':           '返回',
    'configure.on':             '启用',
    'configure.off':            '关闭',
    'configure.reset_confirm':  '将功能开关和外观设置重置为默认？(y/N)：',
    'configure.reset_done':     '已重置。',
    'configure.saved_hint':     '已保存。重跑 1. 应用排版补丁 使更改生效。',
    'configure.body_size_heading':'正文字号',
    'configure.body_size_default_mark':'(默认)',
    'configure.param_palette':  '主题色',
    'configure.palette_heading':'主题色',
    'configure.palette_warm_black':'暖黑',
    'configure.palette_warm_white':'暖白',
    'configure.palette_warm_white_bold':'暖白（正文加粗）',
    'configure.param_body_font':  '正文字体',
    'configure.param_code_font':  '代码字体',
    'configure.body_font_heading':'正文字体',
    'configure.code_font_heading':'代码字体',
    'configure.font_custom_prompt':'输入 CSS font-family（如 \'LXGW WenKai\', serif）：',
    'configure.font_custom_label':'自定义',
    'configure.font_plex_serif':  'IBM Plex Serif',
    'configure.font_georgia':     'Georgia',
    'configure.font_system_serif':'系统衬线体',
    'configure.font_rec_mono':    'Rec Mono Linear',
    'configure.font_jetbrains_mono':'JetBrains Mono',
    'configure.font_system_mono': '系统等宽体',
    'configure.font_custom':      '自定义',
    'apply.font_custom_value':    '自定义',

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
