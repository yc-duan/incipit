// Raw-mode keyboard loop for interactive menu screens.
//
// All interactive screens (main menu, configure, font size picker,
// language picker) go through `keyLoop`. The non-interactive subcommands
// (`incipit apply` / `restore` / `--help`) never touch this file — they
// dispatch from `main()` and return before the menu loop starts.
//
// Design constraints:
//   - Zero dependency. Raw mode + `readline.emitKeypressEvents` is all we
//     need; no inquirer / prompts / enquirer.
//   - Terminal must be a TTY. The caller is expected to have checked
//     `process.stdin.isTTY` before invoking this helper; if we are called
//     anyway, `setRawMode` is a no-op and the loop still works in most
//     emulators that expose keypress events, but the contract is TTY-only.
//   - Clean up on every exit path. Raw mode leaking out of this module
//     leaves the terminal in a no-echo state that confuses users.

'use strict';

const readline = require('readline');

// ANSI escape codes for hiding/showing the terminal text cursor. In raw
// mode we absorb every keypress directly, so the blinking caret at the
// last output position is pure visual noise — it suggests to the user
// "type here", but there's nothing to type at.
const CURSOR_HIDE = '\x1b[?25l';
const CURSOR_SHOW = '\x1b[?25h';

// Belt-and-braces: if the process ever exits while the cursor is still
// hidden (uncaught exception, unexpected signal, parent kill), emit the
// show sequence so the user's terminal doesn't stay in no-cursor mode
// after we're gone. Showing an already-visible cursor is a no-op.
process.on('exit', () => {
  if (process.stdout.isTTY) process.stdout.write(CURSOR_SHOW);
});

// Run a keypress loop until `onKey` returns `{ done: true, result }`.
// `render` is called once up front and again after every non-terminal
// keypress so the caller can redraw the screen based on updated state.
//
// Keybinding reservations (handled here, not passed to `onKey`):
//   - Ctrl+C: restore the terminal, print a newline, exit(130)
//   - Ctrl+D: resolve with `{ action: 'back' }`
//
// `onKey(str, key)` receives the same arguments as readline's keypress
// event. Return `undefined` to keep looping, `{ done: true, result }` to
// resolve the promise with `result`.
function keyLoop({ render, onKey }) {
  return new Promise((resolve, reject) => {
    readline.emitKeypressEvents(process.stdin);
    const wasRaw = process.stdin.isRaw === true;
    try {
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
    } catch (_) { /* non-TTY fall-through; keypress events may still fire */ }
    process.stdin.resume();
    if (process.stdout.isTTY) process.stdout.write(CURSOR_HIDE);

    let finished = false;

    const cleanup = () => {
      process.stdin.removeListener('keypress', handler);
      try {
        if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw);
      } catch (_) {}
      process.stdin.pause();
      if (process.stdout.isTTY) process.stdout.write(CURSOR_SHOW);
    };

    function handler(str, key) {
      if (finished) return;

      if (key && key.ctrl && key.name === 'c') {
        finished = true;
        cleanup();
        process.stdout.write('\n');
        process.exit(130);
      }
      if (key && key.ctrl && key.name === 'd') {
        finished = true;
        cleanup();
        resolve({ action: 'back' });
        return;
      }

      let outcome;
      try {
        outcome = onKey(str, key);
      } catch (exc) {
        finished = true;
        cleanup();
        reject(exc);
        return;
      }

      if (outcome && outcome.done) {
        finished = true;
        cleanup();
        resolve(outcome.result);
        return;
      }

      try {
        renderAndRehide();
      } catch (exc) {
        finished = true;
        cleanup();
        reject(exc);
      }
    }

    process.stdin.on('keypress', handler);

    // Initial draw. Wrap in try/catch so a render-time crash doesn't
    // leave raw mode enabled.
    try {
      renderAndRehide();
    } catch (exc) {
      finished = true;
      cleanup();
      reject(exc);
    }

    // `render()` almost always calls `clearScreen` first, and some
    // platforms' screen clears reset cursor visibility as a side effect.
    // Re-emit the hide sequence after every render so the cursor stays
    // invisible across the whole loop, not just at the initial draw.
    function renderAndRehide() {
      render();
      if (process.stdout.isTTY) process.stdout.write(CURSOR_HIDE);
    }
  });
}

module.exports = { keyLoop };
