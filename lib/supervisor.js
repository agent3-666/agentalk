// ─── Supervisor: deterministic orchestration kernel ─────────────────
// The supervisor is code, not an LLM. It owns task lifecycle state,
// observes quota signals, and executes delegations. The main agent (LLM)
// decides WHAT to delegate; this kernel just does it reliably.
//
// Contract:
//   - Never calls any LLM directly — reuses runAgent() from agents.js
//   - All state persists to files before returning to the caller
//   - Quota is OBSERVED (parsing CLI errors), not predicted

import {
  readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync,
  renameSync, unlinkSync,
} from "fs";
import { homedir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { spawn } from "child_process";
import { runAgent, AGENTS } from "./agents.js";

// ─── Atomic write ──────────────────────────────────────────────────
// Write to `path.tmp` then rename. On POSIX, rename is atomic — readers
// never see a half-written file. Protects quota.json / task.json from
// torn-write corruption if the process dies mid-write.
function atomicWriteJson(path, obj) {
  const data = JSON.stringify(obj, null, 2);
  const tmp = `${path}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
}

// ─── Paths ──────────────────────────────────────────────────────────
const AGENTALK_HOME = join(homedir(), ".agentalk");
const TASKS_DIR = join(AGENTALK_HOME, "tasks");
const QUOTA_PATH = join(AGENTALK_HOME, "quota.json");
const CAPABILITY_PATH = join(AGENTALK_HOME, "capability.json");
const DELEGATIONS_LOG = join(AGENTALK_HOME, "delegations.jsonl");
const SESSIONS_PATH = join(AGENTALK_HOME, "sessions.json");

function ensureHome() {
  if (!existsSync(AGENTALK_HOME)) mkdirSync(AGENTALK_HOME, { recursive: true });
  if (!existsSync(TASKS_DIR)) mkdirSync(TASKS_DIR, { recursive: true });
}

function ensureProjectDir(cwd) {
  const dir = join(cwd, ".agentalk");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function projectMemoryPath(cwd) {
  return join(cwd, ".agentalk", "memory.jsonl");
}

// ─── Task state (JSONL event stream, Claude Code-style) ───────────
// Each task = one .jsonl file, append-only event stream. Current state
// is DERIVED by folding events. No separate task.json — the log IS the
// storage. Advantages:
//   · One file per task (matches Claude Code's session model)
//   · appendFileSync is atomic per-line — no torn-write risk
//   · stdout/stderr chunks are events too, so partial output on timeout
//     is automatically preserved (no special branch needed)
//   · Replayable / inspectable with `cat` or `jq`
function makeTaskId() {
  const ts = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const rand = randomBytes(3).toString("hex");
  return `t_${ts}_${rand}`;
}

function taskJsonlPath(id) { return join(TASKS_DIR, `${id}.jsonl`); }
function legacyTaskJsonPath(id) { return join(TASKS_DIR, `${id}.json`); }

// Emit a single event to the task's jsonl. Non-fatal if write fails
// (caller shouldn't crash because we couldn't log; quota observation
// still returns the diagnostics result).
function emit(taskId, event) {
  try {
    ensureHome();
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n";
    appendFileSync(taskJsonlPath(taskId), line);
  } catch (err) {
    // Non-fatal: log to stderr but let the caller continue.
    // (Missing events hurt debuggability but don't crash the delegation.)
  }
}

// Read every event for a task. Returns [] if missing/unreadable.
export function readTaskEvents(id) {
  const p = taskJsonlPath(id);
  if (!existsSync(p)) return [];
  try {
    return readFileSync(p, "utf-8").trim().split("\n")
      .filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// Fold events → current task state. Event types:
//   task_created, step_added, step_started, stdout, stderr,
//   step_completed, task_updated
function foldEvents(events) {
  if (!events.length) return null;
  let task = null;
  for (const e of events) {
    const ts = e.ts;
    if (e.type === "task_created") {
      task = {
        id: e.id,
        created_at: ts,
        updated_at: ts,
        status: "pending",
        origin: e.origin,
        plan: { intent: e.intent, steps: [] },
        checkpoints: [{ ts, event: "created" }],
        resume_hint: null,
      };
    } else if (!task) {
      continue; // events before task_created are ignored
    } else if (e.type === "step_added") {
      task.plan.steps.push({
        id: e.step_id,
        status: "pending",
        brief: e.brief,
        agent: e.agent,
      });
      task.checkpoints.push({ ts, step: e.step_id, event: "step_added" });
      task.updated_at = ts;
    } else if (e.type === "step_started") {
      const s = task.plan.steps.find(x => x.id === e.step_id);
      if (s) { s.status = "running"; s.started_at = ts; }
      task.checkpoints.push({ ts, step: e.step_id, event: "running" });
      // Any step running → task is running
      if (task.plan.steps.some(x => x.status === "running")) task.status = "running";
      task.updated_at = ts;
    } else if (e.type === "stdout" || e.type === "stderr") {
      // Chunk events are stored raw in the jsonl; for the folded state
      // we just track that output happened (counts/sizes could go here
      // later). Raw retrieval uses tail/readTaskEvents directly.
      task.updated_at = ts;
    } else if (e.type === "step_completed") {
      const s = task.plan.steps.find(x => x.id === e.step_id);
      if (s) {
        s.status = e.status;
        s.result = e.result;
        s.diagnostics = e.diagnostics;
        s.tokens = e.tokens;
        s.elapsed_ms = e.elapsed_ms;
        s.completed_at = ts;
      }
      task.checkpoints.push({ ts, step: e.step_id, event: e.status });
      // Roll up task status. Treat "partial" as a non-failure but non-done
      // terminal state — user/main agent needs to decide what to do next.
      const statuses = task.plan.steps.map(x => x.status);
      if (statuses.some(x => x === "running")) task.status = "running";
      else if (statuses.every(x => x === "done")) task.status = "done";
      else if (statuses.some(x => x === "failed" || x === "partial")) task.status = "partial";
      task.updated_at = ts;
    } else if (e.type === "task_updated") {
      if (e.status) task.status = e.status;
      if (e.resume_hint !== undefined) task.resume_hint = e.resume_hint;
      task.updated_at = ts;
    }
  }
  return task;
}

// Concatenate the stdout text of a given step (or all steps) from jsonl.
// Used by: timeout partial-recovery, --resume-step, `tail` subcommand.
export function readTaskOutput(id, { stepId = null, stream = "stdout" } = {}) {
  const events = readTaskEvents(id);
  let out = "";
  for (const e of events) {
    if (e.type !== stream) continue;
    if (stepId && e.step_id !== stepId) continue;
    out += e.data || "";
  }
  return out;
}

export function createTask({ intent, mainAgent = "main", sessionRef = null }) {
  ensureHome();
  const id = makeTaskId();
  emit(id, {
    type: "task_created",
    id,
    intent,
    origin: { main_agent: mainAgent, session_ref: sessionRef },
  });
  return getTask(id);
}

export function getTask(id) {
  // Primary: read jsonl event stream
  const events = readTaskEvents(id);
  if (events.length) return foldEvents(events);

  // Legacy fallback: tasks created before the JSONL refactor used
  // <id>.json. Still readable, but new tasks should use jsonl. We can
  // drop this fallback after a few weeks when no legacy tasks remain.
  const legacy = legacyTaskJsonPath(id);
  if (existsSync(legacy)) {
    try { return JSON.parse(readFileSync(legacy, "utf-8")); } catch { return null; }
  }
  return null;
}

export function addTaskStep(taskId, step) {
  const task = getTask(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  const id = `s${task.plan.steps.length + 1}`;
  emit(taskId, {
    type: "step_added",
    step_id: id,
    brief: step.brief,
    agent: step.agent,
  });
  return { id, status: "pending", brief: step.brief, agent: step.agent };
}

export function updateTaskStep(taskId, stepId, update) {
  const task = getTask(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  const step = task.plan.steps.find(s => s.id === stepId);
  if (!step) throw new Error(`Step ${stepId} not found in task ${taskId}`);

  if (update.status === "running") {
    emit(taskId, { type: "step_started", step_id: stepId });
  } else if (update.status === "done" || update.status === "failed" || update.status === "partial") {
    emit(taskId, {
      type: "step_completed",
      step_id: stepId,
      status: update.status,
      result: update.result,
      diagnostics: update.diagnostics,
      tokens: update.tokens,
      elapsed_ms: update.elapsed_ms,
    });
  } else {
    // Catch-all — generic status update (rare)
    emit(taskId, { type: "task_updated", status: update.status });
  }
  return { ...step, ...update };
}

// ─── Quota observer ────────────────────────────────────────────────
// These patterns are heuristic — agent CLI outputs vary. The main agent
// reads diagnostics and decides; so false negatives just miss a warning
// rather than corrupt state. Add patterns here as we see real failures.
const QUOTA_PATTERNS = [
  { re: /\b429\b/i,                              outcome: "quota_exceeded", detail: "HTTP 429" },
  { re: /rate[\s_-]?limit/i,                     outcome: "quota_exceeded", detail: "rate limited" },
  { re: /quota[^.\n]{0,30}exceed/i,              outcome: "quota_exceeded", detail: "quota exceeded" },
  { re: /usage[^.\n]{0,30}(limit|exceed)/i,      outcome: "quota_exceeded", detail: "usage limit" },
  { re: /insufficient[^.\n]{0,20}(credit|balance|quota)/i, outcome: "quota_exceeded", detail: "insufficient balance" },
  { re: /(401|403)\b/,                           outcome: "auth_failed",    detail: "auth error" },
  { re: /unauthoriz(ed|ation)/i,                 outcome: "auth_failed",    detail: "unauthorized" },
  { re: /invalid[^.\n]{0,10}(key|token|credential)/i, outcome: "auth_failed", detail: "invalid credentials" },
  { re: /invalid_request_error|\bbad[\s_]?request\b/i, outcome: "bad_request", detail: "bad request (check model/args)" },
];

export function parseQuotaSignal(result) {
  // Timeouts surface through runAgent's result shape
  if (result.timedOut) {
    return { outcome: "timeout", detail: `timed out after ${result.timeoutSec}s`, reset_hint: null };
  }
  if (result.stopped) {
    return { outcome: "stopped", detail: "user stopped", reset_hint: null };
  }

  // Only scan stderr for failure signals. result.response is the agent's
  // content output — it frequently quotes code or text containing tokens
  // like "401", "unauthorized", "rate limit" which would cause false
  // positives if treated as quota/auth signals.
  const errBlob = result.error || "";
  for (const { re, outcome, detail } of QUOTA_PATTERNS) {
    if (re.test(errBlob)) {
      const hint = errBlob.match(/(resets?\s+in\s+[\d\w\s]+|retry[^\n]{0,30}\d+)/i);
      return { outcome, detail, reset_hint: hint ? hint[0].trim() : null };
    }
  }
  // No response + error → generic failure
  if (!result.response?.trim() && result.error) {
    return { outcome: "failed", detail: result.error.slice(0, 200), reset_hint: null };
  }
  return { outcome: "ok", detail: null, reset_hint: null };
}

export function readQuotaState() {
  ensureHome();
  if (!existsSync(QUOTA_PATH)) {
    const seed = {};
    for (const key of Object.keys(AGENTS)) {
      seed[key] = { status: "unknown", last_signal: null, last_checked: null };
    }
    atomicWriteJson(QUOTA_PATH, seed);
    return seed;
  }
  try { return JSON.parse(readFileSync(QUOTA_PATH, "utf-8")); } catch { return {}; }
}

export function updateQuotaState(agent, signal) {
  const state = readQuotaState();
  state[agent] = state[agent] || {};
  state[agent].status = signal.outcome === "ok" ? "available" : signal.outcome;
  state[agent].last_signal = signal;
  state[agent].last_checked = new Date().toISOString();
  atomicWriteJson(QUOTA_PATH, state);
  return state[agent];
}

// ─── Capability registry ───────────────────────────────────────────
// Each entry has:
//   strengths / context_window / cost_tier / good_for / weakness  — technical profile
//   billing: "subscription" | "pay_per_call" | "free"              — how user pays
//   priority: "preferred" | "normal" | "avoid" | "main"            — user's delegation preference
//   note: human-readable description                               — shown in `capabilities` output
//
// Users edit ~/.agentalk/capability.json to override any of these. The skill reads
// `priority` + `billing` and picks delegates accordingly — subscription+preferred first,
// avoid last, main only if explicitly asked (it's typically the calling agent itself).
const DEFAULT_CAPABILITIES = {
  claude: {
    billing: "subscription",
    priority: "main",
    note: "Claude Max/Pro — usually the main agent; don't delegate to self by default",
    strengths: ["reasoning", "code", "long-form writing", "architecture"],
    context_window: 200000,
    cost_tier: "premium",
    good_for: ["complex reasoning", "code review", "multi-file refactors"],
    weakness: ["realtime web data"],
  },
  codex: {
    billing: "subscription",
    priority: "preferred",
    note: "ChatGPT Pro / Codex CLI subscription — fast for code & shell",
    strengths: ["code generation", "shell commands", "quick iteration"],
    context_window: 128000,
    cost_tier: "mid",
    good_for: ["quick code edits", "one-shot scripts", "CLI-heavy tasks", "bug hunting"],
    weakness: ["deep architectural reasoning"],
  },
  gemini: {
    billing: "subscription",
    priority: "preferred",
    note: "Gemini Plus subscription — 2M context is unique, best for long docs / PDFs / full-repo scans",
    strengths: ["long context", "multimodal", "document analysis"],
    context_window: 2000000,
    cost_tier: "mid",
    good_for: ["reading large docs", "PDF analysis", "whole-codebase scans", "bug fixing in big files"],
    weakness: ["some coding benchmarks"],
  },
  opencode: {
    billing: "subscription",
    priority: "preferred",
    note: "OpenCode running GLM Pro — cheap subscription, strong on Chinese & translation",
    strengths: ["flexible backend (GLM/GPT/...)", "chinese", "low cost"],
    context_window: 128000,
    cost_tier: "low",
    good_for: ["translation", "simple tasks", "chinese text work", "cost-sensitive bulk jobs"],
    weakness: ["model depends on backend config"],
  },
};

// Stub for agents not in DEFAULT_CAPABILITIES (typically API models added via
// `agentalk-model` — which charge per call). Users can override in capability.json.
function stubCapability(agentKey) {
  const agent = AGENTS[agentKey];
  const isApiModel = agent?.cmd === "agentalk-model";
  return {
    billing: isApiModel ? "pay_per_call" : "unknown",
    priority: isApiModel ? "normal" : "normal",
    note: isApiModel
      ? `API-backed model via agentalk-model — charged per call, use sparingly`
      : "",
    strengths: [],
    context_window: 0,
    cost_tier: "unknown",
    good_for: [],
    weakness: [],
  };
}

export function readCapabilities() {
  ensureHome();
  if (!existsSync(CAPABILITY_PATH)) {
    // First run: seed with defaults + stubs for any custom agents.
    const seed = {};
    for (const key of Object.keys(AGENTS)) {
      seed[key] = DEFAULT_CAPABILITIES[key] || stubCapability(key);
    }
    atomicWriteJson(CAPABILITY_PATH, seed);
    return seed;
  }
  try {
    const loaded = JSON.parse(readFileSync(CAPABILITY_PATH, "utf-8"));
    let migrated = false;
    // Ensure every active agent has an entry; backfill missing fields from
    // defaults (so new schema fields propagate on upgrade without losing user edits).
    for (const key of Object.keys(AGENTS)) {
      if (!loaded[key]) {
        loaded[key] = DEFAULT_CAPABILITIES[key] || stubCapability(key);
        migrated = true;
        continue;
      }
      const def = DEFAULT_CAPABILITIES[key] || stubCapability(key);
      for (const field of Object.keys(def)) {
        if (loaded[key][field] === undefined) {
          loaded[key][field] = def[field];
          migrated = true;
        }
      }
    }
    if (migrated) {
      try { atomicWriteJson(CAPABILITY_PATH, loaded); } catch { /* non-fatal */ }
    }
    return loaded;
  } catch {
    return { ...DEFAULT_CAPABILITIES };
  }
}

// ─── Memory (project-scoped, JSONL append-only) ────────────────────
// JSONL avoids the concurrent-write corruption that editable markdown
// would hit with multiple concurrent main-agent sessions on one repo.
export function rememberFact(cwd, { fact, context = null, taskId = null }) {
  ensureProjectDir(cwd);
  const record = {
    ts: new Date().toISOString(),
    fact: String(fact).trim(),
    context: context ? String(context).trim() : null,
    task_id: taskId,
  };
  appendFileSync(projectMemoryPath(cwd), JSON.stringify(record) + "\n");
  return record;
}

export function recallMemory(cwd, { limit = 50 } = {}) {
  const p = projectMemoryPath(cwd);
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, "utf-8").trim().split("\n").filter(Boolean);
  return lines.slice(-limit)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

// ─── Session registry ──────────────────────────────────────────────
// Users register named pointers to specific Claude Code sessions (or
// "latest in cwd" if no session_id). Delegation targets of the form
// `@<name>` resolve to (cwd, session_id) and spawn claude --resume
// (with --no-session-persistence so we don't pollute the live session).
//
// Phase 1: claude only (Codex/Gemini session resume semantics differ —
// add when their stories mature).
export function readSessions() {
  ensureHome();
  if (!existsSync(SESSIONS_PATH)) return {};
  try { return JSON.parse(readFileSync(SESSIONS_PATH, "utf-8")); } catch { return {}; }
}

export function writeSessions(obj) {
  ensureHome();
  atomicWriteJson(SESSIONS_PATH, obj);
}

export function registerSession(name, { cwd, sessionId = null, agent = "claude" }) {
  if (!name || /[^a-zA-Z0-9_-]/.test(name)) {
    throw new Error(`Invalid session name "${name}". Use alphanumeric + _ -.`);
  }
  if (!cwd) throw new Error("cwd is required");
  if (!existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`);
  const sessions = readSessions();
  sessions[name] = {
    cwd,
    session_id: sessionId,
    agent,
    registered_at: new Date().toISOString(),
  };
  writeSessions(sessions);
  return sessions[name];
}

export function unregisterSession(name) {
  const sessions = readSessions();
  if (!sessions[name]) return false;
  delete sessions[name];
  writeSessions(sessions);
  return true;
}

export function getSession(name) {
  return readSessions()[name] || null;
}

// ─── Callee-side inbox (transparency to the delegated session) ────
// When a delegation targets @name, we append a lightweight record to
// <callee-cwd>/.agentalk/inbox.jsonl — so when that session is next
// used (by user or by another delegation), it can see "I've been
// called at time X with question Y, gave answer Z-preview".
export function appendInbox(calleeCwd, record) {
  try {
    ensureProjectDir(calleeCwd);
    const p = join(calleeCwd, ".agentalk", "inbox.jsonl");
    appendFileSync(p, JSON.stringify({
      ts: new Date().toISOString(), ...record,
    }) + "\n");
    return p;
  } catch {
    return null; // non-fatal
  }
}

export function readInbox(cwd, { limit = 50 } = {}) {
  const p = join(cwd, ".agentalk", "inbox.jsonl");
  if (!existsSync(p)) return [];
  try {
    const lines = readFileSync(p, "utf-8").trim().split("\n").filter(Boolean);
    return lines.slice(-limit)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ─── Delegation log (global, append-only) ──────────────────────────
// Non-fatal: if the log can't be written, don't break the delegation —
// the task state file is the authoritative record. We still surface the
// failure via return value so callers can warn if they care.
export function logDelegation(record) {
  try {
    ensureHome();
    appendFileSync(DELEGATIONS_LOG, JSON.stringify({
      ts: new Date().toISOString(), ...record,
    }) + "\n");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─── Brief-in / brief-out protocol ─────────────────────────────────
function buildBriefInPrompt(brief, cwd) {
  const lines = [];
  lines.push("You are being delegated a sub-task by a main AI agent.");
  lines.push("");
  lines.push("## Task");
  lines.push(brief.task || "(no task description provided)");
  if (brief.files?.length) {
    lines.push("");
    lines.push(`## Files (paths relative to ${cwd})`);
    for (const f of brief.files) lines.push(`- ${f}`);
  }
  if (brief.context) {
    lines.push("");
    lines.push("## Background");
    lines.push(brief.context);
  }
  if (brief.output) {
    lines.push("");
    lines.push("## Expected output");
    lines.push(brief.output);
  }
  if (brief.budget) {
    lines.push("");
    lines.push("## Budget");
    lines.push(brief.budget);
  }
  if (brief.main_memory_path) {
    lines.push("");
    lines.push("## Reference (optional)");
    lines.push(`Main agent's memory: ${brief.main_memory_path}`);
    lines.push("(Read only if you need broader project context — usually not required.)");
  }
  lines.push("");
  lines.push("## Response format (IMPORTANT)");
  lines.push("Structure your reply with exactly these three section markers so the orchestrator can parse it:");
  lines.push("");
  lines.push("---FINDINGS---");
  lines.push("(your main result — concise, this is what the main agent will read)");
  lines.push("");
  lines.push("---ARTIFACTS---");
  lines.push("(one path per line for any files you created or modified; omit section if none)");
  lines.push("");
  lines.push("---UNKNOWNS---");
  lines.push("(anything you could not determine or that needs a different agent; omit section if none)");
  return lines.join("\n");
}

function parseBriefOut(text) {
  const out = { findings: null, artifacts: [], unknowns: [] };
  if (!text) return out;

  const grab = (marker) => {
    const re = new RegExp(`---${marker}---([\\s\\S]*?)(?=---(?:FINDINGS|ARTIFACTS|UNKNOWNS)---|$)`);
    const m = text.match(re);
    return m ? m[1].trim() : null;
  };

  const findings = grab("FINDINGS");
  const artifacts = grab("ARTIFACTS");
  const unknowns = grab("UNKNOWNS");

  // Fallback: if no markers present, treat entire response as findings
  if (findings === null && artifacts === null && unknowns === null) {
    out.findings = text.trim();
    return out;
  }

  out.findings = findings;
  if (artifacts) {
    out.artifacts = artifacts.split("\n")
      .map(l => l.replace(/^[-*\s]+/, "").trim())
      .filter(Boolean);
  }
  if (unknowns) {
    out.unknowns = unknowns.split("\n")
      .map(l => l.replace(/^[-*\s]+/, "").trim())
      .filter(Boolean);
  }
  return out;
}

function suggestAlternatives(failedAgent, quotas, capabilities) {
  const available = Object.entries(quotas)
    .filter(([k, v]) => k !== failedAgent && (v.status === "available" || v.status === "unknown"))
    .map(([k]) => k);
  if (!available.length) return "no alternative agents currently available";
  const ranked = available.sort((a, b) => {
    const ta = capabilities?.[a]?.cost_tier, tb = capabilities?.[b]?.cost_tier;
    const order = { low: 0, mid: 1, premium: 2, unknown: 3 };
    return (order[ta] ?? 3) - (order[tb] ?? 3);
  });
  return `try one of: ${ranked.join(", ")}`;
}

// ─── System-error shape (returned on IO/unexpected failure) ────────
// Never throw from delegate() — the main agent should always get a
// diagnostics-shaped result so it can reason about the failure.
function systemErrorResult(agent, err) {
  return {
    status: "system_error",
    agent: agent || null,
    task_id: null,
    step_id: null,
    findings: null,
    artifacts: [],
    unknowns: [],
    raw_response: null,
    diagnostics: {
      outcome: "system_error",
      detail: (err?.message || String(err)).slice(0, 400),
      reset_hint: null,
      suggestion: "check disk space, ~/.agentalk/ permissions, or file locking issues",
      elapsed_ms: 0,
      tokens: null,
    },
  };
}

// ─── The main primitive: delegate ──────────────────────────────────
// Called by the main agent (via MCP tool). Creates task state, runs the
// delegate CLI, observes outcome, returns structured result with
// diagnostics so the main agent can decide next steps.
//
// Error policy:
//   - Validation errors (bad agent name, missing brief.task) throw — caller bug
//   - Runtime failures (IO, etc.) are caught and returned as system_error
export async function delegate(params) {
  // Validation: fail loudly on caller bugs
  if (!AGENTS[params?.agent]) {
    throw new Error(`Unknown agent "${params?.agent}". Active: ${Object.keys(AGENTS).join(", ")}`);
  }
  if (!params?.brief?.task) {
    throw new Error("brief.task is required");
  }
  try {
    return await delegateCore(params);
  } catch (err) {
    // IO failure (disk full, permissions, etc.) — surface as diagnostics
    // instead of crashing the kernel. Main agent can decide what to do.
    return systemErrorResult(params.agent, err);
  }
}

// Default delegation timeout — generous for multi-file / long-doc work
// that gemini-class agents naturally do. Users can override per-call via
// the `timeout` option (CLI exposes --timeout N).
const DEFAULT_DELEGATE_TIMEOUT_SEC = 600;

async function delegateCore({
  agent,
  brief,
  cwd = process.cwd(),
  taskId = null,
  mainAgent = "main",
  timeout = null,               // override in seconds; null → use DEFAULT_DELEGATE_TIMEOUT_SEC
  resumeStep = null,            // { task_id, step_id } — prepend prior stdout to brief
}) {

  const quotas = readQuotaState();
  const capabilities = readCapabilities();
  const prior = quotas[agent] || { status: "unknown" };

  // Short-circuit on known-blocked agents — let the main agent re-try via different agent
  if (prior.status === "quota_exceeded" || prior.status === "auth_failed") {
    return {
      status: "blocked",
      agent,
      task_id: null,
      step_id: null,
      findings: null,
      artifacts: [],
      unknowns: [],
      raw_response: null,
      diagnostics: {
        outcome: prior.status,
        detail: prior.last_signal?.detail || "previously observed as blocked",
        reset_hint: prior.last_signal?.reset_hint || null,
        suggestion: suggestAlternatives(agent, quotas, capabilities),
        elapsed_ms: 0,
        tokens: null,
      },
    };
  }

  // If the caller wants to resume from a prior step's output, prepend it
  // to the brief's context as "what you said before". Works for any CLI
  // that takes a prompt — no dependency on each CLI's native session.
  let effectiveBrief = brief;
  if (resumeStep?.task_id && resumeStep?.step_id) {
    const priorOutput = readTaskOutput(resumeStep.task_id, {
      stepId: resumeStep.step_id, stream: "stdout",
    });
    if (priorOutput) {
      const priorNote = `## Your prior output (step ${resumeStep.step_id} of task ${resumeStep.task_id})\n${priorOutput.trim()}\n\n## Continue from there with the task below.`;
      effectiveBrief = {
        ...brief,
        context: brief.context ? `${priorNote}\n\n${brief.context}` : priorNote,
      };
    }
  }

  // Task bookkeeping (uses jsonl event stream under the hood)
  const task = taskId ? getTask(taskId) : createTask({ intent: brief.task, mainAgent });
  if (!task) throw new Error(`Task ${taskId} not found`);
  const step = addTaskStep(task.id, { brief: effectiveBrief, agent });
  updateTaskStep(task.id, step.id, { status: "running" });

  // Execute — stream stdout/stderr chunks into the task's jsonl in real time.
  // This gives us (1) live observability via `tail --follow`, (2) automatic
  // partial-output preservation on timeout, (3) reconstruction from log.
  const prompt = buildBriefInPrompt(effectiveBrief, cwd);
  const startTime = Date.now();
  const effectiveTimeout = timeout ?? DEFAULT_DELEGATE_TIMEOUT_SEC;
  const result = await runAgent(agent, prompt, {
    silent: true,
    timeout: effectiveTimeout,
    onStdout: (chunk) => emit(task.id, { type: "stdout", step_id: step.id, data: chunk }),
    onStderr: (chunk) => emit(task.id, { type: "stderr", step_id: step.id, data: chunk }),
  });
  const elapsedMs = Date.now() - startTime;

  // Observe quota signal, persist
  const signal = parseQuotaSignal(result);
  updateQuotaState(agent, signal);

  // Determine the text we parse for findings:
  //   · On success → the complete response
  //   · On timeout with empty result.response → read accumulated stdout
  //     from the jsonl (partial output that arrived before the timeout)
  let textForParse = result.response || "";
  let finalOutcome = signal.outcome;
  if (finalOutcome === "timeout") {
    const partial = readTaskOutput(task.id, { stepId: step.id, stream: "stdout" });
    if (partial && partial.trim().length > 0) {
      textForParse = partial;
      finalOutcome = "timeout_partial";
      // Upgrade the signal so the main agent sees the distinction
      signal.outcome = "timeout_partial";
      signal.detail = `${signal.detail || "timed out"} — partial output recovered from stream`;
    }
  }

  // Parse delegate's (possibly partial) structured response
  const parsed = parseBriefOut(textForParse);

  const stepStatus = finalOutcome === "ok" ? "done"
    : finalOutcome === "timeout_partial" ? "partial"
    : "failed";

  updateTaskStep(task.id, step.id, {
    status: stepStatus,
    result: parsed,
    diagnostics: signal,
    tokens: result.tokens || null,
    elapsed_ms: elapsedMs,
  });

  logDelegation({
    task_id: task.id,
    step_id: step.id,
    agent,
    brief_task: brief.task.slice(0, 200),
    outcome: finalOutcome,
    detail: signal.detail,
    elapsed_ms: elapsedMs,
    tokens: result.tokens || null,
  });

  return {
    status: finalOutcome,
    agent,
    task_id: task.id,
    step_id: step.id,
    findings: parsed.findings,
    artifacts: parsed.artifacts,
    unknowns: parsed.unknowns,
    raw_response: textForParse || null,
    diagnostics: {
      outcome: finalOutcome,
      detail: signal.detail,
      reset_hint: signal.reset_hint,
      suggestion: finalOutcome !== "ok" ? suggestAlternatives(agent, quotas, capabilities) : null,
      elapsed_ms: elapsedMs,
      tokens: result.tokens || null,
      timeout_sec: effectiveTimeout,
    },
  };
}

// ─── Delegate to a registered session (@name target) ──────────────
// Parallels delegateCore but spawns `claude --resume <id> -p "..."
// --no-session-persistence` in the session's cwd, so the delegate has
// access to that session's accumulated history without polluting it.
//
// Also writes to the callee's inbox for transparency — the session
// can later see what it was asked via `agentalk-delegate inbox`.
export async function delegateSession(params) {
  const name = params?.sessionName;
  if (!name) throw new Error("sessionName is required");
  if (!params?.brief?.task) throw new Error("brief.task is required");
  const sess = getSession(name);
  if (!sess) {
    throw new Error(`Session "${name}" not registered. Use: agentalk-delegate register-session ${name} --cwd <path>`);
  }
  if (sess.agent !== "claude") {
    throw new Error(`Session "${name}" uses agent "${sess.agent}" — Phase 1 only supports claude sessions.`);
  }
  if (!existsSync(sess.cwd)) {
    throw new Error(`Session "${name}" cwd no longer exists: ${sess.cwd}`);
  }

  try {
    return await delegateSessionCore({ ...params, sessionName: name, session: sess });
  } catch (err) {
    return systemErrorResult(`@${name}`, err);
  }
}

async function delegateSessionCore({ sessionName, session, brief, timeout = null, taskId = null, mainAgent = "main" }) {
  const DEFAULT_DELEGATE_TIMEOUT_SEC = 600;
  const effectiveTimeout = timeout ?? DEFAULT_DELEGATE_TIMEOUT_SEC;

  const task = taskId ? getTask(taskId) : createTask({ intent: brief.task, mainAgent });
  if (!task) throw new Error(`Task ${taskId} not found`);
  const step = addTaskStep(task.id, {
    brief: { ...brief, _session_target: `@${sessionName}` },
    agent: `@${sessionName}`,
  });
  updateTaskStep(task.id, step.id, { status: "running" });

  const prompt = buildBriefInPrompt(brief, session.cwd);

  // Build claude args. We use --no-session-persistence so the delegation
  // question + answer don't leak into the user's live session JSONL.
  const claudeArgs = [];
  if (session.session_id) claudeArgs.push("--resume", session.session_id);
  else claudeArgs.push("-c"); // resume latest in cwd
  claudeArgs.push("-p", prompt);
  claudeArgs.push("--no-session-persistence");

  const startTime = Date.now();
  const result = await runClaudeSessionSpawn({
    cmd: "claude",
    args: claudeArgs,
    cwd: session.cwd,
    timeoutSec: effectiveTimeout,
    onStdout: (chunk) => emit(task.id, { type: "stdout", step_id: step.id, data: chunk }),
    onStderr: (chunk) => emit(task.id, { type: "stderr", step_id: step.id, data: chunk }),
  });
  const elapsedMs = Date.now() - startTime;

  const signal = parseQuotaSignal(result);

  let textForParse = result.response || "";
  let finalOutcome = signal.outcome;
  if (finalOutcome === "timeout") {
    const partial = readTaskOutput(task.id, { stepId: step.id, stream: "stdout" });
    if (partial && partial.trim().length > 0) {
      textForParse = partial;
      finalOutcome = "timeout_partial";
      signal.outcome = "timeout_partial";
      signal.detail = `${signal.detail || "timed out"} — partial output recovered`;
    }
  }

  const parsed = parseBriefOut(textForParse);
  const stepStatus = finalOutcome === "ok" ? "done"
    : finalOutcome === "timeout_partial" ? "partial"
    : "failed";

  updateTaskStep(task.id, step.id, {
    status: stepStatus,
    result: parsed,
    diagnostics: signal,
    tokens: result.tokens || null,
    elapsed_ms: elapsedMs,
  });

  // Write to callee's inbox (transparency). Only on success/partial —
  // don't surface failed attempts there, the caller-side log has those.
  let inboxPath = null;
  if (finalOutcome === "ok" || finalOutcome === "timeout_partial") {
    inboxPath = appendInbox(session.cwd, {
      from_caller: mainAgent,
      session_name: sessionName,
      task_summary: brief.task.slice(0, 200),
      task_id: task.id,
      outcome: finalOutcome,
      findings_preview: (parsed.findings || "").slice(0, 300),
    });
  }

  logDelegation({
    task_id: task.id,
    step_id: step.id,
    agent: `@${sessionName}`,
    brief_task: brief.task.slice(0, 200),
    outcome: finalOutcome,
    detail: signal.detail,
    elapsed_ms: elapsedMs,
    tokens: result.tokens || null,
  });

  return {
    status: finalOutcome,
    agent: `@${sessionName}`,
    session_name: sessionName,
    session_cwd: session.cwd,
    task_id: task.id,
    step_id: step.id,
    findings: parsed.findings,
    artifacts: parsed.artifacts,
    unknowns: parsed.unknowns,
    raw_response: textForParse || null,
    inbox_path: inboxPath,
    diagnostics: {
      outcome: finalOutcome,
      detail: signal.detail,
      reset_hint: signal.reset_hint,
      suggestion: null,
      elapsed_ms: elapsedMs,
      tokens: result.tokens || null,
      timeout_sec: effectiveTimeout,
    },
  };
}

// Minimal spawn wrapper used by session delegation. Parallels runAgent
// but with custom cmd/args/cwd and no agent-registry assumptions.
function runClaudeSessionSpawn({ cmd, args, cwd, timeoutSec, onStdout, onStderr }) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    proc.stdout.on("data", (d) => {
      const t = d.toString();
      stdout += t;
      if (onStdout) { try { onStdout(t); } catch {} }
    });
    proc.stderr.on("data", (d) => {
      const t = d.toString();
      stderr += t;
      if (onStderr) { try { onStderr(t); } catch {} }
    });

    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill("SIGTERM"); } catch {}
      resolve({ response: stdout.trim(), error: "timeout", timedOut: true, timeoutSec, elapsed: timeoutSec, tokens: { total: Math.ceil(stdout.length / 3), estimated: true } });
    }, timeoutSec * 1000);

    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve({
        response: stdout.trim(),
        error: code !== 0 ? stderr.trim().slice(0, 400) : "",
        tokens: { total: Math.ceil(stdout.length / 3), estimated: true },
      });
    });

    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve({ response: "", error: err.message });
    });
  });
}
