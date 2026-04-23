'use strict';

export const ATTR = Object.freeze({
  attachedFiles: 'data-incipit-attached-files',
  attachedFilesTop: 'data-incipit-attached-files-top',
  commandItem: 'data-incipit-command-item',
  commandItemActive: 'data-incipit-command-item-active',
  commandLabel: 'data-incipit-command-label',
  commandList: 'data-incipit-command-list',
  commandRef: 'data-incipit-command-ref',
  dropdown: 'data-incipit-dropdown',
  footerButtonLabel: 'data-incipit-footer-button-label',
  inputContainer: 'data-incipit-input-container',
  inputContainerBg: 'data-incipit-input-container-bg',
  inputEditor: 'data-incipit-input-editor',
  inputFooter: 'data-incipit-input-footer',
  inputFooterHost: 'data-incipit-input-footer-host',
  interruptedMessage: 'data-incipit-interrupted-message',
  markdownRoot: 'data-incipit-markdown-root',
  menuItem: 'data-incipit-menu-item',
  menuItemLabel: 'data-incipit-menu-item-label',
  menuItemDescription: 'data-incipit-menu-item-description',
  menuPopup: 'data-incipit-menu-popup',
  message: 'data-incipit-message',
  messagesContainer: 'data-incipit-messages-container',
  sendButton: 'data-incipit-send-button',
  sendIcon: 'data-incipit-send-icon',
  showMore: 'data-incipit-host-show-more',
  spinnerContainer: 'data-incipit-spinner-container',
  spinnerIcon: 'data-incipit-spinner-icon',
  spinnerRow: 'data-incipit-spinner-row',
  stickyMessage: 'data-incipit-sticky-message',
  thinking: 'data-incipit-thinking',
  thinkingToggle: 'data-incipit-thinking-toggle',
  thinkingContent: 'data-incipit-thinking-content',
  thinkingSummary: 'data-incipit-thinking-summary',
  toolArgs: 'data-incipit-tool-args',
  toolBody: 'data-incipit-tool-body',
  toolCommand: 'data-incipit-tool-command',
  toolName: 'data-incipit-tool-name',
  toolNameSecondary: 'data-incipit-tool-name-secondary',
  toolPath: 'data-incipit-tool-path',
  toolSecondary: 'data-incipit-tool-secondary',
  toolSummary: 'data-incipit-tool-summary',
  toolUse: 'data-incipit-tool-use',
  truncationGradient: 'data-incipit-truncation-gradient',
  usageLabel: 'data-incipit-usage-label',
  userAttachments: 'data-incipit-user-attachments',
  userBubble: 'data-incipit-user-bubble',
  userContent: 'data-incipit-user-content',
  userExpandable: 'data-incipit-user-expandable',
  userLayoutWrapper: 'data-incipit-user-layout-wrapper',
  userMessageContainer: 'data-incipit-user-message-container',
  stopIcon: 'data-incipit-stop-icon',
});

export const SEL = Object.freeze(
  Object.fromEntries(Object.entries(ATTR).map(([key, attr]) => [key, `[${attr}]`])),
);

const STATIC_PROBES = Object.freeze([
  ['[class*="attachedFilesContainerAbove"]', ATTR.attachedFilesTop],
  ['[class*="attachedFilesContainer"]', ATTR.attachedFiles],
  ['[class*="commandItem"]', ATTR.commandItem],
  ['[class*="activeCommandItem"]', ATTR.commandItemActive],
  ['[class*="commandLabel"]', ATTR.commandLabel],
  ['[class*="commandList"]', ATTR.commandList],
  ['[class*="commandRef"]', ATTR.commandRef],
  ['[class*="dropdown"]', ATTR.dropdown],
  ['[class*="dropdown_"]', ATTR.dropdown],
  ['[class*="filePath"]', ATTR.toolPath],
  ['[class*="footerButton"] span', ATTR.footerButtonLabel],
  ['fieldset[class*="inputContainer"]', ATTR.inputContainer],
  ['[class*="inputContainerBackground"]', ATTR.inputContainerBg],
  ['[class*="inputFooter"]', ATTR.inputFooter],
  ['[class*="menuItem_"]', ATTR.menuItem],
  ['[class*="menuItemLabel"]', ATTR.menuItemLabel],
  ['[class*="menuItemDescription"]', ATTR.menuItemDescription],
  ['[class*="menuPopup"]', ATTR.menuPopup],
  ['[class*="messagesContainer_"]', ATTR.messagesContainer],
  ['[class*="root_"]', ATTR.markdownRoot],
  ['[class*="spinnerRow"]', ATTR.spinnerRow],
  ['[class*="stickyHeader"]', ATTR.stickyMessage],
  ['[class*="thinkingContent"]', ATTR.thinkingContent],
  ['[class*="timelineMessage"]', ATTR.message],
  ['[class*="toolArgs"]', ATTR.toolArgs],
  ['[class*="toolBody_"]', ATTR.toolBody],
  ['[class*="toolCommand"]', ATTR.toolCommand],
  ['[class*="toolName"]', ATTR.toolName],
  ['[class*="toolNameTextSecondary"]', ATTR.toolNameSecondary],
  ['[class*="toolPath"]', ATTR.toolPath],
  ['[class*="secondaryLine_"]', ATTR.toolSecondary],
  ['[class*="toolSummary"]', ATTR.toolSummary],
  ['[class*="toolUse_"]', ATTR.toolUse],
  ['[class*="truncationGradient"]', ATTR.truncationGradient],
  ['[class*="usageLabel"]', ATTR.usageLabel],
  ['[class*="userMessageContainer"]', ATTR.userMessageContainer],
  ['[class*="Attachments"]', ATTR.userAttachments],
  ['details[class*="thinking"]', ATTR.thinking],
  ['summary[class*="thinkingSummary"]', ATTR.thinkingSummary],
  ['[aria-multiline="true"][contenteditable]', ATTR.inputEditor],
  ['[aria-multiline="true"][role="textbox"]', ATTR.inputEditor],
  ['[class*="messageInput"][contenteditable]', ATTR.inputEditor],
]);

let observer = null;
let fullRescanScheduled = false;
let isComposing = false;
let compositionListenersAttached = false;

function scheduleFullRescan() {
  if (fullRescanScheduled) return;
  fullRescanScheduled = true;
  requestAnimationFrame(() => {
    fullRescanScheduled = false;
    if (document.body) tagHostTree(document.body);
  });
}

function attachCompositionListeners() {
  if (compositionListenersAttached) return;
  compositionListenersAttached = true;
  // IME composition mutates the editor subtree in ways that Chromium's text
  // layout cannot tolerate any style invalidation against. Suppress the
  // observer while composing, then run a single catch-up rescan.
  document.addEventListener('compositionstart', () => { isComposing = true; }, true);
  document.addEventListener('compositionend', () => {
    isComposing = false;
    scheduleFullRescan();
  }, true);
}

export function startHostProbe() {
  if (observer) return observer;
  if (!document.body) return null;
  attachCompositionListeners();
  tagHostTree(document.body);
  observer = new MutationObserver(handleMutations);
  observer.observe(document.body, { childList: true, subtree: true });
  return observer;
}

export function stopHostProbe() {
  if (observer) { observer.disconnect(); observer = null; }
  fullRescanScheduled = false;
}

export function tagHostTree(root) {
  if (!root) return;
  // Never touch nodes inside a contenteditable editor. The chat input
  // creates `<p>` and `<span>` nodes that can match STATIC_PROBES
  // selectors, and setting data-attributes on them desynchronizes the
  // editor model from the DOM, causing character corruption (e.g. a
  // period typed after CJK text gets stranded in an unselectable region).
  if (root.nodeType === 1 && root.isContentEditable) return;
  tagStaticSelectors(root);
  syncFooterHosts(root);
  syncUserMessageNodes(root);
  syncSendButtons(root);
  syncTransientControls(root);
  syncSpinnerNodes(root);
}

export function closestByAttr(node, attr) {
  const element = node?.nodeType === 1 ? node : node?.parentElement;
  return element?.closest?.(`[${attr}]`) || null;
}

// Added subtrees get tagged immediately through `tagHostTree(node)`.
// A full-body resync is still required for cases where a sibling of an
// already-tagged node (footer host candidate, user bubble container) needs
// re-evaluation. That path is amortized to at most once per animation frame
// so a burst of React reconciliations can no longer trigger O(n²) scans.
function handleMutations(mutations) {
  const active = document.activeElement;
  const editorFocused = active && active.isContentEditable;

  // Hard stop during IME composition. Any setAttribute against an ancestor
  // of the editor — even an idempotent one — can desynchronize Chromium's
  // text advance cache from the composition buffer, leaving phantom glyphs
  // that cannot be selected or deleted. compositionend schedules a single
  // catch-up rescan, so nothing is lost.
  if (editorFocused && isComposing) return;

  let hasOutsideMutation = false;
  for (const mutation of mutations) {
    if (editorFocused && !active.contains(mutation.target)) {
      hasOutsideMutation = true;
    }
    for (const node of mutation.addedNodes) {
      if (node.nodeType !== 1) continue;
      tagHostTree(node);
    }
  }
  // Skip the expensive full-body rescan only when ALL mutations are inside
  // the contenteditable editor. But if any mutation landed outside the editor
  // (e.g. send button state change), we must still rescan so attributes like
  // send-state update.
  if (editorFocused && !hasOutsideMutation) return;
  scheduleFullRescan();
}

function ensureAttr(el, attr, value = '') {
  if (!el || el.nodeType !== 1) return;
  if (el.getAttribute(attr) === value) return;
  el.setAttribute(attr, value);
}

function tagStaticSelectors(root) {
  if (root.nodeType !== 1) return;
  for (const [selector, attr] of STATIC_PROBES) {
    if (root.matches?.(selector) && !root.isContentEditable) ensureAttr(root, attr);
    root.querySelectorAll?.(selector).forEach(element => {
      if (!element.isContentEditable) ensureAttr(element, attr);
    });
  }
}

function syncFooterHosts(root) {
  forEachHost(root, SEL.inputFooter, footer => {
    const currentHost = Array.from(footer.children).findLast(isFooterHostCandidate);
    Array.from(footer.querySelectorAll(`[${ATTR.inputFooterHost}]`)).forEach(node => {
      if (node !== currentHost) node.removeAttribute(ATTR.inputFooterHost);
    });
    if (currentHost) ensureAttr(currentHost, ATTR.inputFooterHost);
  });
}

function syncUserMessageNodes(root) {
  forEachHost(root, SEL.userMessageContainer, container => {
    container.querySelectorAll('[class*="container_v2"]').forEach(node => {
      ensureAttr(node, ATTR.userLayoutWrapper);
    });
    const interrupted = container.querySelector('[class*="interruptedMessage"]');
    if (interrupted) ensureAttr(interrupted, ATTR.interruptedMessage);
    container.querySelectorAll('[class*="userMessage_"]').forEach(node => tagUserBubble(node));
    container.querySelectorAll('[class*="content_"]').forEach(node => {
      ensureAttr(node, ATTR.userContent);
    });
    container.querySelectorAll('[class*="expandableContainer"]').forEach(node => {
      ensureAttr(node, ATTR.userExpandable);
    });
  });
}

function syncSendButtons(root) {
  forEachHost(root, '[class*="sendButton"]', button => {
    ensureAttr(button, ATTR.sendButton);
    button.querySelectorAll('[class*="sendIcon"]').forEach(node => {
      ensureAttr(node, ATTR.sendIcon);
    });
    button.querySelectorAll('[class*="stopIcon"]').forEach(node => {
      ensureAttr(node, ATTR.stopIcon);
    });
    const state = resolveSendState(button);
    if (state) ensureAttr(button, 'data-incipit-send-state', state);
    else if (button.hasAttribute('data-incipit-send-state')) {
      button.removeAttribute('data-incipit-send-state');
    }
  });
}

function syncTransientControls(root) {
  const probes = [
    ['[class*="collapseButton"]', ATTR.showMore],
    ['[class*="buttonContainer"]', ATTR.showMore],
    ['[class*="showMore"]', ATTR.showMore],
  ];
  for (const [selector, attr] of probes) {
    forEachHost(root, selector, element => ensureAttr(element, attr));
  }
}

function syncSpinnerNodes(root) {
  forEachHost(root, SEL.spinnerRow, row => {
    row.querySelectorAll('[class*="container_"]').forEach(node => {
      ensureAttr(node, ATTR.spinnerContainer);
    });
    row.querySelectorAll('[class*="icon_"]').forEach(node => {
      ensureAttr(node, ATTR.spinnerIcon);
    });
  });
  forEachHost(root, SEL.thinkingSummary, summary => {
    summary.querySelectorAll('[class*="thinkingToggle"]').forEach(node => {
      ensureAttr(node, ATTR.thinkingToggle);
    });
  });
}

function forEachHost(root, selector, callback) {
  if (root.nodeType !== 1) return;
  if (root.matches?.(selector)) callback(root);
  root.querySelectorAll?.(selector).forEach(callback);
}

function isFooterHostCandidate(node) {
  return node.nodeType === 1 && typeof node.className === 'string' && node.className.includes('container_');
}

function tagUserBubble(node) {
  const classes = typeof node.className === 'string' ? node.className : '';
  if (!classes.includes('userMessage_')) return;
  if (classes.includes('Container') || classes.includes('Attachments')) return;
  node.setAttribute(ATTR.userBubble, '');
}

function resolveSendState(button) {
  if (button.querySelector('[class*="sendIcon"]')) return 'send';
  if (button.querySelector('[class*="stopIcon"]')) return 'stop';
  return null;
}
