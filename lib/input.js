import { createInterface } from "readline";
import chalk from "chalk";
import { t } from "./i18n.js";

// ─── Display width for CJK-aware cursor positioning ────────────────
function isWide(code) {
  return (
    (code >= 0x1100 && code <= 0x115F) ||
    (code >= 0x2E80 && code <= 0x303E) ||
    (code >= 0x3040 && code <= 0x33BF) ||
    (code >= 0x3400 && code <= 0x4DBF) ||
    (code >= 0x4E00 && code <= 0x9FFF) ||
    (code >= 0xA000 && code <= 0xA4CF) ||
    (code >= 0xAC00 && code <= 0xD7AF) ||
    (code >= 0xF900 && code <= 0xFAFF) ||
    (code >= 0xFE30 && code <= 0xFE6F) ||
    (code >= 0xFF01 && code <= 0xFF60) ||
    (code >= 0xFFE0 && code <= 0xFFE6) ||
    (code >= 0x20000 && code <= 0x2FA1F)
  );
}

function stringWidth(str) {
  let w = 0;
  for (const ch of str) {
    const code = ch.codePointAt(0);
    if (code < 32) continue; // control chars
    w += isWide(code) ? 2 : 1;
  }
  return w;
}

// ─── Custom REPL with real-time command suggestions + paste handling ──
// "/" → filtered command list, arrow/tab to select
// Paste detection via bracket paste mode + timing fallback
// Pasted content shown as [Pasted: N lines] until Enter confirms

export function createRepl({ prompt, commands, onLine, onSigint }) {
  // ── Non-TTY fallback (piped input) ──
  if (!process.stdin.isTTY) {
    const queue = [];
    let processing = false;
    async function drain() {
      if (processing) return;
      processing = true;
      while (queue.length > 0) await onLine(queue.shift());
      processing = false;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: chalk.bold.white(prompt) });
    rl.prompt();
    rl.on("line", (line) => { queue.push(line.trim()); drain(); });
    rl.on("close", () => { if (!processing) process.exit(0); });
    process.on("SIGINT", () => onSigint?.());
    return { showPrompt: () => rl.prompt(), pause: () => {} };
  }

  // ── TTY mode: raw input with paste detection ──
  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.resume();

  // Enable bracket paste mode
  process.stdout.write("\x1b[?2004h");
  process.on("exit", () => {
    process.stdout.write("\x1b[?2004l");
    // Reset scroll region on exit (no save/restore needed at exit)
    if (scrollMode) {
      const rows = process.stdout.rows || 24;
      process.stdout.write(`\x1b[1;${rows}r`);
      process.stdout.write(`\x1b[${rows};1H`); // move cursor to bottom
    }
  });

  let buf = "";
  let cursor = 0;
  let selIdx = -1;
  let prevCursorRow = 0;   // which row (0-indexed) cursor was on after last render
  let paused = false;
  let scrollMode = false;  // scroll region active (bottom line reserved for input)
  let lastCtrlC = 0;       // timestamp of last Ctrl+C (for double-tap exit)
  let pausedCtrlC = 0;    // consecutive Ctrl+C count while paused (3 = force exit)

  // Paste state
  let bracketPasting = false;
  let pasteContent = "";  // multi-line/long paste waiting for confirmation
  let postPaste = "";     // text typed after the paste indicator

  const cmdEntries = commands.map(([cmd, desc]) => ({
    cmd, desc, lower: cmd.toLowerCase(),
  }));

  // ── Suggestion matching ──
  function getMatches() {
    if (!buf.startsWith("/") && !buf.startsWith("@")) return [];
    if (buf.includes(" ")) return [];
    const q = buf.toLowerCase();
    return cmdEntries.filter((e) => e.lower.startsWith(q));
  }

  // ── Position cursor at (row, col) relative to input start ──
  // Assumes cursor is already at (inputLastRow, inputLastCol) after writing content.
  function moveCursorTo(inputLastRow, cursorRow, cursorCol) {
    process.stdout.write(`\r`); // col 0 on inputLastRow
    if (inputLastRow > cursorRow) process.stdout.write(`\x1b[${inputLastRow - cursorRow}A`);
    if (cursorCol > 0) process.stdout.write(`\x1b[${cursorCol}C`);
  }

  // ── Rendering ──
  // clearSuggestions is now a no-op; render() uses \r\x1b[J to clear everything
  function clearSuggestions() {}

  function render() {
    const termW = process.stdout.columns || 80;
    const matches = getMatches();
    const promptStr = chalk.bold.white(prompt);
    const promptW = stringWidth(prompt);
    const cursorW = stringWidth(buf.slice(0, cursor));

    // Go back to start of previous render, then erase to end of screen
    if (prevCursorRow > 0) process.stdout.write(`\x1b[${prevCursorRow}A`);
    process.stdout.write(`\r\x1b[J`);
    prevCursorRow = 0;

    // ── Paste indicator ──
    if (pasteContent) {
      const lines = pasteContent.split("\n").length;
      const chars = pasteContent.length;
      const indicatorText = t("input.paste_indicator", { lines, chars });
      const indicatorW = indicatorText.length;
      const hint = t("input.paste_hint");
      process.stdout.write(`${promptStr}${buf}${chalk.bgYellow.black(indicatorText)}${postPaste}${chalk.dim(hint)}`);

      const cursorTotal = promptW + stringWidth(buf) + indicatorW + stringWidth(postPaste);
      const hintTotal   = cursorTotal + stringWidth(hint);
      const cursorRow = Math.floor(cursorTotal / termW);
      const cursorCol = cursorTotal % termW;
      const lastRow   = Math.floor(hintTotal / termW);

      moveCursorTo(lastRow, cursorRow, cursorCol);
      prevCursorRow = cursorRow;
      return;
    }

    // ── Normal input ──
    process.stdout.write(`${promptStr}${buf}`);
    const totalW = promptW + stringWidth(buf);
    const inputLastRow = Math.floor(totalW / termW);

    // Suggestions below the input
    if (matches.length > 0) {
      if (selIdx >= matches.length) selIdx = matches.length - 1;
      const maxShow = Math.min(matches.length, 8);
      for (let i = 0; i < maxShow; i++) {
        process.stdout.write("\n\x1b[2K");
        const m = matches[i];
        if (i === selIdx) {
          process.stdout.write(`  ${chalk.bgCyan.black(` ${m.cmd} `)} ${chalk.dim(m.desc)}`);
        } else {
          process.stdout.write(`  ${chalk.cyan(m.cmd)} ${chalk.dim(m.desc)}`);
        }
      }
      // Return to input last row
      process.stdout.write(`\x1b[${maxShow}A`);
    }

    // Position cursor within input
    const cursorTotal = promptW + cursorW;
    const cursorRow = Math.floor(cursorTotal / termW);
    const cursorCol = cursorTotal % termW;
    moveCursorTo(inputLastRow, cursorRow, cursorCol);
    prevCursorRow = cursorRow;
  }

  function submit() {
    const matches = getMatches();
    let line = buf;
    if (selIdx >= 0 && selIdx < matches.length) line = matches[selIdx].cmd;

    // Combine with paste content if present
    if (pasteContent) {
      line = (line || "") + pasteContent + postPaste;
      pasteContent = "";
      postPaste = "";
    }

    // Go back to start of input (handles multi-line case), clear to end of screen
    if (prevCursorRow > 0) process.stdout.write(`\x1b[${prevCursorRow}A`);
    process.stdout.write(`\r\x1b[J`);
    prevCursorRow = 0;

    const promptStr = chalk.bold.white(prompt);
    const displayLine = line.includes("\n")
      ? `${line.split("\n")[0].slice(0, 60)}... [${line.split("\n").length} lines]`
      : line;
    process.stdout.write(`${promptStr}${displayLine}\n`);

    buf = "";
    cursor = 0;
    selIdx = -1;
    onLine(line.trim());
  }

  function cancelPaste() {
    pasteContent = "";
    postPaste = "";
    render();
  }

  // ── Scroll-region input: fixed bottom line ──
  function updateFixedInput() {
    if (!scrollMode) return;
    const rows = process.stdout.rows || 24;
    const inputStr = buf ? `${chalk.dim("  > ")}${buf}` : chalk.dim("  > ");
    // Save cursor → draw on bottom row → restore cursor
    process.stdout.write(`\x1b7\x1b[${rows};1H\x1b[2K${inputStr}\x1b8`);
  }

  function showPrompt() {
    paused = false;
    pausedCtrlC = 0;
    scrollMode = false;
    render();
  }

  function pause() {
    paused = true;
    // Clear current render (go back to start, erase to end of screen)
    if (prevCursorRow > 0) process.stdout.write(`\x1b[${prevCursorRow}A`);
    process.stdout.write(`\r\x1b[J`);
    prevCursorRow = 0;
    // Note: no scroll region — DECSTBM causes terminals to buffer/hide output
    // until the region is reset, making agent responses appear to only show at
    // discussion end. Plain output scrolls correctly without it.
  }

  // Handle terminal resize — re-render prompt
  if (process.stdout.isTTY) {
    process.stdout.on("resize", () => {
      if (!paused) render();
    });
  }

  // ── Raw data handler ──
  // We handle stdin data directly instead of using emitKeypressEvents,
  // so we can properly detect bracket paste sequences and multi-char paste
  process.stdin.on("data", (data) => {
    let str = data;

    // ── Bracket paste detection ──
    // Start: \x1b[200~   End: \x1b[201~
    if (str.includes("\x1b[200~")) {
      bracketPasting = true;
      str = str.replace("\x1b[200~", "");
    }
    if (str.includes("\x1b[201~")) {
      bracketPasting = false;
      str = str.replace("\x1b[201~", "");
      if (str) pasteContent += str;
      // Normalize line endings
      pasteContent = pasteContent.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      // Short single-line paste → insert directly into buf (no indicator)
      const isShort = !pasteContent.includes("\n") && pasteContent.length <= 200;
      if (isShort) {
        buf = buf.slice(0, cursor) + pasteContent + buf.slice(cursor);
        cursor += pasteContent.length;
        pasteContent = "";
        postPaste = "";
      } else {
        // Long/multi-line paste → show indicator, cursor moves to end of buf
        cursor = buf.length;
        postPaste = "";
      }
      render();
      return;
    }
    if (bracketPasting) {
      pasteContent += str;
      return;
    }

    // ── Parse keypresses from data ──
    let i = 0;
    while (i < str.length) {
      const code = str.charCodeAt(i);

      // Escape sequences
      if (code === 0x1b && str[i + 1] === "[") {
        const rest = str.slice(i + 2);
        if (rest[0] === "A") { handleKey("up"); i += 3; continue; }
        if (rest[0] === "B") { handleKey("down"); i += 3; continue; }
        if (rest[0] === "C") { handleKey("right"); i += 3; continue; }
        if (rest[0] === "D") { handleKey("left"); i += 3; continue; }
        if (rest[0] === "H") { handleKey("home"); i += 3; continue; }
        if (rest[0] === "F") { handleKey("end"); i += 3; continue; }
        if (rest.startsWith("3~")) { handleKey("delete"); i += 4; continue; }
        // Skip unknown CSI sequences
        let j = 0;
        while (j < rest.length && rest.charCodeAt(j) >= 0x20 && rest.charCodeAt(j) <= 0x3f) j++;
        i += 2 + j + 1;
        continue;
      }
      // Lone escape = Esc key
      if (code === 0x1b) { handleKey("escape"); i++; continue; }

      if (code === 0x03) { handleKey("ctrl-c"); i++; continue; }  // Ctrl+C
      if (code === 0x04) { handleKey("ctrl-d"); i++; continue; }  // Ctrl+D
      if (code === 0x15) { handleKey("ctrl-u"); i++; continue; }  // Ctrl+U
      if (code === 0x0d) { handleKey("return"); i++; continue; }  // Enter
      if (code === 0x0a) { i++; continue; }                       // LF (skip, CR is enough)
      if (code === 0x09) { handleKey("tab"); i++; continue; }     // Tab
      if (code === 0x7f) { handleKey("backspace"); i++; continue; } // Backspace

      // Printable character (handle multi-byte UTF-8)
      if (code >= 0x20) {
        handleChar(str[i]);
      }
      i++;
    }
  });

  // ── Key handlers ──
  function handleKey(name) {
    // Ctrl+C: during discussion → stop signal; at prompt → clear input or double-tap to exit
    if (name === "ctrl-c") {
      if (paused) {
        pausedCtrlC++;
        if (pausedCtrlC >= 3) {
          // 3× Ctrl+C while stuck → force quit
          process.stdout.write("\n");
          console.log(chalk.yellow(t("input.force_exit")));
          process.exit(1);
        }
        const remaining = 3 - pausedCtrlC;
        process.stdout.write(`\n${chalk.dim(t("input.ctrlc_stop_hint", { n: remaining }))}\n`);
        clearSuggestions();
        pasteContent = "";
        onSigint?.();
        return;
      }
      pausedCtrlC = 0;
      // At idle prompt: if there's input, just clear it (like Claude Code)
      if (buf || pasteContent) {
        buf = "";
        cursor = 0;
        selIdx = -1;
        pasteContent = "";
        postPaste = "";
        clearSuggestions();
        process.stdout.write("\n");
        render();
        lastCtrlC = 0;
        return;
      }
      // Empty prompt: double-tap Ctrl+C to exit
      const now = Date.now();
      if (now - lastCtrlC < 1500) {
        clearSuggestions();
        console.log(chalk.dim(t("input.bye")));
        process.exit(0);
      }
      lastCtrlC = now;
      process.stdout.write(`\n${chalk.dim(t("input.ctrlc_hint"))}\n`);
      render();
      return;
    }

    // Escape → cancel paste if active, or clear input
    if (name === "escape") {
      if (pasteContent) { cancelPaste(); return; }
      if (buf) { buf = ""; cursor = 0; selIdx = -1; render(); }
      return;
    }

    // During discussion: only basic editing for interjections
    if (paused) {
      if (name === "return" && buf.trim()) {
        const text = buf.trim();
        buf = "";
        cursor = 0;
        updateFixedInput();
        onLine(text);
        return;
      }
      if (name === "backspace" && cursor > 0) {
        buf = buf.slice(0, cursor - 1) + buf.slice(cursor);
        cursor--;
        updateFixedInput();
      }
      return;
    }

    if (name === "ctrl-d") {
      clearSuggestions();
      console.log(chalk.dim(t("input.bye")));
      process.exit(0);
    }

    if (name === "ctrl-u") {
      buf = ""; cursor = 0; selIdx = -1;
      pasteContent = ""; postPaste = "";
      render();
      return;
    }

    if (name === "return") {
      if (!buf.trim() && !pasteContent) return;
      // If a suggestion is highlighted, accept it (like Tab) instead of submitting
      const matches = getMatches();
      if (selIdx >= 0 && selIdx < matches.length) {
        buf = matches[selIdx].cmd + " ";
        cursor = buf.length;
        selIdx = -1;
        render();
        return;
      }
      submit();
      return;
    }

    if (name === "tab") {
      const matches = getMatches();
      if (matches.length > 0) {
        if (selIdx < 0) selIdx = 0;
        buf = matches[selIdx].cmd + " ";
        cursor = buf.length;
        selIdx = -1;
        render();
      }
      return;
    }

    if (name === "up") {
      const matches = getMatches();
      if (matches.length > 0) {
        selIdx = selIdx <= 0 ? matches.length - 1 : selIdx - 1;
        render();
      }
      return;
    }
    if (name === "down") {
      const matches = getMatches();
      if (matches.length > 0) {
        selIdx = selIdx >= matches.length - 1 ? 0 : selIdx + 1;
        render();
      }
      return;
    }

    if (name === "left")  { if (cursor > 0) { cursor--; render(); } return; }
    if (name === "right") { if (cursor < buf.length) { cursor++; render(); } return; }
    if (name === "home")  { cursor = 0; render(); return; }
    if (name === "end")   { cursor = buf.length; render(); return; }

    if (name === "backspace") {
      if (pasteContent) {
        if (postPaste.length > 0) {
          postPaste = postPaste.slice(0, -1);
        } else {
          pasteContent = "";  // delete the whole paste block
        }
        render();
        return;
      }
      if (cursor > 0) {
        buf = buf.slice(0, cursor - 1) + buf.slice(cursor);
        cursor--;
        selIdx = -1;
        render();
      }
      return;
    }

    if (name === "delete") {
      if (cursor < buf.length) {
        buf = buf.slice(0, cursor) + buf.slice(cursor + 1);
        selIdx = -1;
        render();
      }
      return;
    }
  }

  function handleChar(ch) {
    if (paused) {
      buf = buf.slice(0, cursor) + ch + buf.slice(cursor);
      cursor++;
      updateFixedInput();
      return;
    }

    if (pasteContent) {
      postPaste += ch;
      render();
      return;
    }

    buf = buf.slice(0, cursor) + ch + buf.slice(cursor);
    cursor++;
    selIdx = -1;
    render();
  }

  // Draw initial prompt
  render();

  return { showPrompt, pause };
}
