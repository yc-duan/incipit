# incipit

*A frontend rework of the official Claude Code VS Code extension — surface redrawn, engine untouched.*

[中文版 →](README.zh.md)

---

incipit redesigns Claude Code's entire VS Code frontend — body typography, math rendering, tool-call folding, diff, local history editing — in a literary style, with engineering surfaces folded into the same visual language. It does not touch model requests, authentication, tool schema, or the CLI spawn protocol; every byte sent to the server is identical before and after installation.

Run it once and reload VS Code — no extra dependencies. Each time Claude Code updates and overwrites the frontend files, run it again. Backups are kept per version and revertible at any time.

---

## A patch, not a standalone extension

incipit modifies the Claude Code official extension files on your disk. It is not a VS Code extension itself, and it does not replace the official one. Your Claude subscription, API key, login state, MCP configuration, tool schema, and permission settings — every piece of official logic — behave exactly as they would without it.

Remove it and the extension is back to its stock state.

---

## Install

Requires Node.js 16 or later.

```bash
npm install -g incipit@latest
```

`incipit` is a terminal CLI; it must be installed globally. `npm install incipit` (without `-g`) is npm's syntax for installing a local dependency, which drops the package into the current directory's `node_modules/` — neither registered on your PATH nor runnable.

Then:

```bash
incipit
```

On first launch you'll choose a CLI language, then enter the interactive menu:

<p align="center">
  <img src="docs/screenshots/cli-menu-en.png" width="420" alt="incipit CLI main menu: apply patch / restore backup / configure / manage targets / CLI language" />
  <img src="docs/screenshots/cli-configure-en.png" width="420" alt="incipit configure submenu: math rendering, session usage, body font size, theme palette" />
</p>

Menu actions:

- **Apply / Restore**: apply the patch, or roll back to the pre-apply state. Each apply is automatically backed up beforehand, scoped per Claude Code version with a full snapshot (including the entire `webview/` directory). Restore does not touch other VS Code settings.
- **Configure**: toggle math rendering and the session usage badge; switch body font size (12 / 13 / 14) and warm-black / warm-white palette.
- **Manage Claude Code targets**: auto-detects VS Code / Cursor / Insiders / VSCodium / Windsurf / Antigravity, and accepts manually specified extension directories.
- **CLI language**: switch between Chinese and English at any time.

Skip the menu and run directly:

```bash
incipit apply     # apply directly
incipit restore   # open the lightweight restore picker
```

After every Claude Code update, the local patch is overwritten by the official files — run `incipit` again and re-apply. To upgrade incipit itself, use the same global install command.

To uninstall only the incipit CLI:

```bash
npm uninstall -g incipit
```

This removes the `incipit` command itself. It does not restore a patched Claude Code extension or delete `~/.incipit/` / `~/.incipit-backup/`; run `incipit restore` first if you want to roll back the patch.

---

## Interface

A literary-style interface — warm-black background, cream-toned serif type, color narrowed to lightness steps within a single hue, terracotta surfaced sparingly only on links, emphasis, and the bottom status line.

<p align="center">
  <img src="docs/screenshots/panel.png" width="420" alt="incipit chat panel as a whole: warm-black background, cream serif body, bottom status line" />
</p>

Typography is the interface itself: math rendered, tables in booktabs style, code-block syntax colors muted, tool calls collapsed to a single line, the expanded layer using deep red and deep green for diffs, and character-level differences traced inline in muted accents.

Engineering surfaces fold into the same literary style — tool calls, diffs, and the status line share the body's typeface, hue, and emphasis.

<p align="center">
  <img src="docs/screenshots/tools.png" width="420" alt="incipit tool-call expanded block: deep red / deep green diff backgrounds, restrained line numbers, inline character-level accents — same key as the body" />
</p>

---

## Context and cache

A persistent status line above the input box shows the current context size and cache hit rate, refreshing live with every send and reply. Click to expand a popover listing the per-turn token usage and cache ratios for the last few rounds, plus cumulative statistics for the whole session.

<p align="center">
  <img src="docs/screenshots/usage.png" width="420" alt="incipit context and cache badge: persistent numbers in the status line, and the session usage popover when expanded" />
</p>

The data comes from Claude Code's local JSONL transcripts. **No network calls, no model requests.**

---

## diff

Edit / Write diffs no longer use the host's default split-pane Monaco: filename + `+N −M` sit at the header, deleted lines get a deep red background, added lines a deep green, line numbers are kept restrained, and character-level differences receive a second pass of inline coloring in the same hue but more visible. Short diffs render expanded; long diffs fold into a card with `Click to expand` opening the full content in a popover.

<p align="center">
  <img src="docs/screenshots/diff-warm-black.png" width="360" alt="incipit diff in warm-black: wine red / forest green backgrounds with character-level inline coloring" />
  <img src="docs/screenshots/diff-warm-white.png" width="360" alt="incipit diff in warm-white: soft pink / soft green backgrounds with character-level inline coloring" />
</p>

Wine red / forest green under the warm-black theme; soft pink / soft green under the warm-white theme. Every element across the two themes is independently and consistently designed.

---

## Math rendering

Complete math rendering, covering every complex case.

<p align="center">
  <img src="docs/screenshots/math-blocks.png" width="360" alt="incipit math rendering: display blocks, sums / integrals / limits / products, matrices, and aligned equations" />
  <img src="docs/screenshots/math-in-prose.png" width="360" alt="incipit math rendering: inline and display math inside lists, blockquotes, and table cells" />
</p>

KaTeX is loaded on demand — when a reply contains no math, the math pipeline never starts. Font size is fixed at 1.21em, so stroke weight stays consistent with the serif body and CJK text in mixed runs.
The over-stretched brackets in KaTeX's native rendering are fixed as well.

---

## Conversation history editing

- Each user message has icons at the bottom: edit / rerun / fork / more.

<p align="center">
  <img src="docs/screenshots/actions.png" width="420" alt="incipit user-message action row: edit / rerun / fork / more — four restrained icons" />
</p>

- Edit (inline editor): expands an editor in place. AI messages are editable too. Every output block can be edited.

<p align="center">
  <img src="docs/screenshots/edit-assistant.png" width="420" alt="incipit inline editor: in-place edit on an AI turn — translucent panel, serif body, two action icons (× / ✓) at the bottom" />
</p>

- Attachment management: messages display the IDE file references, code selections, and images already attached. You can click to remove existing attachments, or drag-and-drop / paste to add new images.
Local save: clicking save only rewrites the local JSONL conversation record file. No network requests are triggered.
Resend logic: editing only modifies the local context state. To submit the modified content to the model, use Rerun after saving.

<p align="center">
  <img src="docs/screenshots/edit-user.png" width="420" alt="incipit inline editor: in-place edit on a user message — chip strip at the top with image attachment chip and add button" />
</p>

- Rerun: only available on user messages, executable at any user message. It removes the entire downstream conversation context, then resends the current message verbatim through Claude Code's native interface (session.send) under the same session id, fully preserving text, images, and IDE reference structure. **This means the cache for the user message and its prior context is preserved.**

- Fork: calls the host AppContext's forkConversation interface, copying the current and preceding context into a new session while leaving the original session intact.

- More (dropdown menu):
Includes Code rewind and its composite operations (Rewind and Rerun, Rewind and Fork). Rewind calls session.rewindCode to undo all subsequent disk-file changes.
Includes Copy as text / markdown options.

incipit's local history capability follows a discipline: it does not fabricate model context, does not construct Claude Code's message tree on its own, and does not bypass Claude Code's session protocol. For rerun, edit, rewind, and fork, incipit performs only verifiable, minimal mutations on the local JSONL: when truncating history, it preserves a valid prefix, removes the user message and its downstream derivatives, and avoids leaving orphaned assistant / tool_use / tool_result fragments. Resend, code rewind, and conversation forking are all handed back to Claude Code's native interfaces — `session.send`, `rewindCode`, `forkConversation`.

To prevent irreversible disk writes from producing damaged states, incipit performs strict preflight before each operation: the current session id, the target JSONL, the host SessionState, and the relevant native interfaces must all be confirmed available, otherwise the operation is intercepted outright. After a rerun truncation, if the subsequent send fails, incipit will restore the original JSONL — provided it can confirm no new content has been appended to the transcript. The goal is to ensure local history mutations never produce contexts that violate the Claude Code / Anthropic messages structure: dangling tool results, wrong role ordering, misaligned conversation branches, or inconsistent file states.

---

## Compliance

This is a purely frontend project. It does not touch the model tool-calling layer or the network request layer.

The Claude provider's terms of service govern the relationship between you and their service: no API abuse, no rate-limit circumvention, no identity spoofing, no interference with server-side protocols. incipit lies entirely outside that scope — it only changes how things render on your local screen, with no connection to the model provider's servers. Every byte you send is identical before and after installation.

---

## Restore

```bash
incipit restore
```

In the restore menu, the CLI first locks onto your current Claude Code target and only offers backups matching the same version and same extension directory. Backups across different Claude Code versions never restore into each other; the same backup name can safely exist under multiple versions. Pick one, confirm, and the modified extension files are written back to their pre-apply state — copied resources under `webview/` are removed too. Any other settings you've configured in VS Code are not affected.

---

## Platforms

Fully tested and stable on Windows 11 for daily use.

Linux and macOS should work in theory, but have not been verified on actual hardware. If you run into problems, open an issue with your Claude Code extension version and the error message.

After every Claude Code update, the patch is overwritten alongside it. Run `incipit` again — usually done in under ten seconds.

---

## Why not a VS Code extension

VS Code enforces strict sandbox isolation between extensions — one extension cannot inject scripts or styles into another's interface. The only way to change how Claude Code's chat renders is to modify its files on local disk directly. That's why incipit takes the patching approach.

If Claude Code ever ships an official theming or style-injection API, this project will migrate to that path immediately, and the patching approach will be archived.

---

## Acknowledgements

Thanks to the [linuxdo](https://linux.do/) community for discussion, sharing, and feedback.

---

## License

MIT. See [LICENSE](LICENSE).

---
