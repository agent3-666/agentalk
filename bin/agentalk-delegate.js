#!/usr/bin/env node
// agentalk-delegate — multi-CLI sub-task delegation
//
// Separate binary from `agentalk` (which runs discussion modes). This is
// the Skill+CLI integration point: Claude Code (or any AI client) invokes
// `agentalk-delegate <agent> "<task>"` via Bash and parses [MARKER] output.
//
// Usage:
//   agentalk-delegate <agent> "<task>" [--files a,b] [--context "..."] [--output "..."] [--budget "..."] [--task-id <id>]
//   agentalk-delegate quotas       [--json]
//   agentalk-delegate capabilities [--json]
//   agentalk-delegate remember "<fact>" [--memo-context "..."] [--task-id <id>]
//   agentalk-delegate recall       [--limit N] [--json]
//   agentalk-delegate task <id>    [--json]
//   agentalk-delegate init
//   agentalk-delegate review
//   agentalk-delegate help

import { readFileSync, existsSync, statSync } from "fs";
import { join, dirname, isAbsolute } from "path";
import { homedir } from "os";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import chalk from "chalk";
import { AGENTS } from "../lib/agents.js";
import { listAgents } from "../lib/config.js";
import {
  delegate as supervisorDelegate,
  delegateSession as supervisorDelegateSession,
  readQuotaState,
  readCapabilities,
  rememberFact,
  recallMemory,
  getTask,
  readTaskEvents,
  readTaskOutput,
  readSessions,
  registerSession,
  unregisterSession,
  readInbox,
} from "../lib/supervisor.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);

function argValue(key) {
  const idx = argv.findIndex(a => a === key);
  return idx !== -1 && idx + 1 < argv.length ? argv[idx + 1] : null;
}
const flagJson = argv.includes("--json");

// ─── Help ──────────────────────────────────────────────────────────
function printHelp() {
  console.log(`
${chalk.bold("agentalk-delegate")} — multi-CLI sub-task delegation (separate from agentalk discussion modes)

${chalk.bold("Primary: delegate a task")}
  ${chalk.cyan('agentalk-delegate <agent> "<task>"')} [options]
    --files <a,b>                files the delegate should read (paths relative to cwd)
    --context "..."              2-3 lines of background the delegate needs
    --output "..."               expected output format / focus
    --budget "..."               length / detail hint (e.g. "200 words")
    --timeout <sec>              override default timeout (default: 600s for delegations)
    --task-id <id>               reuse an existing task (multi-step)
    --resume-step <tid>:<sid>    prepend that step's stdout as prior context (continues delegate's prior work)
    --no-value-report            suppress the [VALUE_REPORT] block (default: on — lets main agent tell you what was delegated and tokens saved)

${chalk.bold("Session delegation (delegate to a specific Claude Code session with its accumulated context)")}
  ${chalk.cyan("agentalk-delegate register-session <name> --cwd <path> [--session-id <id>]")}
  ${chalk.cyan('agentalk-delegate @<name> "<task>" [options]')}   delegate to registered session
  ${chalk.cyan("agentalk-delegate sessions")}           list registered sessions
  ${chalk.cyan("agentalk-delegate unregister-session <name>")}
  ${chalk.cyan("agentalk-delegate inbox [--cwd X]")}    what delegations has this session received?

${chalk.bold("Helpers")}
  ${chalk.cyan("agentalk-delegate quotas")}              observed quota state per agent (from real 429/rate-limit signals)
  ${chalk.cyan("agentalk-delegate capabilities")}        per-agent strengths / ctx window / cost tier / subscription vs pay-per-call
  ${chalk.cyan('agentalk-delegate remember "fact"')}    append a fact to project memory (.agentalk/memory.jsonl)
  ${chalk.cyan("agentalk-delegate recall")}              read recent project memory entries
  ${chalk.cyan("agentalk-delegate task <id>")}           query a delegation task's state
  ${chalk.cyan("agentalk-delegate tail <id>")}           stream a task's stdout events ([--step s1] [--stream stderr] [--follow])
  ${chalk.cyan("agentalk-delegate init")}                setup status (CLIs, skills) + next-step hints
  ${chalk.cyan("agentalk-delegate review")}              per-agent performance from delegations.jsonl

${chalk.bold("Output format (for shell/skill parsing)")}
  Delegation success   → [STATUS] ok / [TASK] <jsonl path> / [TASK_ID] <id> / [FINDINGS] ... / [TOKENS] N
  Partial on timeout   → [STATUS] timeout_partial / [FINDINGS] <what was captured so far>
  Delegation failure   → [STATUS] <outcome> / [DIAGNOSTICS] ...
  Full context lives in ~/.agentalk/tasks/<id>.jsonl — one file per task, event-stream format.

${chalk.bold("Available agents")}: ${Object.keys(AGENTS).join(", ")}
`);
}

// ─── Primary delegation ────────────────────────────────────────────
async function cmdDelegate(agent, task) {
  const filesRaw = argValue("--files");
  const files = filesRaw ? filesRaw.split(",").map(s => s.trim()).filter(Boolean) : undefined;
  const timeoutStr = argValue("--timeout");
  const timeout = timeoutStr ? parseInt(timeoutStr, 10) : null;
  if (timeoutStr && (isNaN(timeout) || timeout <= 0)) {
    console.error(`Invalid --timeout value: ${timeoutStr}. Expected positive integer seconds.`);
    process.exit(2);
  }
  // --resume-step accepts "taskId:stepId" form, e.g. t_xxx:s1
  const resumeRaw = argValue("--resume-step");
  let resumeStep = null;
  if (resumeRaw) {
    const [tId, sId] = resumeRaw.split(":");
    if (!tId || !sId) {
      console.error("Invalid --resume-step format. Expected <task-id>:<step-id>, e.g. t_xxx:s1");
      process.exit(2);
    }
    resumeStep = { task_id: tId, step_id: sId };
  }
  const result = await supervisorDelegate({
    agent,
    brief: {
      task,
      files,
      context: argValue("--context") || undefined,
      output: argValue("--output") || undefined,
      budget: argValue("--budget") || undefined,
    },
    cwd: process.cwd(),
    taskId: argValue("--task-id") || null,
    mainAgent: "cli",
    timeout,
    resumeStep,
  });

  // Structured marker output — deterministic, parseable by skills/scripts.
  process.stdout.write(`[STATUS] ${result.status}\n`);
  process.stdout.write(`[AGENT] ${result.agent}\n`);
  if (result.task_id) {
    const taskPath = join(homedir(), ".agentalk", "tasks", `${result.task_id}.jsonl`);
    process.stdout.write(`[TASK] ${taskPath}\n`);
    process.stdout.write(`[TASK_ID] ${result.task_id}\n`);
  }
  if (result.step_id) {
    process.stdout.write(`[STEP] ${result.step_id}\n`);
  }
  if (result.diagnostics?.tokens?.total != null) {
    const t = result.diagnostics.tokens;
    process.stdout.write(`[TOKENS] ${t.total}${t.estimated ? " (est)" : ""}\n`);
  }
  if (result.diagnostics?.elapsed_ms != null) {
    process.stdout.write(`[ELAPSED_MS] ${result.diagnostics.elapsed_ms}\n`);
  }
  if (result.findings) {
    process.stdout.write(`[FINDINGS]\n${result.findings}\n[END_FINDINGS]\n`);
  }
  if (result.artifacts?.length) {
    process.stdout.write(`[ARTIFACTS]\n${result.artifacts.map(a => "- " + a).join("\n")}\n[END_ARTIFACTS]\n`);
  }
  if (result.unknowns?.length) {
    process.stdout.write(`[UNKNOWNS]\n${result.unknowns.map(u => "- " + u).join("\n")}\n[END_UNKNOWNS]\n`);
  }
  if (result.status !== "ok") {
    const d = result.diagnostics || {};
    process.stdout.write(`[DIAGNOSTICS]\n`);
    if (d.outcome)    process.stdout.write(`outcome: ${d.outcome}\n`);
    if (d.detail)     process.stdout.write(`detail: ${d.detail}\n`);
    if (d.reset_hint) process.stdout.write(`reset_hint: ${d.reset_hint}\n`);
    if (d.suggestion) process.stdout.write(`suggestion: ${d.suggestion}\n`);
    process.stdout.write(`[END_DIAGNOSTICS]\n`);
  }

  // ─── Value report (Layer 4: make delegation visible) ─────────────
  // The skill REQUIRES the main agent to quote this to the user after
  // every delegation. We compute the numbers here so Claude doesn't
  // have to estimate — it just reads and paraphrases.
  //
  // Default: on. Callers who don't want it (shell scripts, piped
  // programmatic consumers) can suppress with --no-value-report.
  const suppressReport = argv.includes("--no-value-report");
  if (!suppressReport && (result.status === "ok" || result.status === "timeout_partial")) {
    const agentDef = AGENTS[agent];
    const modelName = agentDef?.model || agentDef?.displayName?.match(/\((.+)\)/)?.[1] || "unknown";
    const displayName = agentDef?.displayName || agent;
    const delegateTokens = result.diagnostics?.tokens?.total || 0;

    // Estimate context saved: size of files the delegate read minus
    // size of findings it returned. If no files, we can't quantify
    // — still report delegate-tokens so user sees what it cost.
    let savedTokens = null;
    try {
      const filesRaw = argValue("--files");
      const files = filesRaw ? filesRaw.split(",").map(s => s.trim()).filter(Boolean) : [];
      if (files.length) {
        let bytesRead = 0;
        for (const f of files) {
          try {
            const full = isAbsolute(f) ? f : join(process.cwd(), f);
            bytesRead += statSync(full).size;
          } catch {}
        }
        const findingsBytes = Buffer.byteLength(result.findings || "");
        // Rough chars-to-tokens ratio; errs on the low side.
        savedTokens = Math.max(0, Math.round((bytesRead - findingsBytes) / 3.5));
      }
    } catch { /* non-fatal */ }

    process.stdout.write(`[VALUE_REPORT]\n`);
    process.stdout.write(`agent: ${agent}\n`);
    process.stdout.write(`model: ${modelName}\n`);
    process.stdout.write(`display: ${displayName}\n`);
    process.stdout.write(`delegate_tokens: ${delegateTokens}\n`);
    if (savedTokens !== null) {
      process.stdout.write(`main_context_saved: ~${savedTokens.toLocaleString()} tokens\n`);
    } else {
      process.stdout.write(`main_context_saved: (no --files given — can't estimate; delegate spent ${delegateTokens} tokens on your behalf)\n`);
    }
    process.stdout.write(`task_summary: ${task.slice(0, 150)}${task.length > 150 ? "…" : ""}\n`);
    if (result.status === "timeout_partial") {
      process.stdout.write(`note: partial output recovered — see findings for what was captured before timeout\n`);
    }
    process.stdout.write(`[END_VALUE_REPORT]\n`);
  }

  process.exit(result.status === "ok" ? 0 : 1);
}

// ─── Helpers ───────────────────────────────────────────────────────
function cmdQuotas() {
  const state = readQuotaState();
  if (flagJson) {
    process.stdout.write(JSON.stringify(state, null, 2) + "\n");
    return;
  }
  console.log(chalk.bold("\nObserved quota state (from real CLI signals, not predicted):\n"));
  console.log(`  ${chalk.dim("Agent".padEnd(14) + "Status".padEnd(20) + "Last checked")}`);
  for (const [k, v] of Object.entries(state)) {
    const statusColor = v.status === "available" ? chalk.green
      : v.status === "quota_exceeded" ? chalk.yellow
      : v.status === "auth_failed" ? chalk.red
      : chalk.dim;
    const last = v.last_checked ? v.last_checked.slice(0, 19).replace("T", " ") : "—";
    console.log(`  ${k.padEnd(14)}${statusColor((v.status || "").padEnd(20))}${chalk.dim(last)}`);
    if (v.last_signal?.reset_hint) {
      console.log(`  ${chalk.dim("  reset: " + v.last_signal.reset_hint)}`);
    }
  }
  console.log("");
}

function cmdCapabilities() {
  const caps = readCapabilities();
  if (flagJson) {
    process.stdout.write(JSON.stringify(caps, null, 2) + "\n");
    return;
  }
  console.log(chalk.bold("\nAgent capabilities"));
  console.log(chalk.dim(`  defaults + your overrides at ~/.agentalk/capability.json\n`));

  // Sort: preferred → normal → main → avoid (so preferred agents show first)
  const order = { preferred: 0, normal: 1, main: 2, avoid: 3 };
  const sorted = Object.entries(caps).sort((a, b) => {
    const pa = order[a[1]?.priority] ?? 99;
    const pb = order[b[1]?.priority] ?? 99;
    return pa - pb;
  });

  for (const [k, v] of sorted) {
    // Header line with priority badge + billing badge
    const billingBadge = v.billing === "subscription"
      ? chalk.green("[subscription]")
      : v.billing === "pay_per_call"
      ? chalk.yellow("[pay-per-call]")
      : v.billing === "free"
      ? chalk.cyan("[free]")
      : chalk.dim("[billing?]");
    const priorityBadge = v.priority === "preferred"
      ? chalk.bgGreen.black(" PREFERRED ")
      : v.priority === "main"
      ? chalk.bgBlue.white(" MAIN ")
      : v.priority === "avoid"
      ? chalk.bgYellow.black(" AVOID ")
      : chalk.dim(" normal ");

    console.log(`  ${chalk.bold(k.padEnd(12))} ${priorityBadge} ${billingBadge}`);
    if (v.note) {
      console.log(`    ${chalk.dim(v.note)}`);
    }
    const ctxStr = (v.context_window || 0).toLocaleString();
    console.log(`    ${chalk.dim("cost:")} ${v.cost_tier || "?"}  ${chalk.dim("context:")} ${ctxStr} tokens`);
    if (v.strengths?.length) console.log(`    ${chalk.dim("strengths:")} ${v.strengths.join(", ")}`);
    if (v.good_for?.length)  console.log(`    ${chalk.dim("good for: ")} ${v.good_for.join("; ")}`);
    if (v.weakness?.length) {
      const wk = Array.isArray(v.weakness) ? v.weakness : [v.weakness];
      console.log(`    ${chalk.dim("weakness: ")} ${wk.join(", ")}`);
    }
    console.log("");
  }
  console.log(chalk.dim("  Edit ~/.agentalk/capability.json to change priority (preferred/normal/avoid/main)"));
  console.log(chalk.dim("  or update notes. Changes take effect on next call.\n"));
}

function cmdRemember(fact) {
  const record = rememberFact(process.cwd(), {
    fact,
    context: argValue("--memo-context") || null,
    taskId: argValue("--task-id") || null,
  });
  process.stdout.write(`[REMEMBERED] ${record.ts}\n`);
  process.stdout.write(`[FACT] ${record.fact}\n`);
}

function cmdRecall() {
  const limit = parseInt(argValue("--limit") || "20", 10);
  const memory = recallMemory(process.cwd(), { limit });
  if (flagJson) {
    process.stdout.write(JSON.stringify(memory, null, 2) + "\n");
    return;
  }
  if (memory.length === 0) {
    console.log(chalk.dim("(no project memory yet — use `agentalk-delegate remember \"<fact>\"` to add)"));
    return;
  }
  console.log(chalk.bold(`\n${memory.length} memory entries for ${process.cwd()}:\n`));
  memory.forEach((m, i) => {
    const date = m.ts.slice(0, 10);
    console.log(`  ${chalk.dim((i + 1).toString().padStart(2) + ". [" + date + "]")} ${m.fact}`);
    if (m.context) console.log(`      ${chalk.dim(m.context)}`);
  });
  console.log("");
}

// ─── tail — stream stdout/stderr events from a task's jsonl ────────
// Two modes:
//   tail <task-id>                     — print all stdout events and exit
//   tail <task-id> --follow            — live tail; keep printing as new events append
//   tail <task-id> --step s1           — filter to one step
//   tail <task-id> --stream stderr     — show stderr instead of stdout
async function cmdTail(taskId) {
  const stepFilter = argValue("--step");
  const stream = argValue("--stream") || "stdout";
  const follow = argv.includes("--follow") || argv.includes("-f");
  const taskFile = join(homedir(), ".agentalk", "tasks", `${taskId}.jsonl`);
  if (!existsSync(taskFile)) {
    console.error(`Task ${taskId} not found at ${taskFile}`);
    process.exit(1);
  }

  // Print helper — filters events by type + step
  const matchEvent = (e) => {
    if (e.type !== stream) return false;
    if (stepFilter && e.step_id !== stepFilter) return false;
    return true;
  };

  // Initial dump of everything we have so far
  let bytesRead = 0;
  const events = readTaskEvents(taskId);
  let taskStartMs = Date.now();
  let lastHeartbeatAgent = null;
  let lastOutputMs = Date.now();
  for (const e of events) {
    if (e.type === "task_created" && e.ts) taskStartMs = new Date(e.ts).getTime();
    if (matchEvent(e)) process.stdout.write(e.data || "");
    if (e.type === "stdout" || e.type === "stderr") {
      lastOutputMs = e.ts ? new Date(e.ts).getTime() : Date.now();
      lastHeartbeatAgent = null;
    } else if (e.type === "heartbeat") {
      lastHeartbeatAgent = e.agent || lastHeartbeatAgent;
    }
  }
  bytesRead = statSync(taskFile).size;

  if (!follow) return;

  // Follow mode: poll file for appended content. Cheap (stat + read),
  // survives arbitrary new events without any locking. 250ms is plenty
  // for delegate-class latency.
  const interval = setInterval(() => {
    try {
      const size = statSync(taskFile).size;
      if (size <= bytesRead) {
        // Check if the task has reached a terminal state; if so stop following
        const folded = getTask(taskId);
        if (folded && (folded.status === "done" || folded.status === "partial")) {
          // Drain one final time then exit
          const all = readFileSync(taskFile, "utf-8");
          const slice = all.slice(bytesRead);
          for (const line of slice.split("\n")) {
            if (!line.trim()) continue;
            try {
              const e = JSON.parse(line);
              if (matchEvent(e)) process.stdout.write(e.data || "");
            } catch {}
          }
          clearInterval(interval);
          process.exit(0);
        }
        return;
      }
      const all = readFileSync(taskFile, "utf-8");
      const slice = all.slice(bytesRead);
      for (const line of slice.split("\n")) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          if (e.type === "stdout" || e.type === "stderr") {
            lastOutputMs = e.ts ? new Date(e.ts).getTime() : Date.now();
            lastHeartbeatAgent = null;
            if (matchEvent(e)) process.stdout.write(e.data || "");
          } else if (e.type === "heartbeat") {
            if (lastHeartbeatAgent) {
              process.stderr.write(chalk.dim(`♡ ${e.agent} working... (${Math.round((Date.now() - taskStartMs) / 1000)}s elapsed)\n`));
            }
            lastHeartbeatAgent = e.agent;
          }
        } catch {}
      }
      bytesRead = size;
    } catch {
      // file disappeared or stat failed — give up quietly
      clearInterval(interval);
      process.exit(0);
    }
  }, 250);

  process.on("SIGINT", () => { clearInterval(interval); process.exit(0); });
  // Prevent the function from returning — the interval keeps process alive.
  await new Promise(() => {});
}

function cmdTaskStatus(id) {
  const task = getTask(id);
  if (!task) {
    console.error(`Task ${id} not found in ~/.agentalk/tasks/`);
    process.exit(1);
  }
  if (flagJson) {
    process.stdout.write(JSON.stringify(task, null, 2) + "\n");
    return;
  }
  console.log(chalk.bold(`\n Task ${task.id}`));
  console.log(`  ${chalk.dim("intent: ")} ${task.plan.intent.slice(0, 120)}${task.plan.intent.length > 120 ? "…" : ""}`);
  console.log(`  ${chalk.dim("status: ")} ${task.status}`);
  console.log(`  ${chalk.dim("created:")} ${task.created_at}`);
  console.log(`  ${chalk.dim("updated:")} ${task.updated_at}`);
  console.log(`  ${chalk.bold(task.plan.steps.length + " step(s):")}`);
  for (const s of task.plan.steps) {
    const tok = s.tokens?.total || "?";
    const ms = s.elapsed_ms ? `${s.elapsed_ms}ms` : "—";
    const statusColor = s.status === "done" ? chalk.green
      : s.status === "running" ? chalk.yellow
      : s.status === "failed" ? chalk.red
      : chalk.dim;
    console.log(`    ${s.id} ${statusColor("[" + s.status + "]".padEnd(10))} ${s.agent.padEnd(12)} ${ms.padStart(8)}  ~${tok}t`);
    if (s.brief?.task) console.log(`        ${chalk.dim(s.brief.task.slice(0, 100))}`);
  }
  if (task.status === "running") {
    const events = readTaskEvents(id);
    let latestActivity = null;
    for (const e of events) {
      if (e.type !== "stdout" && e.type !== "stderr" && e.type !== "heartbeat") continue;
      if (!latestActivity || e.ts > latestActivity.ts) latestActivity = e;
    }
    if (latestActivity) {
      const secsAgo = Math.max(0, Math.round((Date.now() - new Date(latestActivity.ts).getTime()) / 1000));
      console.log(`  ${chalk.dim("last activity:")} ${secsAgo}s ago (${latestActivity.type})`);
    } else {
      console.log(chalk.dim("  (no activity events yet)"));
    }
  }
  console.log("");
}

// ─── init (Layer 1: zero-friction setup) ───────────────────────────
async function cmdInit() {
  console.log(chalk.bold("\n agentalk-delegate setup\n"));

  console.log(chalk.bold("Agent CLIs (enabled):"));
  const all = listAgents();
  let active = 0;
  for (const a of all) {
    if (!a.enabled) continue;
    const installed = spawnSync("which", [a.cmd], { stdio: ["ignore", "pipe", "pipe"] }).status === 0;
    if (installed) active++;
    const mark = installed ? chalk.green("✓") : chalk.red("✗");
    const suffix = installed ? "" : chalk.dim("  (not in PATH — install the CLI)");
    console.log(`  ${mark} ${a.key.padEnd(12)} ${chalk.dim(a.cmd)}${suffix}`);
  }
  if (active === 0) {
    console.log(chalk.yellow("\n  No agent CLIs detected. Install at least one (claude, codex, gemini, opencode) to use delegation."));
  } else {
    console.log(chalk.dim(`  ${active} active — delegation will route to these.`));
  }

  console.log(chalk.bold("\nClaude Code skills:"));
  const installScript = join(__dirname, "..", "scripts", "install-skill.js");
  const res = spawnSync("node", [installScript], { stdio: "inherit" });
  if (res.status !== 0) {
    console.log(chalk.red("  Skill install returned non-zero exit"));
  }

  console.log(chalk.bold("\nMCP server (optional — default path uses Skill+CLI):"));
  console.log(chalk.dim("  Skip this unless you want MCP-based clients. To enable, run:"));
  console.log(`    ${chalk.cyan("claude mcp add agentalk agentalk-mcp")}`);

  const claudeMdPath = join(process.cwd(), "CLAUDE.md");
  console.log(chalk.bold("\nProject-specific hint (optional):"));
  if (existsSync(claudeMdPath)) {
    console.log(chalk.dim(`  You have ${claudeMdPath}. Consider appending a`));
    console.log(chalk.dim("  'Multi-agent delegation' section so Claude Code in this project"));
    console.log(chalk.dim("  knows which agent to delegate to for which task. Template lives in"));
    console.log(chalk.dim("  ~/.claude/skills/agentalk-delegate.md (installed above)."));
  } else {
    console.log(chalk.dim(`  No CLAUDE.md in ${process.cwd()} — per-project guidance is optional.`));
  }

  console.log(chalk.bold("\nTry:"));
  console.log(`  ${chalk.cyan("agentalk-delegate capabilities")}   ${chalk.dim("# what each agent is good at")}`);
  console.log(`  ${chalk.cyan("agentalk-delegate quotas")}         ${chalk.dim("# observed quota state")}`);
  console.log(`  ${chalk.cyan('agentalk-delegate gemini "summarize ./README.md" --files ./README.md')}`);
  console.log(`  ${chalk.cyan("agentalk-delegate review")}         ${chalk.dim("# after some real usage")}`);
  console.log("");
}

// ─── review (Layer 2: empirical capability insight) ────────────────
function cmdReview() {
  const log = join(homedir(), ".agentalk", "delegations.jsonl");
  if (!existsSync(log)) {
    console.log(chalk.dim("No delegation log yet. Try some delegations first:"));
    console.log(chalk.cyan("  agentalk-delegate <agent> \"<task>\""));
    return;
  }
  const records = readFileSync(log, "utf-8").trim().split("\n")
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
  if (records.length === 0) {
    console.log(chalk.dim("Delegation log is empty."));
    return;
  }

  console.log(chalk.bold(`\n Delegation review — ${records.length} records\n`));

  const byAgent = {};
  for (const r of records) {
    if (!byAgent[r.agent]) byAgent[r.agent] = {
      total: 0, ok: 0, outcomes: {}, elapsed: [], tokens: [], tasks: [],
    };
    const a = byAgent[r.agent];
    a.total++;
    if (r.outcome === "ok") a.ok++;
    a.outcomes[r.outcome] = (a.outcomes[r.outcome] || 0) + 1;
    if (r.elapsed_ms) a.elapsed.push(r.elapsed_ms);
    if (r.tokens?.total) a.tokens.push(r.tokens.total);
    if (r.brief_task) a.tasks.push(r.brief_task);
  }

  console.log(chalk.bold("Per-agent performance:"));
  console.log(`  ${chalk.dim("agent".padEnd(14) + "calls".padStart(6) + "  " + "ok%".padStart(6) + "  " + "avg ms".padStart(9) + "  " + "avg tok".padStart(8))}`);
  for (const [agent, s] of Object.entries(byAgent)) {
    const rate = s.total > 0 ? ((s.ok / s.total) * 100).toFixed(0) + "%" : "—";
    const avgMs = s.elapsed.length
      ? Math.round(s.elapsed.reduce((a, b) => a + b, 0) / s.elapsed.length) + "ms"
      : "—";
    const avgTok = s.tokens.length
      ? Math.round(s.tokens.reduce((a, b) => a + b, 0) / s.tokens.length)
      : "—";
    const rateColor = s.total < 3 ? chalk.dim
      : s.ok / s.total >= 0.9 ? chalk.green
      : s.ok / s.total >= 0.6 ? chalk.yellow
      : chalk.red;
    console.log(
      `  ${agent.padEnd(14)}` +
      `${s.total.toString().padStart(6)}  ` +
      `${rateColor(rate.padStart(6))}  ` +
      `${avgMs.padStart(9)}  ` +
      `${String(avgTok).padStart(8)}`
    );
    const outcomes = Object.entries(s.outcomes).map(([k, v]) => `${k}=${v}`).join(" ");
    console.log(`  ${chalk.dim("               " + outcomes)}`);
  }

  console.log(chalk.bold("\nTop task keywords (per agent, to sanity-check good_for):"));
  const STOP = new Set(["this", "that", "with", "have", "been", "were", "which", "what", "from", "into", "some", "when", "your", "their", "there", "will", "would", "should", "could", "task", "agent", "please", "file", "files", "code"]);
  for (const [agent, s] of Object.entries(byAgent)) {
    if (s.tasks.length === 0) continue;
    const words = {};
    for (const t of s.tasks) {
      for (const w of t.toLowerCase().match(/\b[a-z]{4,}\b/g) || []) {
        if (STOP.has(w)) continue;
        words[w] = (words[w] || 0) + 1;
      }
    }
    const top = Object.entries(words).sort((a, b) => b[1] - a[1]).slice(0, 6);
    if (top.length) {
      console.log(`  ${agent.padEnd(14)} ${top.map(([w, c]) => `${w}(${c})`).join(" ")}`);
    }
  }

  console.log(chalk.bold("\nSuggestions:"));
  let any = false;
  for (const [agent, s] of Object.entries(byAgent)) {
    if (s.total < 3) continue;
    const rate = s.ok / s.total;
    if (rate < 0.6) {
      console.log(`  ${chalk.yellow("⚠")}  ${agent}: ${(rate * 100).toFixed(0)}% ok over ${s.total} calls — review which task types are failing.`);
      any = true;
    } else if (rate >= 0.9 && s.total >= 10) {
      console.log(`  ${chalk.green("✓")}  ${agent}: ${(rate * 100).toFixed(0)}% ok over ${s.total} calls — consider tightening good_for in ~/.agentalk/capability.json.`);
      any = true;
    }
  }
  if (!any) {
    console.log(chalk.dim("  No strong patterns yet — keep delegating and revisit."));
  }
  console.log(chalk.dim(`\nRaw log: ${log}`));
  console.log("");
}

// ─── Session registry commands ─────────────────────────────────────
function cmdRegisterSession(name) {
  const cwd = argValue("--cwd");
  const sessionId = argValue("--session-id") || null;
  const agent = argValue("--agent") || "claude";
  if (!cwd) {
    console.error(`Usage: agentalk-delegate register-session <name> --cwd <path> [--session-id <id>] [--agent claude]`);
    process.exit(2);
  }
  try {
    const rec = registerSession(name, { cwd, sessionId, agent });
    console.log(chalk.green(`✓ Registered session '${name}'`));
    console.log(`  ${chalk.dim("cwd:       ")} ${rec.cwd}`);
    console.log(`  ${chalk.dim("session_id:")} ${rec.session_id || chalk.dim("(latest in cwd via -c)")}`);
    console.log(`  ${chalk.dim("agent:     ")} ${rec.agent}`);
    console.log("");
    console.log(chalk.dim("Try:"));
    console.log(`  ${chalk.cyan(`agentalk-delegate @${name} "<question>"`)}`);
    console.log("");
    console.log(chalk.dim(`Tip: append the following to ${cwd}/CLAUDE.md so that project's Claude Code knows it's registered as a delegation target:`));
    console.log(chalk.dim(`  ---`));
    console.log(chalk.dim(`  This project is registered with agentalk as session '${name}'.`));
    console.log(chalk.dim(`  Other Claude Code sessions may delegate sub-tasks here via`));
    console.log(chalk.dim(`  \`agentalk-delegate @${name} "..."\`. Delegations are non-persistent`));
    console.log(chalk.dim(`  (won't pollute this session). Run \`agentalk-delegate inbox\` to see`));
    console.log(chalk.dim(`  prior delegations received here.`));
    console.log(chalk.dim(`  ---`));
  } catch (err) {
    console.error(chalk.red(`✗ ${err.message}`));
    process.exit(1);
  }
}

function cmdUnregisterSession(name) {
  const ok = unregisterSession(name);
  if (ok) console.log(chalk.green(`✓ Unregistered session '${name}'`));
  else { console.error(chalk.red(`✗ Session '${name}' not found`)); process.exit(1); }
}

function cmdListSessions() {
  const sessions = readSessions();
  const names = Object.keys(sessions);
  if (flagJson) {
    process.stdout.write(JSON.stringify(sessions, null, 2) + "\n");
    return;
  }
  if (names.length === 0) {
    console.log(chalk.dim("(no sessions registered — use `agentalk-delegate register-session <name> --cwd <path>`)"));
    return;
  }
  console.log(chalk.bold(`\nRegistered sessions (${names.length}):\n`));
  for (const name of names) {
    const s = sessions[name];
    const cwdExists = existsSync(s.cwd);
    const mark = cwdExists ? chalk.green("✓") : chalk.red("✗");
    console.log(`  ${mark} ${chalk.bold("@" + name)} ${chalk.dim("(" + s.agent + ")")}`);
    console.log(`    ${chalk.dim("cwd:       ")} ${s.cwd}${cwdExists ? "" : chalk.red(" [missing]")}`);
    console.log(`    ${chalk.dim("session_id:")} ${s.session_id || chalk.dim("(latest via -c)")}`);
    console.log(`    ${chalk.dim("registered:")} ${s.registered_at}`);
  }
  console.log("");
}

function cmdInbox() {
  const cwd = argValue("--cwd") || process.cwd();
  const limit = parseInt(argValue("--limit") || "20", 10);
  const inbox = readInbox(cwd, { limit });
  if (flagJson) {
    process.stdout.write(JSON.stringify(inbox, null, 2) + "\n");
    return;
  }
  if (inbox.length === 0) {
    console.log(chalk.dim(`(no delegation inbox at ${cwd}/.agentalk/inbox.jsonl)`));
    console.log(chalk.dim("This means no one has delegated to a registered session rooted here."));
    return;
  }
  console.log(chalk.bold(`\n${inbox.length} delegation(s) received at ${cwd}:\n`));
  inbox.forEach((r, i) => {
    const date = r.ts.slice(0, 19).replace("T", " ");
    console.log(`  ${chalk.dim((i + 1).toString().padStart(2) + ".")} [${chalk.cyan(date)}] from ${chalk.bold(r.from_caller || "?")} → ${chalk.dim(`@${r.session_name}`)}`);
    console.log(`      ${chalk.bold("ask:")}     ${r.task_summary}`);
    if (r.findings_preview) {
      console.log(`      ${chalk.bold("preview:")} ${chalk.dim(r.findings_preview.slice(0, 200))}`);
    }
    console.log(`      ${chalk.dim(`outcome: ${r.outcome} · task_id: ${r.task_id}`)}`);
  });
  console.log("");
  console.log(chalk.dim(`Full trail of any entry: agentalk-delegate tail <task_id>`));
  console.log("");
}

// ─── Session-target delegate (@name) ───────────────────────────────
async function cmdDelegateSession(name, task) {
  const timeoutStr = argValue("--timeout");
  const timeout = timeoutStr ? parseInt(timeoutStr, 10) : null;
  if (timeoutStr && (isNaN(timeout) || timeout <= 0)) {
    console.error(`Invalid --timeout value: ${timeoutStr}`);
    process.exit(2);
  }
  const filesRaw = argValue("--files");
  const files = filesRaw ? filesRaw.split(",").map(s => s.trim()).filter(Boolean) : undefined;

  const result = await supervisorDelegateSession({
    sessionName: name,
    brief: {
      task,
      files,
      context: argValue("--context") || undefined,
      output: argValue("--output") || undefined,
      budget: argValue("--budget") || undefined,
    },
    taskId: argValue("--task-id") || null,
    mainAgent: "cli",
    timeout,
  });

  // Same marker shape as regular delegate so skills parse uniformly.
  process.stdout.write(`[STATUS] ${result.status}\n`);
  process.stdout.write(`[AGENT] ${result.agent}\n`);
  process.stdout.write(`[SESSION_CWD] ${result.session_cwd || "?"}\n`);
  if (result.task_id) {
    const taskPath = join(homedir(), ".agentalk", "tasks", `${result.task_id}.jsonl`);
    process.stdout.write(`[TASK] ${taskPath}\n`);
    process.stdout.write(`[TASK_ID] ${result.task_id}\n`);
  }
  if (result.step_id) process.stdout.write(`[STEP] ${result.step_id}\n`);
  if (result.diagnostics?.tokens?.total != null) {
    const t = result.diagnostics.tokens;
    process.stdout.write(`[TOKENS] ${t.total}${t.estimated ? " (est)" : ""}\n`);
  }
  if (result.diagnostics?.elapsed_ms != null) {
    process.stdout.write(`[ELAPSED_MS] ${result.diagnostics.elapsed_ms}\n`);
  }
  if (result.findings) {
    process.stdout.write(`[FINDINGS]\n${result.findings}\n[END_FINDINGS]\n`);
  }
  if (result.unknowns?.length) {
    process.stdout.write(`[UNKNOWNS]\n${result.unknowns.map(u => "- " + u).join("\n")}\n[END_UNKNOWNS]\n`);
  }
  if (result.status !== "ok" && result.status !== "timeout_partial") {
    const d = result.diagnostics || {};
    process.stdout.write(`[DIAGNOSTICS]\n`);
    if (d.outcome)    process.stdout.write(`outcome: ${d.outcome}\n`);
    if (d.detail)     process.stdout.write(`detail: ${d.detail}\n`);
    process.stdout.write(`[END_DIAGNOSTICS]\n`);
  }

  // Value report (Layer 4)
  const suppressReport = argv.includes("--no-value-report");
  if (!suppressReport && (result.status === "ok" || result.status === "timeout_partial")) {
    process.stdout.write(`[VALUE_REPORT]\n`);
    process.stdout.write(`session: @${result.session_name}\n`);
    process.stdout.write(`session_cwd: ${result.session_cwd}\n`);
    process.stdout.write(`delegate_tokens: ${result.diagnostics?.tokens?.total || 0}\n`);
    process.stdout.write(`task_summary: ${task.slice(0, 150)}${task.length > 150 ? "…" : ""}\n`);
    if (result.inbox_path) {
      process.stdout.write(`inbox_logged_to: ${result.inbox_path}\n`);
    }
    if (result.status === "timeout_partial") {
      process.stdout.write(`note: partial output recovered\n`);
    }
    process.stdout.write(`[END_VALUE_REPORT]\n`);
  }

  process.exit(result.status === "ok" || result.status === "timeout_partial" ? 0 : 1);
}

// ─── Dispatch ──────────────────────────────────────────────────────
const first = argv[0];

if (!first || first === "help" || first === "--help" || first === "-h") {
  printHelp();
  process.exit(0);
}

// Subcommand dispatch
if (first === "quotas")       { cmdQuotas();                          process.exit(0); }
if (first === "capabilities") { cmdCapabilities();                    process.exit(0); }
if (first === "init")         { await cmdInit();                      process.exit(0); }
if (first === "review")       { cmdReview();                          process.exit(0); }
if (first === "sessions")     { cmdListSessions();                    process.exit(0); }
if (first === "inbox")        { cmdInbox();                           process.exit(0); }

if (first === "register-session") {
  const name = argv[1];
  if (!name || name.startsWith("--")) {
    console.error("Usage: agentalk-delegate register-session <name> --cwd <path> [--session-id <id>]");
    process.exit(2);
  }
  cmdRegisterSession(name);
  process.exit(0);
}

if (first === "unregister-session") {
  const name = argv[1];
  if (!name || name.startsWith("--")) {
    console.error("Usage: agentalk-delegate unregister-session <name>");
    process.exit(2);
  }
  cmdUnregisterSession(name);
  process.exit(0);
}

if (first === "tail") {
  const id = argv[1];
  if (!id || id.startsWith("--")) {
    console.error("Usage: agentalk-delegate tail <task-id> [--step s1] [--stream stdout|stderr] [--follow]");
    process.exit(2);
  }
  await cmdTail(id);
  process.exit(0);
}

if (first === "recall") {
  cmdRecall();
  process.exit(0);
}

if (first === "remember") {
  const fact = argv[1];
  if (!fact || fact.startsWith("--")) {
    console.error("Usage: agentalk-delegate remember \"<fact>\" [--memo-context \"...\"] [--task-id <id>]");
    process.exit(2);
  }
  cmdRemember(fact);
  process.exit(0);
}

if (first === "task") {
  const id = argv[1];
  if (!id || id.startsWith("--")) {
    console.error("Usage: agentalk-delegate task <task-id>");
    process.exit(2);
  }
  cmdTaskStatus(id);
  process.exit(0);
}

// @session target: delegate to a registered session
if (first?.startsWith("@")) {
  const sessionName = first.slice(1);
  if (!sessionName) {
    console.error("Usage: agentalk-delegate @<session-name> \"<task>\" [options]");
    process.exit(2);
  }
  const task = argv[1];
  if (!task || task.startsWith("--")) {
    console.error(`Usage: agentalk-delegate @${sessionName} "<task description>" [options]`);
    process.exit(2);
  }
  await cmdDelegateSession(sessionName, task);
  // cmdDelegateSession exits itself
}

// Primary: <agent> "<task>" [options]
// Validate the agent key before treating as delegation (avoids accidentally
// running a typo'd subcommand as a delegation).
if (AGENTS[first]) {
  const task = argv[1];
  if (!task || task.startsWith("--")) {
    console.error(`Usage: agentalk-delegate ${first} "<task description>" [options]`);
    console.error("Run `agentalk-delegate help` for full usage.");
    process.exit(2);
  }
  await cmdDelegate(first, task);
  // cmdDelegate calls process.exit itself
}

console.error(`Unknown command or agent: ${first}`);
console.error("Run `agentalk-delegate help` to see usage.");
console.error(`Available agents: ${Object.keys(AGENTS).join(", ")}`);
process.exit(2);
