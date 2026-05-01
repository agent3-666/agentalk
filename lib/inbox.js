import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const INBOX_ROOT = join(homedir(), ".agentalk", "inbox");

function projectKeyFromPath(p) {
  return p.replace(/^\//, "").replace(/\//g, "-");
}

function fuzzyMatchProject(query) {
  if (!existsSync(INBOX_ROOT)) return null;
  const dirs = readdirSync(INBOX_ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
  const q = query.toLowerCase();
  return dirs.find(d => d.toLowerCase().includes(q)) || null;
}

function inboxDir(projectKey) {
  return join(INBOX_ROOT, projectKey);
}

function inboxFile(projectKey, agent) {
  return join(inboxDir(projectKey), agent ? `${agent}.json` : "_all.json");
}

function readMessages(projectKey, agent) {
  const files = agent
    ? [inboxFile(projectKey, agent), inboxFile(projectKey, null)]
    : [inboxFile(projectKey, null)];

  const messages = [];
  for (const f of files) {
    if (existsSync(f)) {
      try {
        const data = JSON.parse(readFileSync(f, "utf8"));
        messages.push(...(data.messages || []));
      } catch {}
    }
  }
  return messages.sort((a, b) => a.timestamp - b.timestamp);
}

function writeMessage(projectKey, agent, { from, content }) {
  const dir = inboxDir(projectKey);
  mkdirSync(dir, { recursive: true });
  const file = inboxFile(projectKey, agent);
  let data = { messages: [] };
  if (existsSync(file)) {
    try { data = JSON.parse(readFileSync(file, "utf8")); } catch {}
  }
  data.messages.push({ from, content, timestamp: Date.now(), read: false });
  writeFileSync(file, JSON.stringify(data, null, 2));
}

function markAllRead(projectKey, agent) {
  const files = agent
    ? [inboxFile(projectKey, agent), inboxFile(projectKey, null)]
    : [inboxFile(projectKey, null)];

  for (const f of files) {
    if (!existsSync(f)) continue;
    try {
      const data = JSON.parse(readFileSync(f, "utf8"));
      data.messages = data.messages.map(m => ({ ...m, read: true }));
      writeFileSync(f, JSON.stringify(data, null, 2));
    } catch {}
  }
}

function clearMessages(projectKey, agent) {
  const file = inboxFile(projectKey, agent);
  if (existsSync(file)) {
    writeFileSync(file, JSON.stringify({ messages: [] }, null, 2));
  }
}

function listProjects() {
  if (!existsSync(INBOX_ROOT)) return [];
  return readdirSync(INBOX_ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .flatMap(d => {
      const dir = join(INBOX_ROOT, d.name);
      const files = readdirSync(dir).filter(f => f.endsWith(".json"));
      return files.map(f => ({
        project: d.name,
        agent: f === "_all.json" ? null : f.replace(".json", ""),
        count: (() => {
          try {
            const data = JSON.parse(readFileSync(join(dir, f), "utf8"));
            return (data.messages || []).filter(m => !m.read).length;
          } catch { return 0; }
        })(),
      }));
    })
    .filter(e => e.count > 0);
}

export {
  projectKeyFromPath,
  fuzzyMatchProject,
  readMessages,
  writeMessage,
  markAllRead,
  clearMessages,
  listProjects,
  inboxFile,
};
