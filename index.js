#!/usr/bin/env node
import { createInterface } from "readline";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import chalk from "chalk";
import { AGENTS, runAgent } from "./lib/agents.js";
import { ContextManager } from "./lib/context.js";
import { discuss, debate, broadcast, requestStop, stopSignal } from "./lib/discuss.js";
import { readClaudeSession } from "./lib/session.js";
import { listAgents, enableAgent, disableAgent, addAgent, removeAgent, setAgentModel, resetConfig, CONFIG_PATH } from "./lib/config.js";

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
  const activeNames = Object.values(AGENTS).map(a => a.name).join(" · ");
  console.log(chalk.bold(`\n 🤖  AgentTalking  v2.0  ·  ${activeNames}\n`));
  const keys = Object.keys(AGENTS).map(k => `@${k}`).join(" / ");
  console.log(chalk.dim("  消息路由:"));
  console.log(chalk.dim(`    ${keys}  定向发送`));
  console.log(chalk.dim("    <msg>                广播给全部"));
  console.log(chalk.dim("  讨论模式:"));
  console.log(chalk.dim("    /discuss [@a @b] [--rounds N] <topic>   并行讨论"));
  console.log(chalk.dim("    /debate  [@a @b] [--turns N]  <topic>   串行辩论（接力）"));
  console.log(chalk.dim("  停止讨论:"));
  console.log(chalk.dim("    s + 回车    优雅停止（生成摘要）"));
  console.log(chalk.dim("    Ctrl+C      立即停止"));
  console.log(chalk.dim("  上下文与导出:"));
  console.log(chalk.dim("    /context    查看上下文统计"));
  console.log(chalk.dim("    /export [caption]  导出讨论为 Markdown 文件（可附标题）"));
  console.log(chalk.dim("    /last       查看上一次讨论结论"));
  console.log(chalk.dim("    /inject     注入当前目录 claude 会话"));
  console.log(chalk.dim("    /clear      清空上下文"));
  console.log(chalk.dim("    /save /load 手动存档/读档"));
  console.log(chalk.dim("  Agent 管理:"));
  console.log(chalk.dim("    /agents                  列出所有 agents 及状态"));
  console.log(chalk.dim("    /agents enable <key>     启用 agent"));
  console.log(chalk.dim("    /agents disable <key>    禁用 agent"));
  console.log(chalk.dim("    /agents model <key> <m>  设置 agent 使用的模型"));
  console.log(chalk.dim("    /agents model <key>      重置为默认模型"));
  console.log(chalk.dim("    /agents add              交互式添加自定义 agent"));
  console.log(chalk.dim("    /agents remove <key>     删除 agent"));
  console.log(chalk.dim(`    config: ${CONFIG_PATH}`));
  console.log(chalk.dim("  启动参数:"));
  console.log(chalk.dim("    -c / --continue   续接上次会话"));
  console.log(chalk.dim("    --from-claude     启动时注入 claude 会话"));
  console.log(chalk.dim("    /quit             退出\n"));
}

if (flagHelp) { printBanner(); process.exit(0); }

// ─── Parse @mentions ─────────────────────────────────────────────────
function parseMentions(input) {
  const allKeys = Object.keys(AGENTS).join("|");
  const mentionRe = new RegExp(`@(${allKeys})\\b`, "gi");
  const targets = [];
  let m;
  while ((m = mentionRe.exec(input)) !== null) targets.push(m[1].toLowerCase());
  const prompt = input.replace(new RegExp(`@(${allKeys})\\b`, "gi"), "").trim();
  return { targets: [...new Set(targets)], prompt };
}

// ─── Parse /discuss or /debate args ──────────────────────────────────
function parseDiscussArgs(input, cmd) {
  let rest = input.slice(cmd.length).trim();
  let max = cmd === "/discuss" ? 8 : 12;

  // Extract @mentions for agent selection
  const allKeys = Object.keys(AGENTS).join("|");
  const mentionRe = new RegExp(`@(${allKeys})\\b`, "gi");
  const mentioned = [];
  let m;
  while ((m = mentionRe.exec(rest)) !== null) mentioned.push(m[1].toLowerCase());
  rest = rest.replace(new RegExp(`@(${allKeys})\\b`, "gi"), "").trim();
  const agents = mentioned.length > 0 ? [...new Set(mentioned)] : null; // null = all

  // Extract --rounds / --turns
  const numMatch = rest.match(/^--(?:rounds|turns)\s+(\d+)\s+([\s\S]+)/);
  let topic = rest;
  if (numMatch) { max = parseInt(numMatch[1]); topic = numMatch[2].trim(); }

  // If topic looks like a file path, read its content
  if (topic && existsSync(topic)) {
    topic = readFileSync(topic, "utf8");
  }

  return { max, topic, agents };
}

// ─── /agents command ────────────────────────────────────────────────
async function handleAgentsCommand(sub) {
  const parts = sub.split(/\s+/).filter(Boolean);
  const subcmd = parts[0];

  // /agents — list all
  if (!subcmd) {
    const all = listAgents();
    console.log(chalk.bold("\n  Agent 列表:\n"));
    for (const a of all) {
      const active = AGENTS[a.key];
      const status = !a.installed
        ? chalk.red("未安装")
        : a.enabled
        ? chalk.green("已启用")
        : chalk.dim("已禁用");
      const inUse = active ? chalk.cyan(" ◀ 运行中") : "";
      const modelInfo = a.model ? chalk.yellow(` [model: ${a.model}]`) : "";
      console.log(`  ${chalk.bold(a.key.padEnd(12))} ${status}${inUse}${modelInfo}`);
      console.log(`    ${chalk.dim(`${a.cmd}  ${a.note || ""}`)}`);
    }
    console.log(chalk.dim(`\n  配置文件: ${CONFIG_PATH}\n`));
    return;
  }

  if (subcmd === "enable" && parts[1]) {
    const r = enableAgent(parts[1]);
    console.log(r.ok ? chalk.green(r.msg) : chalk.red(r.msg));
    if (r.ok) console.log(chalk.dim("重启 agentalk 后生效"));
    return;
  }

  if (subcmd === "disable" && parts[1]) {
    const r = disableAgent(parts[1]);
    console.log(r.ok ? chalk.green(r.msg) : chalk.red(r.msg));
    if (r.ok) console.log(chalk.dim("重启 agentalk 后生效"));
    return;
  }

  if (subcmd === "model" && parts[1]) {
    const model = parts.slice(2).join(" ") || null; // empty = reset to default
    const r = setAgentModel(parts[1], model);
    console.log(r.ok ? chalk.green(r.msg) : chalk.red(r.msg));
    if (r.ok) console.log(chalk.dim("重启 agentalk 后生效"));
    return;
  }

  if (subcmd === "reset") {
    resetConfig();
    console.log(chalk.green("配置已重置为默认值，重启 agentalk 后生效"));
    return;
  }

  if (subcmd === "remove" && parts[1]) {
    const r = removeAgent(parts[1]);
    console.log(r.ok ? chalk.green(r.msg) : chalk.red(r.msg));
    return;
  }

  if (subcmd === "add") {
    // Interactive wizard
    const answers = await wizard([
      { key: "key",   prompt: "唯一 key（英文，如 mygpt）: " },
      { key: "name",  prompt: "显示名称（如 GPT-4o）: " },
      { key: "cmd",   prompt: "命令（如 mycli）: " },
      { key: "args",  prompt: "参数，用 {prompt} 代表用户输入（如: -p {prompt}）: " },
      { key: "color", prompt: "颜色 hex（如 #FF6B6B，留空用默认）: " },
      { key: "output",prompt: "输出格式 text 或 ndjson（留空默认 text）: " },
      { key: "note",  prompt: "备注说明（可选）: " },
    ]);

    const def = {
      key: answers.key.trim(),
      name: answers.name.trim(),
      cmd: answers.cmd.trim(),
      args: answers.args.trim().split(/\s+/),
      color: answers.color.trim() || "#6B7280",
      output: answers.output.trim() || "text",
      note: answers.note.trim(),
    };

    if (!def.key || !def.name || !def.cmd) {
      console.log(chalk.red("key / name / cmd 不能为空"));
      return;
    }

    const r = addAgent(def);
    console.log(r.ok ? chalk.green(r.msg) : chalk.red(r.msg));
    if (r.ok) console.log(chalk.dim("重启 agentalk 后生效"));
    return;
  }

  console.log(chalk.red("用法: /agents [enable|disable|model|add|remove] [key] [value]"));
}

// Simple readline wizard for multi-field input
function wizard(fields) {
  return new Promise((resolve) => {
    const answers = {};
    let i = 0;
    const ask = () => {
      if (i >= fields.length) { resolve(answers); return; }
      process.stdout.write(chalk.cyan(`  ${fields[i].prompt}`));
    };
    ask();
    // Temporarily hook stdin
    const tmpRl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    tmpRl.on("line", (line) => {
      answers[fields[i].key] = line;
      i++;
      if (i < fields.length) { ask(); }
      else { tmpRl.close(); resolve(answers); }
    });
  });
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

  if (input.startsWith("/agents")) {
    await handleAgentsCommand(input.slice(7).trim());
    return;
  }

  if (input === "/export" || input.startsWith("/export ")) {
    if (ctx.messages.length === 0) { console.log(chalk.yellow("上下文为空，无可导出内容")); return; }
    const caption = input.slice(8).trim().replace(/[\/\\:*?"<>|]/g, "");
    const dir = join(homedir(), ".agentalk", "exports");
    mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const slug = caption ? `-${caption}` : "";
    const filepath = join(dir, `agentalk-${ts}${slug}.md`);
    const title = caption || "AgentTalk Export";
    const lines = [
      `# ${title}`,
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
