import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { spawnSync } from "child_process";
import { homedir } from "os";
import { join } from "path";

const CONFIG_DIR = join(homedir(), ".agentalk");
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
    model: null,
    model_flag: "--model",
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
    model: null,
    model_flag: "-m",
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
    model: null,
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
    model: null,
    model_flag: "--model",
    note: "Anthropic Claude Code",
  },
  // ── Disabled by default (install to enable) ──────────────────────
  {
    key: "cline",
    name: "Cline",
    cmd: "cline",
    args: ["-y", "{prompt}"],
    color: "#EF4444",
    output: "text",
    enabled: false,
    note: "Cline AI coding agent. Install: npm i -g cline",
  },
  {
    key: "continue",
    name: "Continue",
    cmd: "cn",
    args: ["-p", "{prompt}"],
    color: "#14B8A6",
    output: "text",
    enabled: false,
    note: "Continue dev CLI. Install: npm install -g @continuedev/cli",
  },
  {
    key: "copilot",
    name: "Copilot",
    cmd: "copilot",
    args: ["-p", "{prompt}"],
    color: "#8B5CF6",
    output: "text",
    enabled: false,
    note: "GitHub Copilot CLI. Install: npm install -g @github/copilot",
  },
  {
    key: "devin",
    name: "Devin",
    cmd: "devin",
    args: ["-p", "{prompt}"],
    color: "#06B6D4",
    output: "text",
    enabled: false,
    note: "Devin for Terminal. Install: https://cli.devin.ai",
  },
  {
    key: "trae",
    name: "Trae",
    cmd: "trae",
    args: ["run", "{prompt}"],
    color: "#F97316",
    output: "text",
    enabled: false,
    note: "Trae agent CLI (ByteDance). Install: https://trae.ai",
  },
  {
    key: "goose",
    name: "Goose",
    cmd: "goose",
    args: ["run", "--text", "{prompt}"],
    color: "#059669",
    output: "text",
    enabled: false,
    note: "Goose AI coding agent (Block). Install: brew install goose / pipx install goose-ai",
  },
  {
    key: "openhands",
    name: "OpenHands",
    cmd: "openhands",
    args: ["--headless", "-t", "{prompt}"],
    color: "#0EA5E9",
    output: "text",
    enabled: false,
    note: "OpenHands (ex OpenDevin). Install: pip install openhands",
  },
  {
    key: "plandex",
    name: "Plandex",
    cmd: "plandex",
    args: ["tell", "-f", "-", "--bg", "{prompt}"],
    color: "#84CC16",
    output: "text",
    enabled: false,
    note: "Plandex CLI (large codebase planning). Install: curl -sL https://plandex.ai/install.sh | bash",
  },
  {
    key: "sweagent",
    name: "SWE-agent",
    cmd: "sweagent",
    args: ["run", "--task", "{prompt}"],
    color: "#7C3AED",
    output: "text",
    enabled: false,
    note: "SWE-agent (GitHub issue solver). Install: pip install sweagent",
  },
  {
    key: "aider",
    name: "Aider",
    cmd: "aider",
    args: ["--message", "{prompt}", "--yes-always", "--no-git", "--no-auto-commits"],
    color: "#EC4899",
    output: "text",
    enabled: false,
    note: "Aider AI coding assistant. Install: pip install aider-chat",
    model: null,
    model_flag: "--model",
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
    args: ["run", "{model}", "{prompt}"],
    color: "#6B7280",
    output: "text",
    enabled: false,
    note: "Ollama local models. Use /agents model ollama <model> to switch. Install: ollama.com",
    model: "llama3",
  },
  {
    key: "cursor",
    name: "Cursor",
    cmd: "cursor-agent",
    args: ["-p", "{prompt}"],
    color: "#000000",
    output: "text",
    enabled: false,
    note: "Cursor AI coding agent CLI. Install: npm install -g cursor-cli",
  },
  {
    key: "kiro",
    name: "Kiro",
    cmd: "kiro-cli",
    args: ["chat", "--no-interactive", "{prompt}"],
    color: "#5B21B6",
    output: "text",
    enabled: false,
    note: "Kiro AI coding agent (Amazon). Install: curl -fsSL https://cli.kiro.dev/install | bash",
  },
  {
    key: "cody",
    name: "Cody",
    cmd: "cody",
    args: ["chat", "-m", "{prompt}"],
    color: "#FF5543",
    output: "text",
    enabled: false,
    note: "Sourcegraph Cody AI assistant. Install: npm install -g @sourcegraph/cody",
  },
  {
    key: "tabnine",
    name: "Tabnine",
    cmd: "tabnine",
    args: ["-y", "-p", "{prompt}"],
    color: "#0074FF",
    output: "text",
    enabled: false,
    note: "Tabnine AI coding assistant. Install: https://www.tabnine.com/install/cli",
  },
  {
    key: "oz",
    name: "Warp(oz)",
    cmd: "oz",
    args: ["agent", "run", "--prompt", "{prompt}"],
    color: "#01A4FF",
    output: "text",
    enabled: false,
    note: "Warp oz agent CLI (Warp terminal). Install: https://docs.warp.dev/features/warp-ai/oz",
  },
  {
    key: "pieces",
    name: "Pieces",
    cmd: "pieces",
    args: ["ask", "{prompt}"],
    color: "#19A974",
    output: "text",
    enabled: false,
    note: "Pieces for Developers CLI. Install: brew install pieces-cli",
  },
  {
    key: "kimi",
    name: "Kimi",
    cmd: "kimi",
    args: ["--print", "-p", "{prompt}"],
    color: "#FF6B35",
    output: "text",
    enabled: false,
    model: null,
    model_flag: "--model",
    note: "Kimi Code CLI (Moonshot AI). Install: pip install kimi-cli",
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

// ─── Timeout helpers ─────────────────────────────────────────────────
export function getGlobalTimeout() {
  const config = loadConfig();
  return (typeof config.timeout === "number") ? config.timeout : 180;
}

export function setGlobalTimeout(seconds) {
  const s = parseInt(seconds);
  if (isNaN(s) || s <= 0) return { ok: false, msg: `Invalid timeout: ${seconds}` };
  const config = loadConfig();
  config.timeout = s;
  saveConfig(config);
  return { ok: true, msg: `Global timeout set to ${s}s` };
}

export function setAgentTimeout(key, seconds) {
  const config = loadConfig();
  const agent = config.agents.find(a => a.key === key);
  if (!agent) return { ok: false, msg: `Agent not found: ${key}` };
  if (seconds == null) {
    delete agent.timeout;
    saveConfig(config);
    return { ok: true, msg: `${agent.name} timeout reset to global` };
  }
  const s = parseInt(seconds);
  if (isNaN(s) || s <= 0) return { ok: false, msg: `Invalid timeout: ${seconds}` };
  agent.timeout = s;
  saveConfig(config);
  return { ok: true, msg: `${agent.name} timeout set to ${s}s` };
}

// ─── Load config, merging new default agents into existing config ────
export function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
    const config = { agents: DEFAULT_AGENTS };
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    return config;
  }
  try {
    const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    const existingKeys = new Set(saved.agents.map(a => a.key));

    // Append any new default agents not yet in user's config
    let updated = false;
    for (const def of DEFAULT_AGENTS) {
      if (!existingKeys.has(def.key)) {
        saved.agents.push(def);
        updated = true;
      }
    }
    if (updated) writeFileSync(CONFIG_PATH, JSON.stringify(saved, null, 2));
    return saved;
  } catch {
    return { agents: DEFAULT_AGENTS };
  }
}

export function resetConfig() {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const config = { agents: DEFAULT_AGENTS };
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  return config;
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
      args: def.args, // contains "{prompt}" and optionally "{model}" placeholders
      color: def.color,
      output: def.output || "text",
      model: def.model || null,
      model_flag: def.model_flag || null,
      note: def.note || "",
      timeout: (typeof def.timeout === "number") ? def.timeout : null,
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

export function setAgentModel(key, model) {
  const config = loadConfig();
  const agent = config.agents.find(a => a.key === key);
  if (!agent) return { ok: false, msg: `未找到 agent: ${key}` };
  const prev = agent.model;
  agent.model = model || null;
  saveConfig(config);
  const display = model || "(default)";
  return { ok: true, msg: `${agent.name} model: ${prev || "(default)"} → ${display}` };
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

// ─── Moderator configuration ─────────────────────────────────────────
// The moderator runs convergence checks and generates summaries.
// Falls back to the first active agent if not explicitly set.
export function getModeratorKey() {
  const config = loadConfig();
  return config.moderator || null;
}

export function setModerator(key) {
  const config = loadConfig();
  const agent = config.agents.find(a => a.key === key);
  if (!agent) return { ok: false, msg: `Agent not found: ${key}` };
  config.moderator = key;
  saveConfig(config);
  return { ok: true, msg: `Moderator set to ${agent.name}` };
}

// ─── Agent order ──────────────────────────────────────────────────────
// Reorder agents: provided keys move to the front in given order,
// remaining agents follow in their current order.
export function reorderAgents(keys) {
  const config = loadConfig();
  for (const key of keys) {
    if (!config.agents.find(a => a.key === key)) {
      return { ok: false, msg: `Agent not found: ${key}` };
    }
  }
  const keySet = new Set(keys);
  const front = keys.map(k => config.agents.find(a => a.key === k));
  const rest  = config.agents.filter(a => !keySet.has(a.key));
  config.agents = [...front, ...rest];
  saveConfig(config);
  return { ok: true, msg: `Order updated: ${keys.join(" → ")}` };
}

export { CONFIG_PATH };
