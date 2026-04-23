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
  const tight = rows < 30;
  return {
    topBlanks:           tight ? 1 : 2,
    titleGapAfter:       tight ? 2 : 3,
    ledgerGapAfter:      tight ? 2 : 3,
    menuGapBeforeRule:   tight ? 1 : 2,
  };
}

const TITLE = 'I  ·  N  ·  C  ·  I  ·  P  ·  I  ·  T';
const TAGLINES = Object.freeze([
  'a quiet typesetting patch',
  'for long-form reading',
]);

function color(text, code) {
  return `${code}${text}${Ansi.RESET}`;
}

function clearScreen() {
  // `\x1B[2J` erases the viewport, `\x1B[3J` erases the scrollback
  // (xterm extension, supported by Windows Terminal / VS Code / iTerm2 /
  // modern Konsole / GNOME Terminal), `\x1B[H` homes the cursor. We
  // deliberately avoid `\x1Bc` (RIS / Reset to Initial State) because
  // RIS also resets cursor visibility, which wipes any `\x1B[?25l` the
  // caller just wrote for raw-mode input loops.
  process.stdout.write('\x1B[2J\x1B[3J\x1B[H');
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
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}

function centerLine(text, width) {
  const len = stripAnsi(text).length;
  if (len >= width) return text;
  return ' '.repeat(Math.floor((width - len) / 2)) + text;
}

function shortenPath(value) {
  const home = os.homedir();
  const normalized = value.startsWith(home) ? `~${value.slice(home.length)}` : value;
  return normalized.replace(/\\/g, '/');
}

function wrapWidth(value, max) {
  if (max <= 0 || value.length <= max) return [value];
  const lines = [];
  for (let i = 0; i < value.length; i += max) lines.push(value.slice(i, i + max));
  return lines;
}

function wrapPathValue(value, max) {
  if (max <= 0 || value.length <= max) return [value];
  const lines = [];
  let remaining = value;
  while (remaining.length > max) {
    const candidate = remaining.slice(0, max);
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

function createPrinter(framePad) {
  return {
    line(text) {
      console.log(framePad + text);
    },
    blank() {
      console.log();
    },
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
      color(label.padEnd(LAYOUT.LABEL_COL), Ansi.GREY) +
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
      color('Target'.padEnd(LAYOUT.LABEL_COL), Ansi.GREY) +
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
  const printer = createPrinter(framePad);
  const rule = color('━'.repeat(inner), Ansi.GREY);

  printer.line(rule);
  for (let i = 0; i < gaps.topBlanks; i++) printer.blank();
  renderTitle(printer, inner, version);
  for (let i = 0; i < gaps.titleGapAfter; i++) printer.blank();
  renderLedger(printer, indent, inner, target, missingText, backupRoot);
  for (let i = 0; i < gaps.ledgerGapAfter; i++) printer.blank();
  renderMenuItems(printer, indent, menuItems);
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
  const printer = createPrinter(framePad);
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
      color(glyph.padEnd(checkCol), glyphColor) +
      color(label, Ansi.IVORY),
    );
  };
  const emitKnob = (rowIndex, mark, label, value) => {
    printer.line(
      leadFor(rowIndex) +
      color(mark.padEnd(markCol), Ansi.TERRA) +
      ' '.repeat(checkCol) +
      color(label.padEnd(labelColWidth), Ansi.IVORY) +
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

  emitToggle(0, '1.', features.math, labels.math);
  emitToggle(1, '2.', features.sessionUsage, labels.sessionUsage);
  emitToggle(2, '3.', features.toolFold, labels.toolFold);
  emitKnob(   3, '4.', labels.bodyFontSize, `${theme.bodyFontSize} px`);
  printer.blank();
  emitPlain(  4, 'r.', labels.reset);
  emitPlain(  5, 'b.', labels.back);

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
  const printer = createPrinter(framePad);
  const rule = color('━'.repeat(inner), Ansi.GREY);
  const centered = text => centerLine(text, inner);

  printer.line(rule);
  for (let i = 0; i < gaps.topBlanks; i++) printer.blank();
  renderTitle(printer, inner, version);
  for (let i = 0; i < gaps.titleGapAfter; i++) printer.blank();
  printer.line(centered(color(heading, Ansi.GREY)));
  printer.blank();
  printer.blank();
  renderMenuItems(printer, indent, optionsList);
  for (let i = 0; i < gaps.menuGapBeforeRule; i++) printer.blank();
  printer.line(rule);
  renderHint(printer, indent, hint);
  for (let i = 0; i < LAYOUT.RULE_GAP_BEFORE_PROMPT; i++) printer.blank();
}

module.exports = {
  Ansi,
  color,
  clearScreen,
  promptPrefix,
  renderMainMenu,
  renderConfigureMenu,
  renderLanguagePicker,
};
