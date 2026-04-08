import chalk from "chalk";
import { AGENTS, runAgent } from "./agents.js";

// ─── Shared stop signal ──────────────────────────────────────────────
// Exported so index.js can trigger it on 's' keypress
export const stopSignal = { requested: false };

export function requestStop() {
  stopSignal.requested = true;
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
    return `${history}\n\n你是 ${agentName}。请就以上话题发表你的观点，要有自己的独立判断，简洁有力（300字以内）。如果你认为已经有明确答案无需讨论，回复末尾加 [STOP]。`;
  }
  return `${history}\n\n你是 ${agentName}，这是第 ${round} 轮讨论。请回应其他 Agent 的观点：认同哪些、质疑哪些、补充什么。如果你认为讨论已收敛，回复末尾加 [STOP]。简洁（200字以内）。`;
}

function buildDebatePrompt(context, agentKey, position, totalAgents) {
  const history = formatHistory(context.messages);
  const agentName = AGENTS[agentKey].name;
  const isFirst = context.messages.filter(m => !["user","system"].includes(m.role)).length === 0;

  if (isFirst) {
    return `${history}\n\n你是 ${agentName}，作为第一个发言者。请就话题发表你的初始观点，简洁有力（200字以内）。如认为无需继续讨论，回复末尾加 [STOP]。`;
  }
  return `${history}\n\n你是 ${agentName}（第 ${position}/${totalAgents} 位发言）。请接着上一位的发言，推进讨论：可以补充、反驳、或深化。如认为讨论已收敛，回复末尾加 [STOP]。简洁（200字以内）。`;
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
async function gracefulStop(context, sep) {
  const summary = await summarizeCurrent(context);
  console.log(`\n${chalk.bold.yellow("🛑 讨论已停止")}`);
  console.log(`${chalk.white(summary)}`);
  context.add("system", `[讨论中止] ${summary}`);
  console.log(`\n${sep}\n`);
  context.save();
  stopSignal.requested = false;
}

// ─── /discuss — parallel rounds ──────────────────────────────────────
export async function discuss(topic, context, options = {}) {
  const { maxRounds = 8, agents = Object.keys(AGENTS) } = options;
  const sep = chalk.dim("─".repeat(60));
  stopSignal.requested = false;

  console.log(`\n${sep}`);
  console.log(chalk.bold.magenta(`💬 并行讨论 · 最多 ${maxRounds} 轮 · 自动收敛`));
  console.log(chalk.dim(`话题: ${topic}`));
  console.log(chalk.dim(`提示: 输入 s + 回车可优雅停止`));
  console.log(sep);

  context.add("user", topic);

  for (let round = 1; round <= maxRounds; round++) {
    if (stopSignal.requested) { await gracefulStop(context, sep); return; }

    console.log(chalk.bold(`\n── Round ${round} ──`));

    const results = await Promise.all(
      agents.map((key) => runAgent(key, buildDiscussPrompt(context, key, round)))
    );

    let stopCount = 0;
    for (const r of results) {
      if (r.response) {
        context.add(r.agent, r.response);
        if (hasStopSignal(r.response)) stopCount++;
      }
    }

    if (stopSignal.requested) { await gracefulStop(context, sep); return; }

    if (stopCount === results.length) {
      console.log(chalk.bold.green(`\n✅ 全员同意收敛，生成结论...`));
      const summary = await summarizeCurrent(context);
      console.log(chalk.white(summary));
      context.add("system", `[讨论结论] ${summary}`);
      console.log(`\n${sep}\n`);
      context.save();
      return;
    } else if (stopCount > 0) {
      console.log(chalk.dim(`\n[${stopCount}/${results.length} 人建议收敛，继续讨论...]`));
    }

    if (round >= 2) {
      const verdict = await judgeConvergence(context.messages.slice(-agents.length * 3));
      if (verdict.converged) {
        console.log(`\n${chalk.bold.green("✅ 讨论收敛")} ${chalk.white(verdict.summary)}`);
        context.add("system", `[讨论结论] ${verdict.summary}`);
        console.log(`\n${sep}\n`);
        context.save();
        return;
      } else {
        console.log(chalk.dim(`\n[裁判] 继续 — ${verdict.reason}`));
      }
    }

    if (round === maxRounds) {
      console.log(chalk.yellow(`\n⚠️  达到最大轮数 (${maxRounds})`));
      const summary = await summarizeCurrent(context);
      console.log(chalk.white(summary));
      context.add("system", `[讨论超时] ${summary}`);
    }
  }

  console.log(`\n${sep}\n`);
  context.save();
}

// ─── /debate — serial (A→B→C→D→A→...) ──────────────────────────────
export async function debate(topic, context, options = {}) {
  const { maxTurns = 12, agents = Object.keys(AGENTS) } = options;
  const sep = chalk.dim("─".repeat(60));
  stopSignal.requested = false;

  console.log(`\n${sep}`);
  console.log(chalk.bold.cyan(`🎙️  串行辩论 · 最多 ${maxTurns} 轮 · 接力发言`));
  console.log(chalk.dim(`话题: ${topic}`));
  console.log(chalk.dim(`顺序: ${agents.map(k => AGENTS[k].name).join(" → ")} → 循环`));
  console.log(chalk.dim(`提示: 输入 s + 回车可优雅停止`));
  console.log(sep);

  context.add("user", topic);

  // Track which agents have voted [STOP] — need all agents to vote before convergence check
  const stoppedAgents = new Set();

  for (let turn = 0; turn < maxTurns; turn++) {
    if (stopSignal.requested) { await gracefulStop(context, sep); return; }

    const agentKey = agents[turn % agents.length];
    const position = (turn % agents.length) + 1;
    const roundNum = Math.floor(turn / agents.length) + 1;

    if (turn % agents.length === 0) {
      console.log(chalk.bold(`\n── Round ${roundNum} ──`));
    }

    const prompt = buildDebatePrompt(context, agentKey, position, agents.length);
    const result = await runAgent(agentKey, prompt);

    if (result.response) {
      context.add(agentKey, result.response);
      if (hasStopSignal(result.response)) {
        stoppedAgents.add(agentKey);
        const stopped = stoppedAgents.size;
        const total = agents.length;
        if (stopped < total) {
          console.log(chalk.dim(`\n[${AGENTS[agentKey].name} 建议收敛 · ${stopped}/${total} 人 · 等待其余人表态]`));
        } else {
          // All agents voted [STOP] — now let the judge decide
          console.log(chalk.dim(`\n[全员建议收敛，交由裁判确认...]`));
          const verdict = await judgeConvergence(context.messages.slice(-agents.length * 2));
          if (verdict.converged) {
            console.log(`\n${chalk.bold.green("✅ 辩论收敛")} ${chalk.white(verdict.summary)}`);
            context.add("system", `[辩论结论] ${verdict.summary}`);
            console.log(`\n${sep}\n`);
            context.save();
            return;
          } else {
            console.log(chalk.dim(`[裁判] 尚未收敛 — ${verdict.reason}`));
            stoppedAgents.clear(); // reset, keep debating
          }
        }
      }
    }

    // Check convergence at the end of each full cycle
    const isEndOfCycle = (turn + 1) % agents.length === 0;
    if (isEndOfCycle && turn > 0) {
      if (stopSignal.requested) { await gracefulStop(context, sep); return; }
      const verdict = await judgeConvergence(context.messages.slice(-agents.length * 2));
      if (verdict.converged) {
        console.log(`\n${chalk.bold.green("✅ 辩论收敛")} ${chalk.white(verdict.summary)}`);
        context.add("system", `[辩论结论] ${verdict.summary}`);
        console.log(`\n${sep}\n`);
        context.save();
        return;
      } else {
        console.log(chalk.dim(`\n[裁判] 继续 — ${verdict.reason}`));
      }
    }

    if (turn === maxTurns - 1) {
      console.log(chalk.yellow(`\n⚠️  达到最大轮次 (${maxTurns})`));
      const summary = await summarizeCurrent(context);
      console.log(chalk.white(summary));
      context.add("system", `[辩论超时] ${summary}`);
    }
  }

  console.log(`\n${sep}\n`);
  context.save();
}

// ─── broadcast ───────────────────────────────────────────────────────
export async function broadcast(message, context, targets) {
  const sep = chalk.dim("─".repeat(60));
  console.log(`\n${sep}`);
  console.log(chalk.bold.white(`📨 → ${targets.map((t) => AGENTS[t].name).join(", ")}`));

  context.add("user", message);
  const prompt = context.buildPrompt(null, "请回应以上最新消息。");
  const results = await Promise.all(targets.map((key) => runAgent(key, prompt)));

  for (const r of results) {
    if (r.response) context.add(r.agent, r.response);
  }

  console.log(`\n${sep}\n`);
  context.save();
}
