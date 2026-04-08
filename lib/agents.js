import { spawn, spawnSync } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import chalk from "chalk";


function getOpencodeModel() {
  const dbPath = join(homedir(), ".local", "share", "opencode", "opencode.db");
  if (!existsSync(dbPath)) return "opencode";
  try {
    const result = spawnSync(
      "sqlite3",
      [dbPath, "SELECT json_extract(data,'$.modelID') FROM message WHERE json_extract(data,'$.role')='assistant' ORDER BY time_created DESC LIMIT 1;"],
      { encoding: "utf8" }
    );
    const model = result.stdout?.trim();
    // Shorten: "glm-5.1" → "GLM-5.1"
    return model ? model.toUpperCase() : "opencode";
  } catch {
    return "opencode";
  }
}

const opencodeModel = getOpencodeModel();

// ─── Agent Definitions ──────────────────────────────────────────────
export const AGENTS = {
  codex: {
    name: "Codex",
    color: chalk.hex("#10B981"),
    label: chalk.bgHex("#10B981").black(" Codex  "),
    cmd: "codex",
    args: (prompt) => ["exec", "--skip-git-repo-check", prompt],
    parseOutput: null,
  },
  gemini: {
    name: "Gemini",
    color: chalk.hex("#3B82F6"),
    label: chalk.bgHex("#3B82F6").white(" Gemini "),
    cmd: "gemini",
    args: (prompt) => ["-p", prompt],
    parseOutput: null,
  },
  opencode: {
    name: opencodeModel,
    color: chalk.hex("#A855F7"),
    label: chalk.bgHex("#A855F7").white(` ${opencodeModel.padEnd(7).slice(0, 7)} `),
    cmd: "opencode",
    args: (prompt) => ["run", prompt, "--format", "json"],
    // NDJSON parser: extract text from {"type":"text","part":{"text":"..."}} events
    parseOutput: (raw) => {
      const lines = raw.split("\n");
      return lines
        .map((line) => {
          try {
            const obj = JSON.parse(line);
            if (obj.type === "text" && obj.part?.text) return obj.part.text;
          } catch {}
          return "";
        })
        .join("");
    },
  },
  claude: {
    name: "Claude",
    color: chalk.hex("#D97706"),
    label: chalk.bgHex("#D97706").black(" Claude "),
    cmd: "claude",
    args: (prompt) => ["-p", prompt],
    parseOutput: null,
  },
};

// ─── Stream handler for opencode NDJSON ─────────────────────────────
function streamOpencode(proc, agent, silent, resolve) {
  const startTime = Date.now();
  let firstChunk = true;
  let textBuffer = "";
  let rawBuffer = "";

  proc.stdout.on("data", (data) => {
    rawBuffer += data.toString();
    // Parse complete lines
    const lines = rawBuffer.split("\n");
    rawBuffer = lines.pop(); // keep incomplete line

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === "text" && obj.part?.text) {
          const text = obj.part.text;
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
      } catch {}
    }
  });

  let stderr = "";
  proc.stderr.on("data", (d) => { stderr += d.toString(); });

  proc.on("close", (code) => {
    // Flush any remaining data in the buffer
    if (rawBuffer.trim()) {
      try {
        const obj = JSON.parse(rawBuffer.trim());
        if (obj.type === "text" && obj.part?.text) {
          const text = obj.part.text;
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
    resolve({ agent: "opencode", response: textBuffer.trim(), error: stderr.trim(), elapsed: parseFloat(elapsed) });
  });

  proc.on("error", (err) => {
    if (!silent) console.log(`${agent.color("╰")} ${chalk.red(err.message)}`);
    resolve({ agent: "opencode", response: "", error: err.message, elapsed: 0 });
  });
}

// ─── Universal agent runner ──────────────────────────────────────────
export function runAgent(agentKey, prompt, { silent = false } = {}) {
  const agent = AGENTS[agentKey];
  return new Promise((resolve) => {
    const startTime = Date.now();

    if (!silent) console.log(`\n${agent.label} ${chalk.dim("thinking...")}`);

    const proc = spawn(agent.cmd, agent.args(prompt), {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    // opencode uses NDJSON — special handler
    if (agentKey === "opencode") {
      streamOpencode(proc, agent, silent, resolve);
      return;
    }

    // Plain text output for claude / codex / gemini
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
