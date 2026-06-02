// ─── Session discovery: scan ~/.claude/projects/ ───────────────────
// Claude Code stores one directory per cwd under ~/.claude/projects/.
// Each dir holds N session JSONL files. Every JSONL event carries a
// `cwd` field — we use that as the authoritative cwd (dirname encoding
// is lossy when the original path contains `-`).
//
// This module is read-only and side-effect-free. Used by:
//   - resolveSession() in supervisor.js — fallback when @<name> misses
//     the explicit registry
//   - `agentalk-delegate sessions` — list discoverable sessions

import { existsSync, readdirSync, statSync, readFileSync } from "fs";
import { homedir } from "os";
import { join, basename } from "path";

const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

function readAuthoritativeCwd(jsonlPath) {
  try {
    const text = readFileSync(jsonlPath, "utf-8");
    const lines = text.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      const i = line.indexOf('"cwd"');
      if (i === -1) continue;
      try {
        const obj = JSON.parse(line);
        if (typeof obj.cwd === "string" && obj.cwd.startsWith("/")) return obj.cwd;
      } catch { /* skip */ }
    }
  } catch { /* unreadable */ }
  return null;
}

// Scan all Claude Code project dirs. Returns one entry per cwd.
// Shape:
//   {
//     cwd:            "/Users/x/proj",
//     basename:       "proj",
//     latest_session: "abc123",     // jsonl basename without .jsonl
//     last_active:    1715000000000,  // ms epoch
//     session_count:  3,
//   }
// Sorted by last_active desc.
export function scanClaudeProjects() {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return [];
  let dirs;
  try { dirs = readdirSync(CLAUDE_PROJECTS_DIR); } catch { return []; }
  const out = [];
  for (const dir of dirs) {
    const full = join(CLAUDE_PROJECTS_DIR, dir);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (!st.isDirectory()) continue;
    let files;
    try { files = readdirSync(full); } catch { continue; }
    const jsonls = files.filter(f => f.endsWith(".jsonl"));
    if (jsonls.length === 0) continue;
    let latestFile = null, latestMtime = 0;
    for (const f of jsonls) {
      try {
        const m = statSync(join(full, f)).mtimeMs;
        if (m > latestMtime) { latestMtime = m; latestFile = f; }
      } catch { /* skip */ }
    }
    if (!latestFile) continue;
    const cwd = readAuthoritativeCwd(join(full, latestFile));
    if (!cwd) continue;
    out.push({
      cwd,
      basename: basename(cwd),
      latest_session: latestFile.replace(/\.jsonl$/, ""),
      last_active: latestMtime,
      session_count: jsonls.length,
    });
  }
  out.sort((a, b) => b.last_active - a.last_active);
  return out;
}

// Try to find a single project matching `query`. Resolution order:
//   1. exact cwd path
//   2. exact basename (case-sensitive)
//   3. exact basename (case-insensitive)
//   4. unique substring match on basename
// Returns:
//   - { match: <project> } on unique hit
//   - { ambiguous: true, candidates: [...] } on multiple matches
//   - null on no match
//
// `projects` is optional (caller can pass a cached scan).
export function resolveSessionByScan(query, projects = null) {
  if (!query) return null;
  const all = projects || scanClaudeProjects();
  if (all.length === 0) return null;

  // 1. exact cwd path
  if (query.startsWith("/")) {
    const exact = all.find(p => p.cwd === query);
    if (exact) return { match: exact };
  }

  // 2. exact basename, case-sensitive
  let hits = all.filter(p => p.basename === query);
  if (hits.length === 1) return { match: hits[0] };
  if (hits.length > 1) return { ambiguous: true, candidates: hits };

  // 3. exact basename, case-insensitive
  const q = query.toLowerCase();
  hits = all.filter(p => p.basename.toLowerCase() === q);
  if (hits.length === 1) return { match: hits[0] };
  if (hits.length > 1) return { ambiguous: true, candidates: hits };

  // 4. substring match on basename (case-insensitive)
  hits = all.filter(p => p.basename.toLowerCase().includes(q));
  if (hits.length === 1) return { match: hits[0] };
  if (hits.length > 1) return { ambiguous: true, candidates: hits };

  return null;
}

export function relativeTimeAgo(ms) {
  const diff = Date.now() - ms;
  const s = Math.max(0, Math.floor(diff / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
