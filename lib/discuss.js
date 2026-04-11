import chalk from "chalk";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { AGENTS, runAgent, stopSignal, requestStop, clearStop } from "./agents.js";
import { t } from "./i18n.js";
import { getModeratorKey, getGlobalTimeout } from "./config.js";

// Re-export stop signal helpers so index.js / MCP server only need to know
// about discuss.js
export { stopSignal, requestStop };

// ─── Summary persistence ──────────────────────────────────────────────
const SUMMARIES_DIR = join(homedir(), ".agentalk", "summaries");

function topicSlug(topic) {
  return topic.slice(0, 40).replace(/\s+/g, "-").replace(/[^\w\u4e00-\u9fff-]/g, "").slice(0, 30);
}

// Build the markdown content for a summary
function buildSummaryContent(context, topic, agentKeys, dateStr) {
  const participants = agentKeys.map(k => AGENTS[k]?.displayName || k).join(", ");

  // Extract conclusion if present
  const conclusionMsg = context.messages.findLast(
    m => m.role === "system" && /^\[(CONCLUSION|DEBATE_CONCLUSION|TIMEOUT|ABORTED)\]/.test(m.content)
  );
  const conclusion = conclusionMsg
    ? conclusionMsg.content.replace(/^\[.*?\]\s*/, "").trim()
    : null;

  const lines = [
    t("summary.md_title"),
    ``,
    t("summary.md_date", { date: dateStr }),
    t("summary.md_topic", { topic }),
    t("summary.md_participants", { names: participants }),
    ``,
  ];

  // TL;DR at the top — most useful for coding agents skimming the file
  if (conclusion) {
    lines.push(`---`, ``, t("summary.md_conclusion"), ``, conclusion, ``, `---`, ``);
  } else {
    lines.push(`---`, ``);
  }

  lines.push(`${t("summary.md_section")}`, ``);

  for (const m of context.messages) {
    if (m.role === "user") {
      lines.push(`${t("summary.md_user")}\n\n${m.content}\n`);
    } else if (m.role === "system") {
      // Skip — conclusion already shown at top
    } else {
      const name = AGENTS[m.role]?.displayName || m.role;
      lines.push(`### ${name}\n\n${m.content}\n`);
    }
  }

  return lines.join("\n");
}

// Save to a specific directory; returns filepath or null
function saveToDir(dir, content, filename) {
  try {
    mkdirSync(dir, { recursive: true });
    const filepath = join(dir, filename);
    writeFileSync(filepath, content);
    return filepath;
  } catch {
    return null;
  }
}

// Save discussion summary — writes THREE things:
//   1. Global archive (Markdown):  ~/.agentalk/summaries/<stamp>-<slug>.md
//   2. Local project (Markdown):   <cwd>/.agentalk/<stamp>-<slug>.md  +  latest.md
//   3. Local project (raw JSON):   <cwd>/.agentalk/<stamp>-<slug>.json +  latest.json
// Markdown is for humans / coding agents to read. JSON preserves the exact
// {role, content, timestamp} array so the discussion can be programmatically
// replayed or parsed.
// Returns { global, local, localJson } paths (null if failed)
export function saveSummary(context, topic, agentKeys, { localDir = null } = {}) {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 16).replace("T", " ");
  const fileStamp = now.toISOString().slice(0, 16).replace(/[-:T]/g, "").slice(0, 12);
  const slug = topicSlug(topic);
  const mdName = `${fileStamp}-${slug}.md`;
  const jsonName = `${fileStamp}-${slug}.json`;
  const content = buildSummaryContent(context, topic, agentKeys, dateStr);

  const globalPath = saveToDir(SUMMARIES_DIR, content, mdName);

  let localPath = null;
  let localJsonPath = null;
  if (localDir) {
    const dir = join(localDir, ".agentalk");
    localPath = saveToDir(dir, content, mdName);
    if (localPath) {
      // Fixed filenames — coding agents can reference these without globbing
      saveToDir(dir, content, "latest.md");
    }
    // Raw JSON: untouched message array + metadata header
    const rawPayload = JSON.stringify({
      topic,
      date: dateStr,
      participants: agentKeys,
      cwd: localDir,
      messages: context.messages,
    }, null, 2);
    localJsonPath = saveToDir(dir, rawPayload, jsonName);
    if (localJsonPath) saveToDir(dir, rawPayload, "latest.json");
  }

  return { global: globalPath, local: localPath, localJson: localJsonPath };
}

// ─── Output abstraction (terminal vs MCP capture) ────────────────────
export function makeOutput(capture = false) {
  if (!capture) return { log: (...a) => console.log(...a), lines: null };
  const lines = [];
  return { log: (...a) => lines.push(a.map(String).join(" ")), lines };
}

// ─── User input buffer (for mid-discussion interjections) ────────────
const userInputQueue = [];

// ─── Feed buffer (user supplements mid-discussion) ───────────────────
export const feedBuffer = [];

export function feedMessage(msg) {
  feedBuffer.push(msg);
}

export function drainFeed() {
  if (feedBuffer.length === 0) return null;
  const msgs = feedBuffer.splice(0);
  return msgs.join("\n");
}

export function pushUserInput(text) {
  userInputQueue.push(text);
}

function flushUserInput(context, out) {
  let flushed = false;
  while (userInputQueue.length > 0) {
    const msg = userInputQueue.shift();
    context.add("user", msg);
    out.log(`\n${chalk.bold.white("👤 You:")} ${msg}`);
    flushed = true;
  }
  return flushed;
}

// ─── Judge / Moderator ───────────────────────────────────────────────
// The moderator is configurable via /agents moderator <key>.
// Falls back to the first active agent if not set.
function getJudgeKey() {
  const configured = getModeratorKey();
  if (configured && AGENTS[configured]) return configured;
  // Fallback: first active agent
  return Object.keys(AGENTS)[0] || null;
}

function getJudgeAgent() {
  return AGENTS[getJudgeKey()] || null;
}

// Display the judge's verdict attributed to Claude with its colored label
function showJudgeVerdict(verdict, out) {
  const agent = getJudgeAgent();
  if (!agent) {
    // Fallback: no formatting if Claude not in active agents
    if (verdict.converged) {
      out.log(t("discuss.converged", { summary: verdict.summary }));
    } else {
      out.log(t("discuss.judge_continue", { reason: verdict.reason }));
    }
    return;
  }
  const modLabel = `${agent.label}${chalk.dim(" [Moderator]")}`;
  if (verdict.converged) {
    out.log(`\n${modLabel}`);
    out.log(`${agent.color("│")} ✅ ${verdict.summary}`);
    out.log(`${agent.color("╰")}`);
  } else {
    out.log(`\n${modLabel}`);
    out.log(`${agent.color("│")} ${chalk.dim("→")} ${verdict.reason || "continuing..."}`);
    out.log(`${agent.color("╰")}`);
  }
}

// Display a summary attributed to Claude as moderator
function showModeratorSummary(summary, out) {
  const agent = getJudgeAgent();
  if (!agent) { out.log(summary); return; }
  const modLabel = `${agent.label}${chalk.dim(" [Moderator]")}`;
  out.log(`\n${modLabel}`);
  for (const line of summary.split("\n")) {
    if (line.trim()) out.log(`${agent.color("│")} ${line}`);
  }
  out.log(`${agent.color("╰")}`);
}

// ─── Error detection helpers ─────────────────────────────────────────
function isTransientError(error) {
  return /busy|rate.?limit|overloaded|capacity|503|529|too many|timeout|ECONNREFUSED/i.test(error);
}

// ─── History formatter ────────────────────────────────────────────────
function formatHistory(messages) {
  return messages
    .map((m) => {
      const speaker =
        m.role === "user" ? "[User]"
        : m.role === "system" ? "[System]"
        : `[${m.role.charAt(0).toUpperCase() + m.role.slice(1)}]`;
      return `${speaker}\n${m.content}`;
    })
    .join("\n\n");
}

// ─── Prompt builders ─────────────────────────────────────────────────
function buildDiscussPrompt(context, agentKey, round) {
  const history = formatHistory(context.messages);
  const name = AGENTS[agentKey].name;
  if (round === 1) {
    return t("prompt.discuss_r1", { history, name });
  }
  return t("prompt.discuss_rn", { history, name, round });
}

function buildDebatePrompt(context, agentKey, position, totalAgents, roundNum) {
  const history = formatHistory(context.messages);
  const name = AGENTS[agentKey].name;
  const isFirst = context.messages.filter(m => !["user", "system"].includes(m.role)).length === 0;

  if (isFirst) {
    return t("prompt.debate_r1_first", { history, name });
  }
  if (roundNum <= 1) {
    return t("prompt.debate_r1_mid", { history, name, pos: position, total: totalAgents });
  }
  return t("prompt.debate_rn", { history, name, pos: position, total: totalAgents, round: roundNum });
}

// ─── Convergence check ───────────────────────────────────────────────
function hasStopSignal(response) {
  return /\[STOP\]/i.test(response);
}

// Briefing, convergence checks, and moderator planning all get a generous
// timeout — they're orchestration steps, not per-agent work.
const ORCHESTRATOR_TIMEOUT = 600;

async function judgeConvergence(recentMessages) {
  const history = formatHistory(recentMessages);
  const result = await runAgent(getJudgeKey(), t("prompt.judge", { history }), { silent: true, timeout: ORCHESTRATOR_TIMEOUT });
  const text = result.response.trim();
  if (text.startsWith("CONVERGED:")) {
    return { converged: true, summary: text.replace("CONVERGED:", "").trim() };
  }
  return { converged: false, reason: text.replace("CONTINUE:", "").trim() };
}

async function summarizeCurrent(context) {
  const agent = getJudgeAgent();
  const judgeLabel = agent ? `${agent.displayName} [Moderator]` : "Moderator";
  console.log(chalk.dim(t("discuss.summarising", { judge: judgeLabel })));
  const history = formatHistory(context.messages.slice(-12));
  const result = await runAgent(getJudgeKey(), t("prompt.summarise", { history }), { silent: true, timeout: ORCHESTRATOR_TIMEOUT });
  return result.response.trim();
}

// ─── Graceful stop ───────────────────────────────────────────────────
async function gracefulStop(context, out) {
  // Flip the signal off BEFORE summarizing, otherwise the summariser's own
  // runAgent call would see stopSignal and resolve as stopped immediately.
  clearStop();
  const summary = await summarizeCurrent(context);
  out.log(t("discuss.stopped"));
  showModeratorSummary(summary, out);
  context.add("system", `[ABORTED] ${summary}`);
  context.save();
}

// ─── /discuss — parallel rounds ──────────────────────────────────────
export async function discuss(topic, context, options = {}) {
  const { maxRounds = 8, agents = Object.keys(AGENTS), capture = false, noAddUser = false } = options;
  const out = makeOutput(capture);
  clearStop();

  out.log(t("discuss.parallel_header", { rounds: maxRounds }));
  out.log(t("discuss.topic", { topic }));

  if (!noAddUser) context.add("user", topic);

  for (let round = 1; round <= maxRounds; round++) {
    if (stopSignal.requested) { await gracefulStop(context, out); return out.lines; }

    // Drain feed buffer — user supplements from /add
    const feed = drainFeed();
    if (feed) {
      context.add("system", `[用户补充] ${feed}`);
      out.log(`\n📋 用户补充: ${feed.slice(0, 100)}${feed.length > 100 ? "..." : ""}`);
    }

    out.log(`\n── Round ${round} ──`);

    // runAgent watches stopSignal internally — no need to race here.
    const results = await Promise.all(
      agents.map((key) => runAgent(key, buildDiscussPrompt(context, key, round), { silent: capture }))
    );

    let stopCount = 0;
    let successCount = 0;
    for (const r of results) {
      if (r.stopped) continue; // user pressed stop — loop top will handle
      if (r.response) {
        context.add(r.agent, r.response);
        context.save();
        successCount++;
        // Only count [STOP] from round 2+ — round 1 must complete fully
        if (round >= 2 && hasStopSignal(r.response)) stopCount++;
      } else if (r.error) {
        const name = AGENTS[r.agent]?.displayName || r.agent;
        if (r.timedOut) {
          out.log(chalk.yellow(t("discuss.timeout_skip", { name, s: r.timeoutSec })));
        } else if (isTransientError(r.error)) {
          out.log(chalk.yellow(t("discuss.busy_skip", { name })));
        } else {
          out.log(chalk.yellow(t("discuss.error_skip", { name, msg: r.error.split("\n")[0].slice(0, 80) })));
        }
      }
    }

    if (successCount === 0) {
      out.log(chalk.red(t("discuss.all_failed")));
      break;
    }

    if (stopSignal.requested) { await gracefulStop(context, out); return out.lines; }

    if (round >= 2 && stopCount === results.length) {
      out.log(t("discuss.converge_all"));
      const summary = await summarizeCurrent(context);
      showModeratorSummary(summary, out);
      context.add("system", `[CONCLUSION] ${summary}`);
      context.save();
      return out.lines;
    } else if (stopCount > 0) {
      out.log(t("discuss.converge_some", { n: stopCount, total: results.length }));
    }

    if (round >= 2) {
      out.log(t("discuss.judge_checking"));
      const verdict = await judgeConvergence(context.messages.slice(-agents.length * 3));
      showJudgeVerdict(verdict, out);
      if (verdict.converged) {
        context.add("system", `[CONCLUSION] ${verdict.summary}`);
        context.save();
        return out.lines;
      }
    }

    if (round === maxRounds) {
      out.log(t("discuss.max_rounds", { n: maxRounds }));
      const summary = await summarizeCurrent(context);
      showModeratorSummary(summary, out);
      context.add("system", `[TIMEOUT] ${summary}`);
    }
  }

  context.save();
  return out.lines;
}

// ─── /debate — serial (A→B→C→D→A→...) ──────────────────────────────
export async function debate(topic, context, options = {}) {
  const { maxTurns = 12, agents = Object.keys(AGENTS), capture = false, noJudge = false, noAddUser = false } = options;
  const out = makeOutput(capture);
  clearStop();

  const agentNames = agents.map(k => AGENTS[k]?.displayName || k).join(" → ");
  out.log(t("discuss.serial_header", { agents: agentNames }) + (!noJudge ? t("discuss.serial_turns", { turns: maxTurns }) : ""));

  if (!noAddUser) context.add("user", topic);

  const stoppedAgents = new Set();
  let skippedInRow = 0;

  for (let turn = 0; turn < maxTurns; turn++) {
    if (stopSignal.requested) { await gracefulStop(context, out); return out.lines; }

    flushUserInput(context, out);

    // Drain feed buffer — user supplements from /add
    const feed = drainFeed();
    if (feed) {
      context.add("system", `[用户补充] ${feed}`);
      out.log(`\n📋 用户补充: ${feed.slice(0, 100)}${feed.length > 100 ? "..." : ""}`);
    }

    const agentKey = agents[turn % agents.length];
    const position = (turn % agents.length) + 1;
    const roundNum = Math.floor(turn / agents.length) + 1;

    if (turn % agents.length === 0) out.log(t("discuss.round", { n: roundNum }));

    const prompt = buildDebatePrompt(context, agentKey, position, agents.length, roundNum);
    const result = await runAgent(agentKey, prompt, { silent: capture });

    if (result.stopped) {
      // Stop signal fired mid-turn — loop top will run gracefulStop
      continue;
    }

    if (!result.response && result.error) {
      skippedInRow++;
      const name = AGENTS[agentKey]?.displayName || agentKey;
      if (result.timedOut) {
        out.log(chalk.yellow(t("discuss.timeout_skip", { name, s: result.timeoutSec })));
      } else if (isTransientError(result.error)) {
        out.log(chalk.yellow(t("discuss.busy_skip", { name })));
      } else {
        out.log(chalk.yellow(t("discuss.error_skip", { name, msg: result.error.split("\n")[0].slice(0, 80) })));
      }
      if (skippedInRow >= agents.length) {
        out.log(chalk.red(t("discuss.all_failed")));
        break;
      }
      continue;
    }
    skippedInRow = 0;

    if (result.response) {
      context.add(agentKey, result.response);
      context.save();
      // Only honor [STOP] from round 2 onwards — round 1 must complete fully
      if (roundNum >= 2 && hasStopSignal(result.response)) {
        stoppedAgents.add(agentKey);
        const stopped = stoppedAgents.size;
        const total = agents.length;
        if (stopped < total) {
          out.log(t("discuss.judge_pending", { name: AGENTS[agentKey].displayName, n: stopped, total }));
        } else if (!noJudge) {
          out.log(t("discuss.judge_checking"));
          const verdict = await judgeConvergence(context.messages.slice(-agents.length * 2));
          showJudgeVerdict(verdict, out);
          if (verdict.converged) {
            context.add("system", `[DEBATE_CONCLUSION] ${verdict.summary}`);
            context.save();
            return out.lines;
          } else {
            stoppedAgents.clear();
          }
        }
      }
    }

    // Judge at end of each cycle, but only from round 2+ (skip if noJudge)
    const isEndOfCycle = (turn + 1) % agents.length === 0;
    if (!noJudge && isEndOfCycle && roundNum >= 2) {
      if (stopSignal.requested) { await gracefulStop(context, out); return out.lines; }
      out.log(t("discuss.judge_checking"));
      const verdict = await judgeConvergence(context.messages.slice(-agents.length * 2));
      showJudgeVerdict(verdict, out);
      if (verdict.converged) {
        context.add("system", `[DEBATE_CONCLUSION] ${verdict.summary}`);
        context.save();
        return out.lines;
      }
    }

    if (turn === maxTurns - 1) {
      out.log(t("discuss.max_turns", { n: maxTurns }));
      if (!noJudge) {
        const summary = await summarizeCurrent(context);
        showModeratorSummary(summary, out);
        context.add("system", `[TIMEOUT] ${summary}`);
      }
    }
  }

  context.save();
  return out.lines;
}

// ─── Moderator-led session ───────────────────────────────────────────
// Parse the moderator's structured plan response
function parsePlan(text) {
  const allAgents = Object.keys(AGENTS);
  const result = { format: "debate", rounds: 4, agents: allAgents, topic: "", reason: "" };
  for (const line of text.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toUpperCase();
    const val = line.slice(colon + 1).trim();
    if (key === "FORMAT") {
      const f = val.toLowerCase();
      if (["discuss", "debate", "broadcast"].includes(f)) result.format = f;
    } else if (key === "ROUNDS") {
      const n = parseInt(val);
      if (n > 0 && n <= 12) result.rounds = n;
    } else if (key === "AGENTS") {
      if (val.toLowerCase() !== "all") {
        const keys = val.split(",").map(s => s.trim()).filter(k => AGENTS[k]);
        if (keys.length > 0) result.agents = keys;
      }
    } else if (key === "TOPIC") {
      result.topic = val;
    } else if (key === "REASON") {
      result.reason = val;
    } else if (key === "BRIEFING") {
      result.briefing = val.toLowerCase() === "yes";
    }
  }
  return result;
}

export async function moderatedSession(request, context, options = {}) {
  const { capture = false, briefingProvider = null, contextSource = null } = options;
  const out = makeOutput(capture);
  clearStop();

  const judgeKey = getJudgeKey();
  const judgeAgent = getJudgeAgent();
  const agentList = Object.entries(AGENTS).map(([k, a]) => `${k}=${a.name}`).join(", ");
  const history = formatHistory(context.messages.slice(-20));

  const briefingHint = contextSource ? t("prompt.mod_plan_briefing_hint", { source: contextSource }) : "";
  const planResult = await runAgent(judgeKey, t("prompt.mod_plan", { request, history, agents: agentList, briefing_hint: briefingHint }), { silent: true, timeout: ORCHESTRATOR_TIMEOUT });

  // User stopped during planning — bail silently
  if (planResult.stopped) {
    clearStop();
    return out.lines;
  }

  // Abort if planning failed — don't cascade into a full debate of timeouts
  if (planResult.timedOut || !planResult.response.trim()) {
    if (judgeAgent && !capture) {
      const modLabel = `${judgeAgent.label}${chalk.dim(" [Moderator]")}`;
      out.log(`\n${modLabel}`);
      out.log(`${judgeAgent.color("│")} ${chalk.yellow(t("mod.plan_failed"))}`);
      out.log(`${judgeAgent.color("│")} ${chalk.dim(t("mod.plan_fallback"))}`);
      out.log(`${judgeAgent.color("╰")}`);
    }
    return out.lines;
  }

  const plan = parsePlan(planResult.response);
  if (!plan.topic) plan.topic = request;

  // Moderator requested a context briefing — run it before the discussion starts
  if (plan.briefing && briefingProvider) {
    const ok = await briefingProvider(plan.topic);
    if (!ok) return out.lines; // briefing failed → abort (no context = no point)
  }

  // Show the decision
  if (judgeAgent && !capture) {
    const modLabel = `${judgeAgent.label}${chalk.dim(" [Moderator]")}`;
    out.log(`\n${modLabel}`);
    out.log(`${judgeAgent.color("│")} ${chalk.bold(plan.format.toUpperCase())} · ${plan.rounds} rounds · ${plan.agents.map(k => AGENTS[k]?.name || k).join(", ")}`);
    if (plan.reason) out.log(`${judgeAgent.color("│")} ${chalk.dim(plan.reason)}`);
    if (plan.topic !== request) out.log(`${judgeAgent.color("│")} ${chalk.dim("→ " + plan.topic)}`);
    out.log(`${judgeAgent.color("╰")}`);
  }

  // Add user's original request to context, save discussion metadata
  context.add("user", request);
  context.add("system", `[DISCUSSION_START] mode=${plan.format} agents=${plan.agents.join(",")} rounds=${plan.rounds}`);
  context.save();

  if (stopSignal.requested) { await gracefulStop(context, out); return out.lines; }

  // Execute the plan
  if (plan.format === "discuss") {
    await discuss(plan.topic, context, { maxRounds: plan.rounds, agents: plan.agents, capture, noAddUser: true });
  } else if (plan.format === "broadcast") {
    const prompt = context.buildPrompt(null, plan.topic);
    const results = await Promise.all(plan.agents.map(key => runAgent(key, prompt)));
    for (const r of results) {
      if (r.response) { context.add(r.agent, r.response); context.save(); }
    }
  } else {
    await debate(plan.topic, context, { maxTurns: plan.rounds * plan.agents.length, agents: plan.agents, capture, noAddUser: true });
  }

  return out.lines;
}

// ─── broadcast ───────────────────────────────────────────────────────
export async function broadcast(message, context, targets) {
  const targetNames = targets.map((k) => AGENTS[k].displayName).join(", ");
  console.log(chalk.bold.white(t("broadcast.header", { targets: targetNames })));

  context.add("user", message);
  const prompt = context.buildPrompt(null, "Please respond to the latest message above.");
  const results = await Promise.all(targets.map((key) => runAgent(key, prompt)));

  for (const r of results) {
    if (r.response) context.add(r.agent, r.response);
  }

  context.save();
}
