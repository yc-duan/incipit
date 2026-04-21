import { preprocessMarkdownMath } from './math_tokens.js';
import { ATTR, SEL, closestByAttr, startHostProbe } from './host_probe.js';
import { renderMathInSegment as rewriteMathInSegment } from './math_rewriter.js';

/**
 * Webview enhancement script for the patched Claude Code UI.
 *
 * Loads local assets, rewrites math, applies typography styles, manages
 * thinking state, and injects small UI helpers such as copy buttons and the
 * cache badge.
 *
 * Math gating: the old host-class blocklist is gone. `preprocessMarkdownMath`
 * is only ever called from the patched `react-markdown` handoff, which
 * Claude Code uses exclusively for assistant messages. User bubbles bypass
 * it entirely, so their DOM text never receives the placeholder token and
 * `math_rewriter` leaves them alone. The only DOM-level protection left is
 * against mutating live `contenteditable` subtrees, which would corrupt the
 * chat input.
 */

(() => {
  'use strict';

  window.__CLAUDE_ENHANCE_PREPROCESS_MARKDOWN__ = preprocessMarkdownMath;

  // ========== 0. dom api freeze ==========
  //
  // Capture the native DOM mutation methods before React runs and block
  // writes to `open` on frozen thinking `<details>` elements.
  // The thinking subsystem toggles those nodes through `NATIVE_SET` and
  // `NATIVE_REMOVE`, so React reconciliation cannot close them again.

  const NATIVE_SET = Element.prototype.setAttribute;
  const NATIVE_REMOVE = Element.prototype.removeAttribute;
  const NATIVE_TOGGLE = Element.prototype.toggleAttribute;

  Element.prototype.setAttribute = function(name, value) {
    if (name === 'open' && this.__claudeFrozen) return;
    return NATIVE_SET.call(this, name, value);
  };
  Element.prototype.removeAttribute = function(name) {
    if (name === 'open' && this.__claudeFrozen) return;
    return NATIVE_REMOVE.call(this, name);
  };
  Element.prototype.toggleAttribute = function(name, force) {
    if (name === 'open' && this.__claudeFrozen) return this.hasAttribute('open');
    return NATIVE_TOGGLE.call(this, name, force);
  };

  // Also intercept the IDL setter: `details.open = true/false`.
  if (typeof HTMLDetailsElement !== 'undefined') {
    const desc = Object.getOwnPropertyDescriptor(HTMLDetailsElement.prototype, 'open');
    if (desc && desc.set) {
      const NATIVE_OPEN_SET = desc.set;
      Object.defineProperty(HTMLDetailsElement.prototype, 'open', {
        configurable: true,
        get: desc.get,
        set: function(value) {
          if (this.__claudeFrozen) return;
          NATIVE_OPEN_SET.call(this, value);
        },
      });
    }
  }

  // ========== 1. utils ==========

  const DEBUG = (() => {
    try { return localStorage.getItem('claudeEnhanceDebug') === '1'; } catch { return false; }
  })();

  const log  = (...a) => console.log('[Claude Enhance]', ...a);
  const warn = (...a) => console.warn('[Claude Enhance]', ...a);
  const dbg  = (...a) => { if (DEBUG) console.log('[Claude Enhance:dbg]', ...a); };

  // 32-bit FNV-1a with no dependencies.
  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(36);
  }

  function pageNonce() {
    const el = document.querySelector('script[nonce]');
    return el ? (el.nonce || el.getAttribute('nonce') || '') : '';
  }

  // Resolve the script URL into a base path for sibling assets.
  // `import.meta.url` is preferred, with `document.currentScript` as fallback.
  const BASE_URL = (() => {
    try {
      // Loaded as an ES module through `webview/index.js`.
      // eslint-disable-next-line
      return new URL('./', import.meta.url);
    } catch {
      const s = document.currentScript;
      if (s && s.src) return new URL('./', s.src);
      return new URL('./', location.href);
    }
  })();

  const assetURL = (rel) => new URL(rel, BASE_URL).href;

  // ========== 2. asset-loader ==========

  const assets = (() => {
    let katexPromise = null;
    let hljsPromise = null;

    function loadCSS(href) {
      return new Promise((resolve, reject) => {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        link.onload = () => resolve();
        link.onerror = () => reject(new Error('CSS load failed: ' + href));
        document.head.appendChild(link);
      });
    }

    function loadJS(src) {
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

    return {
      katex() {
        if (!katexPromise) {
          katexPromise = Promise.all([
            loadCSS(assetURL('katex/katex.min.css')),
            loadJS(assetURL('katex/katex.min.js')),
          ]).then(() => {
            if (typeof window.katex === 'undefined') {
              throw new Error('KaTeX loaded but window.katex missing');
            }
            log('KaTeX ready');
          }).catch(e => { warn('KaTeX load failed:', e); throw e; });
        }
        return katexPromise;
      },
      hljs() {
        if (!hljsPromise) {
          hljsPromise = Promise.all([
            loadCSS(assetURL('hljs/styles/vs2015.min.css')),
            loadJS(assetURL('hljs/highlight.min.js')),
          ]).then(() => {
            if (typeof window.hljs === 'undefined') {
              throw new Error('hljs loaded but window.hljs missing');
            }
            log('highlight.js ready');
          }).catch(e => { warn('hljs load failed:', e); throw e; });
        }
        return hljsPromise;
      },
    };
  })();

  function isKatexReady() {
    return typeof window.katex !== 'undefined';
  }

  // ========== 3. math-rewriter ==========

  // Apply narrow TeX fixes only for cases that are known to break rendering.
  //
  // 1. Display mode: normalise matrix and alignment newlines into `\\\n`.
  // 2. `demoteLeftRightAroundBraces`: when a token contains `\underbrace`
  //    or `\overbrace`, strip every `\left` / `\right` modifier from its
  //    delimiters. KaTeX's auto-sizing reads the max depth of enclosed
  //    content to pick a delimiter size, and a brace label inflates that
  //    depth enough to jump straight to `delim-size4` (absurdly large
  //    parens around a short formula). The classic `\smash[b]{}` trick
  //    works in real LaTeX but KaTeX's implementation crops the smashed
  //    depth visually, taking the label with it. Removing `\left\right`
  //    drops us back to the literal delimiter characters at their natural
  //    size — which is exactly what classical TeX typesetting (and the
  //    Google AI Studio reference rendering) does for a labelled-brace
  //    expression. For expressions with genuinely tall content that need
  //    auto-sized delimiters, the label-brace shape is rare enough in
  //    long-form prose that the trade-off is net positive.
  function fixTeX(tex, display) {
    let fixed = demoteLeftRightAroundBraces(tex);
    if (display) {
      fixed = fixed.replace(/([^\\])\\\s*\n/g, '$1\\\\\n');
    }
    return fixed;
  }

  // Only the common delimiter pairs are handled. `\left.` (invisible) is
  // intentionally left alone because replacing it with a literal `.` would
  // introduce a visible dot; any expression that opens with `\left.` is
  // outside the "labelled brace in prose" scenario this fix targets.
  const LEFT_RIGHT_SUBSTITUTIONS = [
    [/\\left\(/g, '('],
    [/\\right\)/g, ')'],
    [/\\left\[/g, '['],
    [/\\right\]/g, ']'],
    [/\\left\\\{/g, '\\{'],
    [/\\right\\\}/g, '\\}'],
    [/\\left\|/g, '|'],
    [/\\right\|/g, '|'],
    [/\\left\\lvert\b/g, '\\lvert'],
    [/\\right\\rvert\b/g, '\\rvert'],
    [/\\left\\langle\b/g, '\\langle'],
    [/\\right\\rangle\b/g, '\\rangle'],
  ];

  function demoteLeftRightAroundBraces(tex) {
    if (typeof tex !== 'string' || tex.length === 0) return tex;
    if (tex.indexOf('\\underbrace') === -1 && tex.indexOf('\\overbrace') === -1) {
      return tex;
    }
    let fixed = tex;
    for (const [pattern, replacement] of LEFT_RIGHT_SUBSTITUTIONS) {
      fixed = fixed.replace(pattern, replacement);
    }
    return fixed;
  }

  const ENV_TEX_PROBE_RE = /\\begin\{[A-Za-z]+\*?\}/;

  function renderTokenToNode(tok) {
    const node = document.createElement(tok.display ? 'div' : 'span');
    node.setAttribute('data-tex-source', tok.tex);
    node.setAttribute('data-tex-display', tok.display ? '1' : '0');
    // Tex containing a LaTeX environment (matrix/align/cases/...) is marked
    // so theme.css can pin its font-size to body scale. Without this an
    // inline env embedded in a heading inherits heading em scaling, which
    // compounds with KaTeX's own 1.21× factor and balloons the 2D delimiter
    // layout visually. Detection is content-based so env math picked up via
    // bare `\begin..\end`, `$..$`, or `$$..$$` all receive the same treatment.
    if (ENV_TEX_PROBE_RE.test(tok.tex)) {
      node.setAttribute('data-tex-kind', 'env');
    }
    node.className = 'claude-math';
    try {
      node.innerHTML = window.katex.renderToString(
        fixTeX(tok.tex, tok.display),
        {
          displayMode: tok.display,
          throwOnError: false,
          strict: 'ignore',
          output: 'html',
          trust: false,
        },
      );
    } catch (e) {
      warn('KaTeX render error:', (e && e.message) || e, 'tex:', tok.tex);
      node.setAttribute('data-render-error', (e && e.message) || 'unknown');
      node.textContent =
        (tok.display ? '$$' : '$') + tok.tex + (tok.display ? '$$' : '$');
    }
    return node;
  }

  function renderMathInSegment(segment) {
    if (!isKatexReady()) {
      return { complete: false, mutated: false };
    }
    try {
      return rewriteMathInSegment(segment, renderTokenToNode);
    } catch (e) {
      warn('renderMathInSegment failed:', e);
      return { complete: true, mutated: false };
    }
  }

  // ========== 4b. CJK ↔ ASCII punctuation spacing ==========
  //
  // Some Chromium and Electron builds do not apply `text-autospace`
  // consistently. This walker wraps ASCII punctuation that touches CJK text
  // in `<span class="claude-punc">` so CSS can add spacing.
  //
  // The wrapped span still contains the original punctuation character, so
  // `textContent` stays unchanged. Existing `.claude-punc` nodes are skipped.
  const CJK_RANGE_RE = /[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f]/;
  // Limit the set to punctuation that commonly needs spacing next to CJK.
  // Exclude `-`, `_`, quotes, and `/` to avoid noisy false positives.
  const PUNCT_CHARS = new Set([',', '.', ':', ';', '!', '?', '(', ')']);
  const PUNCT_SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'CODE', 'PRE', 'TEXTAREA', 'INPUT', 'BUTTON',
    'SVG', 'MATH',
  ]);

  function shouldSkipPunctSubtree(el) {
    if (!el || el.nodeType !== 1) return true;
    if (PUNCT_SKIP_TAGS.has(el.tagName)) return true;
    // Skip contenteditable subtrees as a second line of defense.
    if (el.isContentEditable) return true;
    if (el.classList) {
      if (el.classList.contains('katex')) return true;
      if (el.classList.contains('claude-math')) return true;
      if (el.classList.contains('claude-punc')) return true;
      if (el.classList.contains('claude-user-copy-btn')) return true;
      if (el.classList.contains('claude-user-copy-btn-row')) return true;
      if (el.classList.contains('claude-show-more-row')) return true;
      if (el.classList.contains('claude-show-more-btn')) return true;
    }
    if (el.hasAttribute && el.hasAttribute('data-tex-source')) return true;
    return false;
  }

  function findPunctBoundaries(text) {
    const boundaries = [];
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (!PUNCT_CHARS.has(ch)) continue;
      const prev = i > 0 ? text[i - 1] : '';
      const next = i < text.length - 1 ? text[i + 1] : '';
      // Only touch punctuation that borders at least one CJK character.
      if (CJK_RANGE_RE.test(prev) || CJK_RANGE_RE.test(next)) {
        boundaries.push(i);
      }
    }
    return boundaries;
  }

  function splitTextNodeForPunct(textNode) {
    const value = textNode.nodeValue || '';
    const boundaries = findPunctBoundaries(value);
    if (boundaries.length === 0) return false;

    const parent = textNode.parentNode;
    if (!parent) return false;

    // Do not replace the original text node. React may still hold references
    // to it for later incremental updates. Shrink the original node in place
    // and insert the new nodes beside it instead.
    const firstBoundary = boundaries[0];
    const prefix = value.slice(0, firstBoundary);
    const anchor = textNode.nextSibling; // May be `null`, which means append.

    // Build all replacement nodes before mutating the DOM.
    const toInsert = [];
    for (let i = 0; i < boundaries.length; i += 1) {
      const idx = boundaries[i];
      const span = document.createElement('span');
      span.className = 'claude-punc';
      span.textContent = value[idx];
      toInsert.push(span);

      const sliceStart = idx + 1;
      const sliceEnd = i + 1 < boundaries.length ? boundaries[i + 1] : value.length;
      if (sliceEnd > sliceStart) {
        toInsert.push(document.createTextNode(value.slice(sliceStart, sliceEnd)));
      }
    }

    // Shorten the original text node only after the replacement nodes exist.
    textNode.nodeValue = prefix;

    for (const node of toInsert) {
      parent.insertBefore(node, anchor);
    }
    return true;
  }

  function padCjkPunctInSegment(segment) {
    if (!segment || !segment.isConnected) return false;
    // Recheck contenteditable state even though `closestSegment` already gates it.
    if (segment.isContentEditable) return false;
    // Collect candidates first, then mutate. Editing during traversal would
    // destabilize the walk.
    const candidates = [];
    const stack = [segment];
    while (stack.length) {
      const node = stack.pop();
      if (node.nodeType === 3) {
        const v = node.nodeValue || '';
        if (v.length >= 2 && CJK_RANGE_RE.test(v)) {
          candidates.push(node);
        }
        continue;
      }
      if (node.nodeType !== 1) continue;
      if (node !== segment && shouldSkipPunctSubtree(node)) continue;
      for (const child of node.childNodes) stack.push(child);
    }
    let mutated = false;
    for (const textNode of candidates) {
      if (!textNode.isConnected) continue;
      if (splitTextNodeForPunct(textNode)) mutated = true;
    }
    return mutated;
  }

  // ========== 5. segment-processor ==========

  const SEG_VERSION_ATTR = 'data-math-rendered';
  const SEG_HASH_ATTR    = 'data-math-hash';
  const SEG_VERSION      = 'v18';
  const SEG_SELECTOR     = 'p, li, td, th, blockquote, h1, h2, h3, h4, h5, h6, dd, dt';
  // Never use structural containers as fallback segments.
  // Doing so would let `linearizeSegment` stitch text across child blocks and
  // produce invalid DOM when a math span is inserted.
  const FALLBACK_BLOCKED_TAGS = new Set([
    'UL', 'OL', 'DL', 'MENU',
    'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'COLGROUP',
    'PICTURE', 'FIGURE',
  ]);

  // Fingerprint the segment using plain text plus `data-tex-source` placeholders.
  function segmentHash(segment) {
    const parts = [];
    const collect = (node) => {
      if (node.nodeType === 3) {
        parts.push(node.nodeValue);
        return;
      }
      if (node.nodeType !== 1) return;
      // Already-rendered math contributes its source token.
      if (node.hasAttribute && node.hasAttribute('data-tex-source')) {
        parts.push('\x01M');
        parts.push(node.getAttribute('data-tex-display') === '1' ? 'D' : 'I');
        parts.push(':');
        parts.push(node.getAttribute('data-tex-source'));
        parts.push('\x01');
        return; // Skip the subtree.
      }
      // KaTeX's `<span class="katex">` should already be wrapped by
      // our `data-tex-source` attribute. This fallback only fires for
      // stray KaTeX output without the wrapper — read its TeX source
      // annotation for a stable hash key and stop descending.
      if (node.classList && node.classList.contains('katex')) {
        const annot = node.querySelector && node.querySelector('annotation[encoding="application/x-tex"]');
        parts.push('\x01K:' + (annot ? annot.textContent : '') + '\x01');
        return;
      }
      // Ignore UI elements injected by this script.
      if (node.classList && (
            node.classList.contains('claude-user-copy-btn') ||
            node.classList.contains('claude-user-copy-btn-row') ||
            node.classList.contains('claude-show-more-row') ||
            node.classList.contains('claude-show-more-btn')
          )) return;
      for (const child of node.childNodes) collect(child);
    };
    for (const child of segment.childNodes) collect(child);
    return fnv1a(parts.join(''));
  }

  function processSegment(segment) {
    if (!isKatexReady()) return; // Wait for KaTeX.
    if (!segment.isConnected) return;
    // A queued segment may later move into a contenteditable subtree.
    // Bail out immediately in that case and leave the DOM untouched.
    if (segment.isContentEditable) return;
    if (segment.closest && segment.closest('[contenteditable="true"]')) return;

    const curHash = segmentHash(segment);
    if (segment.getAttribute(SEG_VERSION_ATTR) === SEG_VERSION &&
        segment.getAttribute(SEG_HASH_ATTR) === curHash) {
      return; // Cache hit. Leave the DOM untouched.
    }

    const renderResult = renderMathInSegment(segment);
    if (!renderResult.complete) return;

    // Apply CJK punctuation spacing only after math rendering.
    // Math nodes are skipped by class, and running punctuation first would
    // distort token offsets inside math source text.
    padCjkPunctInSegment(segment);

    segment.setAttribute(SEG_VERSION_ATTR, SEG_VERSION);
    segment.setAttribute(SEG_HASH_ATTR, segmentHash(segment));
  }

  // ========== 6. observer / scheduler ==========

  const pendingSegments = new Set();
  let rafId = null;

  function closestSegment(node) {
    let el = node;
    if (el && el.nodeType !== 1) el = el.parentElement;
    if (!el) return null;
    // Never touch contenteditable subtrees. The chat input contains real
    // `<p>` nodes that match `SEG_SELECTOR`, and mutating them would
    // desynchronize the editor model from the DOM.
    if (el.isContentEditable) return null;
    // First try the strict `SEG_SELECTOR`.
    let cur = el;
    while (cur && cur !== document.body) {
      if (cur.matches && cur.matches(SEG_SELECTOR)) return cur;
      cur = cur.parentElement;
    }
    // Fallback to the direct parent element when a strict segment is missing,
    // such as display math rendered inside a bare `<div>`.
    // Reject root containers and structural blocks so math ranges cannot span
    // across list items, table rows, or similar child blocks.
    if (el === document.body || el === document.documentElement) return null;
    if (FALLBACK_BLOCKED_TAGS.has(el.tagName)) return null;
    return el;
  }

  function enqueueNode(node) {
    if (!node) return;
    if (node.nodeType === 1) {
      const cls = (typeof node.className === 'string' ? node.className : '') || '';
      if (cls.indexOf('katex') !== -1 ||
          cls.indexOf('hljs') !== -1 ||
          cls.indexOf('claude-user-copy-btn') !== -1 ||
          cls.indexOf('claude-show-more') !== -1 ||
          cls.indexOf('claude-math') !== -1 ||
          cls.indexOf('claude-punc') !== -1) {
        return;
      }
      // Skip any subtree rooted inside a contenteditable editor.
      if (node.isContentEditable) return;
      const seg = closestSegment(node);
      if (seg) pendingSegments.add(seg);
      if (node.querySelectorAll) {
        for (const s of node.querySelectorAll(SEG_SELECTOR)) {
          if (s.isContentEditable) continue;
          pendingSegments.add(s);
        }
      }
    } else if (node.nodeType === 3) {
      const seg = closestSegment(node);
      if (seg) pendingSegments.add(seg);
    }
  }

  function schedule() {
    if (rafId !== null) return;
    rafId = requestAnimationFrame(flush);
  }

  function flush() {
    rafId = null;
    // Consume the math queue only after `KaTeX` is ready.
    if (isKatexReady() && pendingSegments.size) {
      const segs = Array.from(pendingSegments);
      pendingSegments.clear();
      for (const seg of segs) {
        if (!seg.isConnected) continue;
        try { processSegment(seg); }
        catch (e) { warn('processSegment failed:', e); }
      }
    }
    // Code highlighting.
    if (typeof window.hljs !== 'undefined') {
      try { highlightAllCode(); } catch (e) { warn('highlight failed:', e); }
    }
    // Copy-button injection.
    try { scanAndAddCopyButtons(); } catch (e) { warn('copy-btn failed:', e); }
  }

  function handleMutations(mutations) {
    let dirty = false;
    for (const m of mutations) {
      if (m.type === 'characterData') {
        const seg = closestSegment(m.target);
        if (seg) { pendingSegments.add(seg); dirty = true; }
      } else if (m.type === 'childList') {
        for (const node of m.addedNodes) { enqueueNode(node); }
        // Ignore removed nodes because they are already gone.
        if (m.addedNodes.length) dirty = true;
      }
    }
    if (dirty || pendingSegments.size) schedule();
  }

  // Chromium bug workaround: a MutationObserver with `characterData: true`
  // observing `document.body` disables the IME paint optimization for the
  // contenteditable chat input. Every composition buffer update must
  // generate a mutation record, which forces composition text through the
  // regular paint path — but that path leaves the previous composition
  // frame's pixels behind, accumulating as phantom glyphs (especially when
  // narrow Latin punctuation like `,` `.` precedes wide CJK characters).
  //
  // Fix: scope the content observer to the messages container. The chat
  // input lives in `inputContainer` which is a sibling, not a descendant,
  // so the editor subtree is completely excluded from characterData
  // observation and the paint optimization stays on.
  const MESSAGES_ROOT_SELECTOR = '[class*="messagesContainer_"]';

  function setupObserver() {
    let contentObs = null;
    let attachedRoot = null;

    function attachContent(root) {
      if (!root || root === attachedRoot) return;
      if (contentObs) contentObs.disconnect();
      attachedRoot = root;
      contentObs = new MutationObserver(handleMutations);
      contentObs.observe(root, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      for (const s of root.querySelectorAll(SEG_SELECTOR)) {
        if (!s.isContentEditable) pendingSegments.add(s);
      }
      schedule();
    }

    const initial = document.querySelector(MESSAGES_ROOT_SELECTOR);
    if (initial) attachContent(initial);

    // Lightweight finder: childList-only on body, so it does NOT affect the
    // editor's IME paint. Its job is to pick up messagesContainer when React
    // mounts or remounts it, and hand it off to the content observer.
    const finder = new MutationObserver(() => {
      const root = document.querySelector(MESSAGES_ROOT_SELECTOR);
      if (root && root !== attachedRoot) attachContent(root);
    });
    finder.observe(document.body, { childList: true, subtree: true });

    enqueueInitialSegments();
    schedule();
  }

  // Initial scan:
  //   1. enqueue every element matched by `SEG_SELECTOR`
  //   2. walk text nodes containing `$` or `\` and use `closestSegment`
  //      as a fallback
  function enqueueInitialSegments() {
    for (const s of document.querySelectorAll(SEG_SELECTOR)) {
      // `querySelectorAll` bypasses `closestSegment`, so filter editor nodes
      // explicitly here.
      if (s.isContentEditable) continue;
      pendingSegments.add(s);
    }

    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const v = node.nodeValue;
          if (!v || v.length < 2) return NodeFilter.FILTER_REJECT;
          // The render path only cares about placeholders, not raw `$` or
          // backslash text. Skipping pages without the placeholder prefix
          // keeps the walker from touching unrelated chrome text.
          if (v.indexOf('CCREMATH') === -1) return NodeFilter.FILTER_REJECT;
          // Skip text inside scripts, styles, and code blocks.
          let p = node.parentNode;
          while (p && p.nodeType === 1) {
            const tag = p.tagName;
            if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'CODE' || tag === 'PRE') {
              return NodeFilter.FILTER_REJECT;
            }
            p = p.parentNode;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      }
    );
    let tn;
    while ((tn = walker.nextNode())) {
      const seg = closestSegment(tn);
      if (seg) pendingSegments.add(seg);
    }
  }

  // ========== 7. code-highlight ==========

  function highlightAllCode() {
    if (typeof window.hljs === 'undefined') return;
    const blocks = document.querySelectorAll('pre code:not(.hljs)');
    for (const block of blocks) {
      if (block.classList.contains('language-latex')) continue;
      try { window.hljs.highlightElement(block); } catch (e) { /* ignore */ }
    }
  }

  // ========== 8. user-copy ==========
  //
  // Only user message bubbles get a copy button. Assistant replies and tool
  // output are intentionally left alone because reconstructing source text
  // from their DOM is much less reliable.
  //
  // The button lives in a transparent sibling row on the host container so
  // bubble padding stays compact.

  // Outline SVG icons that inherit `currentColor`.
  const COPY_ICON_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>' +
    '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>' +
    '</svg>';
  const CHECK_ICON_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<polyline points="20 6 9 17 4 12"/>' +
    '</svg>';

  function flashCopied(btn) {
    btn.innerHTML = CHECK_ICON_SVG;
    btn.classList.add('copied');
    setTimeout(() => {
      btn.innerHTML = COPY_ICON_SVG;
      btn.classList.remove('copied');
    }, 1200);
  }

  async function copyText(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      flashCopied(btn);
    } catch (err) {
      warn('Copy failed:', err);
    }
  }

  // Prefer `[class*="content_"]` text. Fall back to the bubble text with
  // attachments and injected controls removed.
  function userBubbleText(bubbleEl) {
    const content = bubbleEl.querySelector(SEL.userContent);
    if (content) return content.textContent || '';
    const clone = bubbleEl.cloneNode(true);
    clone.querySelectorAll(
      `${SEL.userAttachments}, .claude-user-copy-btn, .claude-user-copy-btn-row`
    ).forEach(n => n.remove());
    return clone.textContent || '';
  }

  // Walk upward to the outer `userMessageContainer`, which hosts the sibling row.
  function findUserMessageHost(bubbleEl) {
    return closestByAttr(bubbleEl, ATTR.userMessageContainer);
  }

  function addUserCopyButton(bubbleEl) {
    const host = findUserMessageHost(bubbleEl);
    if (!host) return;
    if (host.querySelector(':scope > .claude-user-copy-btn-row')) return;
    const row = document.createElement('div');
    row.className = 'claude-user-copy-btn-row';
    const btn = document.createElement('button');
    btn.className = 'claude-user-copy-btn';
    btn.type = 'button';
    btn.innerHTML = COPY_ICON_SVG;
    btn.title = '复制我的消息';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      copyText(userBubbleText(bubbleEl).trim(), btn);
    });
    row.appendChild(btn);
    host.appendChild(row);
  }

  // ---- custom show-more handling ----
  //
  // Measure the bubble, classify it as `short` or `long`, and replace the
  // host truncation UI with a custom show-more row when needed.
  const LONG_THRESHOLD_PX = 600;

  function addShowMoreRow(bubble) {
    if (bubble.querySelector(':scope > .claude-show-more-row')) return;
    const row = document.createElement('div');
    row.className = 'claude-show-more-row';
    const btn = document.createElement('button');
    btn.className = 'claude-show-more-btn';
    btn.type = 'button';
    btn.textContent = 'Show more';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const expanded = bubble.getAttribute('data-claude-expanded') === '1';
      if (expanded) {
        bubble.removeAttribute('data-claude-expanded');
        btn.textContent = 'Show more';
      } else {
        bubble.setAttribute('data-claude-expanded', '1');
        btn.textContent = 'Show less';
      }
    });
    row.appendChild(btn);
    bubble.appendChild(row);
  }

  function classifyUserBubble(bubble) {
    const existing = bubble.getAttribute('data-claude-length');
    if (existing === 'short' || existing === 'long') return;
    const content = bubble.querySelector(SEL.userContent);
    if (!content) return;
    // Temporarily remove clipping to measure the natural height.
    bubble.setAttribute('data-claude-length', 'measuring');
    const h = content.scrollHeight;
    if (h === 0) {
      // Layout is not ready yet. Clear the marker and retry on the next scan.
      bubble.removeAttribute('data-claude-length');
      return;
    }
    if (h <= LONG_THRESHOLD_PX) {
      bubble.setAttribute('data-claude-length', 'short');
    } else {
      bubble.setAttribute('data-claude-length', 'long');
      addShowMoreRow(bubble);
    }
  }

  function scanAndAddCopyButtons() {
    const userBubbles = document.querySelectorAll(
      SEL.userBubble
    );
    for (const bubble of userBubbles) {
      // Interrupted messages are not real user input.
      if (bubble.querySelector(SEL.interruptedMessage)) continue;
      addUserCopyButton(bubble);
      classifyUserBubble(bubble);
    }
  }

  // ========== 8b. permission indicator softening ==========
  //
  // Class names for bypass and danger indicators vary across versions.
  // Text scanning provides a fallback by tagging small leaf nodes whose text
  // contains bypass or danger markers.
  const DANGER_TEXT_RE = /\b(bypass\s+permissions?|yolo\s*mode|dangerous(?:ly)?)\b/i;

  // Shared accent color for softened danger indicators.
  const CLAUDE_CORAL = '#d97757';
  const CLAUDE_CORAL_BG = 'rgba(217,119,87,0.10)';
  const CLAUDE_CORAL_BORDER = 'rgba(217,119,87,0.45)';

  function applyCoralStyle(el) {
    // Change only foreground-related properties. Some containers carry danger
    // classes on large surfaces and should keep their background fill.
    el.style.setProperty('color', CLAUDE_CORAL, 'important');
    el.style.setProperty('border-color', CLAUDE_CORAL_BORDER, 'important');
    el.style.setProperty('fill', CLAUDE_CORAL, 'important');
  }

  let _lastSoftenAt = 0;
  function softenDangerIndicators() {
    // Throttle to 1.2s.
    const now = performance.now();
    if (now - _lastSoftenAt < 1200) return;
    _lastSoftenAt = now;

    // 1) direct class-based matches
    const classSelectors = [
      '[class*="bypassPermission" i]',
      '[class*="bypass-permission" i]',
      '[class*="permissionMode" i]',
      '[class*="permission-mode" i]',
      '[class*="dangerMode" i]',
      '[class*="yoloMode" i]',
      '[class*="dangerous" i]',
    ];
    for (const sel of classSelectors) {
      try {
        for (const el of document.querySelectorAll(sel)) {
          if (el.hasAttribute('data-claude-softened')) continue;
          el.setAttribute('data-claude-softened', '1');
          applyCoralStyle(el);
        }
      } catch { /* invalid selector on old chromium */ }
    }

    // 2) text-scan fallback, narrowly scoped to the chrome surfaces where
    //    bypass / danger indicators actually live (footer and header regions).
    //    The previous version scanned every `div,span,button,a,li` in the
    //    document, which was O(DOM) on every call.
    const scopes = [];
    for (const s of document.querySelectorAll(SEL.inputFooter)) scopes.push(s);
    for (const s of document.querySelectorAll(SEL.stickyMessage)) scopes.push(s);
    for (const scope of scopes) {
      const candidates = scope.querySelectorAll('div, span, button, a, li');
      for (const el of candidates) {
        if (el.hasAttribute('data-claude-softened')) continue;
        if (el.children.length > 5) continue;
        const text = (el.textContent || '').trim();
        if (text.length === 0 || text.length > 80) continue;
        if (DANGER_TEXT_RE.test(text)) {
          el.setAttribute('data-claude-softened', '1');
          applyCoralStyle(el);
        }
      }
    }
  }

  // ========== 9. styles ==========

  function injectStyles() {
    // Load `theme.css` as a standalone stylesheet instead of embedding it in a
    // JS template string. This avoids escaping pitfalls from CSS comments,
    // backticks, and `${...}` sequences.
    if (document.getElementById('claude-enhance-styles-link')) return;
    const link = document.createElement('link');
    link.id = 'claude-enhance-styles-link';
    link.rel = 'stylesheet';
    link.href = assetURL('theme.css');
    document.head.appendChild(link);
  }

  // ========== 10. VS Code CSS variable overrides ==========
  //
  // VS Code writes `--vscode-*` variables into inline styles on `<html>`.
  // Override the derived app variables through `setProperty(..., 'important')`
  // and reapply them whenever the host rewrites the inline style.
  const SOFT_BG = '#1f1f1e';
  const SOFT_FG = '#f8f8f6';
  const SOFT_FG_2 = '#bcbcb9';   // Secondary text.

  const APP_VAR_OVERRIDES = {
    // Background layer.
    '--app-background': SOFT_BG,
    '--app-primary-background': SOFT_BG,
    '--app-root-background': SOFT_BG,
    '--app-secondary-background': SOFT_BG,
    '--app-tool-background': SOFT_BG,
    '--app-header-background': SOFT_BG,
    '--app-input-background': SOFT_BG,
    '--app-input-secondary-background': SOFT_BG,
    '--app-menu-background': SOFT_BG,
    // Foreground layer.
    '--app-primary-foreground': SOFT_FG,
    '--app-input-foreground': SOFT_FG,
    '--app-input-secondary-foreground': SOFT_FG,
    '--app-menu-foreground': SOFT_FG,
    '--app-secondary-foreground': SOFT_FG_2,
    '--app-secondary-text': SOFT_FG_2,
    // Monospace fallback.
    // `Rec Mono Linear` needs explicit `font-variation-settings`, so this
    // variable stays on a system monospace stack for any unmatched host node.
    '--app-monospace-font-family': "Consolas, 'Courier New', monospace",
  };

  let _vsVarObserver = null;
  let _vsVarApplyScheduled = false;
  let _vsVarSelfWriting = false;

  function applyAppVarOverrides() {
    // A reentry flag is cheaper than disconnect/reconnect on every apply.
    // The observer callback ignores mutations that arrive while this flag
    // is set, so the observer never has to be torn down mid-apply.
    _vsVarSelfWriting = true;
    try {
      const html = document.documentElement;
      for (const [k, v] of Object.entries(APP_VAR_OVERRIDES)) {
        html.style.setProperty(k, v, 'important');
      }
      const body = document.body;
      if (body) {
        for (const [k, v] of Object.entries(APP_VAR_OVERRIDES)) {
          body.style.setProperty(k, v, 'important');
        }
      }
    } finally {
      _vsVarSelfWriting = false;
    }
  }

  function scheduleApplyAppVarOverrides() {
    if (_vsVarApplyScheduled) return;
    _vsVarApplyScheduled = true;
    requestAnimationFrame(() => {
      _vsVarApplyScheduled = false;
      applyAppVarOverrides();
    });
  }

  function setupAppVarObserver() {
    _vsVarObserver = new MutationObserver(() => {
      if (_vsVarSelfWriting) return;
      scheduleApplyAppVarOverrides();
    });
    _vsVarObserver.observe(document.documentElement, {
      attributes: true, attributeFilter: ['style'],
    });
  }

  // ========== 11. thinking ==========
  //
  // The host syncs thinking state through the native `toggle` event on
  // `<details>`. Suppress that path, mutate the real `open` attribute
  // directly, and mirror expansion state in CSS through `[open]`.
  //
  // Viewport position is locked by recording `summary.getBoundingClientRect()`
  // before the click and restoring the scroll delta afterward.
  function setupThinking() {
    // `dom-api-freeze` already patched the prototypes.
    // This subsystem freezes every thinking node, suppresses `toggle` state
    // sync, handles user clicks, and persists expansion intent across remounts.
    //
    // Intent is stored on a stable position key:
    // `m<msgIdx>t<thinkingIdx>`.

    const intentOpen = new Set();

    const keyFor = (details) => {
      const msg = details.closest(SEL.message);
      if (!msg) return null;
      const container = msg.closest(SEL.messagesContainer) || document.body;
      const msgs = container.querySelectorAll(SEL.message);
      let msgIdx = -1;
      for (let i = 0; i < msgs.length; i++) {
        if (msgs[i] === msg) { msgIdx = i; break; }
      }
      if (msgIdx < 0) return null;
      const thinkings = msg.querySelectorAll(SEL.thinking);
      let tIdx = -1;
      for (let i = 0; i < thinkings.length; i++) {
        if (thinkings[i] === details) { tIdx = i; break; }
      }
      if (tIdx < 0) return null;
      return `m${msgIdx}t${tIdx}`;
    };

    const armHostToggleSync = (details) => {
      details.__claudeAllowHostToggleOnce = true;
      if (details.__claudeAllowHostToggleReset) {
        clearTimeout(details.__claudeAllowHostToggleReset);
      }
      details.__claudeAllowHostToggleReset = setTimeout(() => {
        details.__claudeAllowHostToggleOnce = false;
        details.__claudeAllowHostToggleReset = null;
      }, 0);
    };

    // The host re-renders the built-in SVG toggle during streaming and flips
    // its expanded class independently from the frozen `<details>` state,
    // which makes the arrow flicker even while the body stays open. Hide that
    // SVG in CSS and let the summary pseudo-element read only the real `open`
    // attribute so arrow state cannot drift away from the content state.

    const reconcileAll = () => {
      const all = document.querySelectorAll(SEL.thinking);
      for (let i = 0; i < all.length; i++) {
        const d = all[i];
        d.__claudeFrozen = true;
        const k = keyFor(d);
        if (!k) continue;
        const shouldOpen = intentOpen.has(k);
        const isOpen = d.hasAttribute('open');
        if (shouldOpen && !isOpen) {
          NATIVE_SET.call(d, 'open', '');
        } else if (!shouldOpen && isOpen) {
          // New nodes should start collapsed until the user opens them.
          NATIVE_REMOVE.call(d, 'open');
        }
      }
    };
    reconcileAll();

    // React streaming remounts thinking blocks during the same task that
    // committed the new DOM. Reconcile in a microtask so the restored `open`
    // state lands before paint instead of one frame later, with a trailing
    // rAF pass as a safety net for any writes that happen after layout.
    let pendingMicrotask = false;
    let pendingFrame = false;
    const scheduleReconcile = () => {
      if (!pendingMicrotask) {
        pendingMicrotask = true;
        queueMicrotask(() => {
          pendingMicrotask = false;
          reconcileAll();
        });
      }
      if (pendingFrame) return;
      pendingFrame = true;
      requestAnimationFrame(() => {
        pendingFrame = false;
        reconcileAll();
      });
    };

    // Watch remounts and external writes to `open` so new thinking nodes can
    // inherit the user's last intent.
    //
    // The handler is a no-op unless the mutation actually touches a thinking
    // `<details>` — either by adding one into the tree or by flipping its
    // `open` attribute. Cheap string test first, DOM probe second. This keeps
    // the React reconciler's stream of chat-body mutations from firing a
    // microtask + rAF pair on every keystroke.
    const mightContainThinking = (node) => {
      if (!node || node.nodeType !== 1) return false;
      if (node.tagName === 'DETAILS') return true;
      return typeof node.querySelector === 'function' && node.querySelector('details') !== null;
    };
    const thinkingObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'attributes') {
          if (m.target && m.target.tagName === 'DETAILS') {
            scheduleReconcile();
            return;
          }
          continue;
        }
        for (const node of m.addedNodes) {
          if (mightContainThinking(node)) { scheduleReconcile(); return; }
        }
      }
    });
    thinkingObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['open'],
    });

    // The host React tree still needs one `toggle` after a user click so its
    // internal `isExpanded` prop stays aligned with the DOM we froze. Let that
    // one through, but keep suppressing every external close/open the host
    // emits during streaming.
    document.addEventListener('toggle', (e) => {
      const t = e.target;
      if (t && t.matches && t.matches(SEL.thinking)) {
        if (t.__claudeAllowHostToggleOnce) {
          t.__claudeAllowHostToggleOnce = false;
          if (t.__claudeAllowHostToggleReset) {
            clearTimeout(t.__claudeAllowHostToggleReset);
            t.__claudeAllowHostToggleReset = null;
          }
          return;
        }
        e.stopImmediatePropagation();
      }
    }, true);

    const findScroller = (el) => {
      let n = el.parentElement;
      while (n) {
        const cs = getComputedStyle(n);
        if (/(auto|scroll)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight) return n;
        n = n.parentElement;
      }
      return document.scrollingElement || document.documentElement;
    };

    document.addEventListener('click', (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      const summary = t.closest(SEL.thinkingSummary);
      if (!summary) return;
      const details = summary.closest('details');
      if (!details) return;

      e.preventDefault();
      e.stopImmediatePropagation();

      // Reapply the frozen marker defensively.
      details.__claudeFrozen = true;

      const scroller = findScroller(details);
      const topBefore = summary.getBoundingClientRect().top;

      // Toggle through the captured native methods and update the intent set
      // so remounted nodes can be restored by `reconcileAll`.
      const k = keyFor(details);
      armHostToggleSync(details);
      if (details.hasAttribute('open')) {
        NATIVE_REMOVE.call(details, 'open');
        if (k) intentOpen.delete(k);
      } else {
        NATIVE_SET.call(details, 'open', '');
        if (k) intentOpen.add(k);
      }

      // One rAF is enough: `getBoundingClientRect()` forces layout, so the
      // measurement is always post-reflow regardless of frame boundary.
      requestAnimationFrame(() => {
        const topAfter = summary.getBoundingClientRect().top;
        const delta = topAfter - topBefore;
        if (scroller && Math.abs(delta) > 0.5) {
          scroller.scrollTop += delta;
        }
      });
    }, true);
  }

  // ========== 12. init ==========

  function whenDOMReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else { fn(); }
  }

  // ============================================================
  // Cache badge.
  // ============================================================
  // Data arrives from the extension host through `webview.postMessage`.
  // The badge is inserted into the input footer before the bypass control.
  function setupCacheBadge() {
    var BADGE_CLASS = 'cceBadge';
    var TEXT_CLASS = 'cceBadgeText';
    var POPUP_CLASS = 'cceStatPopup';
    // Outline icon with descending bars for a lightweight stats metaphor.
    var ICON_SVG = '<svg class="cceBadgeIcon" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">' +
      '<line x1="4" y1="6" x2="16" y2="6"/>' +
      '<line x1="4" y1="10" x2="13" y2="10"/>' +
      '<line x1="4" y1="14" x2="9" y2="14"/>' +
      '</svg>';
    var latest = null;       // Latest payload: ctx/hit plus recent and totals.
    var popupEl = null;
    var popupAnchor = null;  // Badge button currently anchoring the popup.

    function fmtTokens(n) {
      if (!Number.isFinite(n) || n <= 0) return '—';
      if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
      if (n >= 1000) {
        var k = n / 1000;
        return (k >= 100 ? k.toFixed(0) : k.toFixed(1)) + 'k';
      }
      return String(n);
    }
    function fmtPct(p) {
      if (!Number.isFinite(p) || p < 0) return '—';
      return (p * 100).toFixed(2) + '%';
    }
    function fmtRelTime(iso) {
      if (!iso) return '—';
      var t = Date.parse(iso);
      if (isNaN(t)) return '—';
      var s = Math.max(0, Math.round((Date.now() - t) / 1000));
      if (s < 60) return s + 's ago';
      if (s < 3600) return Math.round(s / 60) + 'm ago';
      if (s < 86400) return Math.round(s / 3600) + 'h ago';
      return Math.round(s / 86400) + 'd ago';
    }
    function fmtDuration(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return '—';
      var s = Math.round(ms / 1000);
      if (s < 60) return s + ' s';
      var m = Math.round(s / 60);
      if (m < 60) return m + ' min';
      var h = Math.floor(m / 60), mm = m % 60;
      return h + ' h ' + (mm ? mm + ' min' : '');
    }
    function revealVal(el, target) {
      if (el.__cceRAF) { cancelAnimationFrame(el.__cceRAF); el.__cceRAF = null; }
      if (!target) { el.textContent = ''; return; }
      var len = target.length;
      var display = new Array(len + 1).join(' ');
      var index = 0, lastT = 0, STEP = 40;
      function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
      function frame(t) {
        if (t - lastT < STEP) { el.__cceRAF = requestAnimationFrame(frame); return; }
        lastT = t;
        if (index - 3 >= len) {
          el.textContent = target;
          el.__cceRAF = null;
          return;
        }
        var arr = display.split('');
        for (var w = 0; w <= 3; w++) {
          var F = index - w;
          if (F >= 0 && F < len) {
            var ch = target[F];
            if (ch === ' ') arr[F] = ' ';
            else if (w === 3) arr[F] = ch;
            else if (w === 0) arr[F] = '\u258C';
            else arr[F] = pick(['.', '_', ch]);
          }
        }
        display = arr.join('');
        el.textContent = display;
        index++;
        el.__cceRAF = requestAnimationFrame(frame);
      }
      el.__cceRAF = requestAnimationFrame(frame);
    }
    // Some backends expose no prompt-cache counters at all.
    // Show `—` instead of `0%` so the UI reads as unsupported, not as a miss.
    function sessionHasNoCache(payload) {
      if (!payload || !payload.totals) return false;
      var T = payload.totals;
      return (T.cr || 0) === 0 && (T.cw || 0) === 0;
    }
    function renderText(textEl) {
      if (!textEl) return;
      var ctxStr, hitStr;
      if (!latest) {
        ctxStr = '—'; hitStr = '—';
      } else {
        ctxStr = fmtTokens(latest.ctx);
        hitStr = sessionHasNoCache(latest) ? '—' : fmtPct(latest.hit);
      }
      if (!textEl.__cceBuilt) {
        textEl.innerHTML =
          '<span class="cceBadgeLabel">Ctx</span> ' +
          '<span class="cceBadgeVal" data-cce-val="ctx"></span>' +
          '    ' +
          '<span class="cceBadgeLabel">Cache</span> ' +
          '<span class="cceBadgeVal" data-cce-val="hit"></span>';
        textEl.__cceBuilt = true;
      }
      var ctxEl = textEl.querySelector('[data-cce-val="ctx"]');
      var hitEl = textEl.querySelector('[data-cce-val="hit"]');
      if (ctxEl && ctxEl.__cceLast !== ctxStr) {
        var firstCtx = ctxEl.__cceLast === undefined;
        ctxEl.__cceLast = ctxStr;
        if (firstCtx) ctxEl.textContent = ctxStr;
        else revealVal(ctxEl, ctxStr);
      }
      if (hitEl && hitEl.__cceLast !== hitStr) {
        var firstHit = hitEl.__cceLast === undefined;
        hitEl.__cceLast = hitStr;
        if (firstHit) hitEl.textContent = hitStr;
        else revealVal(hitEl, hitStr);
      }
    }

    function buildPopup() {
      var el = document.createElement('div');
      el.className = POPUP_CLASS;
      el.setAttribute('role', 'dialog');
      el.innerHTML =
        '<div class="cceStatSection">' +
          '<div class="cceStatHeading">Recent requests</div>' +
          '<div class="cceStatRecent" data-recent></div>' +
        '</div>' +
        '<div class="cceStatDivider"></div>' +
        '<div class="cceStatSection">' +
          '<div class="cceStatHeading">Session</div>' +
          '<div class="cceStatTotals" data-totals></div>' +
        '</div>';
      el.addEventListener('click', function(ev) { ev.stopPropagation(); });
      return el;
    }
    function renderPopup() {
      if (!popupEl) return;
      var recentBox = popupEl.querySelector('[data-recent]');
      var totalsBox = popupEl.querySelector('[data-totals]');
      if (recentBox) {
        if (!latest || !latest.recent || !latest.recent.length) {
          recentBox.innerHTML = '<div class="cceStatEmpty">No requests yet</div>';
        } else {
          var rows = '';
          for (var i = 0; i < latest.recent.length; i++) {
            var r = latest.recent[i];
            rows +=
              '<div class="cceStatRow">' +
                '<span class="cceStatTime">' + fmtRelTime(r.ts) + '</span>' +
                '<span class="cceStatCtx">' + fmtTokens(r.ctx) + '</span>' +
                '<span class="cceStatHit">' + fmtPct(r.hit) + '</span>' +
              '</div>';
          }
          recentBox.innerHTML = rows;
        }
      }
      if (totalsBox) {
        if (!latest || !latest.totals) {
          totalsBox.innerHTML = '<div class="cceStatEmpty">—</div>';
        } else {
          var T = latest.totals;
          var lines = [
            ['Requests',    String(T.requests || 0),                ''],
            ['Duration',    fmtDuration(T.durationMs || 0),         ''],
            ['Fresh input', fmtTokens(T.fresh || 0),                ''],
            ['Cache write', fmtTokens(T.cw || 0),                   ''],
            ['Cache read',  fmtTokens(T.cr || 0),                   sessionHasNoCache(latest) ? '—' : fmtPct(T.hitOverall || 0)],
            ['Output',      fmtTokens(T.out || 0),                  ''],
          ];
          var html = '';
          for (var j = 0; j < lines.length; j++) {
            var L = lines[j];
            html +=
              '<div class="cceStatKV">' +
                '<span class="cceStatLabel">' + L[0] + '</span>' +
                '<span class="cceStatValue">' + L[1] + '</span>' +
                '<span class="cceStatExtra">' + L[2] + '</span>' +
              '</div>';
          }
          totalsBox.innerHTML = html;
        }
      }
    }
    function positionPopup() {
      if (!popupEl || !popupAnchor) return;
      var r = popupAnchor.getBoundingClientRect();
      // Place the popup above the badge and align their left edges.
      popupEl.style.left = Math.round(r.left) + 'px';
      popupEl.style.bottom = Math.round(window.innerHeight - r.top + 6) + 'px';
    }
    function openPopup(anchor) {
      popupAnchor = anchor;
      if (!popupEl) {
        popupEl = buildPopup();
        document.body.appendChild(popupEl);
      }
      popupEl.classList.add('cceStatOpen');
      anchor.classList.add('cceBadgeActive');
      renderPopup();
      positionPopup();
    }
    function closePopup() {
      if (!popupEl) return;
      popupEl.classList.remove('cceStatOpen');
      if (popupAnchor) popupAnchor.classList.remove('cceBadgeActive');
      popupAnchor = null;
    }
    function isOpen() {
      return !!(popupEl && popupEl.classList.contains('cceStatOpen'));
    }

    function ensureBadge() {
      var hosts = document.querySelectorAll(SEL.inputFooterHost);
      for (var i = 0; i < hosts.length; i++) {
        var host = hosts[i];
        if (!host) continue;
        var badge = host.querySelector(':scope > .' + BADGE_CLASS);
        if (!badge) {
          badge = document.createElement('button');
          badge.type = 'button';
          badge.className = BADGE_CLASS;
          badge.innerHTML = ICON_SVG + '<span class="' + TEXT_CLASS + '"></span>';
          badge.addEventListener('click', function(ev) {
            ev.stopPropagation();
            if (isOpen() && popupAnchor === ev.currentTarget) {
              closePopup();
            } else {
              openPopup(ev.currentTarget);
            }
          });
          host.insertBefore(badge, host.firstChild);
        }
        var textEl = badge.querySelector('.' + TEXT_CLASS);
        renderText(textEl);
      }
    }

    window.addEventListener('message', function(ev) {
      var d = ev && ev.data;
      if (!d || d.__cceBadge !== true || !d.payload) return;
      latest = d.payload;
      ensureBadge();
      if (isOpen()) { renderPopup(); positionPopup(); }
    });

    document.addEventListener('click', function(ev) {
      if (!isOpen()) return;
      var t = ev.target;
      if (popupEl && popupEl.contains(t)) return;
      if (popupAnchor && popupAnchor.contains(t)) return;
      closePopup();
    }, true);
    document.addEventListener('keydown', function(ev) {
      if (ev.key === 'Escape' && isOpen()) closePopup();
    }, true);
    window.addEventListener('resize', function() { if (isOpen()) positionPopup(); });
    window.addEventListener('scroll', function() { if (isOpen()) positionPopup(); }, true);

    // `inputFooter` can remount under React, so keep a small observer to
    // reinsert the badge. The observer is coalesced to at most one
    // `ensureBadge` call per animation frame, and it ignores mutations that
    // cannot possibly touch the footer (no `inputFooter`-class node added).
    var ensureScheduled = false;
    function scheduleEnsureBadge() {
      if (ensureScheduled) return;
      ensureScheduled = true;
      requestAnimationFrame(function() { ensureScheduled = false; ensureBadge(); });
    }
    function mutationTouchesFooter(m) {
      for (var i = 0; i < m.addedNodes.length; i++) {
        var n = m.addedNodes[i];
        if (!n || n.nodeType !== 1) continue;
        var cls = typeof n.className === 'string' ? n.className : '';
        if (cls.indexOf('inputFooter') !== -1 || cls.indexOf('Footer') !== -1) return true;
        if (n.querySelector && n.querySelector('[class*="inputFooter"]')) return true;
      }
      return false;
    }
    var mo = new MutationObserver(function(mutations) {
      for (var i = 0; i < mutations.length; i++) {
        if (mutationTouchesFooter(mutations[i])) { scheduleEnsureBadge(); return; }
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });

    ensureBadge();
  }

  function init() {
    log('Initializing v15 (theme.css + IBM Plex Serif + Noto Sans SC + Rec Mono Linear)...');
    applyAppVarOverrides();   // Run before `injectStyles` so CSS sees the variables.
    setupAppVarObserver();
    startHostProbe();
    injectStyles();
    setupObserver();
    setupThinking();
    setupCacheBadge();

    // Drain the math queue after KaTeX loads. `setupObserver` already filled
    // `pendingSegments` via its own initial scan and flush() bailed because
    // `isKatexReady()` was false — so nothing has been drained yet. Just
    // reschedule the flush instead of walking the DOM a second time.
    assets.katex().then(() => {
      schedule();
    }).catch(() => { /* Already warned. */ });

    assets.hljs().then(() => {
      schedule();
    }).catch(() => { /* Already warned. */ });
  }

  whenDOMReady(init);
})();
