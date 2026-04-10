import { spawn } from "child_process";
import chalk from "chalk";
import { getActiveAgents, getGlobalTimeout } from "./config.js";
import { t } from "./i18n.js";

// ─── Load agents from config at startup ─────────────────────────────
export const AGENTS = buildAgents(getActiveAgents());

// ─── Active process registry (for immediate kill on stop) ────────────
const activeProcs = new Set();

export function killActiveAgents() {
  for (const p of activeProcs) {
    try { p.kill("SIGKILL"); } catch {}
  }
  activeProcs.clear();
}

function buildAgents(defs) {
  const agents = {};
  for (const [key, def] of Object.entries(defs)) {
    const color = chalk.hex(def.color);
    const labelText = ` ${def.name.slice(0, 7).padEnd(7)} `;
    // Light bg → black text, dark bg → white text
    const label = isLightColor(def.color)
      ? chalk.bgHex(def.color).black(labelText)
      : chalk.bgHex(def.color).white(labelText);

    const modelTag = def.model ? chalk.dim(` (${def.model})`) : "";
    const displayName = def.model ? `${def.name} (${def.model})` : def.name;

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
function streamOpencode(proc, agent, silent, resolve, spinner, timedOutRef) {
  const startTime = Date.now();
  let firstChunk = true;
  let textBuffer = "";
  let rawBuffer = "";
  let stderr = "";

  function handleText(text) {
    textBuffer += text;
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

  proc.stderr.on("data", (d) => { stderr += d.toString(); });

  proc.on("close", (code) => {
    clearTimeout(timedOutRef?.killTimer);
    // Flush remaining buffer
    if (rawBuffer.trim()) {
      try {
        const obj = JSON.parse(rawBuffer.trim());
        if (obj.type === "text" && obj.part?.text) handleText(obj.part.text);
      } catch {}
    }
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    if (timedOutRef?.value) {
      spinner?.stop();
      if (!silent) {
        if (firstChunk) console.log(`${agent.label}`);
        console.log(`${agent.color("╰")} ${chalk.yellow(t("agents.timeout_label", { s: timedOutRef.timeoutSec }))}`);
      }
      resolve({ agent: agent.key, response: textBuffer.trim() || "", error: "timeout", timedOut: true, timeoutSec: timedOutRef.timeoutSec, elapsed: parseFloat(elapsed) });
      return;
    }
    if (!silent) {
      if (firstChunk) spinner?.stop(); // no output at all
      if (code !== 0 && !textBuffer.trim()) {
        if (firstChunk) console.log(`${agent.label}`);
        const errMsg = stderr.trim().split("\n")[0] || `exit code ${code}`;
        console.log(`${agent.color("│")} ${chalk.red("Error:")} ${errMsg}`);
      }
      const tokens = Math.ceil(textBuffer.length / 3);
      console.log(`${agent.color("╰")} ${chalk.dim(`${elapsed}s · ~${tokens} tokens`)}`);
    }
    resolve({ agent: agent.key, response: textBuffer.trim(), error: stderr.trim(), elapsed: parseFloat(elapsed) });
  });

  proc.on("error", (err) => {
    clearTimeout(timedOutRef?.killTimer);
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

function startSpinner(agent) {
  let i = 0;
  const base = `\r${agent.label} `;
  const thinkingText = t("spinner.thinking");
  process.stdout.write(`\n${base}${chalk.dim(`${SPINNER[0]} ${thinkingText}`)}`);
  const timer = setInterval(() => {
    i = (i + 1) % SPINNER.length;
    process.stdout.write(`\r${base}${chalk.dim(`${SPINNER[i]} ${thinkingText}`)}`);
  }, 80);
  return {
    stop() {
      clearInterval(timer);
      process.stdout.write("\x1b[2K\r");
    },
  };
}

// ─── Universal agent runner ──────────────────────────────────────────
export function runAgent(agentKey, prompt, { silent = false } = {}) {
  const agent = AGENTS[agentKey];
  if (!agent) return Promise.resolve({ agent: agentKey, response: "", error: `Agent "${agentKey}" not found or not enabled`, elapsed: 0 });

  return new Promise((resolve) => {
    const startTime = Date.now();
    const spinner = silent ? null : startSpinner(agent);

    const timeoutSec = agent.timeout || getGlobalTimeout();
    const timedOutRef = { value: false, killTimer: null, timeoutSec };

    const proc = spawn(agent.cmd, agent.buildArgs(prompt), {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    activeProcs.add(proc);
    proc.on("close", () => activeProcs.delete(proc));
    proc.on("error", () => activeProcs.delete(proc));

    timedOutRef.killTimer = setTimeout(() => {
      timedOutRef.value = true;
      proc.kill("SIGTERM");
      setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 1000);
    }, timeoutSec * 1000);

    if (agent.output === "ndjson") {
      streamOpencode(proc, agent, silent, resolve, spinner, timedOutRef);
      return;
    }

    // Plain text
    let firstChunk = true;
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      const text = data.toString();
      stdout += text;
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

    proc.stderr.on("data", (d) => { stderr += d.toString(); });

    proc.on("close", (code) => {
      clearTimeout(timedOutRef.killTimer);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      if (timedOutRef.value) {
        spinner?.stop();
        if (!silent) {
          if (firstChunk) console.log(`${agent.label}`);
          console.log(`${agent.color("╰")} ${chalk.yellow(t("agents.timeout_label", { s: timeoutSec }))}`);
        }
        resolve({ agent: agentKey, response: stdout.trim() || "", error: "timeout", timedOut: true, timeoutSec, elapsed: parseFloat(elapsed) });
        return;
      }
      if (!silent) {
        if (firstChunk) spinner?.stop(); // no output at all, stop spinner
        if (code !== 0 && !stdout.trim()) {
          if (firstChunk) console.log(`${agent.label}`);
          const errMsg = stderr.trim().split("\n")[0] || `exit code ${code}`;
          console.log(`${agent.color("│")} ${chalk.red("Error:")} ${errMsg}`);
        }
        const tokens = Math.ceil(stdout.length / 3);
        console.log(`${agent.color("╰")} ${chalk.dim(`${elapsed}s · ~${tokens} tokens`)}`);
      }
      resolve({ agent: agentKey, response: stdout.trim(), error: stderr.trim(), elapsed: parseFloat(elapsed) });
    });

    proc.on("error", (err) => {
      clearTimeout(timedOutRef.killTimer);
      spinner?.stop();
      if (!silent) {
        console.log(`${agent.label}`);
        console.log(`${agent.color("╰")} ${chalk.red(err.message)}`);
      }
      resolve({ agent: agentKey, response: "", error: err.message, elapsed: 0 });
    });
  });
}
