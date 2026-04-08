#!/usr/bin/env node
import { createInterface } from "readline";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import chalk from "chalk";
import { AGENTS, runAgent } from "./lib/agents.js";
import { ContextManager } from "./lib/context.js";
import { discuss, debate, broadcast, requestStop, stopSignal } from "./lib/discuss.js";
import { readClaudeSession } from "./lib/session.js";

// ─── Parse CLI args ─────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flagContinue = argv.includes("-c") || argv.includes("--continue");
const flagFromClaude = argv.includes("--from-claude");
const flagHelp = argv.includes("-h") || argv.includes("--help");
const inlineMsg = argv.filter((a) => !a.startsWith("-")).join(" ").trim();

// ─── Init context ───────────────────────────────────────────────────
const ctx = new ContextManager(process.cwd());

if (flagContinue) {
  const loaded = ctx.load();
  if (loaded) {
    const s = ctx.stats();
    console.log(chalk.dim(`[续接会话] ${s.messages} 条消息，约 ${s.tokens.toLocaleString()} tokens`));
  } else {
    console.log(chalk.dim("[续接会话] 未找到历史，开始新会话"));
  }
}

if (flagFromClaude) {
  const msgs = readClaudeSession(process.cwd(), 20);
  if (msgs && msgs.length > 0) {
    const summary = msgs
      .map((m) => `[${m.role === "user" ? "User" : "Claude"}] ${m.content.slice(0, 300)}`)
      .join("\n\n");
    ctx.add("system", `[来自 Claude Code 的工程上下文]\n${summary}`);
    console.log(chalk.dim(`[Claude Session] 注入 ${msgs.length} 条历史消息`));
  } else {
    console.log(chalk.dim("[Claude Session] 未找到当前目录的 claude 会话"));
  }
}

// ─── Banner ─────────────────────────────────────────────────────────
function printBanner() {
  console.log(
    chalk.bold(`
 ╔══════════════════════════════════════════════════════╗
 ║           🤖  AgentTalking  v2.0                    ║
 ║  Claude · Codex · Gemini · ${AGENTS.opencode.name}  ·  共享上下文  ║
 ╚══════════════════════════════════════════════════════╝
`)
  );
  console.log(chalk.dim("  消息路由:"));
  console.log(chalk.dim("    @claude / @codex / @gemini / @opencode <msg>  定向发送"));
  console.log(chalk.dim("    <msg>                                         广播给全部"));
  console.log(chalk.dim("  讨论模式:"));
  console.log(chalk.dim("    /discuss [@a @b] [--rounds N] <topic>   并行讨论"));
  console.log(chalk.dim("    /debate  [@a @b] [--turns N]  <topic>   串行辩论（接力）"));
  console.log(chalk.dim("  停止讨论:"));
  console.log(chalk.dim("    s + 回车    优雅停止（生成摘要）"));
  console.log(chalk.dim("    Ctrl+C      立即停止"));
  console.log(chalk.dim("  上下文与导出:"));
  console.log(chalk.dim("    /context    查看上下文统计"));
  console.log(chalk.dim("    /export     导出讨论为 Markdown 文件"));
  console.log(chalk.dim("    /last       查看上一次讨论结论"));
  console.log(chalk.dim("    /inject     注入当前目录 claude 会话"));
  console.log(chalk.dim("    /clear      清空上下文"));
  console.log(chalk.dim("    /save /load 手动存档/读档"));
  console.log(chalk.dim("  启动参数:"));
  console.log(chalk.dim("    -c / --continue   续接上次会话"));
  console.log(chalk.dim("    --from-claude     启动时注入 claude 会话"));
  console.log(chalk.dim("    /quit             退出\n"));
}

if (flagHelp) { printBanner(); process.exit(0); }

// ─── Parse @mentions ─────────────────────────────────────────────────
function parseMentions(input) {
  const mentionRe = /@(claude|codex|gemini|opencode)\b/gi;
  const targets = [];
  let m;
  while ((m = mentionRe.exec(input)) !== null) targets.push(m[1].toLowerCase());
  const prompt = input.replace(mentionRe, "").trim();
  return { targets: [...new Set(targets)], prompt };
}

// ─── Parse /discuss or /debate args ──────────────────────────────────
function parseDiscussArgs(input, cmd) {
  let rest = input.slice(cmd.length).trim();
  let max = cmd === "/discuss" ? 8 : 12;

  // Extract @mentions for agent selection
  const mentionRe = /@(claude|codex|gemini|opencode)\b/gi;
  const mentioned = [];
  let m;
  while ((m = mentionRe.exec(rest)) !== null) mentioned.push(m[1].toLowerCase());
  rest = rest.replace(mentionRe, "").trim();
  const agents = mentioned.length > 0 ? [...new Set(mentioned)] : null; // null = all

  // Extract --rounds / --turns
  const numMatch = rest.match(/^--(?:rounds|turns)\s+(\d+)\s+([\s\S]+)/);
  let topic = rest;
  if (numMatch) { max = parseInt(numMatch[1]); topic = numMatch[2].trim(); }

  return { max, topic, agents };
}

// ─── Handle one input line ───────────────────────────────────────────
async function handleLine(input) {
  if (!input.trim()) return;

  // 's' during discussion = graceful stop
  if (input === "s" && pending > 0) {
    requestStop();
    console.log(chalk.yellow("\n[停止信号已发送，等待当前步骤完成...]"));
    return;
  }

  if (input.startsWith("/discuss")) {
    const { max, topic, agents } = parseDiscussArgs(input, "/discuss");
    if (!topic) { console.log(chalk.red("用法: /discuss [@agent...] <话题>")); return; }
    await discuss(topic, ctx, { maxRounds: max, ...(agents && { agents }) });
    return;
  }

  if (input.startsWith("/debate")) {
    const { max, topic, agents } = parseDiscussArgs(input, "/debate");
    if (!topic) { console.log(chalk.red("用法: /debate [@agent...] <话题>")); return; }
    await debate(topic, ctx, { maxTurns: max, ...(agents && { agents }) });
    return;
  }

  if (input === "/context" || input === "/ctx") {
    const s = ctx.stats();
    console.log(chalk.dim(`上下文: ${s.messages} 条消息 · ${s.chars.toLocaleString()} 字符 · ~${s.tokens.toLocaleString()} tokens`));
    return;
  }

  if (input === "/export") {
    if (ctx.messages.length === 0) { console.log(chalk.yellow("上下文为空，无可导出内容")); return; }
    const dir = join(homedir(), ".agentalking", "exports");
    mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filepath = join(dir, `agentalking-${ts}.md`);
    const lines = [
      `# AgentTalking Export`,
      `> ${new Date().toLocaleString()}  ·  ${process.cwd()}\n`,
    ];
    for (const m of ctx.messages) {
      const speaker = m.role === "user" ? "**You**"
        : m.role === "system" ? "*[System]*"
        : `**${m.role.charAt(0).toUpperCase() + m.role.slice(1)}**`;
      lines.push(`### ${speaker}\n${m.content}\n`);
    }
    writeFileSync(filepath, lines.join("\n"));
    console.log(chalk.green(`已导出: ${filepath}`));
    return;
  }

  if (input === "/last") {
    const conclusions = ctx.messages.filter(
      m => m.role === "system" && (m.content.includes("[讨论结论]") || m.content.includes("[辩论结论]"))
    );
    if (conclusions.length === 0) {
      console.log(chalk.yellow("暂无讨论结论，先用 /discuss 或 /debate 进行一次讨论"));
    } else {
      const last = conclusions[conclusions.length - 1];
      console.log(chalk.bold("\n上一次讨论结论:"));
      console.log(chalk.white(last.content.replace(/\[.*?结论\]\s*/, "")));
    }
    return;
  }

  if (input === "/clear") { ctx.clear(); console.log(chalk.dim("上下文已清空")); return; }
  if (input === "/save")  { ctx.save(); console.log(chalk.dim(`已保存: ${ctx.path}`)); return; }
  if (input === "/load")  {
    const ok = ctx.load();
    const s = ctx.stats();
    console.log(ok ? chalk.dim(`已加载: ${s.messages} 条消息`) : chalk.red("未找到存档"));
    return;
  }

  if (input === "/inject") {
    const msgs = readClaudeSession(process.cwd(), 20);
    if (msgs?.length > 0) {
      const summary = msgs
        .map((m) => `[${m.role === "user" ? "User" : "Claude"}] ${m.content.slice(0, 300)}`)
        .join("\n\n");
      ctx.add("system", `[来自 Claude Code 的工程上下文]\n${summary}`);
      console.log(chalk.dim(`注入 ${msgs.length} 条 claude 会话消息`));
    } else {
      console.log(chalk.yellow("未找到当前目录的 claude 会话"));
    }
    return;
  }

  if (input === "/help")  { printBanner(); return; }
  if (input === "/quit" || input === "/q" || input === "/exit") {
    console.log(chalk.dim("\nBye! 👋")); process.exit(0);
  }

  // @mention 路由 or broadcast
  const { targets, prompt } = parseMentions(input);
  if (!prompt) { console.log(chalk.red("请输入消息内容")); return; }
  const sendTo = targets.length > 0 ? targets : Object.keys(AGENTS);
  await broadcast(prompt, ctx, sendTo);
}

// ─── Single-shot mode ────────────────────────────────────────────────
if (inlineMsg) {
  await handleLine(inlineMsg);
  process.exit(0);
}

// ─── Interactive REPL ────────────────────────────────────────────────
printBanner();

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: chalk.bold.white("You > "),
});

rl.prompt();

let pending = 0;
let stdinClosed = false;

// Ctrl+C: if discussion running → graceful stop, else exit
process.on("SIGINT", () => {
  if (pending > 0) {
    console.log(chalk.yellow("\n[Ctrl+C] 发送停止信号..."));
    requestStop();
  } else {
    console.log(chalk.dim("\nBye! 👋"));
    process.exit(0);
  }
});

rl.on("line", async (line) => {
  pending++;
  try {
    await handleLine(line.trim());
  } catch (err) {
    console.log(chalk.red(`Error: ${err.message}`));
  }
  pending--;
  if (stdinClosed && pending === 0) process.exit(0);
  rl.prompt();
});

rl.on("close", () => {
  stdinClosed = true;
  if (pending === 0) { console.log(chalk.dim("\nBye! 👋")); process.exit(0); }
});
