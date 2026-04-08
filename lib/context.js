import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import chalk from "chalk";
import { runAgent } from "./agents.js";

// 512k tokens ≈ 1.5M chars (mixed Chinese/English, ~3 chars/token)
const MAX_CHARS = 512_000 * 3;
const SESSIONS_DIR = join(homedir(), ".agentalking", "sessions");

function cwdToKey(cwd) {
  return cwd.replace(/\//g, "-").replace(/^-/, "");
}

function sessionPath(cwd) {
  return join(SESSIONS_DIR, `${cwdToKey(cwd)}.json`);
}

// Rough token estimate
function estimateTokens(text) {
  return Math.ceil(text.length / 3);
}

function totalChars(messages) {
  return messages.reduce((sum, m) => sum + m.content.length, 0);
}

export class ContextManager {
  constructor(cwd = process.cwd()) {
    this.cwd = cwd;
    this.messages = []; // { role, content, timestamp }
    this.path = sessionPath(cwd);
  }

  add(role, content) {
    this.messages.push({ role, content, timestamp: Date.now() });
    this._enforceLimit();
  }

  // Build a formatted prompt that includes the full conversation history
  buildPrompt(agentKey, instruction = "") {
    if (this.messages.length === 0) return instruction;

    const history = this.messages
      .map((m) => {
        const speaker = m.role === "user" ? "User" : m.role.charAt(0).toUpperCase() + m.role.slice(1);
        return `[${speaker}]\n${m.content}`;
      })
      .join("\n\n");

    return `${history}\n\n${instruction}`.trim();
  }

  stats() {
    const chars = totalChars(this.messages);
    const tokens = estimateTokens(this.messages.map((m) => m.content).join(" "));
    return { messages: this.messages.length, chars, tokens };
  }

  // ─── Persistence ────────────────────────────────────────────────
  save() {
    mkdirSync(SESSIONS_DIR, { recursive: true });
    writeFileSync(this.path, JSON.stringify({ cwd: this.cwd, messages: this.messages }, null, 2));
  }

  load() {
    if (!existsSync(this.path)) return false;
    try {
      const data = JSON.parse(readFileSync(this.path, "utf8"));
      this.messages = data.messages || [];
      return true;
    } catch {
      return false;
    }
  }

  clear() {
    this.messages = [];
  }

  // ─── Token limit enforcement ────────────────────────────────────
  async _enforceLimit() {
    if (totalChars(this.messages) <= MAX_CHARS) return;
    await this._compress();
  }

  // Compress: keep first + last 10 messages, summarize the middle
  async _compress() {
    if (this.messages.length <= 20) {
      // Just truncate oldest if too small to summarize
      this.messages = this.messages.slice(-20);
      return;
    }

    const keep_head = this.messages.slice(0, 2);
    const keep_tail = this.messages.slice(-10);
    const middle = this.messages.slice(2, -10);

    const middleText = middle
      .map((m) => `[${m.role}]: ${m.content.slice(0, 500)}`)
      .join("\n\n");

    console.log(chalk.dim("\n[Context] 超出 512k 上限，正在压缩历史..."));

    const result = await runAgent(
      "claude",
      `请将以下对话历史压缩为简洁摘要（保留关键决策、结论和上下文，不超过1000字）：\n\n${middleText}`,
      { silent: true }
    );

    const summary = {
      role: "system",
      content: `[历史摘要]\n${result.response}`,
      timestamp: Date.now(),
    };

    this.messages = [...keep_head, summary, ...keep_tail];
    console.log(chalk.dim("[Context] 压缩完成"));
  }
}
