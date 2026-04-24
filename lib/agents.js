import { spawn } from "child_process";
import chalk from "chalk";
import { getActiveAgents, getGlobalTimeout } from "./config.js";
import { t } from "./i18n.js";

// ─── Load agents from config at startup ─────────────────────────────
export const AGENTS = buildAgents(getActiveAgents());

// ─── Shared stop signal ──────────────────────────────────────────────
// Single source of truth for "user wants to stop". Every in-flight runAgent
// watches this and resolves early when it flips true. discuss.js re-exports
// these for index.js, so CLI code doesn't need to know about agents.js.
export const stopSignal = { requested: false };
export function requestStop() { stopSignal.requested = true; }
export function clearStop() { stopSignal.requested = false; }

// ─── Background process cleanup on exit ─────────────────────────────
// We never kill agent processes mid-discussion — just stop waiting for them.
// They're cleaned up when agentalk exits.
const bgProcs = new Set();
process.on("exit", () => {
  for (const p of bgProcs) { try { p.kill("SIGKILL"); } catch {} }
});

function buildAgents(defs) {
  const agents = {};
  for (const [key, def] of Object.entries(defs)) {
    const color = chalk.hex(def.color);
    const labelText = ` ${def.name.slice(0, 7).padEnd(7)} `;
    // Light bg → black text, dark bg → white text
    const label = isLightColor(def.color)
      ? chalk.bgHex(def.color).black(labelText)
      : chalk.bgHex(def.color).white(labelText);

    const shownModel = def.displayModel || def.model || null;
    const modelTag = shownModel ? chalk.dim(` (${shownModel})`) : "";
    const displayName = shownModel ? `${def.name} (${shownModel})` : def.name;

    agents[key] = {
      key,
      name: def.name,
      displayName,
      color,
      label: label + modelTag,
      cmd: def.cmd,
      output: def.output,
      model: def.model || null,
      timeout: def.timeout || null,
      // Build args array, replacing {prompt} and {model} placeholders at call time
      // If model_flag is set and model is set, prepend [flag, model] to args
      buildArgs: (prompt) => {
        let args = def.args.map(a => {
          if (a === "{prompt}") return prompt;
          if (a === "{model}" && def.model) return def.model;
          return a;
        });
        // flag-based model injection (skip if args already has {model} placeholder)
        if (def.model && def.model_flag && !def.args.includes("{model}")) {
          args = [def.model_flag, def.model, ...args];
        }
        return args;
      },
    };
  }
  return agents;
}

function isLightColor(hex) {
  // Simple luminance check
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 128;
}

// ─── Stream handler for opencode NDJSON ─────────────────────────────
function streamOpencode(proc, agent, silent, resolve, spinner, settledRef, onStdout, onStderr) {
  const startTime = Date.now();
  let firstChunk = true;
  let textBuffer = "";
  let rawBuffer = "";
  let stderr = "";

  function handleText(text) {
    if (settledRef?.value) return;
    textBuffer += text;
    if (onStdout) { try { onStdout(text); } catch {} }
    if (!silent) {
      if (firstChunk) {
        spinner?.stop();
        console.log(`${agent.label}`);
        firstChunk = false;
      }
      for (const l of text.split("\n")) {
        if (l.trim()) console.log(`${agent.color("│")} ${l}`);
      }
    }
  }

  proc.stdout.on("data", (data) => {
    rawBuffer += data.toString();
    const lines = rawBuffer.split("\n");
    rawBuffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === "text" && obj.part?.text) handleText(obj.part.text);
      } catch {}
    }
  });

  proc.stderr.on("data", (d) => {
    const text = d.toString();
    stderr += text;
    if (onStderr) { try { onStderr(text); } catch {} }
  });

  proc.on("close", (code) => {
    if (settledRef?.value) return; // already resolved by timeout or stop
    // Flush remaining buffer
    if (rawBuffer.trim()) {
      try {
        const obj = JSON.parse(rawBuffer.trim());
        if (obj.type === "text" && obj.part?.text) handleText(obj.part.text);
      } catch {}
    }
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const tokens = { total: Math.ceil(textBuffer.length / 3), estimated: true };
    if (!silent) {
      if (firstChunk) spinner?.stop(); // no output at all
      if (code !== 0 && !textBuffer.trim()) {
        if (firstChunk) console.log(`${agent.label}`);
        const errMsg = stderr.trim().split("\n")[0] || `exit code ${code}`;
        console.log(`${agent.color("│")} ${chalk.red("Error:")} ${errMsg}`);
      }
      console.log(`${agent.color("╰")} ${chalk.dim(`${elapsed}s · ~${tokens.total} tokens`)}`);
    }
    resolve({ agent: agent.key, response: textBuffer.trim(), error: stderr.trim(), elapsed: parseFloat(elapsed), tokens });
  });

  proc.on("error", (err) => {
    if (settledRef?.value) return;
    spinner?.stop();
    if (!silent) {
      console.log(`${agent.label}`);
      console.log(`${agent.color("╰")} ${chalk.red(err.message)}`);
    }
    resolve({ agent: agent.key, response: "", error: err.message, elapsed: 0 });
  });
}

// ─── Spinner for "thinking…" state ──────────────────────────────────
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`;
}

function startSpinner(agent, timeoutSec) {
  let i = 0;
  const startTime = Date.now();
  const base = `\r${agent.label} `;
  const thinkingText = t("spinner.thinking");

  function timeStr() {
    const elapsed = Date.now() - startTime;
    const elapsedFmt = fmtElapsed(elapsed);
    if (!timeoutSec) return ` ${elapsedFmt}`;
    const remaining = Math.max(0, timeoutSec * 1000 - elapsed);
    return ` ${elapsedFmt} / ${fmtElapsed(remaining)} left`;
  }

  process.stdout.write(`\n${base}${chalk.dim(`${SPINNER[0]} ${thinkingText}${timeStr()}`)}`);
  const timer = setInterval(() => {
    i = (i + 1) % SPINNER.length;
    process.stdout.write(`\r${base}${chalk.dim(`${SPINNER[i]} ${thinkingText}${timeStr()}`)}`);
  }, 200);
  return {
    stop() {
      clearInterval(timer);
      process.stdout.write("\x1b[2K\r");
    },
  };
}

// ─── Universal agent runner ──────────────────────────────────────────
// Uses Promise.race between the agent process, a timeout, and a stop-signal
// poll. On any of those winning, settledRef flips true — all stream handlers
// read it and become no-ops so no stale output leaks to the terminal.
// Cleanup clears the timeout/poll to prevent leaked handles keeping the event
// loop alive.
//
// The underlying child process is NOT killed (by design: some CLIs do
// expensive bookkeeping on exit). It keeps running in bgProcs until exit.
export function runAgent(agentKey, prompt, { silent = false, timeout: timeoutOverride, onStdout, onStderr } = {}) {
  const agent = AGENTS[agentKey];
  if (!agent) return Promise.resolve({ agent: agentKey, response: "", error: `Agent "${agentKey}" not found or not enabled`, elapsed: 0 });

  // Fast path: user already requested stop before we were called. Don't spawn
  // anything, don't show a spinner, just resolve as stopped.
  if (stopSignal.requested) {
    return Promise.resolve({ agent: agentKey, response: "", error: "stopped", stopped: true, elapsed: 0 });
  }

  const timeoutSec = timeoutOverride ?? agent.timeout ?? getGlobalTimeout();
  const startTime = Date.now();
  const spinner = silent ? null : startSpinner(agent, timeoutSec);

  // settledRef: once true, every stream handler/close handler becomes a no-op.
  // This is how we prevent stale output after stop/timeout.
  const settledRef = { value: false };

  let timeoutId = null;
  let stopPollId = null;
  const cleanup = () => {
    if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
    if (stopPollId) { clearInterval(stopPollId); stopPollId = null; }
  };

  const agentPromise = new Promise((resolve) => {
    const proc = spawn(agent.cmd, agent.buildArgs(prompt), {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    bgProcs.add(proc);
    proc.on("close", () => bgProcs.delete(proc));
    proc.on("error", () => bgProcs.delete(proc));

    if (agent.output === "ndjson") {
      streamOpencode(proc, agent, silent, resolve, spinner, settledRef, onStdout, onStderr);
      return;
    }

    // Plain text
    let firstChunk = true;
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      if (settledRef.value) return;
      const text = data.toString();
      stdout += text;
      if (onStdout) { try { onStdout(text); } catch {} }
      if (!silent) {
        if (firstChunk) {
          spinner?.stop();
          console.log(`${agent.label}`);
          firstChunk = false;
        }
        for (const line of text.split("\n")) {
          if (line.trim()) console.log(`${agent.color("│")} ${line}`);
        }
      }
    });

    proc.stderr.on("data", (d) => {
      const text = d.toString();
      stderr += text;
      if (onStderr) { try { onStderr(text); } catch {} }
    });

    proc.on("close", (code) => {
      if (settledRef.value) return; // already resolved by timeout / stop
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      // Parse real token usage if the subprocess emitted [USAGE] on stderr
      const usageMatch = stderr.match(/\[USAGE\] prompt=(\d+) completion=(\d+) total=(\d+)/);
      const tokens = usageMatch
        ? { prompt: +usageMatch[1], completion: +usageMatch[2], total: +usageMatch[3], estimated: false }
        : { total: Math.ceil(stdout.length / 3), estimated: true };
      // Strip [USAGE] line from stderr so it doesn't surface as an error
      const cleanErr = stderr.replace(/\[USAGE\][^\n]*\n?/, "").trim();
      const hasError = code !== 0 && !stdout.trim();
      if (!silent) {
        if (firstChunk) spinner?.stop();
        if (hasError) {
          if (firstChunk) console.log(`${agent.label}`);
          const errMsg = cleanErr.split("\n")[0] || `exit code ${code}`;
          console.log(`${agent.color("│")} ${chalk.red("Error:")} ${errMsg}`);
        }
        const tokLabel = tokens.estimated ? `~${tokens.total}` : `${tokens.total}`;
        console.log(`${agent.color("╰")} ${chalk.dim(`${elapsed}s · ${tokLabel} tokens`)}`);
      }
      resolve({ agent: agentKey, response: stdout.trim(), error: cleanErr, inlineShown: !silent && hasError, elapsed: parseFloat(elapsed), tokens });
    });

    proc.on("error", (err) => {
      if (settledRef.value) return;
      spinner?.stop();
      if (!silent) {
        console.log(`${agent.label}`);
        console.log(`${agent.color("╰")} ${chalk.red(err.message)}`);
      }
      resolve({ agent: agentKey, response: "", error: err.message, inlineShown: !silent, elapsed: 0 });
    });
  });

  const timeoutPromise = new Promise(resolve => {
    timeoutId = setTimeout(() => {
      if (settledRef.value) { resolve({ agent: agentKey, response: "", error: "", elapsed: 0 }); return; }
      settledRef.value = true;
      spinner?.stop();
      if (!silent) {
        console.log(`${agent.label}`);
        console.log(`${agent.color("╰")} ${chalk.yellow(t("agents.timeout_label", { s: timeoutSec }))}`);
      }
      resolve({ agent: agentKey, response: "", error: "timeout", timedOut: true, timeoutSec, elapsed: timeoutSec });
    }, timeoutSec * 1000);
  });

  const stopPromise = new Promise(resolve => {
    // Fast path: already stopped before we even started
    if (stopSignal.requested) {
      settledRef.value = true;
      spinner?.stop();
      resolve({ agent: agentKey, response: "", error: "stopped", stopped: true, elapsed: 0 });
      return;
    }
    stopPollId = setInterval(() => {
      if (stopSignal.requested && !settledRef.value) {
        settledRef.value = true;
        spinner?.stop();
        resolve({ agent: agentKey, response: "", error: "stopped", stopped: true, elapsed: 0 });
      }
    }, 50);
  });

  return Promise.race([agentPromise, timeoutPromise, stopPromise])
    .then((result) => { cleanup(); return result; });
}
