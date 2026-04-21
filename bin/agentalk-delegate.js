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

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import chalk from "chalk";
import { AGENTS } from "../lib/agents.js";
import { listAgents } from "../lib/config.js";
import {
  delegate as supervisorDelegate,
  readQuotaState,
  readCapabilities,
  rememberFact,
  recallMemory,
  getTask,
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
    --files <a,b>           files the delegate should read (paths relative to cwd)
    --context "..."         2-3 lines of background the delegate needs
    --output "..."          expected output format / focus
    --budget "..."          length / detail hint (e.g. "200 words")
    --task-id <id>          reuse an existing task (multi-step)

${chalk.bold("Helpers")}
  ${chalk.cyan("agentalk-delegate quotas")}           observed quota state per agent (from real 429/rate-limit signals)
  ${chalk.cyan("agentalk-delegate capabilities")}     per-agent strengths / ctx window / cost tier
  ${chalk.cyan('agentalk-delegate remember "fact"')}  append a fact to project memory (.agentalk/memory.jsonl)
  ${chalk.cyan("agentalk-delegate recall")}           read recent project memory entries
  ${chalk.cyan("agentalk-delegate task <id>")}        query a delegation task's state
  ${chalk.cyan("agentalk-delegate init")}             setup status (CLIs, skills) + next-step hints
  ${chalk.cyan("agentalk-delegate review")}           per-agent performance from delegations.jsonl

${chalk.bold("Output format (for shell/skill parsing)")}
  Delegation success → [STATUS] ok / [TASK] <path> / [FINDINGS] ... / [TOKENS] N
  Delegation failure → [STATUS] <outcome> / [DIAGNOSTICS] ...
  Always includes [TASK] <path> to the full task JSON for deep inspection.

${chalk.bold("Available agents")}: ${Object.keys(AGENTS).join(", ")}
`);
}

// ─── Primary delegation ────────────────────────────────────────────
async function cmdDelegate(agent, task) {
  const filesRaw = argValue("--files");
  const files = filesRaw ? filesRaw.split(",").map(s => s.trim()).filter(Boolean) : undefined;
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
  });

  // Structured marker output — deterministic, parseable by skills/scripts.
  process.stdout.write(`[STATUS] ${result.status}\n`);
  process.stdout.write(`[AGENT] ${result.agent}\n`);
  if (result.task_id) {
    const taskPath = join(homedir(), ".agentalk", "tasks", `${result.task_id}.json`);
    process.stdout.write(`[TASK] ${taskPath}\n`);
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
  console.log(chalk.bold("\nAgent capabilities (defaults + local overrides from ~/.agentalk/capability.json):\n"));
  for (const [k, v] of Object.entries(caps)) {
    console.log(`  ${chalk.bold(k)}${chalk.dim("  (cost: " + (v.cost_tier || "?") + ", ctx: " + (v.context_window || 0).toLocaleString() + ")")}`);
    if (v.strengths?.length) console.log(`    ${chalk.dim("strengths:")} ${v.strengths.join(", ")}`);
    if (v.good_for?.length)  console.log(`    ${chalk.dim("good for: ")} ${v.good_for.join("; ")}`);
    if (v.weakness?.length) {
      const wk = Array.isArray(v.weakness) ? v.weakness : [v.weakness];
      console.log(`    ${chalk.dim("weakness: ")} ${wk.join(", ")}`);
    }
    console.log("");
  }
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
