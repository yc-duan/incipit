'use strict';

const os = require('os');

const Ansi = {
  RESET: '\x1b[0m',
  BOLD: '\x1b[1m',
  ITALIC: '\x1b[3m',
  TERRA: '\x1b[38;2;217;119;87m',
  IVORY: '\x1b[38;2;248;248;246m',
  GREY: '\x1b[38;2;152;152;152m',
  RED: '\x1b[31m',
  GREEN: '\x1b[32m',
  YELLOW: '\x1b[33m',
  CYAN: '\x1b[36m',
};

const LAYOUT = Object.freeze({
  TERM_MIN: 60,
  TERM_MAX: 100,
  INNER_WIDTH: 68,
  FRAME_MARGIN: 4,
  INDENT: 6,
  LABEL_COL: 12,
  MENU_GAP_BEFORE_RULE: 2,
  RULE_GAP_BEFORE_PROMPT: 0,
  PROMPT_MARK: '› ',
  MENU_MARK_COL: 5,
});

// Vertical breathing space is dynamic. On a roomy terminal we keep the
// book-page rhythm; on a default 24–26 row terminal the top rule would
// otherwise scroll off above the title, so the gaps compress to fit.
function verticalGaps() {
  const rows = process.stdout.rows || 30;
  const tight = rows <= 30;
  return {
    topBlanks:           tight ? 1 : 2,
    titleGapAfter:       tight ? 2 : 3,
    ledgerGapAfter:      tight ? 2 : 3,
    menuGapBeforeRule:   tight ? 1 : 2,
  };
}

function viewportRows() {
  const rows = process.stdout && process.stdout.rows;
  return Number.isFinite(rows) && rows > 0 ? rows : 30;
}

const TITLE = 'I  ·  N  ·  C  ·  I  ·  P  ·  I  ·  T';
const TAGLINES = Object.freeze([
  'a quiet typesetting patch',
  'for long-form reading',
]);

let activeCapture = null;

function supportsTerminalControl() {
  if (!process.stdout || !process.stdout.isTTY) return false;
  return process.env.TERM !== 'dumb';
}

function supportsColor() {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  return supportsTerminalControl();
}

function color(text, code) {
  if (!supportsColor()) return String(text);
  return `${code}${text}${Ansi.RESET}`;
}

function clearScreen(options = {}) {
  if (activeCapture) {
    activeCapture.cleared = true;
    return;
  }
  if (!supportsTerminalControl()) return;
  // Soft clear is for in-screen redraws; hard clear is only for crossing
  // UI modes, where old menu/prompt history should disappear too.
  const history = Boolean(options.history);
  process.stdout.write(history ? '\x1B[2J\x1B[3J\x1B[H' : '\x1B[2J\x1B[H');
}

function termWidth() {
  const width = process.stdout.columns || 96;
  return Math.min(Math.max(width, LAYOUT.TERM_MIN), LAYOUT.TERM_MAX);
}

function frameGeometry() {
  const outer = termWidth();
  const inner = Math.min(outer - LAYOUT.FRAME_MARGIN, LAYOUT.INNER_WIDTH);
  const padLen = Math.max(0, Math.floor((outer - inner) / 2));
  return {
    inner,
    framePad: ' '.repeat(padLen),
    indent: ' '.repeat(LAYOUT.INDENT),
  };
}

function stripAnsi(value) {
  return String(value || '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function visibleWidth(value) {
  let width = 0;
  for (const ch of stripAnsi(value)) width += codePointWidth(ch.codePointAt(0));
  return width;
}

function codePointWidth(cp) {
  if (cp == null) return 0;
  if (cp === 0) return 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (isCombining(cp)) return 0;
  if (isWide(cp)) return 2;
  return 1;
}

function isCombining(cp) {
  return (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe20 && cp <= 0xfe2f)
  );
}

function isWide(cp) {
  return (
    cp >= 0x1100 && (
      cp <= 0x115f ||
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x3fffd)
    )
  );
}

function padVisibleEnd(value, width) {
  const text = String(value || '');
  return text + ' '.repeat(Math.max(0, width - visibleWidth(text)));
}

function truncateVisible(value, max) {
  const text = String(value || '');
  if (max <= 0 || visibleWidth(text) <= max) return text;
  if (max <= 1) return '…';
  return takeVisiblePrefix(text, max - 1) + '…';
}

function takeVisiblePrefix(value, max) {
  let out = '';
  let used = 0;
  for (const ch of String(value || '')) {
    const width = codePointWidth(ch.codePointAt(0));
    if (used + width > max) break;
    out += ch;
    used += width;
  }
  return out;
}

function centerLine(text, width) {
  const len = visibleWidth(text);
  if (len >= width) return text;
  return ' '.repeat(Math.floor((width - len) / 2)) + text;
}

function shortenPath(value) {
  const home = os.homedir();
  const normalized = value.startsWith(home) ? `~${value.slice(home.length)}` : value;
  return normalized.replace(/\\/g, '/');
}

function wrapWidth(value, max) {
  if (max <= 0 || visibleWidth(value) <= max) return [value];
  const lines = [];
  let remaining = String(value || '');
  while (visibleWidth(remaining) > max) {
    const chunk = takeVisiblePrefix(remaining, max);
    if (!chunk) break;
    lines.push(chunk);
    remaining = remaining.slice(chunk.length);
  }
  if (remaining) lines.push(remaining);
  return lines;
}

function wrapPathValue(value, max) {
  if (max <= 0 || visibleWidth(value) <= max) return [value];
  const lines = [];
  let remaining = String(value || '');
  while (visibleWidth(remaining) > max) {
    const candidate = takeVisiblePrefix(remaining, max);
    if (!candidate) break;
    const cut = selectPathBreak(candidate, max);
    lines.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining) lines.push(remaining);
  return lines;
}

function selectPathBreak(candidate, max) {
  const slash = candidate.lastIndexOf('/') + 1;
  if (slash > 0) return slash;
  const hyphen = candidate.lastIndexOf('-') + 1;
  if (hyphen > 0) return hyphen;
  return max;
}

function wrapLedgerValue(value, max) {
  return value.includes('/') ? wrapPathValue(value, max) : wrapWidth(value, max);
}

function createPrinter(framePad, inner) {
  if (activeCapture && activeCapture.frame == null) {
    activeCapture.frame = { padLen: framePad.length, inner };
  }
  return {
    line(text) {
      if (activeCapture) activeCapture.lines.push(framePad + text);
      else console.log(framePad + text);
    },
    blank() {
      if (activeCapture) activeCapture.lines.push('');
      else console.log();
    },
    scrollStart() {
      if (activeCapture && activeCapture.scrollStart == null) {
        activeCapture.scrollStart = activeCapture.lines.length;
      }
    },
    scrollEnd() {
      if (activeCapture && activeCapture.scrollEnd == null) {
        activeCapture.scrollEnd = activeCapture.lines.length;
      }
    },
  };
}

function captureScreenRender(render) {
  const previous = activeCapture;
  const capture = { cleared: false, lines: [], scrollStart: null, scrollEnd: null, frame: null };
  activeCapture = capture;
  try {
    render();
  } finally {
    activeCapture = previous;
  }
  const scrollRegion =
    Number.isInteger(capture.scrollStart) &&
    Number.isInteger(capture.scrollEnd) &&
    capture.scrollEnd > capture.scrollStart
      ? { start: capture.scrollStart, end: capture.scrollEnd }
      : null;
  return {
    cleared: capture.cleared,
    frame: capture.frame,
    scrollRegion,
    text: capture.lines.length ? capture.lines.join('\n') + '\n' : '',
  };
}

function renderTitle(printer, inner, version) {
  const centered = text => centerLine(text, inner);
  printer.line(centered(color(TITLE, `${Ansi.TERRA}${Ansi.BOLD}`)));
  printer.blank();
  for (const tagline of TAGLINES) {
    printer.line(centered(color(tagline, `${Ansi.GREY}${Ansi.ITALIC}`)));
  }
  if (version) {
    printer.blank();
    printer.line(centered(color(`version ${version}`, `${Ansi.GREY}${Ansi.ITALIC}`)));
  }
}

function renderLedger(printer, indent, inner, target, missingText, backupRoot) {
  const valueMax = Math.max(10, inner - indent.length - LAYOUT.LABEL_COL);
  const continuation = indent + ' '.repeat(LAYOUT.LABEL_COL);
  const emitRow = (label, value) => {
    const chunks = wrapLedgerValue(value, valueMax);
    printer.line(
      indent +
      color(padVisibleEnd(label, LAYOUT.LABEL_COL), Ansi.GREY) +
      color(chunks[0], Ansi.IVORY),
    );
    for (const chunk of chunks.slice(1)) {
      printer.line(continuation + color(chunk, Ansi.IVORY));
    }
  };

  if (target) {
    emitRow('Target', `Claude Code ${target.version}`);
    emitRow('Extension', shortenPath(target.extensionDir));
  } else {
    printer.line(
      indent +
      color(padVisibleEnd('Target', LAYOUT.LABEL_COL), Ansi.GREY) +
      color(missingText, `${Ansi.GREY}${Ansi.ITALIC}`),
    );
  }
  emitRow('Backup', shortenPath(backupRoot));
}

// Cursor indent replaces the first half of `indent` with a terra `›`
// while preserving the six-column visible width, so selected and
// unselected rows stay left-aligned with the ledger above.
function cursorIndent() {
  return '   ' + color('›', Ansi.TERRA) + '  ';
}

function renderMenuItems(printer, indent, items) {
  const cursor = cursorIndent();
  for (const item of items) {
    const mark = color(item.mark.padEnd(LAYOUT.MENU_MARK_COL), Ansi.TERRA);
    const lead = item.selected ? cursor : indent;
    printer.line(lead + mark + color(item.label, Ansi.IVORY));
  }
}

function renderHint(printer, indent, hint) {
  if (!hint) return;
  printer.blank();
  printer.line(indent + color(hint, `${Ansi.GREY}${Ansi.ITALIC}`));
}

function promptPrefix() {
  const { framePad, indent } = frameGeometry();
  return framePad + indent + color(LAYOUT.PROMPT_MARK, Ansi.TERRA);
}

function renderMainMenu(options) {
  const { menuItems, target, missingText, backupRoot, version, hint } = options;
  clearScreen();
  const { inner, framePad, indent } = frameGeometry();
  const gaps = verticalGaps();
  const printer = createPrinter(framePad, inner);
  const rule = color('━'.repeat(inner), Ansi.GREY);

  printer.line(rule);
  for (let i = 0; i < gaps.topBlanks; i++) printer.blank();
  renderTitle(printer, inner, version);
  for (let i = 0; i < gaps.titleGapAfter; i++) printer.blank();
  renderLedger(printer, indent, inner, target, missingText, backupRoot);
  for (let i = 0; i < gaps.ledgerGapAfter; i++) printer.blank();
  printer.scrollStart();
  renderMenuItems(printer, indent, menuItems);
  printer.scrollEnd();
  for (let i = 0; i < gaps.menuGapBeforeRule; i++) printer.blank();
  printer.line(rule);
  renderHint(printer, indent, hint);
  for (let i = 0; i < LAYOUT.RULE_GAP_BEFORE_PROMPT; i++) printer.blank();
}

function renderConfigureMenu(options) {
  const { version, heading, features, theme, labels, selectedIndex, hint } = options;
  clearScreen();
  const { inner, framePad, indent } = frameGeometry();
  const gaps = verticalGaps();
  const printer = createPrinter(framePad, inner);
  const rule = color('━'.repeat(inner), Ansi.GREY);
  const centered = text => centerLine(text, inner);
  const cursor = cursorIndent();

  printer.line(rule);
  for (let i = 0; i < gaps.topBlanks; i++) printer.blank();
  renderTitle(printer, inner, version);
  for (let i = 0; i < gaps.titleGapAfter; i++) printer.blank();
  printer.line(centered(color(heading, Ansi.GREY)));
  printer.blank();
  printer.blank();

  const markCol = LAYOUT.MENU_MARK_COL;
  const checkCol = 4;
  const labelColWidth = 22;

  // Every emit* call takes a `rowIndex` to compare against `selectedIndex`
  // so the terra `›` cursor tracks the currently focused row.
  const leadFor = rowIndex => (rowIndex === selectedIndex ? cursor : indent);

  const emitToggle = (rowIndex, mark, on, label) => {
    const glyph = on ? '✓' : '✗';
    const glyphColor = on ? Ansi.TERRA : Ansi.GREY;
    printer.line(
      leadFor(rowIndex) +
      color(mark.padEnd(markCol), Ansi.TERRA) +
      color(padVisibleEnd(glyph, checkCol), glyphColor) +
      color(label, Ansi.IVORY),
    );
  };
  const emitKnob = (rowIndex, mark, label, value) => {
    printer.line(
      leadFor(rowIndex) +
      color(mark.padEnd(markCol), Ansi.TERRA) +
      ' '.repeat(checkCol) +
      color(padVisibleEnd(label, labelColWidth), Ansi.IVORY) +
      color(value, Ansi.IVORY),
    );
  };
  const emitPlain = (rowIndex, mark, label) => {
    printer.line(
      leadFor(rowIndex) +
      color(mark.padEnd(markCol), Ansi.TERRA) +
      ' '.repeat(checkCol) +
      color(label, Ansi.IVORY),
    );
  };

  printer.scrollStart();
  emitToggle(0, '1.', features.math, labels.math);
  emitToggle(1, '2.', features.sessionUsage, labels.sessionUsage);
  emitKnob(   2, '3.', labels.bodyFontSize, `${theme.bodyFontSize} px`);
  emitKnob(   3, '4.', labels.palette, labels.paletteValue);
  emitKnob(   4, '5.', labels.bodyFont, labels.bodyFontValue);
  emitKnob(   5, '6.', labels.codeFont, labels.codeFontValue);
  printer.blank();
  emitPlain(  6, 'r.', labels.reset);
  emitPlain(  7, 'b.', labels.back);
  printer.scrollEnd();

  for (let i = 0; i < gaps.menuGapBeforeRule; i++) printer.blank();
  printer.line(rule);
  renderHint(printer, indent, hint);
  for (let i = 0; i < LAYOUT.RULE_GAP_BEFORE_PROMPT; i++) printer.blank();
}

function renderLanguagePicker(options) {
  const { heading, optionsList, version, hint } = options;
  clearScreen();
  const { inner, framePad, indent } = frameGeometry();
  const gaps = verticalGaps();
  const printer = createPrinter(framePad, inner);
  const rule = color('━'.repeat(inner), Ansi.GREY);
  const centered = text => centerLine(text, inner);

  printer.line(rule);
  for (let i = 0; i < gaps.topBlanks; i++) printer.blank();
  renderTitle(printer, inner, version);
  for (let i = 0; i < gaps.titleGapAfter; i++) printer.blank();
  printer.line(centered(color(heading, Ansi.GREY)));
  printer.blank();
  printer.blank();
  printer.scrollStart();
  renderMenuItems(printer, indent, optionsList);
  printer.scrollEnd();
  for (let i = 0; i < gaps.menuGapBeforeRule; i++) printer.blank();
  printer.line(rule);
  renderHint(printer, indent, hint);
  for (let i = 0; i < LAYOUT.RULE_GAP_BEFORE_PROMPT; i++) printer.blank();
}

// ============================================================
// target screens
// ============================================================

// Render the target manage screen. Two visual modes:
//
//   - mode 'browse' (default): cursor lives on the action rows only
//     (a / d / b). `selectedIndex` is interpreted as an index into
//     `actions`. Target rows are pure read-only display, no dot, no
//     cursor. The screen sub-heading is `listHeading`.
//
//   - mode 'delete': cursor lives on target rows, with a single ●
//     (TERRA) glyph on the cursored row. `selectedIndex` indexes into
//     `entries`. The action rows are hidden — pressing Enter commits
//     to a deletion, Esc/b returns to browse mode at the call site.
//     The sub-heading switches to `deleteHeading`.
function renderTargetMenu(options) {
  const {
    mode = 'browse',
    version, heading, entries, actions, selectedIndex, hint,
    listHeading, deleteHeading,
    noTargetsText, noTargetsHint,
    columnLabels,
  } = options;
  clearScreen();
  const { inner, framePad, indent } = frameGeometry();
  const gaps = verticalGaps();
  const printer = createPrinter(framePad, inner);
  const rule = color('━'.repeat(inner), Ansi.GREY);
  const centered = text => centerLine(text, inner);
  const cursor = cursorIndent();

  printer.line(rule);
  for (let i = 0; i < gaps.topBlanks; i++) printer.blank();
  renderTitle(printer, inner, version);
  for (let i = 0; i < gaps.titleGapAfter; i++) printer.blank();
  printer.line(centered(color(heading, Ansi.GREY)));
  printer.blank();
  printer.blank();

  // Sub-heading: list label in browse mode, "pick a target to remove"
  // in delete mode.
  const subHeading = mode === 'delete' ? deleteHeading : listHeading;

  printer.scrollStart();
  if (entries.length === 0) {
    printer.line(indent + color(noTargetsText, `${Ansi.GREY}${Ansi.ITALIC}`));
    printer.line(indent + color(noTargetsHint, `${Ansi.GREY}${Ansi.ITALIC}`));
  } else {
    printer.line(indent + color(subHeading, Ansi.GREY));
    printer.blank();

    const labelMax = Math.max(20, inner - indent.length - 32);
    entries.forEach((entry, i) => {
      const label = truncateLabel(entry.label, labelMax);
      const versionPart = entry.version
        ? color(entry.version.padStart(8), Ansi.IVORY)
        : ' '.repeat(8);
      const tags = buildTagSpan(entry, columnLabels);

      if (mode === 'delete') {
        const lead = i === selectedIndex ? cursor : indent;
        const dot = i === selectedIndex
          ? color('●', Ansi.TERRA)
          : ' ';
        printer.line(
          lead +
          dot + '  ' +
          color(padVisibleEnd(label, labelMax), Ansi.IVORY) +
          '  ' + versionPart +
          '  ' + tags,
        );
        // Path on its own line, dimmed.
        const pathLine = shortenPath(entry.extensionsDir || '');
        if (pathLine) {
          printer.line(
            indent + '   ' + color(pathLine, `${Ansi.GREY}${Ansi.ITALIC}`),
          );
        }
      } else {
        // Browse mode — no cursor, no dot.
        printer.line(
          indent +
          color(padVisibleEnd(label, labelMax), Ansi.IVORY) +
          '  ' + versionPart +
          '  ' + tags,
        );
        const pathLine = shortenPath(entry.extensionsDir || '');
        if (pathLine) {
          printer.line(
            indent + color(pathLine, `${Ansi.GREY}${Ansi.ITALIC}`),
          );
        }
      }
    });
  }

  printer.blank();
  printer.line(indent + color('─'.repeat(Math.max(0, inner - indent.length - 2)), Ansi.GREY));
  printer.blank();

  if (mode !== 'delete') {
    actions.forEach((row, i) => {
      const lead = i === selectedIndex ? cursor : indent;
      printer.line(
        lead +
        color(row.mark.padEnd(LAYOUT.MENU_MARK_COL), Ansi.TERRA) +
        color(row.label, Ansi.IVORY),
      );
    });
  }
  printer.scrollEnd();

  for (let i = 0; i < gaps.menuGapBeforeRule; i++) printer.blank();
  printer.line(rule);
  renderHint(printer, indent, hint);
  for (let i = 0; i < LAYOUT.RULE_GAP_BEFORE_PROMPT; i++) printer.blank();
}

function buildTagSpan(entry, columnLabels) {
  const tags = [];
  if (!entry.valid) tags.push(color(`[${columnLabels.invalid}]`, Ansi.RED));
  tags.push(
    entry.kind === 'auto'
      ? color(`[${columnLabels.auto}]`, Ansi.GREY)
      : color(`[${columnLabels.manual}]`, `${Ansi.TERRA}`),
  );
  return tags.join(' ');
}

function truncateLabel(label, max) {
  return truncateVisible(label, max);
}

// "Add target" intro screen — explains what folder to pick before the
// system folder dialog opens. The word "folder" / "文件夹" inside the
// intro line is rendered in TERRA so the user's eye lands on it.
function renderAddTargetIntro(options) {
  const {
    version, heading, intro, dialogWord,
    optionA, optionAEgs, optionAEgs2,
    optionB, optionBEgs, optionBEgs2,
    optionC, optionCEg,
    actions, selectedIndex, hint,
  } = options;
  clearScreen();
  const { inner, framePad, indent } = frameGeometry();
  const gaps = verticalGaps();
  const compact = viewportRows() <= 32;
  const printer = createPrinter(framePad, inner);
  const rule = color('━'.repeat(inner), Ansi.GREY);
  const centered = text => centerLine(text, inner);
  const cursor = cursorIndent();
  const leadFor = rowIndex => (rowIndex === selectedIndex ? cursor : indent);

  printer.line(rule);
  for (let i = 0; i < (compact ? 1 : gaps.topBlanks); i++) printer.blank();
  renderTitle(printer, inner, version);
  for (let i = 0; i < (compact ? 1 : gaps.titleGapAfter); i++) printer.blank();
  printer.line(centered(color(heading, Ansi.GREY)));
  printer.blank();
  if (!compact) printer.blank();

  printer.scrollStart();
  // Replace `{folder}` placeholder with terra-colored word.
  const introRendered = String(intro).replace(
    /\{folder\}/,
    color(dialogWord, `${Ansi.TERRA}${Ansi.BOLD}`),
  );
  printer.line(indent + introRendered);
  printer.blank();

  printer.line(indent + '  · ' + color(optionA, Ansi.IVORY));
  if (optionAEgs)  printer.line(indent + '      ' + color(optionAEgs,  `${Ansi.GREY}${Ansi.ITALIC}`));
  if (optionAEgs2) printer.line(indent + '      ' + color(optionAEgs2, `${Ansi.GREY}${Ansi.ITALIC}`));
  if (!compact) printer.blank();

  printer.line(indent + '  · ' + color(optionB, Ansi.IVORY));
  if (optionBEgs)  printer.line(indent + '      ' + color(optionBEgs,  `${Ansi.GREY}${Ansi.ITALIC}`));
  if (optionBEgs2) printer.line(indent + '      ' + color(optionBEgs2, `${Ansi.GREY}${Ansi.ITALIC}`));
  if (!compact) printer.blank();

  printer.line(indent + '  · ' + color(optionC, Ansi.IVORY));
  if (optionCEg) printer.line(indent + '      ' + color(optionCEg, `${Ansi.GREY}${Ansi.ITALIC}`));
  printer.blank();
  if (!compact) printer.blank();

  actions.forEach((row, i) => {
    printer.line(
      leadFor(i) +
      color(row.mark.padEnd(LAYOUT.MENU_MARK_COL), Ansi.TERRA) +
      color(row.label, Ansi.IVORY),
    );
  });
  printer.scrollEnd();

  for (let i = 0; i < (compact ? 0 : gaps.menuGapBeforeRule); i++) printer.blank();
  printer.line(rule);
  renderHint(printer, indent, hint);
}

// Identify-success screen: shows what the picker resolved to and the
// label-input row. The label input is a one-shot readline call from the
// caller; here we just render the visual frame.
function renderIdentifyResult(options) {
  const {
    version, heading,
    kindLabel, extensionsDir, settingsPath, latestVersion,
    settingsInferred,
    emptyDataWarn,
    actions, selectedIndex, hint,
    labels,
  } = options;
  clearScreen();
  const { inner, framePad, indent } = frameGeometry();
  const gaps = verticalGaps();
  const printer = createPrinter(framePad, inner);
  const rule = color('━'.repeat(inner), Ansi.GREY);
  const centered = text => centerLine(text, inner);
  const cursor = cursorIndent();
  const leadFor = rowIndex => (rowIndex === selectedIndex ? cursor : indent);

  printer.line(rule);
  for (let i = 0; i < gaps.topBlanks; i++) printer.blank();
  renderTitle(printer, inner, version);
  for (let i = 0; i < gaps.titleGapAfter; i++) printer.blank();
  printer.line(centered(color(heading, Ansi.GREY)));
  printer.blank();
  printer.blank();

  const emit = (label, value, valueColor) => {
    printer.line(
      indent +
      color(padVisibleEnd(label, LAYOUT.LABEL_COL + 2), Ansi.GREY) +
      color(value, valueColor || Ansi.IVORY),
    );
  };
  printer.scrollStart();
  emit(labels.recognized, kindLabel, Ansi.TERRA);
  emit(labels.kind, kindLabel);
  emit(labels.extensions, shortenPath(extensionsDir || ''));
  if (settingsPath) {
    emit(labels.settings, shortenPath(settingsPath));
  } else {
    emit(labels.settings, settingsInferred || '(unknown)');
  }
  if (latestVersion) emit(labels.version, latestVersion);
  printer.blank();

  if (emptyDataWarn) {
    printer.line(indent + color(emptyDataWarn, Ansi.YELLOW));
    printer.blank();
  }

  actions.forEach((row, i) => {
    printer.line(
      leadFor(i) +
      color(row.mark.padEnd(LAYOUT.MENU_MARK_COL), Ansi.TERRA) +
      color(row.label, Ansi.IVORY),
    );
  });
  printer.scrollEnd();

  for (let i = 0; i < gaps.menuGapBeforeRule; i++) printer.blank();
  printer.line(rule);
  renderHint(printer, indent, hint);
}

// Identify-failure screen: explains why we rejected the picked folder
// and lets the user re-pick or back out.
function renderIdentifyFailure(options) {
  const {
    version, heading, picked, body,
    actions, selectedIndex, hint, labelPicked,
  } = options;
  clearScreen();
  const { inner, framePad, indent } = frameGeometry();
  const gaps = verticalGaps();
  const printer = createPrinter(framePad, inner);
  const rule = color('━'.repeat(inner), Ansi.GREY);
  const centered = text => centerLine(text, inner);
  const cursor = cursorIndent();
  const leadFor = rowIndex => (rowIndex === selectedIndex ? cursor : indent);

  printer.line(rule);
  for (let i = 0; i < gaps.topBlanks; i++) printer.blank();
  renderTitle(printer, inner, version);
  for (let i = 0; i < gaps.titleGapAfter; i++) printer.blank();
  printer.line(centered(color(heading, `${Ansi.RED}${Ansi.BOLD}`)));
  printer.blank();
  printer.blank();

  printer.scrollStart();
  if (picked) {
    printer.line(indent + color(labelPicked + ':', Ansi.GREY));
    for (const chunk of wrapPathValue(shortenPath(picked), inner - indent.length - 4)) {
      printer.line(indent + '  ' + color(chunk, Ansi.IVORY));
    }
    printer.blank();
  }

  for (const line of String(body || '').split('\n')) {
    printer.line(indent + color(line, Ansi.IVORY));
  }
  printer.blank();
  printer.blank();

  actions.forEach((row, i) => {
    printer.line(
      leadFor(i) +
      color(row.mark.padEnd(LAYOUT.MENU_MARK_COL), Ansi.TERRA) +
      color(row.label, Ansi.IVORY),
    );
  });
  printer.scrollEnd();

  for (let i = 0; i < gaps.menuGapBeforeRule; i++) printer.blank();
  printer.line(rule);
  renderHint(printer, indent, hint);
}

// Apply pre-picker — invoked once at the top of every interactive apply.
// `entries` lists the user's known targets in order; `selectedIndex`
// indexes the row the user is about to commit to (cursor + dot are
// synced — the cursored row gets a single ● in TERRA, all other rows
// get a blank space so column alignment is preserved without showing
// any "non-selected" glyph).
function renderApplyPicker(options) {
  const {
    version, heading, entries, actions,
    selectedIndex, hint, columnLabels, noActiveText,
  } = options;
  clearScreen();
  const { inner, framePad, indent } = frameGeometry();
  const gaps = verticalGaps();
  const printer = createPrinter(framePad, inner);
  const rule = color('━'.repeat(inner), Ansi.GREY);
  const centered = text => centerLine(text, inner);
  const cursor = cursorIndent();
  const leadFor = rowIndex => (rowIndex === selectedIndex ? cursor : indent);

  printer.line(rule);
  for (let i = 0; i < gaps.topBlanks; i++) printer.blank();
  renderTitle(printer, inner, version);
  for (let i = 0; i < gaps.titleGapAfter; i++) printer.blank();
  printer.line(centered(color(heading, Ansi.GREY)));
  printer.blank();
  printer.blank();

  printer.scrollStart();
  if (!entries.length) {
    printer.line(indent + color(noActiveText, Ansi.YELLOW));
    printer.blank();
  } else {
    const labelMax = Math.max(20, inner - indent.length - 30);
    entries.forEach((entry, i) => {
      // Single-state dot: visible only on the cursored row.
      const dot = i === selectedIndex
        ? color('●', Ansi.TERRA)
        : ' ';
      const label = truncateLabel(entry.label, labelMax);
      const versionPart = entry.version
        ? color(entry.version.padStart(8), Ansi.IVORY)
        : ' '.repeat(8);
      const kindTag = entry.kind === 'auto'
        ? color(`[${columnLabels.auto}]`, Ansi.GREY)
        : color(`[${columnLabels.manual}]`, Ansi.TERRA);
      printer.line(
        leadFor(i) +
        dot + '  ' +
        color(padVisibleEnd(label, labelMax), Ansi.IVORY) +
        '  ' + versionPart +
        '  ' + kindTag,
      );
      const pathLine = shortenPath(entry.extensionsDir || '');
      if (pathLine) {
        printer.line(
          indent + '   ' + color(pathLine, `${Ansi.GREY}${Ansi.ITALIC}`),
        );
      }
    });
  }

  printer.blank();
  printer.line(indent + color('─'.repeat(Math.max(0, inner - indent.length - 2)), Ansi.GREY));
  printer.blank();

  const actionStart = entries.length;
  actions.forEach((row, i) => {
    const idx = actionStart + i;
    printer.line(
      leadFor(idx) +
      color(row.mark.padEnd(LAYOUT.MENU_MARK_COL), Ansi.TERRA) +
      color(row.label, Ansi.IVORY),
    );
  });
  printer.scrollEnd();

  for (let i = 0; i < gaps.menuGapBeforeRule; i++) printer.blank();
  printer.line(rule);
  renderHint(printer, indent, hint);
}

module.exports = {
  Ansi,
  color,
  captureScreenRender,
  clearScreen,
  supportsTerminalControl,
  promptPrefix,
  renderMainMenu,
  renderConfigureMenu,
  renderLanguagePicker,
  renderTargetMenu,
  renderAddTargetIntro,
  renderIdentifyResult,
  renderIdentifyFailure,
  renderApplyPicker,
};
