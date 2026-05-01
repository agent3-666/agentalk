import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "fs";
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
    args: ["exec", "--skip-git-repo-check", "--full-auto", "-s", "workspace-write", "{prompt}"],
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
    cmd: "agentalk-model",
    args: ["-m", "cursor/claude-3-5-sonnet-20241022", "{prompt}"],
    color: "#2E2E2E",
    output: "text",
    enabled: false,
    model: "cursor/claude-3-5-sonnet-20241022",
    note: "Cursor API (uses your Pro/Business subscription). Get key: cursor.com/settings → API Keys. Enable: /agents set-key cursor <key> && /agents enable cursor",
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
  {
    key: "deepseek",
    name: "DeepSeek V4 Pro",
    cmd: "agentalk-model",
    args: ["-m", "deepseek/deepseek-v4-pro", "{prompt}"],
    color: "#4D9BF0",
    output: "text",
    enabled: false,
    model: "deepseek/deepseek-v4-pro",
    note: "DeepSeek V4 Pro via official API. Set key: /agents set-key deepseek <key> then /agents enable deepseek",
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

// ─── Detect model name for Gemini CLI ───────────────────────────────
function detectGeminiModel() {
  try {
    const settings = JSON.parse(readFileSync(join(homedir(), ".gemini", "settings.json"), "utf8"));
    if (settings?.model) return settings.model;
  } catch {}
  return "gemini-2.5-pro"; // CLI default
}

// ─── Detect model name for Codex CLI ────────────────────────────────
function detectCodexModel() {
  try {
    const content = readFileSync(join(homedir(), ".codex", "config.toml"), "utf8");
    const match = content.match(/^model\s*=\s*"([^"]+)"/m);
    if (match) return match[1];
  } catch {}
  return "o3"; // CLI default
}

// ─── Detect model name for Claude Code ──────────────────────────────
// Reads the most recent Claude session file to find which model was used.
// Used for display only — does NOT inject --model into Claude's args.
function detectClaudeModel() {
  const projectsDir = join(homedir(), ".claude", "projects");
  if (!existsSync(projectsDir)) return null;
  try {
    let newest = null;
    let newestMtime = 0;
    for (const projDir of readdirSync(projectsDir)) {
      const projPath = join(projectsDir, projDir);
      try {
        for (const file of readdirSync(projPath)) {
          if (!file.endsWith(".jsonl")) continue;
          const fp = join(projPath, file);
          const mtime = statSync(fp).mtimeMs;
          if (mtime > newestMtime) { newestMtime = mtime; newest = fp; }
        }
      } catch {}
    }
    if (!newest) return null;
    const content = readFileSync(newest, "utf8");
    // Scan from the end — model field appears in assistant messages
    const lastChunk = content.slice(-12000);
    const lines = lastChunk.split("\n").reverse();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        const m = obj.message?.model || obj.model;
        if (m && typeof m === "string") return m;
      } catch {}
    }
  } catch {}
  return null;
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
    const defaultsByKey = Object.fromEntries(DEFAULT_AGENTS.map(d => [d.key, d]));

    // Append any new default agents not yet in user's config
    // Also soft-fill model from defaults when user's config has model=null
    let updated = false;
    for (const def of DEFAULT_AGENTS) {
      if (!existingKeys.has(def.key)) {
        saved.agents.push(def);
        updated = true;
      }
    }
    for (const agent of saved.agents) {
      const def = defaultsByKey[agent.key];
      if (def && agent.model == null && def.model != null) {
        agent.model = def.model;
        updated = true;
      }
      // Migrate: drop forced model overrides that were pinned in earlier defaults.
      // codex-mini-latest breaks with ChatGPT-subscription login; gemini-2.5-pro
      // was a soft preference, not a requirement. Fall back to each CLI's own
      // default — caller can set an explicit model via `/agents model <k> <m>`.
      if (agent.key === "codex" && agent.model === "codex-mini-latest") {
        agent.model = null;
        updated = true;
      }
      // Migrate: switch to workspace-write sandbox so codex can actually write files.
      // Old configs used -c sandbox_permissions=[disk-full-read-access] (read-only).
      if (agent.key === "codex" && !agent.args.includes("workspace-write")) {
        agent.args = defaultsByKey["codex"].args;
        updated = true;
      }
      if (agent.key === "gemini" && agent.model === "gemini-2.5-pro") {
        agent.model = null;
        updated = true;
      }
      // Migrate old cursor entry: cursor-agent doesn't exist → use agentalk-model API approach
      if (agent.key === "cursor" && agent.cmd === "cursor-agent") {
        agent.cmd = "agentalk-model";
        agent.args = ["-m", "cursor/claude-3-5-sonnet-20241022", "{prompt}"];
        agent.color = "#2E2E2E";
        agent.model = "cursor/claude-3-5-sonnet-20241022";
        agent.note = "Cursor API (uses your Pro/Business subscription). Get key: cursor.com/settings → API Keys. Enable: /agents set-key cursor <key> && /agents enable cursor";
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
  const defaultsByKey = Object.fromEntries(DEFAULT_AGENTS.map(d => [d.key, d]));

  // Detect Claude's current model once for all claude-keyed agents
  let claudeDetected = null;

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

    // displayModel: used for label/header only, never injected as --model arg.
    let displayModel = def.model || null;
    // Strip provider prefix (e.g. "deepseek/deepseek-v4-pro" → "deepseek-v4-pro")
    if (displayModel && displayModel.includes("/")) {
      const parts = displayModel.split("/");
      displayModel = parts[parts.length - 1];
    }
    if (!displayModel && def.key === "claude") {
      if (claudeDetected === null) claudeDetected = detectClaudeModel();
      displayModel = claudeDetected;
    }
    if (!displayModel && def.key === "gemini") displayModel = detectGeminiModel();
    if (!displayModel && def.key === "codex") displayModel = detectCodexModel();

    agents[def.key] = {
      key: def.key,
      name,
      cmd: def.cmd,
      args: def.args, // contains "{prompt}" and optionally "{model}" placeholders
      color: def.color,
      output: def.output || "text",
      model: def.model || null,
      displayModel,
      model_flag: def.model_flag || defaultsByKey[def.key]?.model_flag || null,
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
  // Insert before the last enabled agent (which acts as default moderator),
  // so new agents land at second-to-last and the moderator stays at the end.
  const enabledIndices = config.agents
    .map((a, i) => (a.enabled ? i : -1))
    .filter(i => i !== -1);
  if (enabledIndices.length > 0) {
    const lastEnabledIdx = enabledIndices[enabledIndices.length - 1];
    config.agents.splice(lastEnabledIdx, 0, { ...def, enabled: true });
  } else {
    config.agents.push({ ...def, enabled: true });
  }
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

// ─── Caller detection ────────────────────────────────────────────────
// Returns true when agentalk is running as a sub-process of Claude Code.
// Claude Code injects CLAUDECODE=1 into all child environments; --from-claude
// is the explicit flag users pass when invoking agentalk from Claude Code.
export function isCallerClaudeCode() {
  return process.env.CLAUDECODE === "1" || process.argv.includes("--from-claude");
}

export { CONFIG_PATH };
