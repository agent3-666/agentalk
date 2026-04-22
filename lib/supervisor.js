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

// ─── Task state ────────────────────────────────────────────────────
function makeTaskId() {
  const ts = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const rand = randomBytes(3).toString("hex");
  return `t_${ts}_${rand}`;
}

function taskPath(id) {
  return join(TASKS_DIR, `${id}.json`);
}

function writeTask(task) {
  task.updated_at = new Date().toISOString();
  atomicWriteJson(taskPath(task.id), task);
}

export function createTask({ intent, mainAgent = "main", sessionRef = null }) {
  ensureHome();
  const now = new Date().toISOString();
  const task = {
    id: makeTaskId(),
    created_at: now,
    updated_at: now,
    status: "pending",
    origin: { main_agent: mainAgent, session_ref: sessionRef },
    plan: { intent, steps: [] },
    checkpoints: [{ ts: now, event: "created" }],
    resume_hint: null,
  };
  writeTask(task);
  return task;
}

export function getTask(id) {
  const p = taskPath(id);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; }
}

export function addTaskStep(taskId, step) {
  const task = getTask(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  const id = `s${task.plan.steps.length + 1}`;
  const fullStep = { id, status: "pending", ...step };
  task.plan.steps.push(fullStep);
  task.checkpoints.push({
    ts: new Date().toISOString(), step: id, event: "step_added",
  });
  writeTask(task);
  return fullStep;
}

export function updateTaskStep(taskId, stepId, update) {
  const task = getTask(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  const step = task.plan.steps.find(s => s.id === stepId);
  if (!step) throw new Error(`Step ${stepId} not found in task ${taskId}`);
  Object.assign(step, update);
  if (update.status) {
    task.checkpoints.push({
      ts: new Date().toISOString(), step: stepId, event: update.status,
    });
    // Roll up task status: if any step running → running; if all done → done
    const statuses = task.plan.steps.map(s => s.status);
    if (statuses.some(s => s === "running")) task.status = "running";
    else if (statuses.every(s => s === "done")) task.status = "done";
    else if (statuses.some(s => s === "failed")) task.status = "partial";
  }
  writeTask(task);
  return step;
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
];

export function parseQuotaSignal(result) {
  // Timeouts surface through runAgent's result shape
  if (result.timedOut) {
    return { outcome: "timeout", detail: `timed out after ${result.timeoutSec}s`, reset_hint: null };
  }
  if (result.stopped) {
    return { outcome: "stopped", detail: "user stopped", reset_hint: null };
  }

  const blob = [result.error || "", result.response || ""].join("\n");
  for (const { re, outcome, detail } of QUOTA_PATTERNS) {
    if (re.test(blob)) {
      const hint = blob.match(/(resets?\s+in\s+[\d\w\s]+|retry[^\n]{0,30}\d+)/i);
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

async function delegateCore({
  agent,
  brief,
  cwd = process.cwd(),
  taskId = null,
  mainAgent = "main",
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

  // Task bookkeeping
  const task = taskId ? getTask(taskId) : createTask({ intent: brief.task, mainAgent });
  if (!task) throw new Error(`Task ${taskId} not found`);
  const step = addTaskStep(task.id, {
    brief, agent, started_at: new Date().toISOString(),
  });
  updateTaskStep(task.id, step.id, { status: "running" });

  // Execute
  const prompt = buildBriefInPrompt(brief, cwd);
  const startTime = Date.now();
  const result = await runAgent(agent, prompt, { silent: true });
  const elapsedMs = Date.now() - startTime;

  // Observe quota signal, persist
  const signal = parseQuotaSignal(result);
  updateQuotaState(agent, signal);

  // Parse delegate's structured response
  const parsed = parseBriefOut(result.response || "");
  const outcome = signal.outcome;

  updateTaskStep(task.id, step.id, {
    status: outcome === "ok" ? "done" : "failed",
    result: parsed,
    diagnostics: signal,
    completed_at: new Date().toISOString(),
    tokens: result.tokens || null,
    elapsed_ms: elapsedMs,
  });

  logDelegation({
    task_id: task.id,
    step_id: step.id,
    agent,
    brief_task: brief.task.slice(0, 200),
    outcome,
    detail: signal.detail,
    elapsed_ms: elapsedMs,
    tokens: result.tokens || null,
  });

  return {
    status: outcome,
    agent,
    task_id: task.id,
    step_id: step.id,
    findings: parsed.findings,
    artifacts: parsed.artifacts,
    unknowns: parsed.unknowns,
    raw_response: result.response || null,
    diagnostics: {
      outcome,
      detail: signal.detail,
      reset_hint: signal.reset_hint,
      suggestion: outcome !== "ok" ? suggestAlternatives(agent, quotas, capabilities) : null,
      elapsed_ms: elapsedMs,
      tokens: result.tokens || null,
    },
  };
}
