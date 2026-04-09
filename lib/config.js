import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { spawnSync } from "child_process";
import { homedir } from "os";
import { join } from "path";

const CONFIG_DIR = join(homedir(), ".agentalking");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

// ─── Default agent registry ──────────────────────────────────────────
// output: "text" | "ndjson"
// detect_name: if true, auto-detect model name at runtime
// extra_args: prepended before {prompt} in args
const DEFAULT_AGENTS = [
  {
    key: "codex",
    name: "Codex",
    cmd: "codex",
    args: ["exec", "--skip-git-repo-check", "{prompt}"],
    color: "#10B981",
    output: "text",
    enabled: true,
    note: "OpenAI Codex CLI",
  },
  {
    key: "gemini",
    name: "Gemini",
    cmd: "gemini",
    args: ["-p", "{prompt}"],
    color: "#3B82F6",
    output: "text",
    enabled: true,
    note: "Google Gemini CLI",
  },
  {
    key: "opencode",
    name: "OpenCode",
    cmd: "opencode",
    args: ["run", "{prompt}", "--format", "json"],
    color: "#A855F7",
    output: "ndjson",
    detect_name: true,
    enabled: true,
    note: "OpenCode CLI (supports GLM, GPT, etc.)",
  },
  {
    key: "claude",
    name: "Claude",
    cmd: "claude",
    args: ["-p", "{prompt}"],
    color: "#D97706",
    output: "text",
    enabled: true,
    note: "Anthropic Claude Code",
  },
  {
    key: "aider",
    name: "Aider",
    cmd: "aider",
    args: ["--message", "{prompt}", "--yes-always", "--no-git", "--no-auto-commits"],
    color: "#EC4899",
    output: "text",
    enabled: false,
    note: "Aider AI coding assistant (aider.chat). Run: pip install aider-chat",
  },
  {
    key: "q",
    name: "Amazon Q",
    cmd: "q",
    args: ["chat", "--no-interactive", "{prompt}"],
    color: "#F59E0B",
    output: "text",
    enabled: false,
    note: "Amazon Q Developer CLI. Install: https://aws.amazon.com/q/developer",
  },
  {
    key: "ollama",
    name: "Ollama",
    cmd: "ollama",
    args: ["run", "llama3", "{prompt}"],
    color: "#6B7280",
    output: "text",
    enabled: false,
    note: "Ollama local models. Change 'llama3' in args to your model. Install: ollama.com",
  },
];

// ─── Detect model name for opencode ─────────────────────────────────
function detectOpencodeModel() {
  const dbPath = join(homedir(), ".local", "share", "opencode", "opencode.db");
  if (!existsSync(dbPath)) return null;
  try {
    const result = spawnSync(
      "sqlite3",
      [dbPath, "SELECT json_extract(data,'$.modelID') FROM message WHERE json_extract(data,'$.role')='assistant' ORDER BY time_created DESC LIMIT 1;"],
      { encoding: "utf8" }
    );
    const model = result.stdout?.trim();
    return model ? model.toUpperCase() : null;
  } catch {
    return null;
  }
}

// ─── Check if a command is installed ────────────────────────────────
function isInstalled(cmd) {
  const result = spawnSync("which", [cmd], { encoding: "utf8" });
  return result.status === 0;
}

// ─── Load config (create with defaults if missing) ───────────────────
export function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
    const config = { agents: DEFAULT_AGENTS };
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    return config;
  }
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return { agents: DEFAULT_AGENTS };
  }
}

export function saveConfig(config) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ─── Get active (enabled + installed) agents as runtime objects ──────
export function getActiveAgents() {
  const config = loadConfig();
  const agents = {};

  for (const def of config.agents) {
    if (!def.enabled) continue;
    if (!isInstalled(def.cmd)) continue;

    // Resolve display name
    let name = def.name;
    if (def.detect_name) {
      if (def.key === "opencode") {
        name = detectOpencodeModel() || def.name;
      }
    }

    agents[def.key] = {
      key: def.key,
      name,
      cmd: def.cmd,
      args: def.args, // contains "{prompt}" placeholder
      color: def.color,
      output: def.output || "text",
      note: def.note || "",
    };
  }

  return agents;
}

// ─── Config mutation helpers ─────────────────────────────────────────
export function enableAgent(key) {
  const config = loadConfig();
  const agent = config.agents.find(a => a.key === key);
  if (!agent) return { ok: false, msg: `未找到 agent: ${key}` };
  agent.enabled = true;
  saveConfig(config);
  return { ok: true, msg: `已启用 ${agent.name}` };
}

export function disableAgent(key) {
  const config = loadConfig();
  const agent = config.agents.find(a => a.key === key);
  if (!agent) return { ok: false, msg: `未找到 agent: ${key}` };
  agent.enabled = false;
  saveConfig(config);
  return { ok: true, msg: `已禁用 ${agent.name}` };
}

export function addAgent(def) {
  const config = loadConfig();
  if (config.agents.find(a => a.key === def.key)) {
    return { ok: false, msg: `Key "${def.key}" 已存在，请用不同的 key` };
  }
  config.agents.push({ ...def, enabled: true });
  saveConfig(config);
  return { ok: true, msg: `已添加 ${def.name}` };
}

export function removeAgent(key) {
  const config = loadConfig();
  const idx = config.agents.findIndex(a => a.key === key);
  if (idx === -1) return { ok: false, msg: `未找到 agent: ${key}` };
  const name = config.agents[idx].name;
  config.agents.splice(idx, 1);
  saveConfig(config);
  return { ok: true, msg: `已删除 ${name}` };
}

export function listAgents() {
  const config = loadConfig();
  return config.agents.map(a => ({
    ...a,
    installed: isInstalled(a.cmd),
  }));
}

export { CONFIG_PATH };
