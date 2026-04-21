// Math token pipeline for incipit.
//
// Two distinct paths share this module, and they must never cross:
//
//   1. Preprocess path (raw markdown → placeholders)
//      `preprocessMarkdownMath` is called from the patched `react-markdown`
//      `file.value` handoff. It only ever sees assistant-side markdown
//      source, because Claude Code's user bubbles bypass `react-markdown`
//      entirely and emit raw text directly.
//
//   2. Render path (placeholders in DOM text → render tokens)
//      `tokenizePlaceholders` is called by `math_rewriter` while scanning
//      segments in the live DOM. It only recognizes placeholders carrying
//      this run's `RUNTIME_TOKEN`, so stale text copy-pasted by the user
//      or leftover from a previous session cannot be mistaken for a real
//      math span.
//
// Together these guarantees remove the need for DOM-level host-class
// blocklists. If a piece of text never transited the preprocess hook,
// it cannot possibly contain a valid placeholder, and the render path
// will leave it alone.

const PLACEHOLDER_PREFIX = 'CCREMATH';
const PLACEHOLDER_SUFFIX = 'ZZ';
const INLINE_PLACEHOLDER = 'I';
const DISPLAY_PLACEHOLDER = 'D';
const MAX_SOFTBREAK_INDENT = 3;

const HEX_RE = /^[0-9A-F]+$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Per-webview random token baked into every placeholder this run generates.
// Same run, same token — preprocess and the render path share one module
// instance, so they always agree on the current token.
const RUNTIME_TOKEN = generateRuntimeToken();

const INLINE_PLACEHOLDER_PATTERN =
  `${PLACEHOLDER_PREFIX}${INLINE_PLACEHOLDER}${RUNTIME_TOKEN}[0-9A-F]+${PLACEHOLDER_SUFFIX}`;
const PLACEHOLDER_SCAN_RE = new RegExp(
  `${PLACEHOLDER_PREFIX}([ID])${RUNTIME_TOKEN}([0-9A-F]+)${PLACEHOLDER_SUFFIX}`,
  'g',
);

const TRAILING_WS_RE = /[ \t]+$/;
const LEADING_WS_RE = /^[ \t]+/;
const HEADING_LINE_RE = /^[ \t]{0,3}#{1,6}(?:[ \t]|$)/;
const BLOCKQUOTE_LINE_RE = /^[ \t]{0,3}>/;
const FENCE_LINE_RE = /^[ \t]{0,3}(?:`{3,}|~{3,})/;
const THEMATIC_BREAK_RE = /^[ \t]{0,3}(?:[-*_][ \t]*){3,}$/;
const TABLE_ROW_RE = /^[ \t]{0,3}\|/;
const HTML_BLOCK_RE = /^[ \t]{0,3}</;
const ORDERED_LIST_MARKER_RE = /^[ \t]{0,3}\d+[.)][ \t]+/;
const BULLET_LIST_MARKER_RE = /^[ \t]{0,3}[-+*][ \t]+/;
const INLINE_PLACEHOLDER_START_RE = new RegExp(
  `^[ \\t]{0,${MAX_SOFTBREAK_INDENT}}(?=${INLINE_PLACEHOLDER_PATTERN})`,
);
const INLINE_PLACEHOLDER_END_RE = new RegExp(
  `${INLINE_PLACEHOLDER_PATTERN}[ \\t]*$`,
);
const LIST_MARKER_ONLY_RE = new RegExp(
  `^[ \\t]{0,${MAX_SOFTBREAK_INDENT}}(?:[-*+]|\\d+[.)])[ \\t]*$`,
);

// Whitelist of LaTeX environments that should be recognized as display math
// when emitted bare (no surrounding `$$` or `\[` delimiters). Large language
// models frequently omit the outer delimiter when emitting matrices, cases,
// and alignment environments, leaving the raw `\begin{..}..\end{..}` source
// exposed in prose. KaTeX can render every name in this set in display mode
// when passed the full `\begin..\end` block as tex input.
//
// Membership is deliberately narrow: only environments defined in KaTeX's
// supported list. Unknown names fall through to the regular `\X` skip so an
// unrecognized `\begin{foo}..\end{foo}` stays as literal text instead of
// triggering a render error.
const MATH_ENVIRONMENTS = new Set([
  'align', 'align*',
  'alignat', 'alignat*',
  'aligned', 'alignedat',
  'array',
  'Bmatrix', 'Bmatrix*',
  'bmatrix', 'bmatrix*',
  'cases', 'cases*',
  'CD',
  'darray',
  'dcases', 'dcases*',
  'drcases',
  'eqnarray', 'eqnarray*',
  'equation', 'equation*',
  'flalign', 'flalign*',
  'gather', 'gather*',
  'gathered',
  'matrix', 'matrix*',
  'multline', 'multline*',
  'pmatrix', 'pmatrix*',
  'rcases',
  'smallmatrix',
  'split',
  'subarray',
  'Vmatrix', 'Vmatrix*',
  'vmatrix', 'vmatrix*',
]);

const BEGIN_PREFIX = '\\begin{';
const MATH_ENV_NAME_CAPTURE_RE = /^([A-Za-z]+\*?)\}/;

// Public: cheap prefilter for the preprocess path. `$` or `\` only.
export function hasRawMathMarkers(text) {
  return typeof text === 'string' && text.length > 1 &&
    (text.includes('$') || text.includes('\\'));
}

// Public: cheap prefilter for the render path. Must see this run's token.
export function hasMathPlaceholders(text) {
  return typeof text === 'string' && text.length > 1 &&
    text.includes(PLACEHOLDER_PREFIX) && text.includes(RUNTIME_TOKEN);
}

// Public: raw markdown → markdown with placeholders. Preserves the original
// text on any tokenizer incompleteness so streaming input is never corrupted.
export function preprocessMarkdownMath(text) {
  if (!hasRawMathMarkers(text)) {
    return text;
  }

  const normalizedText = normalizeLineEndings(text);
  const result = tokenizeRawMath(normalizedText);
  if (!result.complete || !containsMathTokens(result.tokens)) {
    return text;
  }

  const placeholderText = stringifyTokens(result.tokens, buildPlaceholder);
  return normalizeMarkdownMathLayout(placeholderText);
}

// Public: text (with placeholders) → math token list for the renderer.
// Only emits `math` tokens; the rewriter does not need text tokens.
export function tokenizePlaceholders(text) {
  const tokens = [];
  if (!hasMathPlaceholders(text)) {
    return { complete: true, tokens };
  }

  // `matchAll` returns a fresh iterator each call and never relies on the
  // global `lastIndex`, so it is immune to async reentry or early-throw
  // states that would leave a shared regex pointing mid-string.
  for (const match of text.matchAll(PLACEHOLDER_SCAN_RE)) {
    let tex;
    try {
      tex = decodeTex(match[2]);
    } catch {
      continue;
    }
    tokens.push({
      type: 'math',
      display: match[1] === DISPLAY_PLACEHOLDER,
      tex,
      rawStart: match.index,
      rawEnd: match.index + match[0].length,
    });
  }
  return { complete: true, tokens };
}

// Internal: raw-input tokenizer used by `preprocessMarkdownMath`.
// Does not recognize placeholders — preprocess input never contains them.
function tokenizeRawMath(text) {
  const state = { text, tokens: [], i: 0, textStart: 0, complete: true };
  while (state.i < text.length) {
    // Skip markdown code spans and fenced code blocks first. The preprocessor
    // runs before markdown parsing, so it must understand backticks directly.
    if (skipMarkdownCode(state)) {
      continue;
    }
    if (
      scanEnvironmentMath(state) ||
      scanBackslashMath(state) ||
      scanDollarMath(state)
    ) {
      continue;
    }
    state.i += 1;
  }

  flushTextToken(state, text.length);
  return { complete: state.complete, tokens: state.tokens };
}

function skipMarkdownCode(state) {
  return skipFencedCode(state) || skipInlineCode(state);
}

function skipFencedCode(state) {
  const { text, i } = state;
  if (text[i] !== '`') return false;
  if (!atMarkdownLineStart(text, i)) return false;
  let fenceLen = 0;
  while (text[i + fenceLen] === '`') fenceLen += 1;
  if (fenceLen < 3) return false;
  const openLineEnd = text.indexOf('\n', i + fenceLen);
  if (openLineEnd === -1) return false;
  for (let k = i + fenceLen; k < openLineEnd; k += 1) {
    if (text[k] === '`') return false;
  }
  let pos = openLineEnd + 1;
  while (pos < text.length) {
    const lineEnd = indexOfNewline(text, pos);
    const lineLast = lineEnd === -1 ? text.length : lineEnd;
    if (matchesClosingFence(text, pos, lineLast, fenceLen)) {
      state.i = lineEnd === -1 ? text.length : (lineEnd + 1);
      return true;
    }
    pos = lineEnd === -1 ? text.length : (lineEnd + 1);
  }
  // Streaming input may contain an opening fence before its closer arrives.
  // Treat the tail as code and stop scanning without aborting the tokenizer.
  state.i = text.length;
  return true;
}

function skipInlineCode(state) {
  const { text, i } = state;
  if (text[i] !== '`') return false;
  if (isBackslashEscaped(text, i)) return false;
  let openLen = 0;
  while (text[i + openLen] === '`') openLen += 1;
  let pos = i + openLen;
  while (pos < text.length) {
    if (text[pos] !== '`') {
      pos += 1;
      continue;
    }
    let runLen = 0;
    while (text[pos + runLen] === '`') runLen += 1;
    if (runLen === openLen) {
      state.i = pos + runLen;
      return true;
    }
    pos += runLen;
  }
  state.i = i + 1;
  return true;
}

function atMarkdownLineStart(text, i) {
  let j = i;
  while (j > 0 && (text[j - 1] === ' ' || text[j - 1] === '\t')) j -= 1;
  if (i - j > 3) return false;
  return j === 0 || text[j - 1] === '\n';
}

function matchesClosingFence(text, start, end, minLen) {
  let j = start;
  let leading = 0;
  while (j < end && (text[j] === ' ' || text[j] === '\t') && leading < 3) {
    j += 1;
    leading += 1;
  }
  let runLen = 0;
  while (j + runLen < end && text[j + runLen] === '`') runLen += 1;
  if (runLen < minLen) return false;
  let k = j + runLen;
  while (k < end) {
    if (text[k] !== ' ' && text[k] !== '\t') return false;
    k += 1;
  }
  return true;
}

function indexOfNewline(text, from) {
  return text.indexOf('\n', from);
}

function containsMathTokens(tokens) {
  return tokens.some((token) => token.type === 'math');
}

function stringifyTokens(tokens, mapMathToken) {
  let output = '';
  for (const token of tokens) {
    output += token.type === 'math' ? mapMathToken(token) : token.value;
  }
  return output;
}

function normalizeLineEndings(text) {
  return text.replace(/\r\n?/g, '\n');
}

function normalizeMarkdownMathLayout(text) {
  const lines = text.split('\n');
  const out = [];
  for (let index = 0; index < lines.length; index += 1) {
    let current = lines[index];
    while (index + 1 < lines.length && shouldCollapseSoftbreak(current, lines[index + 1])) {
      current = joinSoftbreak(current, lines[index + 1]);
      index += 1;
    }
    out.push(current);
  }
  return out.join('\n');
}

function shouldCollapseSoftbreak(currentLine, nextLine) {
  if (currentLine.indexOf('\n') !== -1 || nextLine.indexOf('\n') !== -1) {
    return false;
  }

  const current = trimRightSpaces(currentLine);
  const next = trimLeftSpaces(nextLine);
  if (!current || !next) return false;

  if (isListMarkerOnly(current) && startsWithInlinePlaceholder(next)) {
    return true;
  }

  if (isStandaloneMarkdownBlock(current) || startsWithMarkdownBlock(next)) {
    return false;
  }

  if (startsWithInlinePlaceholder(next)) {
    return true;
  }

  if (endsWithInlinePlaceholder(current) && startsWithContinuationText(next)) {
    return true;
  }

  return false;
}

function joinSoftbreak(currentLine, nextLine) {
  return trimRightSpaces(currentLine) + ' ' + trimLeftSpaces(nextLine);
}

function trimRightSpaces(text) {
  return text.replace(TRAILING_WS_RE, '');
}

function trimLeftSpaces(text) {
  return text.replace(LEADING_WS_RE, '');
}

function startsWithInlinePlaceholder(text) {
  return INLINE_PLACEHOLDER_START_RE.test(text);
}

function endsWithInlinePlaceholder(text) {
  return INLINE_PLACEHOLDER_END_RE.test(text);
}

function isListMarkerOnly(text) {
  return LIST_MARKER_ONLY_RE.test(text);
}

function startsWithMarkdownBlock(text) {
  return (
    HEADING_LINE_RE.test(text) ||
    BLOCKQUOTE_LINE_RE.test(text) ||
    FENCE_LINE_RE.test(text) ||
    THEMATIC_BREAK_RE.test(text) ||
    TABLE_ROW_RE.test(text) ||
    HTML_BLOCK_RE.test(text) ||
    ORDERED_LIST_MARKER_RE.test(text) ||
    BULLET_LIST_MARKER_RE.test(text)
  );
}

function isStandaloneMarkdownBlock(text) {
  return (
    HEADING_LINE_RE.test(text) ||
    BLOCKQUOTE_LINE_RE.test(text) ||
    FENCE_LINE_RE.test(text) ||
    THEMATIC_BREAK_RE.test(text) ||
    TABLE_ROW_RE.test(text) ||
    HTML_BLOCK_RE.test(text)
  );
}

function startsWithContinuationText(text) {
  return !startsWithMarkdownBlock(text);
}

function buildPlaceholder(token) {
  const mode = token.display ? DISPLAY_PLACEHOLDER : INLINE_PLACEHOLDER;
  return PLACEHOLDER_PREFIX + mode + RUNTIME_TOKEN + encodeTex(token.tex) + PLACEHOLDER_SUFFIX;
}

// Bare-environment scan for `\begin{NAME}..\end{NAME}` blocks emitted without
// outer `$$`/`\[` delimiters. Only fires on whitelisted environment names.
// Unknown names return false so the generic `\X` skip in `scanBackslashMath`
// handles them (advancing by two chars and leaving the remainder as text).
//
// Scan order matters: this runs before `scanDollarMath`, so an environment
// wrapped in `$$..$$` is claimed by the dollar scanner whole — the `$` comes
// first in source order, so when control reaches the `\` inside the dollar
// block this function is not consulted. Code blocks are handled earlier by
// `skipMarkdownCode`, which protects literal `\begin{..}` text quoted inside
// fenced or inline code regions.
//
// Nesting uses same-name depth counting only. A `\begin{pmatrix}` inside a
// `\begin{pmatrix}` is tracked, but a `\begin{bmatrix}` inside `\begin{pmatrix}`
// is ignored as far as this scan is concerned — the outer `\end{pmatrix}` is
// still found correctly because the closer is a different literal string.
function hasSameLineProseBefore(text, pos) {
  for (let j = pos - 1; j >= 0; j -= 1) {
    const ch = text[j];
    if (ch === '\n') return false;
    if (ch !== ' ' && ch !== '\t' && ch !== '\r') return true;
  }
  return false;
}

function hasSameLineProseAfter(text, pos) {
  for (let j = pos; j < text.length; j += 1) {
    const ch = text[j];
    if (ch === '\n') return false;
    if (ch !== ' ' && ch !== '\t' && ch !== '\r') return true;
  }
  return false;
}

function scanEnvironmentMath(state) {
  const { text, i } = state;
  if (text[i] !== '\\' || isBackslashEscaped(text, i)) {
    return false;
  }

  if (text.slice(i, i + BEGIN_PREFIX.length) !== BEGIN_PREFIX) {
    return false;
  }

  const nameStart = i + BEGIN_PREFIX.length;
  const nameMatch = MATH_ENV_NAME_CAPTURE_RE.exec(text.slice(nameStart));
  if (!nameMatch) {
    return false;
  }

  const name = nameMatch[1];
  if (!MATH_ENVIRONMENTS.has(name)) {
    return false;
  }

  const headerEnd = nameStart + nameMatch[0].length;
  const openMarker = `\\begin{${name}}`;
  const closeMarker = `\\end{${name}}`;

  let depth = 1;
  let pos = headerEnd;
  while (pos < text.length) {
    const nextClose = text.indexOf(closeMarker, pos);
    if (nextClose === -1) {
      markIncomplete(state);
      return true;
    }
    const nextOpen = text.indexOf(openMarker, pos);
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth += 1;
      pos = nextOpen + openMarker.length;
      continue;
    }
    depth -= 1;
    pos = nextClose + closeMarker.length;
    if (depth === 0) {
      // Decide display vs. inline from the surrounding source line. If any
      // non-whitespace character sits on the same markdown line before the
      // `\begin` or after the `\end`, the author clearly meant the block to
      // flow with the prose (inline). An environment alone on its line has
      // no surrounding text and renders as display. This matches both the
      // common `A = \begin{pmatrix}..\end{pmatrix}` inline pattern and the
      // standalone equation block that occupies its own paragraph.
      const inline =
        hasSameLineProseBefore(text, i) || hasSameLineProseAfter(text, pos);
      pushMathToken(state, {
        type: 'math',
        display: !inline,
        tex: text.slice(i, pos),
        rawStart: i,
        rawEnd: pos,
      });
      return true;
    }
  }

  markIncomplete(state);
  return true;
}

function scanBackslashMath(state) {
  const { text, i } = state;
  if (text[i] !== '\\' || i + 1 >= text.length) {
    return false;
  }

  const next = text[i + 1];
  if (next !== '(' && next !== '[') {
    state.i += 2;
    return true;
  }

  const closeSeq = next === '(' ? '\\)' : '\\]';
  const closeIdx = text.indexOf(closeSeq, i + 2);
  if (closeIdx === -1) {
    markIncomplete(state);
    return true;
  }

  const tex = text.slice(i + 2, closeIdx);
  if (!tex.trim()) {
    state.i = closeIdx + closeSeq.length;
    return true;
  }

  pushMathToken(state, {
    type: 'math',
    display: next === '[',
    tex,
    rawStart: i,
    rawEnd: closeIdx + closeSeq.length,
  });
  return true;
}

function scanDollarMath(state) {
  const { text, i } = state;
  if (text[i] !== '$' || isBackslashEscaped(text, i)) {
    return false;
  }

  const display = text[i + 1] === '$';
  const delim = display ? '$$' : '$';
  const closeIdx = findClosingDelimiter(text, i + delim.length, delim, display);
  if (closeIdx === -1) {
    markIncomplete(state);
    return true;
  }

  const tex = text.slice(i + delim.length, closeIdx);
  if (!tex.trim()) {
    state.i = closeIdx + delim.length;
    return true;
  }

  if (!display && !looksLikeInlineMath(text, i, closeIdx, tex)) {
    state.i = i + 1;
    return true;
  }

  pushMathToken(state, {
    type: 'math',
    display,
    tex,
    rawStart: i,
    rawEnd: closeIdx + delim.length,
  });
  return true;
}

// Heuristics to reject false-positive inline math spans. Each rule below
// targets a specific real-world confusion:
//
//   1. Opening `$` followed by whitespace → trailing "$" in prose.
//   2. Closing `$` preceded by whitespace → same shape, flipped.
//   3. Opening `$` glued to a preceding word char → `a$b` is not math.
//   4. Closing `$` glued to a following digit → avoids welding "$5 and $6".
//   5. Content spans a blank line → real inline math never does.
//   6. Content contains a backtick → code-reference runs like "$HOME
//      and `foo`" are the classic shell-variable false positive.
function looksLikeInlineMath(text, openIdx, closeIdx, tex) {
  const afterOpen = text[openIdx + 1];
  if (afterOpen === undefined || /\s/.test(afterOpen)) return false;

  const beforeClose = text[closeIdx - 1];
  if (beforeClose === undefined || /\s/.test(beforeClose)) return false;

  const beforeOpen = text[openIdx - 1];
  if (beforeOpen !== undefined && /[A-Za-z0-9]/.test(beforeOpen)) return false;

  const afterClose = text[closeIdx + 1];
  if (afterClose !== undefined && /[0-9]/.test(afterClose)) return false;

  if (/\n\s*\n/.test(tex)) return false;
  if (tex.indexOf('`') !== -1) return false;

  return true;
}

function pushMathToken(state, token) {
  flushTextToken(state, token.rawStart);
  state.tokens.push(token);
  state.textStart = token.rawEnd;
  state.i = token.rawEnd;
}

function markIncomplete(state) {
  state.complete = false;
  state.i = state.text.length;
}

function flushTextToken(state, end) {
  if (end <= state.textStart) {
    return;
  }

  state.tokens.push({
    type: 'text',
    value: state.text.slice(state.textStart, end),
    start: state.textStart,
    end,
  });
}

function isBackslashEscaped(text, pos) {
  let count = 0;
  let idx = pos - 1;
  while (idx >= 0 && text[idx] === '\\') {
    count += 1;
    idx -= 1;
  }
  return (count & 1) === 1;
}

function findClosingDelimiter(text, start, delim, display) {
  let searchFrom = start;
  while (searchFrom < text.length) {
    const idx = text.indexOf(delim, searchFrom);
    if (idx === -1) {
      return -1;
    }
    if (isBackslashEscaped(text, idx)) {
      searchFrom = idx + 1;
      continue;
    }
    if (!display && text[idx + 1] === '$') {
      searchFrom = idx + 2;
      continue;
    }
    return idx;
  }
  return -1;
}

function encodeTex(tex) {
  return bytesToHex(encoder.encode(tex));
}

function decodeTex(hex) {
  return decoder.decode(hexToBytes(hex));
}

function bytesToHex(bytes) {
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0').toUpperCase();
  }
  return hex;
}

function hexToBytes(hex) {
  if ((hex.length & 1) === 1 || !HEX_RE.test(hex)) {
    throw new Error('Invalid math placeholder hex payload');
  }

  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function generateRuntimeToken() {
  try {
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      const bytes = new Uint8Array(4);
      crypto.getRandomValues(bytes);
      let hex = '';
      for (const byte of bytes) {
        hex += byte.toString(16).padStart(2, '0').toUpperCase();
      }
      return hex;
    }
  } catch {
    /* fall through */
  }
  let token = '';
  for (let i = 0; i < 8; i += 1) {
    token += Math.floor(Math.random() * 16).toString(16).toUpperCase();
  }
  return token;
}
