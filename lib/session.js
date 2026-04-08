import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const CLAUDE_PROJECTS = join(homedir(), ".claude", "projects");

function cwdToProjectKey(cwd) {
  // Claude replaces / and _ with -, keeps the leading -
  return cwd.replace(/[\/\_]/g, "-");
}

function extractMessages(jsonlPath, maxMessages = 20) {
  const lines = readFileSync(jsonlPath, "utf8").trim().split("\n");
  const messages = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "user" && entry.type !== "assistant") continue;

      const msg = entry.message;
      if (!msg?.content) continue;

      const contentArr = Array.isArray(msg.content)
        ? msg.content
        : [{ type: "text", text: msg.content }];

      const textParts = contentArr
        .filter((p) => p.type === "text" && p.text?.trim())
        .map((p) => p.text.trim());

      if (textParts.length === 0) continue;

      messages.push({ role: msg.role, content: textParts.join("\n") });
    } catch {
      // skip malformed lines
    }
  }

  return messages.slice(-maxMessages);
}

// Returns last N text messages from the most recent claude session in cwd
export function readClaudeSession(cwd = process.cwd(), maxMessages = 20) {
  try {
    const projectDir = join(CLAUDE_PROJECTS, cwdToProjectKey(cwd));
    if (!existsSync(projectDir)) return null;

    const files = readdirSync(projectDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ f, mtime: statSync(join(projectDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length === 0) return null;

    return extractMessages(join(projectDir, files[0].f), maxMessages);
  } catch {
    return null;
  }
}
