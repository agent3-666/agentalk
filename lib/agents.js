import { spawn } from "child_process";
import chalk from "chalk";
import { getActiveAgents } from "./config.js";

// ─── Load agents from config at startup ─────────────────────────────
export const AGENTS = buildAgents(getActiveAgents());

function buildAgents(defs) {
  const agents = {};
  for (const [key, def] of Object.entries(defs)) {
    const color = chalk.hex(def.color);
    const labelText = ` ${def.name.slice(0, 7).padEnd(7)} `;
    // Light bg → black text, dark bg → white text
    const label = isLightColor(def.color)
      ? chalk.bgHex(def.color).black(labelText)
      : chalk.bgHex(def.color).white(labelText);

    agents[key] = {
      key,
      name: def.name,
      color,
      label,
      cmd: def.cmd,
      output: def.output,
      // Build args array, replacing {prompt} placeholder at call time
      buildArgs: (prompt) => def.args.map(a => a === "{prompt}" ? prompt : a),
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
function streamOpencode(proc, agent, silent, resolve) {
  const startTime = Date.now();
  let firstChunk = true;
  let textBuffer = "";
  let rawBuffer = "";
  let stderr = "";

  function handleText(text) {
    textBuffer += text;
    if (!silent) {
      if (firstChunk) {
        process.stdout.write("\x1b[1A\x1b[2K");
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
    // Flush remaining buffer
    if (rawBuffer.trim()) {
      try {
        const obj = JSON.parse(rawBuffer.trim());
        if (obj.type === "text" && obj.part?.text) handleText(obj.part.text);
      } catch {}
    }
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    if (!silent) {
      if (code !== 0 && !textBuffer.trim()) {
        const errMsg = stderr.trim().split("\n")[0] || `exit code ${code}`;
        console.log(`${agent.color("│")} ${chalk.red("Error:")} ${errMsg}`);
      }
      const tokens = Math.ceil(textBuffer.length / 3);
      console.log(`${agent.color("╰")} ${chalk.dim(`${elapsed}s · ~${tokens} tokens`)}`);
    }
    resolve({ agent: agent.key, response: textBuffer.trim(), error: stderr.trim(), elapsed: parseFloat(elapsed) });
  });

  proc.on("error", (err) => {
    if (!silent) console.log(`${agent.color("╰")} ${chalk.red(err.message)}`);
    resolve({ agent: agent.key, response: "", error: err.message, elapsed: 0 });
  });
}

// ─── Universal agent runner ──────────────────────────────────────────
export function runAgent(agentKey, prompt, { silent = false } = {}) {
  const agent = AGENTS[agentKey];
  if (!agent) return Promise.resolve({ agent: agentKey, response: "", error: `Agent "${agentKey}" not found or not enabled`, elapsed: 0 });

  return new Promise((resolve) => {
    const startTime = Date.now();
    if (!silent) console.log(`\n${agent.label} ${chalk.dim("thinking...")}`);

    const proc = spawn(agent.cmd, agent.buildArgs(prompt), {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    if (agent.output === "ndjson") {
      streamOpencode(proc, agent, silent, resolve);
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
          process.stdout.write("\x1b[1A\x1b[2K");
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
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      if (!silent) {
        if (code !== 0 && !stdout.trim()) {
          const errMsg = stderr.trim().split("\n")[0] || `exit code ${code}`;
          console.log(`${agent.color("│")} ${chalk.red("Error:")} ${errMsg}`);
        }
        const tokens = Math.ceil(stdout.length / 3);
        console.log(`${agent.color("╰")} ${chalk.dim(`${elapsed}s · ~${tokens} tokens`)}`);
      }
      resolve({ agent: agentKey, response: stdout.trim(), error: stderr.trim(), elapsed: parseFloat(elapsed) });
    });

    proc.on("error", (err) => {
      if (!silent) console.log(`${agent.color("╰")} ${chalk.red(err.message)}`);
      resolve({ agent: agentKey, response: "", error: err.message, elapsed: 0 });
    });
  });
}
