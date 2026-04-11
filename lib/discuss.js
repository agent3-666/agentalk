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

  // Token usage section — pick up the [TOKEN_USAGE] system message if present
  const tokenMsg = context.messages.findLast(
    m => m.role === "system" && m.content.startsWith("[TOKEN_USAGE]")
  );
  if (tokenMsg) {
    try {
      const usage = JSON.parse(tokenMsg.content.slice("[TOKEN_USAGE] ".length));
      const entries = Object.entries(usage).filter(([, v]) => v.total > 0);
      if (entries.length > 0) {
        lines.push(`---`, ``, `## Token Usage`, ``);
        lines.push(`| Agent | Tokens | Turns |`);
        lines.push(`|-------|--------|-------|`);
        let grandTotal = 0;
        for (const [key, v] of entries) {
          const name = v.estimated ? `${AGENTS[key]?.displayName || key} *(est.)*` : (AGENTS[key]?.displayName || key);
          const est = v.estimated ? "~" : "";
          const total = `${est}${v.total.toLocaleString()}`;
          const breakdown = v.prompt > 0 ? ` (↑${v.prompt.toLocaleString()} ↓${v.completion.toLocaleString()})` : "";
          lines.push(`| ${name} | ${total}${breakdown} | ${v.turns} |`);
          grandTotal += v.total;
        }
        lines.push(`| **Total** | **~${grandTotal.toLocaleString()}** | |`);
        lines.push(``);
      }
    } catch {}
  }

  lines.push(`${t("summary.md_section")}`, ``);

  for (const m of context.messages) {
    if (m.role === "user") {
      lines.push(`${t("summary.md_user")}\n\n${m.content}\n`);
    } else if (m.role === "system") {
      // Skip — conclusion and token usage already shown at top
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

// ─── Material fetching (moderator pre-flight) ────────────────────────

function extractUrls(text) {
  const re = /https?:\/\/[^\s<>"{}|\\^`[\]]+/g;
  return [...new Set(text.match(re) || [])];
}

async function fetchUrl(url) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
      headers: { "User-Agent": "AgentTalk/2.0" },
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("text") && !ct.includes("json") && !ct.includes("xml")) return null;
    const raw = await res.text();
    const stripped = raw
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]{3,}/g, "  ")
      .replace(/\n{4,}/g, "\n\n\n")
      .trim();
    return stripped.slice(0, 20_000);
  } catch {
    return null;
  }
}

async function gatherMaterials({ urls = [], files = [] }, out) {
  const materials = {};
  for (const url of urls) {
    out.log(chalk.dim(`  ↳ ${t("briefing.fetching")} ${url.slice(0, 80)}`));
    const content = await fetchUrl(url);
    if (content) {
      materials[url] = content;
      out.log(chalk.dim(`    ✓ ${content.length.toLocaleString()} chars`));
    } else {
      out.log(chalk.yellow(`    ⚠ ${t("briefing.fetch_failed")}: ${url.slice(0, 60)}`));
    }
  }
  for (const fp of files) {
    try {
      const content = readFileSync(fp, "utf8");
      materials[fp] = content.slice(0, 50_000);
      out.log(chalk.dim(`  ↳ ${t("briefing.reading")}: ${fp} (${content.length.toLocaleString()} chars)`));
    } catch {
      out.log(chalk.yellow(`  ⚠ ${t("briefing.read_failed")}: ${fp}`));
    }
  }
  return materials;
}

async function synthesizeBriefing(judgeKey, judgeAgent, topic, materials, out) {
  const color = judgeAgent ? judgeAgent.color : (s) => s;
  const label = judgeAgent ? `${judgeAgent.label}${chalk.dim(" [Moderator]")}` : "[Moderator]";
  const materialsText = Object.entries(materials)
    .map(([src, content]) => `### Source: ${src}\n\n${content}`)
    .join("\n\n---\n\n");
  out.log(`\n${label}`);
  out.log(`${color("│")} ${chalk.dim(t("briefing.synthesising", { n: Object.keys(materials).length }))}`);
  const result = await runAgent(
    judgeKey,
    t("prompt.briefing_synthesis", { topic, materials: materialsText }),
    { silent: true, timeout: ORCHESTRATOR_TIMEOUT }
  );
  if (!result.response?.trim()) {
    out.log(`${color("│")} ${chalk.yellow(t("briefing.synthesis_failed"))}`);
    out.log(`${color("╰")}`);
    return null;
  }
  out.log(`${color("│")} ${chalk.green(t("briefing.injected", { n: Object.keys(materials).length }))}`);
  out.log(`${color("╰")}`);
  return result.response.trim();
}

// ─── Output abstraction (terminal vs MCP capture) ────────────────────
export function makeOutput(capture = false) {
  if (!capture) return { log: (...a) => console.log(...a), lines: null };
  const lines = [];
  return { log: (...a) => lines.push(a.map(String).join(" ")), lines };
}

// ─── Token usage tracking ─────────────────────────────────────────────
function makeTokenUsage() { return {}; }

function recordTokens(usage, agentKey, tokens) {
  if (!tokens || !agentKey) return;
  if (!usage[agentKey]) usage[agentKey] = { total: 0, prompt: 0, completion: 0, turns: 0, estimated: false };
  const e = usage[agentKey];
  e.total      += tokens.total      || 0;
  e.prompt     += tokens.prompt     || 0;
  e.completion += tokens.completion || 0;
  e.turns++;
  if (tokens.estimated) e.estimated = true;
}

function printTokenTable(usage, agentKeys, out) {
  const entries = agentKeys.map(k => [k, usage[k]]).filter(([, v]) => v && v.total > 0);
  if (!entries.length) return;
  out.log("");
  out.log(chalk.dim("── Token Usage ──"));
  let grandTotal = 0;
  let anyEstimated = false;
  for (const [key, v] of entries) {
    const name = (AGENTS[key]?.displayName || key).slice(0, 20).padEnd(20);
    const est = v.estimated ? "~" : " ";
    const totalStr = `${est}${v.total.toLocaleString()}`;
    const breakdown = v.prompt > 0
      ? chalk.dim(` (↑${v.prompt.toLocaleString()} ↓${v.completion.toLocaleString()})`)
      : "";
    out.log(chalk.dim(`  ${name} ${totalStr.padStart(8)}${breakdown}   · ${v.turns} turns`));
    grandTotal += v.total;
    if (v.estimated) anyEstimated = true;
  }
  out.log(chalk.dim("  " + "─".repeat(46)));
  const est = anyEstimated ? "~" : " ";
  out.log(chalk.dim(`  ${"Total".padEnd(20)} ${est}${grandTotal.toLocaleString()}`));
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
  // Fallback: last active agent (moderator anchors the end of the debate order)
  const keys = Object.keys(AGENTS);
  return keys.at(-1) || null;
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
function buildDiscussPrompt(context, agentKey, round, type = "discuss") {
  const history = formatHistory(context.messages);
  const name = AGENTS[agentKey].name;
  if (type === "brainstorm") {
    if (round === 1) return t("prompt.brainstorm_r1", { history, name });
    return t("prompt.brainstorm_rn", { history, name, round });
  }
  if (round === 1) return t("prompt.discuss_r1", { history, name });
  return t("prompt.discuss_rn", { history, name, round });
}

function buildDebatePrompt(context, agentKey, position, totalAgents, roundNum, type = "debate") {
  const history = formatHistory(context.messages);
  const name = AGENTS[agentKey].name;
  const isFirst = context.messages.filter(m => !["user", "system"].includes(m.role)).length === 0;
  const prefix = type === "challenge" ? "challenge" : type === "deepen" ? "deepen" : "debate";

  if (isFirst) return t(`prompt.${prefix}_r1_first`, { history, name });
  if (roundNum <= 1) return t(`prompt.${prefix}_r1_mid`, { history, name, pos: position, total: totalAgents });
  return t(`prompt.${prefix}_rn`, { history, name, pos: position, total: totalAgents, round: roundNum });
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
  const { maxRounds = 8, agents = Object.keys(AGENTS), capture = false, noAddUser = false, promptType = "discuss", header } = options;
  const out = makeOutput(capture);
  const tokenUsage = makeTokenUsage();
  clearStop();

  function finalize() {
    printTokenTable(tokenUsage, agents, out);
    if (Object.keys(tokenUsage).length > 0) {
      context.add("system", `[TOKEN_USAGE] ${JSON.stringify(tokenUsage)}`);
      context.save();
    }
    return out.lines;
  }

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
      agents.map((key) => runAgent(key, buildDiscussPrompt(context, key, round, promptType), { silent: capture }))
    );

    let stopCount = 0;
    let successCount = 0;
    for (const r of results) {
      if (r.stopped) continue; // user pressed stop — loop top will handle
      if (r.response) {
        context.add(r.agent, r.response);
        context.save();
        recordTokens(tokenUsage, r.agent, r.tokens);
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

    if (stopSignal.requested) { await gracefulStop(context, out); return finalize(); }

    if (round >= 2 && stopCount === results.length) {
      out.log(t("discuss.converge_all"));
      const summary = await summarizeCurrent(context);
      showModeratorSummary(summary, out);
      context.add("system", `[CONCLUSION] ${summary}`);
      context.save();
      return finalize();
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
        return finalize();
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
  return finalize();
}

// ─── /debate — serial (A→B→C→D→A→...) ──────────────────────────────
export async function debate(topic, context, options = {}) {
  const { maxTurns = 12, agents = Object.keys(AGENTS), capture = false, noJudge = false, noAddUser = false, promptType = "debate", header } = options;
  const out = makeOutput(capture);
  const tokenUsage = makeTokenUsage();
  clearStop();

  function finalize() {
    printTokenTable(tokenUsage, agents, out);
    if (Object.keys(tokenUsage).length > 0) {
      context.add("system", `[TOKEN_USAGE] ${JSON.stringify(tokenUsage)}`);
      context.save();
    }
    return out.lines;
  }

  const agentNames = agents.map(k => AGENTS[k]?.displayName || k).join(" → ");
  out.log(header || t("discuss.serial_header", { agents: agentNames }) + (!noJudge ? t("discuss.serial_turns", { turns: maxTurns }) : ""));

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

    const prompt = buildDebatePrompt(context, agentKey, position, agents.length, roundNum, promptType);
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
      recordTokens(tokenUsage, agentKey, result.tokens);
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
            return finalize();
          } else {
            stoppedAgents.clear();
          }
        }
      }
    }

    // Judge at end of each cycle, but only from round 2+ (skip if noJudge)
    const isEndOfCycle = (turn + 1) % agents.length === 0;
    if (!noJudge && isEndOfCycle && roundNum >= 2) {
      if (stopSignal.requested) { await gracefulStop(context, out); return finalize(); }
      out.log(t("discuss.judge_checking"));
      const verdict = await judgeConvergence(context.messages.slice(-agents.length * 2));
      showJudgeVerdict(verdict, out);
      if (verdict.converged) {
        context.add("system", `[DEBATE_CONCLUSION] ${verdict.summary}`);
        context.save();
        return finalize();
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
  return finalize();
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
    } else if (key === "FETCH") {
      const urls = val.split(",").map(s => s.trim()).filter(s => /^https?:\/\//i.test(s));
      if (urls.length > 0) result.fetch = urls;
    } else if (key === "FILES") {
      const paths = val.split(",").map(s => s.trim()).filter(s => s && !/^(none|no|-)$/i.test(s));
      if (paths.length > 0) result.files = paths;
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

  // Auto-detect URLs in the request so the moderator knows what's already being handled
  const detectedUrls = extractUrls(request);
  const urlHint = detectedUrls.length > 0
    ? t("prompt.mod_plan_url_hint", { urls: detectedUrls.join(", ") })
    : "";

  const briefingHint = contextSource ? t("prompt.mod_plan_briefing_hint", { source: contextSource }) : "";
  const planResult = await runAgent(judgeKey, t("prompt.mod_plan", { request, history, agents: agentList, briefing_hint: briefingHint, url_hint: urlHint }), { silent: true, timeout: ORCHESTRATOR_TIMEOUT });

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

  // ─── Pre-flight: gather external materials and inject briefing ───────
  // Merge auto-detected URLs with any the moderator explicitly requested
  const allUrls = [...new Set([...detectedUrls, ...(plan.fetch || [])])];
  const allFiles = plan.files || [];

  if (allUrls.length > 0 || allFiles.length > 0) {
    const color = judgeAgent ? judgeAgent.color : (s) => s;
    const label = judgeAgent ? `${judgeAgent.label}${chalk.dim(" [Moderator]")}` : "[Moderator]";
    // Use a box-wrapped output so fetch progress lines appear inside the moderator block
    const boxOut = capture
      ? out
      : { log: (...a) => out.log(`${color("│")} ${a.map(String).join(" ")}`) };
    if (!capture) {
      out.log(`\n${label}`);
      out.log(`${color("│")} ${chalk.dim(t("briefing.preflight", { n: allUrls.length + allFiles.length }))}`);
    }
    const materials = await gatherMaterials({ urls: allUrls, files: allFiles }, boxOut);
    if (!capture) out.log(`${color("╰")}`);
    if (Object.keys(materials).length > 0 && !stopSignal.requested) {
      const briefing = await synthesizeBriefing(judgeKey, judgeAgent, plan.topic, materials, out);
      if (briefing) {
        context.add("system", `[BRIEFING]\n${briefing}`);
        context.save();
      }
    }
  }
  if (stopSignal.requested) { await gracefulStop(context, out); return out.lines; }

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
