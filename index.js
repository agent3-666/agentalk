#!/usr/bin/env node
import { createInterface } from "readline";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import chalk from "chalk";
import { AGENTS, runAgent } from "./lib/agents.js";
import { ContextManager } from "./lib/context.js";
import { discuss, debate, broadcast, requestStop, stopSignal, pushUserInput, saveSummary } from "./lib/discuss.js";
import { readClaudeSession } from "./lib/session.js";
import { listAgents, enableAgent, disableAgent, addAgent, removeAgent, setAgentModel, resetConfig, getModeratorKey, setModerator, reorderAgents, CONFIG_PATH } from "./lib/config.js";
import { createRepl } from "./lib/input.js";
import { loadLang, setLang, getLang, t } from "./lib/i18n.js";

// ─── Load language setting ───────────────────────────────────────────
loadLang();

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
    console.log(chalk.dim(`\n${t("session.loaded", { msgs: s.messages, tokens: s.tokens.toLocaleString() })}\n`));
    for (const m of ctx.messages) {
      if (m.role === "user") {
        console.log(`${chalk.bold.white("👤 You:")} ${chalk.white(m.content.length > 200 ? m.content.slice(0, 200) + "..." : m.content)}`);
      } else if (m.role === "system") {
        console.log(`${chalk.white("📋 " + (m.content.length > 200 ? m.content.slice(0, 200) + "..." : m.content))}`);
      } else {
        const agent = AGENTS[m.role];
        const label = agent ? agent.label : chalk.cyan(m.role);
        const preview = m.content.length > 300 ? m.content.slice(0, 300) + "..." : m.content;
        const color = agent ? agent.color : chalk.white;
        console.log(`${label}`);
        for (const line of preview.split("\n")) {
          if (line.trim()) console.log(`${color("│")} ${chalk.white(line)}`);
        }
        console.log(`${color("╰")} ${chalk.dim(t("history.label"))}`);
      }
    }
    console.log(chalk.dim(`\n${"─".repeat(60)}`));
    console.log(chalk.dim(t("session.history_note")));
  } else {
    console.log(chalk.dim(t("session.not_found")));
  }
}

if (flagFromClaude) {
  const msgs = readClaudeSession(process.cwd(), 20);
  if (msgs && msgs.length > 0) {
    const summary = msgs
      .map((m) => `[${m.role === "user" ? "User" : "Claude"}] ${m.content.slice(0, 300)}`)
      .join("\n\n");
    ctx.add("system", t("inject.system_label", { summary }));
    console.log(chalk.dim(t("session.claude_injected", { count: msgs.length })));
  } else {
    console.log(chalk.dim(t("session.claude_none")));
  }
}

// ─── Banner ─────────────────────────────────────────────────────────
function printBanner() {
  const activeNames = Object.values(AGENTS).map(a => a.displayName).join(" · ");
  const keys = Object.keys(AGENTS).map(k => `@${k}`).join(" / ");
  console.log(chalk.bold(`\n ${t("banner.title", { agents: activeNames })}\n`));
  console.log(chalk.dim(`  ${t("banner.default_mode")}`));
  console.log(chalk.dim(`    ${t("banner.msg_hint")}`));
  console.log(chalk.dim(`    ${t("banner.mention_hint", { keys })}`));
  console.log(chalk.dim(`    ${t("banner.interject_hint")}`));
  console.log(chalk.dim(`  ${t("banner.more_modes")}`));
  console.log(chalk.dim(`    ${t("banner.debate_hint")}`));
  console.log(chalk.dim(`    ${t("banner.discuss_hint")}`));
  console.log(chalk.dim(`    ${t("banner.broadcast_hint")}`));
  console.log(chalk.dim(`  ${t("banner.stop_header")}`));
  console.log(chalk.dim(`    ${t("banner.stop_s")}`));
  console.log(chalk.dim(`    ${t("banner.stop_ctrl")}`));
  console.log(chalk.dim(`  ${t("banner.context_header")}`));
  console.log(chalk.dim(`    ${t("banner.context_hint")}`));
  console.log(chalk.dim(`    ${t("banner.export_hint")}`));
  console.log(chalk.dim(`    ${t("banner.last_hint")}`));
  console.log(chalk.dim(`    ${t("banner.inject_hint")}`));
  console.log(chalk.dim(`    ${t("banner.clear_hint")}`));
  console.log(chalk.dim(`    ${t("banner.save_load_hint")}`));
  console.log(chalk.dim(`  ${t("banner.agents_header")}`));
  console.log(chalk.dim(`    ${t("banner.agents_list")}`));
  console.log(chalk.dim(`    ${t("banner.agents_enable")}`));
  console.log(chalk.dim(`    ${t("banner.agents_disable")}`));
  console.log(chalk.dim(`    ${t("banner.agents_model")}`));
  console.log(chalk.dim(`    ${t("banner.agents_model_r")}`));
  console.log(chalk.dim(`    ${t("banner.agents_add")}`));
  console.log(chalk.dim(`    ${t("banner.agents_remove")}`));
  console.log(chalk.dim(`    ${t("banner.agents_moderator")}`));
  console.log(chalk.dim(`    ${t("banner.agents_order")}`));
  console.log(chalk.dim(`    ${t("banner.config_path", { path: CONFIG_PATH })}`));
  console.log(chalk.dim(`    ${t("banner.lang_hint")}`));
  console.log(chalk.dim(`  ${t("banner.startup_header")}`));
  console.log(chalk.dim(`    ${t("banner.flag_c")}`));
  console.log(chalk.dim(`    ${t("banner.flag_claude")}`));
  console.log(chalk.dim(`    ${t("banner.quit_hint")}`));
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

  const allKeys = Object.keys(AGENTS).join("|");
  const mentionRe = new RegExp(`@(${allKeys})\\b`, "gi");
  const mentioned = [];
  let m;
  while ((m = mentionRe.exec(rest)) !== null) mentioned.push(m[1].toLowerCase());
  rest = rest.replace(new RegExp(`@(${allKeys})\\b`, "gi"), "").trim();
  const agents = mentioned.length > 0 ? [...new Set(mentioned)] : null;

  const numMatch = rest.match(/^--(?:rounds|turns)\s+(\d+)\s+([\s\S]+)/);
  let topic = rest;
  if (numMatch) { max = parseInt(numMatch[1]); topic = numMatch[2].trim(); }

  return { max, topic, agents };
}

// ─── /agents command ────────────────────────────────────────────────
async function handleAgentsCommand(sub) {
  const parts = sub.split(/\s+/).filter(Boolean);
  const subcmd = parts[0];

  if (!subcmd) {
    const all = listAgents();
    const moderatorKey = getModeratorKey();
    console.log(chalk.bold(t("agents.list_header")));
    for (const a of all) {
      const active = AGENTS[a.key];
      const status = !a.installed
        ? chalk.red(t("agents.not_installed"))
        : a.enabled
        ? chalk.green(t("agents.enabled"))
        : chalk.dim(t("agents.disabled"));
      const inUse = active ? chalk.cyan(t("agents.active")) : "";
      const isMod = a.key === moderatorKey;
      const modMarker = isMod ? chalk.magenta(t("agents.moderator_marker")) : "";
      const modelInfo = a.model ? chalk.yellow(t("agents.model_tag", { model: a.model })) : "";
      console.log(`  ${chalk.bold(a.key.padEnd(12))} ${status}${inUse}${modMarker}${modelInfo}`);
      console.log(`    ${chalk.dim(`${a.cmd}  ${a.note || ""}`)}`);
    }
    console.log(chalk.dim(t("agents.config_path", { path: CONFIG_PATH })));
    return;
  }

  if (subcmd === "enable" && parts[1]) {
    const r = enableAgent(parts[1]);
    console.log(r.ok ? chalk.green(r.msg) : chalk.red(r.msg));
    if (r.ok) console.log(chalk.dim(t("agents.restart_required")));
    return;
  }

  if (subcmd === "disable" && parts[1]) {
    const r = disableAgent(parts[1]);
    console.log(r.ok ? chalk.green(r.msg) : chalk.red(r.msg));
    if (r.ok) console.log(chalk.dim(t("agents.restart_required")));
    return;
  }

  if (subcmd === "model" && parts[1]) {
    const model = parts.slice(2).join(" ") || null;
    const r = setAgentModel(parts[1], model);
    console.log(r.ok ? chalk.green(r.msg) : chalk.red(r.msg));
    if (r.ok) console.log(chalk.dim(t("agents.restart_required")));
    return;
  }

  if (subcmd === "moderator") {
    if (!parts[1]) {
      const key = getModeratorKey();
      const name = key ? (AGENTS[key]?.displayName || key) : t("agents.moderator_auto");
      console.log(chalk.dim(t("agents.moderator_current", { name })));
      return;
    }
    const r = setModerator(parts[1]);
    console.log(r.ok ? chalk.green(r.msg) : chalk.red(r.msg));
    if (r.ok) console.log(chalk.dim(t("agents.restart_required")));
    return;
  }

  if (subcmd === "order") {
    if (parts.length < 2) {
      const active = listAgents().filter(a => a.installed && a.enabled).map(a => a.key);
      console.log(chalk.dim(`${t("agents.order_current")}: ${active.join(" → ")}`));
      console.log(chalk.dim(t("agents.order_usage")));
      return;
    }
    const r = reorderAgents(parts.slice(1));
    console.log(r.ok ? chalk.green(r.msg) : chalk.red(r.msg));
    if (r.ok) console.log(chalk.dim(t("agents.restart_required")));
    return;
  }

  if (subcmd === "reset") {
    resetConfig();
    console.log(chalk.green(t("agents.reset_done")));
    return;
  }

  if (subcmd === "remove" && parts[1]) {
    const r = removeAgent(parts[1]);
    console.log(r.ok ? chalk.green(r.msg) : chalk.red(r.msg));
    return;
  }

  if (subcmd === "add") {
    const answers = await wizard([
      { key: "key",    prompt: t("wizard.key") },
      { key: "name",   prompt: t("wizard.name") },
      { key: "cmd",    prompt: t("wizard.cmd") },
      { key: "args",   prompt: t("wizard.args") },
      { key: "color",  prompt: t("wizard.color") },
      { key: "output", prompt: t("wizard.output") },
      { key: "note",   prompt: t("wizard.note") },
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
      console.log(chalk.red(t("agents.key_empty")));
      return;
    }

    const r = addAgent(def);
    console.log(r.ok ? chalk.green(r.msg) : chalk.red(r.msg));
    if (r.ok) console.log(chalk.dim(t("agents.restart_required")));
    return;
  }

  console.log(chalk.red(t("agents.usage")));
}

// Simple readline wizard for multi-field input
function wizard(fields) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY && process.stdin.isRaw) process.stdin.setRawMode(false);

    const answers = {};
    let i = 0;
    const ask = () => {
      if (i >= fields.length) { resolve(answers); return; }
      process.stdout.write(chalk.cyan(`  ${fields[i].prompt}`));
    };
    ask();
    const tmpRl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    tmpRl.on("line", (line) => {
      answers[fields[i].key] = line;
      i++;
      if (i < fields.length) { ask(); }
      else {
        tmpRl.close();
        if (process.stdin.isTTY) process.stdin.setRawMode(true);
        resolve(answers);
      }
    });
  });
}

// ─── Save summary and show path ─────────────────────────────────────
function logSummary(ctx, topic, agentKeys) {
  const { global: gPath, local: lPath } = saveSummary(ctx, topic, agentKeys, { localDir: process.cwd() });
  if (gPath) console.log(chalk.dim(t("summary.saved", { path: gPath })));
  if (lPath) console.log(chalk.dim(t("summary.saved_local", { path: lPath })));
}

// ─── Handle one input line ───────────────────────────────────────────
async function handleLine(input) {
  if (!input.trim()) return;

  // During active discussion: 's'/'S' = stop, anything else = user interjection
  if (pending > 1) {
    if (input.toLowerCase() === "s") {
      requestStop();
      console.log(chalk.yellow(t("discuss.stop_sent")));
    } else {
      pushUserInput(input);
      console.log(chalk.dim(t("discuss.interjected")));
    }
    return;
  }

  // "/" alone → show command hints
  if (input === "/") {
    const cmds = [
      ["/debate  <topic>",   t("cmd.debate")],
      ["/discuss <topic>",   t("cmd.discuss")],
      ["/broadcast <msg>",   t("cmd.broadcast")],
      ["/context",           t("cmd.context")],
      ["/export",            t("cmd.export")],
      ["/last",              t("cmd.last")],
      ["/inject",            t("cmd.inject")],
      ["/clear",             t("cmd.clear")],
      ["/save / /load",      `${t("cmd.save")} / ${t("cmd.load")}`],
      ["/agents",            t("cmd.agents")],
      ["/agents moderator",  t("cmd.agents_moderator")],
      ["/agents order",      t("cmd.agents_order")],
      ["/lang en|zh",        t("cmd.lang")],
      ["/help",              t("cmd.help")],
      ["/quit",              t("cmd.quit")],
    ];
    console.log("");
    for (const [cmd, desc] of cmds) {
      console.log(`  ${chalk.cyan(cmd.padEnd(22))} ${chalk.dim(desc)}`);
    }
    console.log("");
    return;
  }

  // /lang — switch language
  if (input.startsWith("/lang")) {
    const lang = input.slice(5).trim();
    if (!lang) {
      console.log(chalk.dim(`Language: ${getLang()} (en / zh)`));
      return;
    }
    const ok = setLang(lang);
    if (ok) {
      console.log(chalk.green(`Language set to: ${lang} (restart to apply fully)`));
    } else {
      console.log(chalk.red(`Unknown language: ${lang} — use en or zh`));
    }
    return;
  }

  if (input.startsWith("/discuss")) {
    const { max, topic, agents } = parseDiscussArgs(input, "/discuss");
    if (!topic) { console.log(chalk.red(t("err.discuss_usage"))); return; }
    const usedAgents = agents || Object.keys(AGENTS);
    await discuss(topic, ctx, { maxRounds: max, ...(agents && { agents }) });
    logSummary(ctx, topic, usedAgents);
    return;
  }

  if (input.startsWith("/debate")) {
    const { max, topic, agents } = parseDiscussArgs(input, "/debate");
    if (!topic) { console.log(chalk.red(t("err.debate_usage"))); return; }
    const usedAgents = agents || Object.keys(AGENTS);
    await debate(topic, ctx, { maxTurns: max, ...(agents && { agents }) });
    logSummary(ctx, topic, usedAgents);
    return;
  }

  if (input === "/context" || input === "/ctx") {
    const s = ctx.stats();
    console.log(chalk.dim(t("context.stats", { msgs: s.messages, chars: s.chars.toLocaleString(), tokens: s.tokens.toLocaleString() })));
    return;
  }

  if (input.startsWith("/agents")) {
    await handleAgentsCommand(input.slice(7).trim());
    return;
  }

  if (input === "/export" || input.startsWith("/export ")) {
    if (ctx.messages.length === 0) { console.log(chalk.yellow(t("context.empty"))); return; }
    const caption = input.slice(8).trim().replace(/[/\\:*?"<>|]/g, "");
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
    console.log(chalk.green(t("context.exported", { path: filepath })));
    return;
  }

  if (input === "/last") {
    const conclusions = ctx.messages.filter(
      m => m.role === "system" && (
        m.content.includes("[CONCLUSION]") || m.content.includes("[DEBATE_CONCLUSION]")
      )
    );
    if (conclusions.length === 0) {
      console.log(chalk.yellow(t("context.no_conclusion")));
    } else {
      const last = conclusions[conclusions.length - 1];
      console.log(chalk.bold(t("context.last_header")));
      console.log(chalk.white(last.content.replace(/\[(?:CONCLUSION|DEBATE_CONCLUSION)\]\s*/, "")));
    }
    return;
  }

  if (input === "/clear") { ctx.clear(); console.log(chalk.dim(t("context.cleared"))); return; }
  if (input === "/save")  { ctx.save(); console.log(chalk.dim(t("context.saved", { path: ctx.path }))); return; }
  if (input === "/load")  {
    const ok = ctx.load();
    const s = ctx.stats();
    console.log(ok ? chalk.dim(t("context.loaded", { msgs: s.messages })) : chalk.red(t("context.not_found")));
    return;
  }

  if (input === "/inject") {
    const msgs = readClaudeSession(process.cwd(), 20);
    if (msgs?.length > 0) {
      const summary = msgs
        .map((m) => `[${m.role === "user" ? "User" : "Claude"}] ${m.content.slice(0, 300)}`)
        .join("\n\n");
      ctx.add("system", t("inject.system_label", { summary }));
      console.log(chalk.dim(t("inject.done", { count: msgs.length })));
    } else {
      console.log(chalk.yellow(t("inject.none")));
    }
    return;
  }

  if (input === "/help")  { printBanner(); return; }
  if (input === "/quit" || input === "/q" || input === "/exit") {
    console.log(chalk.dim(t("input.bye"))); process.exit(0);
  }

  // Unknown slash command — catch before falling through to debate
  if (input.startsWith("/") && !input.startsWith("/broadcast") && !input.startsWith("/bc ")) {
    const cmd = input.split(" ")[0];
    console.log(chalk.red(t("err.unknown_cmd", { cmd })));
    console.log(chalk.dim(t("err.unknown_cmd_hint")));
    return;
  }

  // /broadcast — explicit parallel mode
  if (input.startsWith("/broadcast ") || input.startsWith("/bc ")) {
    const msg = input.replace(/^\/(broadcast|bc)\s+/, "").trim();
    if (!msg) { console.log(chalk.red(t("err.broadcast_usage"))); return; }
    const { targets, prompt } = parseMentions(msg);
    const sendTo = targets.length > 0 ? targets : Object.keys(AGENTS);
    await broadcast(prompt || msg, ctx, sendTo);
    logSummary(ctx, prompt || msg, sendTo);
    return;
  }

  // Default: serial debate (each agent speaks once, building on previous)
  const { targets, prompt } = parseMentions(input);
  if (!prompt) { console.log(chalk.red(t("err.empty_prompt"))); return; }
  const sendTo = targets.length > 0 ? targets : Object.keys(AGENTS);
  await debate(prompt, ctx, { maxTurns: sendTo.length, agents: sendTo, noJudge: true });
  logSummary(ctx, prompt, sendTo);
}

// ─── Single-shot mode ────────────────────────────────────────────────
if (inlineMsg) {
  await handleLine(inlineMsg);
  process.exit(0);
}

// ─── Command definitions for autocomplete ───────────────────────────
const REPL_COMMANDS = [
  ["/debate",    t("cmd.debate")],
  ["/discuss",   t("cmd.discuss")],
  ["/broadcast", t("cmd.broadcast")],
  ["/context",   t("cmd.context")],
  ["/export",    t("cmd.export")],
  ["/last",      t("cmd.last")],
  ["/inject",    t("cmd.inject")],
  ["/clear",     t("cmd.clear")],
  ["/save",      t("cmd.save")],
  ["/load",      t("cmd.load")],
  ["/agents",    t("cmd.agents")],
  ["/lang",      t("cmd.lang")],
  ["/help",      t("cmd.help")],
  ["/quit",      t("cmd.quit")],
  ...Object.keys(AGENTS).map(k => [`@${k}`, t("cmd.send_to", { name: AGENTS[k].name })]),
];

// ─── Interactive REPL ────────────────────────────────────────────────
printBanner();

let pending = 0;

const repl = createRepl({
  prompt: t("input.prompt"),
  commands: REPL_COMMANDS,
  agents: AGENTS,
  onLine: async (line) => {
    if (!line) return;
    pending++;
    if (pending === 1) repl.pause();   // only set up scroll region on first entry
    try {
      await handleLine(line);
    } catch (err) {
      console.log(chalk.red(`Error: ${err.message}`));
    }
    pending--;
    if (pending === 0) repl.showPrompt();  // only tear down when fully done
  },
  onSigint: () => {
    // Only called during active discussion (paused state in input.js)
    console.log(chalk.yellow(t("input.stop_signal")));
    requestStop();
  },
});
