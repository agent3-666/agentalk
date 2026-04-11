import chalk from "chalk";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { AGENTS, runAgent } from "./agents.js";
import { t } from "./i18n.js";
import { getModeratorKey } from "./config.js";

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

// Save discussion summary — global archive + local project dir
// Returns { global, local } paths (null if failed)
export function saveSummary(context, topic, agentKeys, { localDir = null } = {}) {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 16).replace("T", " ");
  const fileStamp = now.toISOString().slice(0, 16).replace(/[-:T]/g, "").slice(0, 12);
  const slug = topicSlug(topic);
  const filename = `${fileStamp}-${slug}.md`;
  const content = buildSummaryContent(context, topic, agentKeys, dateStr);

  const globalPath = saveToDir(SUMMARIES_DIR, content, filename);

  let localPath = null;
  if (localDir) {
    const dir = join(localDir, ".agentalk");
    localPath = saveToDir(dir, content, filename);
    if (localPath) {
      // Always overwrite latest.md — coding agents reference this fixed path
      saveToDir(dir, content, "latest.md");
    }
  }

  return { global: globalPath, local: localPath };
}

// ─── Output abstraction (terminal vs MCP capture) ────────────────────
export function makeOutput(capture = false) {
  if (!capture) return { log: (...a) => console.log(...a), lines: null };
  const lines = [];
  return { log: (...a) => lines.push(a.map(String).join(" ")), lines };
}

// ─── Shared stop signal ──────────────────────────────────────────────
export const stopSignal = { requested: false };

export function requestStop() {
  stopSignal.requested = true;
}

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

// ─── User input queue (mid-discussion interjections) ──────────────────
const userInputQueue = [];

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

async function judgeConvergence(recentMessages) {
  const history = formatHistory(recentMessages);
  const result = await runAgent(getJudgeKey(), t("prompt.judge", { history }), { silent: true });
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
  const result = await runAgent(getJudgeKey(), t("prompt.summarise", { history }), { silent: true });
  return result.response.trim();
}

// ─── Graceful stop ───────────────────────────────────────────────────
async function gracefulStop(context, out) {
  const summary = await summarizeCurrent(context);
  out.log(t("discuss.stopped"));
  showModeratorSummary(summary, out);
  context.add("system", `[ABORTED] ${summary}`);
  context.save();
  stopSignal.requested = false;
}

// ─── /discuss — parallel rounds ──────────────────────────────────────
export async function discuss(topic, context, options = {}) {
  const { maxRounds = 8, agents = Object.keys(AGENTS), capture = false } = options;
  const out = makeOutput(capture);
  stopSignal.requested = false;

  out.log(t("discuss.parallel_header", { rounds: maxRounds }));
  out.log(t("discuss.topic", { topic }));

  context.add("user", topic);

  for (let round = 1; round <= maxRounds; round++) {
    if (stopSignal.requested) { await gracefulStop(context, out); return out.lines; }

    // Drain feed buffer — user supplements from /add
    const feed = drainFeed();
    if (feed) {
      context.add("system", `[用户补充] ${feed}`);
      out.log(`\n📋 用户补充: ${feed.slice(0, 100)}${feed.length > 100 ? "..." : ""}`);
    }

    out.log(`\n── Round ${round} ──`);

    const results = await Promise.all(
      agents.map((key) => runAgent(key, buildDiscussPrompt(context, key, round), { silent: capture }))
    );

    let stopCount = 0;
    let successCount = 0;
    for (const r of results) {
      if (r.response) {
        context.add(r.agent, r.response);
        successCount++;
        // Only count [STOP] from round 2+ — round 1 must complete fully
        if (round >= 2 && hasStopSignal(r.response)) stopCount++;
      } else if (r.error) {
        const name = AGENTS[r.agent]?.displayName || r.agent;
        if (isTransientError(r.error)) {
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
  const { maxTurns = 12, agents = Object.keys(AGENTS), capture = false, noJudge = false } = options;
  const out = makeOutput(capture);
  stopSignal.requested = false;

  const agentNames = agents.map(k => AGENTS[k]?.displayName || k).join(" → ");
  out.log(t("discuss.serial_header", { agents: agentNames }) + (!noJudge ? t("discuss.serial_turns", { turns: maxTurns }) : ""));

  context.add("user", topic);

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

    if (!result.response && result.error) {
      skippedInRow++;
      const name = AGENTS[agentKey]?.displayName || agentKey;
      if (isTransientError(result.error)) {
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
