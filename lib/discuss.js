import chalk from "chalk";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { AGENTS, runAgent } from "./agents.js";

// ─── Summary persistence ──────────────────────────────────────────────
const SUMMARIES_DIR = join(homedir(), ".agentalk", "summaries");

function topicSlug(topic) {
  return topic.slice(0, 40).replace(/\s+/g, "-").replace(/[^\w\u4e00-\u9fff-]/g, "").slice(0, 30);
}

export function saveSummary(context, topic, agentKeys) {
  try {
    mkdirSync(SUMMARIES_DIR, { recursive: true });
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 16).replace("T", " ");
    const fileStamp = now.toISOString().slice(0, 16).replace(/[-:T]/g, "").slice(0, 12);
    const slug = topicSlug(topic);
    const filename = `${fileStamp}-${slug}.md`;
    const filepath = join(SUMMARIES_DIR, filename);

    const participants = agentKeys.map(k => AGENTS[k]?.displayName || k).join(", ");

    const lines = [
      `# AgentTalk 讨论摘要`,
      ``,
      `**时间:** ${dateStr}`,
      `**话题:** ${topic}`,
      `**参与者:** ${participants}`,
      ``,
      `---`,
      ``,
    ];

    for (const m of context.messages) {
      if (m.role === "user") {
        lines.push(`**👤 用户**\n\n${m.content}\n`);
      } else if (m.role === "system") {
        if (m.content.startsWith("[辩论结论]") || m.content.startsWith("[讨论结论]") || m.content.startsWith("[辩论超时]") || m.content.startsWith("[讨论中止]")) {
          lines.push(`---\n\n## 结论\n\n${m.content.replace(/^\[.*?\]\s*/, "")}\n`);
        }
        // skip other system messages (injected context etc.)
      } else {
        const name = AGENTS[m.role]?.displayName || m.role;
        lines.push(`### ${name}\n\n${m.content}\n`);
      }
    }

    writeFileSync(filepath, lines.join("\n"));
    return filepath;
  } catch {
    return null;
  }
}

// ─── Output abstraction (terminal vs MCP capture) ────────────────────
export function makeOutput(capture = false) {
  if (!capture) return { log: (...a) => console.log(...a), lines: null };
  const lines = [];
  return { log: (...a) => lines.push(a.map(String).join(" ")), lines };
}

// ─── Shared stop signal ──────────────────────────────────────────────
// Exported so index.js can trigger it on 's' keypress
export const stopSignal = { requested: false };

export function requestStop() {
  stopSignal.requested = true;
}

// ─── User input buffer (for mid-discussion interjections) ────────────
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

// ─── Error detection helpers ─────────────────────────────────────────
function isTransientError(error) {
  return /busy|rate.?limit|overloaded|capacity|503|529|too many|timeout|ECONNREFUSED/i.test(error);
}

// ─── Prompts ─────────────────────────────────────────────────────────
const JUDGE_PROMPT = (history) => `
你是一个讨论裁判。以下是多个 AI Agent 的讨论记录，判断讨论是否已经收敛。

收敛的标准：
- 各方在核心观点上已经达成共识，或者明确接受了某个最优答案
- 不再有新的实质性分歧或新信息被引入
- 已经有清晰的结论或建议

讨论记录：
${history}

请只回复以下两种之一：
CONVERGED: [一句话总结共识]
CONTINUE: [一句话说明还有什么分歧]
`.trim();

const SUMMARY_PROMPT = (history) => `
以下是一场多 Agent 讨论，因用户中断而提前结束。请总结目前的讨论进度：已达成的共识、尚未解决的分歧，以及最可能的结论方向。100字以内。

${history}
`.trim();

function formatHistory(messages) {
  return messages
    .map((m) => {
      const speaker =
        m.role === "user" ? "【用户】"
        : m.role === "system" ? "【系统】"
        : `【${m.role.charAt(0).toUpperCase() + m.role.slice(1)}】`;
      return `${speaker}\n${m.content}`;
    })
    .join("\n\n");
}

// ─── Prompt builders ─────────────────────────────────────────────────
function buildDiscussPrompt(context, agentKey, round) {
  const history = formatHistory(context.messages);
  const agentName = AGENTS[agentKey].name;
  if (round === 1) {
    return `${history}\n\n你是 ${agentName}。请就以上话题发表你的观点，要有自己的独立判断，简洁有力（300字以内）。注意：第一轮不允许收敛，请充分表达你的独立见解。`;
  }
  return `${history}\n\n你是 ${agentName}，这是第 ${round} 轮讨论。请先回应其他 Agent 的观点：认同哪些、质疑哪些、补充什么。如果你认为核心分歧已解决且无新信息可补充，回复末尾加 [STOP]。简洁（200字以内）。`;
}

function buildDebatePrompt(context, agentKey, position, totalAgents, roundNum) {
  const history = formatHistory(context.messages);
  const agentName = AGENTS[agentKey].name;
  const isFirst = context.messages.filter(m => !["user","system"].includes(m.role)).length === 0;

  // Round 1: no [STOP] allowed — everyone must contribute before convergence is considered
  if (isFirst) {
    return `${history}\n\n你是 ${agentName}，作为第一个发言者。请就话题发表你的初始观点，简洁有力（200字以内）。注意：第一轮不允许收敛，请充分表达你的独立见解。`;
  }
  if (roundNum <= 1) {
    return `${history}\n\n你是 ${agentName}（第 ${position}/${totalAgents} 位发言）。请接着前面的发言，推进讨论：可以补充、反驳、或深化。注意：第一轮不允许收敛，请充分表达你的独立见解。简洁（200字以内）。`;
  }
  // Round 2+: allow [STOP], but encourage engaging with others first
  return `${history}\n\n你是 ${agentName}（第 ${position}/${totalAgents} 位发言，第 ${roundNum} 轮）。请先回应其他人的观点（认同、质疑或补充），再判断是否已收敛。如果你认为核心分歧已解决且无新信息可补充，回复末尾加 [STOP]。简洁（200字以内）。`;
}

// ─── Convergence check ───────────────────────────────────────────────
function hasStopSignal(response) {
  return /\[STOP\]/i.test(response);
}

async function judgeConvergence(recentMessages) {
  const history = formatHistory(recentMessages);
  const result = await runAgent("claude", JUDGE_PROMPT(history), { silent: true });
  const text = result.response.trim();
  if (text.startsWith("CONVERGED:")) {
    return { converged: true, summary: text.replace("CONVERGED:", "").trim() };
  }
  return { converged: false, reason: text.replace("CONTINUE:", "").trim() };
}

async function summarizeCurrent(context) {
  console.log(chalk.dim("\n[正在生成当前进度摘要...]"));
  const history = formatHistory(context.messages.slice(-12));
  const result = await runAgent("claude", SUMMARY_PROMPT(history), { silent: true });
  return result.response.trim();
}

// ─── Graceful stop ───────────────────────────────────────────────────
async function gracefulStop(context, sep, out) {
  const summary = await summarizeCurrent(context);
  out.log(`\n🛑 讨论已停止`);
  out.log(summary);
  context.add("system", `[讨论中止] ${summary}`);
  context.save();
  stopSignal.requested = false;
}

// ─── /discuss — parallel rounds ──────────────────────────────────────
export async function discuss(topic, context, options = {}) {
  const { maxRounds = 8, agents = Object.keys(AGENTS), capture = false } = options;
  const out = makeOutput(capture);
  const sep = "─".repeat(60);
  stopSignal.requested = false;

  out.log(`\n💬 并行讨论 · 最多 ${maxRounds} 轮 · 自动收敛`);
  out.log(`话题: ${topic}`);

  context.add("user", topic);

  for (let round = 1; round <= maxRounds; round++) {
    if (stopSignal.requested) { await gracefulStop(context, sep, out); return out.lines; }

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
          out.log(`${chalk.yellow(`[${name} 服务繁忙，本轮跳过]`)}`);
        } else {
          out.log(`${chalk.yellow(`[${name} 出错，本轮跳过]`)}`);
        }
      }
    }

    if (successCount === 0) {
      out.log(chalk.red("\n所有 agent 均不可用，讨论中止"));
      break;
    }

    if (stopSignal.requested) { await gracefulStop(context, sep, out); return out.lines; }

    if (round >= 2 && stopCount === results.length) {
      out.log(`\n✅ 全员同意收敛，生成结论...`);
      const summary = await summarizeCurrent(context);
      out.log(summary);
      context.add("system", `[讨论结论] ${summary}`);
      context.save();
      return out.lines;
    } else if (stopCount > 0) {
      out.log(`\n[${stopCount}/${results.length} 人建议收敛，继续讨论...]`);
    }

    if (round >= 2) {
      const verdict = await judgeConvergence(context.messages.slice(-agents.length * 3));
      if (verdict.converged) {
        out.log(`\n✅ 讨论收敛: ${verdict.summary}`);
        context.add("system", `[讨论结论] ${verdict.summary}`);
        context.save();
        return out.lines;
      } else {
        out.log(`\n[裁判] 继续 — ${verdict.reason}`);
      }
    }

    if (round === maxRounds) {
      out.log(`\n⚠️  达到最大轮数 (${maxRounds})`);
      const summary = await summarizeCurrent(context);
      out.log(summary);
      context.add("system", `[讨论超时] ${summary}`);
    }
  }

  context.save();
  return out.lines;
}

// ─── /debate — serial (A→B→C→D→A→...) ──────────────────────────────
export async function debate(topic, context, options = {}) {
  const { maxTurns = 12, agents = Object.keys(AGENTS), capture = false, noJudge = false } = options;
  const out = makeOutput(capture);
  const sep = "─".repeat(60);
  stopSignal.requested = false;

  const agentNames = agents.map(k => AGENTS[k]?.displayName || k).join(" → ");
  out.log(`\n🎙️  串行讨论 · ${agentNames}${!noJudge ? ` · 最多 ${maxTurns} 轮` : ""}`);

  context.add("user", topic);

  const stoppedAgents = new Set();
  let skippedInRow = 0;

  for (let turn = 0; turn < maxTurns; turn++) {
    if (stopSignal.requested) { await gracefulStop(context, sep, out); return out.lines; }

    // Flush any user input between turns
    flushUserInput(context, out);

    const agentKey = agents[turn % agents.length];
    const position = (turn % agents.length) + 1;
    const roundNum = Math.floor(turn / agents.length) + 1;

    if (turn % agents.length === 0) out.log(`\n── Round ${roundNum} ──`);

    const prompt = buildDebatePrompt(context, agentKey, position, agents.length, roundNum);
    const result = await runAgent(agentKey, prompt, { silent: capture });

    // ── Error recovery: skip on failure ──
    if (!result.response && result.error) {
      skippedInRow++;
      if (isTransientError(result.error)) {
        out.log(`${chalk.yellow(`[${AGENTS[agentKey]?.displayName || agentKey} 服务繁忙，跳过]`)}`);
      } else {
        out.log(`${chalk.yellow(`[${AGENTS[agentKey]?.displayName || agentKey} 出错，跳过: ${result.error.split("\n")[0].slice(0, 80)}]`)}`);
      }
      // If all agents failed in a row, bail out
      if (skippedInRow >= agents.length) {
        out.log(chalk.red("\n所有 agent 均不可用，讨论中止"));
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
          out.log(`\n[${AGENTS[agentKey].displayName} 建议收敛 · ${stopped}/${total} 人 · 等待其余人表态]`);
        } else if (!noJudge) {
          out.log(`\n[全员建议收敛，交由裁判确认...]`);
          const verdict = await judgeConvergence(context.messages.slice(-agents.length * 2));
          if (verdict.converged) {
            out.log(`\n✅ 辩论收敛: ${verdict.summary}`);
            context.add("system", `[辩论结论] ${verdict.summary}`);
            context.save();
            return out.lines;
          } else {
            out.log(`[裁判] 尚未收敛 — ${verdict.reason}`);
            stoppedAgents.clear();
          }
        }
      }
    }

    // Judge at end of each cycle, but only from round 2+ (skip if noJudge)
    const isEndOfCycle = (turn + 1) % agents.length === 0;
    if (!noJudge && isEndOfCycle && roundNum >= 2) {
      if (stopSignal.requested) { await gracefulStop(context, sep, out); return out.lines; }
      const verdict = await judgeConvergence(context.messages.slice(-agents.length * 2));
      if (verdict.converged) {
        out.log(`\n✅ 辩论收敛: ${verdict.summary}`);
        context.add("system", `[辩论结论] ${verdict.summary}`);
        context.save();
        return out.lines;
      } else {
        out.log(`\n[裁判] 继续 — ${verdict.reason}`);
      }
    }

    if (turn === maxTurns - 1) {
      out.log(`\n⚠️  达到最大轮次 (${maxTurns})`);
      if (!noJudge) {
        const summary = await summarizeCurrent(context);
        out.log(summary);
        context.add("system", `[辩论超时] ${summary}`);
      }
    }
  }

  context.save();
  return out.lines;
}

// ─── broadcast ───────────────────────────────────────────────────────
export async function broadcast(message, context, targets) {
  const sep = chalk.dim("─".repeat(60));
  console.log(`\n${sep}`);
  console.log(chalk.bold.white(`📨 → ${targets.map((t) => AGENTS[t].displayName).join(", ")}`));

  context.add("user", message);
  const prompt = context.buildPrompt(null, "请回应以上最新消息。");
  const results = await Promise.all(targets.map((key) => runAgent(key, prompt)));

  for (const r of results) {
    if (r.response) context.add(r.agent, r.response);
  }

  console.log(`\n${sep}\n`);
  context.save();
}
