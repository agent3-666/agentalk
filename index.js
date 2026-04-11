#!/usr/bin/env node
import { createInterface } from "readline";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import chalk from "chalk";
import { AGENTS, runAgent } from "./lib/agents.js";
import { ContextManager } from "./lib/context.js";
import { discuss, debate, panel, brainstorm, challenge, deepen, broadcast, moderatedSession, requestStop, stopSignal, pushUserInput, saveSummary, feedMessage } from "./lib/discuss.js";
import { listAgents, enableAgent, disableAgent, addAgent, removeAgent, setAgentModel, resetConfig, getModeratorKey, setModerator, reorderAgents, getGlobalTimeout, setGlobalTimeout, setAgentTimeout, CONFIG_PATH } from "./lib/config.js";
import { resolveModel, inferProvider, PROVIDER_COLORS, setApiKey, getApiKey, listApiKeys, setCustomEndpoint, getCustomEndpoint } from "./lib/model-runner.js";
import { createRepl } from "./lib/input.js";
import { loadLang, setLang, getLang, t } from "./lib/i18n.js";

// ─── Load language setting ───────────────────────────────────────────
loadLang();

// ─── Parse CLI args ─────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flagContinue = argv.includes("-c") || argv.includes("--continue");
const flagFromClaude = argv.includes("--from-claude");
const flagHelp = argv.includes("-h") || argv.includes("--help");
const flagInstallSkill = argv.includes("--install-skill");
const flagVerbose = argv.includes("--verbose") || argv.includes("-v");

// Non-interactive headless mode: --discuss / --debate / --panel / --brainstorm / --challenge / --deepen
const flagDiscussIdx    = argv.findIndex(a => a === "--discuss");
const flagDebateIdx     = argv.findIndex(a => a === "--debate");
const flagPanelIdx      = argv.findIndex(a => a === "--panel");
const flagBrainstormIdx = argv.findIndex(a => a === "--brainstorm");
const flagChallengeIdx  = argv.findIndex(a => a === "--challenge");
const flagDeepenIdx     = argv.findIndex(a => a === "--deepen");
const headlessTopic  = flagDiscussIdx    !== -1 ? argv[flagDiscussIdx    + 1]
                     : flagDebateIdx     !== -1 ? argv[flagDebateIdx     + 1]
                     : flagPanelIdx      !== -1 ? argv[flagPanelIdx      + 1]
                     : flagBrainstormIdx !== -1 ? argv[flagBrainstormIdx + 1]
                     : flagChallengeIdx  !== -1 ? argv[flagChallengeIdx  + 1]
                     : flagDeepenIdx     !== -1 ? argv[flagDeepenIdx     + 1]
                     : null;
const headlessMode   = flagDiscussIdx    !== -1 ? "discuss"
                     : flagDebateIdx     !== -1 ? "debate"
                     : flagPanelIdx      !== -1 ? "panel"
                     : flagBrainstormIdx !== -1 ? "brainstorm"
                     : flagChallengeIdx  !== -1 ? "challenge"
                     : flagDeepenIdx     !== -1 ? "deepen"
                     : null;

const inlineMsg = argv.filter((a) => !a.startsWith("-")).join(" ").trim();

// ─── Briefing state ─────────────────────────────────────────────────
// When --from-claude is set, the named agent becomes the "context source"
// for this session. On the first substantive message the user types, we
// Briefing is on-demand: the moderator decides in its planning step whether
// external context is needed. contextSourceKey just says who to ask.
let contextSourceKey = null;
if (flagFromClaude) {
  if (AGENTS.claude) {
    contextSourceKey = "claude";
  } else {
    console.log(chalk.yellow(t("briefing.source_not_active", { key: "claude" })));
    console.log(chalk.dim(t("briefing.source_hint")));
  }
}

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

// ─── Banner ─────────────────────────────────────────────────────────
// Compact startup banner: 6 lines. Enough to start using the tool.
// Full help lives in printFullHelp() (triggered by /help or -h).
function printBanner() {
  const activeNames = Object.values(AGENTS).map(a => a.displayName).join(" · ");
  console.log(chalk.bold(`\n ${t("banner.title", { agents: activeNames })}\n`));
  console.log(chalk.dim(`  ${t("banner.quick_msg")}`));
  console.log(chalk.dim(`  ${t("banner.quick_cmds")}`));
  console.log(chalk.dim(`  ${t("banner.quick_stop")}`));
  console.log(chalk.dim(`  ${t("banner.quick_help")}\n`));
}

function printFullHelp() {
  const activeNames = Object.values(AGENTS).map(a => a.displayName).join(" · ");
  const keys = Object.keys(AGENTS).map(k => `@${k}`).join(" / ");
  console.log(chalk.bold(`\n ${t("banner.title", { agents: activeNames })}\n`));
  console.log(chalk.dim(`  ${t("banner.default_mode")}`));
  console.log(chalk.dim(`    ${t("banner.msg_hint")}`));
  console.log(chalk.dim(`    ${t("banner.mention_hint", { keys })}`));
  console.log(chalk.dim(`    ${t("banner.interject_hint")}`));
  console.log(chalk.dim(`  ${t("banner.code_modes")}`));
  console.log(chalk.dim(`    ${t("banner.debate_hint")}`));
  console.log(chalk.dim(`    ${t("banner.discuss_hint")}`));
  console.log(chalk.dim(`    ${t("banner.broadcast_hint")}`));
  console.log(chalk.dim(`    ${t("banner.mod_hint")}`));
  console.log(chalk.dim(`  ${t("banner.stop_header")}`));
  console.log(chalk.dim(`    ${t("banner.stop_s")}`));
  console.log(chalk.dim(`    ${t("banner.add_hint")}`));
  console.log(chalk.dim(`    ${t("banner.stop_ctrl")}`));
  console.log(chalk.dim(`  ${t("banner.context_header")}`));
  console.log(chalk.dim(`    ${t("banner.context_hint")}`));
  console.log(chalk.dim(`    ${t("banner.export_hint")}`));
  console.log(chalk.dim(`    ${t("banner.last_hint")}`));
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
  console.log(chalk.dim(`    ${t("banner.agents_timeout")}`));
  console.log(chalk.dim(`    ${t("banner.config_path", { path: CONFIG_PATH })}`));
  console.log(chalk.dim(`    ${t("banner.lang_hint")}`));
  console.log(chalk.dim(`  ${t("banner.startup_header")}`));
  console.log(chalk.dim(`    ${t("banner.flag_c")}`));
  console.log(chalk.dim(`    ${t("banner.flag_claude")}`));
  console.log(chalk.dim(`    ${t("banner.quit_hint")}`));
}

if (flagHelp) { printFullHelp(); process.exit(0); }

if (flagInstallSkill) {
  await import("./scripts/install-skill.js");
  process.exit(0);
}

// ─── Headless mode: --discuss / --debate ────────────────────────────
if (headlessMode && headlessTopic) {
  const ctx = new ContextManager(process.cwd());
  // --verbose: stream each agent's output to stdout in real-time (capture=false)
  // default: capture silently, print only the final conclusion (clean for piping)
  let lines;
  if      (headlessMode === "discuss")    lines = await discuss   (headlessTopic, ctx, { capture: !flagVerbose });
  else if (headlessMode === "panel")      lines = await panel     (headlessTopic, ctx, { capture: !flagVerbose });
  else if (headlessMode === "brainstorm") lines = await brainstorm(headlessTopic, ctx, { capture: !flagVerbose });
  else if (headlessMode === "challenge")  lines = await challenge (headlessTopic, ctx, { capture: !flagVerbose });
  else if (headlessMode === "deepen")     lines = await deepen    (headlessTopic, ctx, { capture: !flagVerbose });
  else                                    lines = await debate    (headlessTopic, ctx, { capture: !flagVerbose });
  if (!flagVerbose) {
    // Print captured output then extract conclusion for clean stdout
    const conclusion = ctx.messages.findLast(
      m => m.role === "system" && /^\[(辩论结论|讨论结论|CONCLUSION|DEBATE_CONCLUSION)\]/.test(m.content)
    );
    if (conclusion) {
      process.stdout.write(conclusion.content + "\n");
    } else if (lines?.length) {
      process.stdout.write(lines.join("\n") + "\n");
    }
  }
  process.exit(0);
}

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

  if (subcmd === "timeout") {
    if (parts.length === 1) {
      const s = getGlobalTimeout();
      console.log(chalk.dim(t("agents.timeout_current", { s })));
      return;
    }
    const isNum = /^\d+$/.test(parts[1]);
    if (isNum) {
      const r = setGlobalTimeout(parts[1]);
      console.log(r.ok ? chalk.green(r.msg) : chalk.red(r.msg));
      return;
    }
    // per-agent: /agents timeout <key> [<s>|reset]
    const val = (parts[2] === "reset" || !parts[2]) ? null : parts[2];
    const r = setAgentTimeout(parts[1], val);
    console.log(r.ok ? chalk.green(r.msg) : chalk.red(r.msg));
    return;
  }

  if (subcmd === "reset") {
    resetConfig();
    console.log(chalk.green(t("agents.reset_done")));
    return;
  }

  // /agents add-model <model-id> [<model-id> ...]
  // Registers one or more API models as agentalk-model-backed agents
  if (subcmd === "add-model") {
    if (parts.length < 2) {
      console.log(chalk.red(t("agents.add_model_usage")));
      return;
    }
    for (const modelId of parts.slice(1)) {
      const { provider, model } = resolveModel(modelId);
      const key = model.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
      const color = PROVIDER_COLORS[provider] || "#6B7280";
      const r = addAgent({
        key,
        name: model,
        cmd: "agentalk-model",
        args: ["-m", modelId, "{prompt}"],
        color,
        output: "text",
        note: `${provider}/${model} via API — set key with: /agents set-key ${provider} <key>`,
      });
      console.log(r.ok ? chalk.green(t("agents.add_model_added", { key, model: modelId })) : chalk.red(r.msg));
    }
    console.log(chalk.dim(t("agents.restart_required")));
    return;
  }

  // /agents set-key <provider> <api-key>
  if (subcmd === "set-key") {
    if (parts.length === 1) {
      const providers = listApiKeys();
      if (providers.length === 0) console.log(chalk.dim(t("agents.set_key_none")));
      else console.log(chalk.dim(t("agents.set_key_list", { providers: providers.join(", ") })));
      return;
    }
    if (parts.length < 3) { console.log(chalk.red(t("agents.set_key_usage"))); return; }
    setApiKey(parts[1], parts[2]);
    console.log(chalk.green(t("agents.set_key_done", { provider: parts[1] })));
    return;
  }

  // /agents set-endpoint <provider> <base-url>
  if (subcmd === "set-endpoint") {
    if (parts.length < 3) { console.log(chalk.red(t("agents.set_endpoint_usage"))); return; }
    setCustomEndpoint(parts[1], parts[2]);
    console.log(chalk.green(t("agents.set_endpoint_done", { provider: parts[1], endpoint: parts[2] })));
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
  const { global: gPath, local: lPath, localJson: jPath } =
    saveSummary(ctx, topic, agentKeys, { localDir: process.cwd() });
  if (gPath) console.log(chalk.dim(t("summary.saved", { path: gPath })));
  if (lPath) console.log(chalk.dim(t("summary.saved_local", { path: lPath })));
  if (jPath) console.log(chalk.dim(t("summary.saved_raw", { path: jPath })));
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
      ["/debate      <topic>", t("cmd.debate")],
      ["/panel      <topic>",  t("cmd.panel")],
      ["/brainstorm <topic>",  t("cmd.brainstorm")],
      ["/challenge  <topic>",  t("cmd.challenge")],
      ["/deepen     <topic>",  t("cmd.deepen")],
      ["/discuss    <topic>",  t("cmd.discuss")],
      ["/broadcast <msg>",   t("cmd.broadcast")],
      ["/mod <topic>",       t("cmd.mod")],
      ["/from [<agent>]",    t("cmd.from")],
      ["/context",           t("cmd.context")],
      ["/export",            t("cmd.export")],
      ["/last",              t("cmd.last")],
      ["/clear",             t("cmd.clear")],
      ["/save / /load",      `${t("cmd.save")} / ${t("cmd.load")}`],
      ["/agents",            t("cmd.agents")],
      ["/agents moderator",  t("cmd.agents_moderator")],
      ["/agents order",      t("cmd.agents_order")],
      ["/agents timeout",    t("cmd.agents_timeout")],
      ["/agents add-model",  t("cmd.agents_add_model")],
      ["/agents set-key",    t("cmd.agents_set_key")],
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

  // /add during discussion = feed supplemental info to agents
  if (input.startsWith("/add ") && pending > 0) {
    const msg = input.slice(5).trim();
    if (!msg) { console.log(chalk.red("用法: /add <补充信息>")); return; }
    feedMessage(msg);
    console.log(chalk.green(`[已追加，下一轮可见: ${msg.slice(0, 60)}${msg.length > 60 ? "..." : ""}]`));
    return;
  }

  if (input.startsWith("/mod ")) {
    const topic = input.slice(5).trim();
    if (!topic) { console.log(chalk.red(t("err.mod_usage"))); return; }
    await moderatedSession(topic, ctx, contextSourceKey
      ? { briefingProvider: runBriefing, contextSource: AGENTS[contextSourceKey]?.displayName }
      : {});
    logSummary(ctx, topic, Object.keys(AGENTS));
    return;
  }

  if (input.startsWith("/discuss")) {
    const { max, topic, agents } = parseDiscussArgs(input, "/discuss");
    if (!topic) { console.log(chalk.red("用法: /discuss [@agent...] [--rounds N] <话题|文件路径>")); return; }
    await discuss(topic, ctx, { maxRounds: max, ...(agents && { agents }) });
    logSummary(ctx, topic, agents || Object.keys(AGENTS));
    return;
  }

  if (input.startsWith("/debate")) {
    const { max, topic, agents } = parseDiscussArgs(input, "/debate");
    if (!topic) { console.log(chalk.red("用法: /debate [@agent...] [--turns N] <话题|文件路径>")); return; }
    await debate(topic, ctx, { maxTurns: max, ...(agents && { agents }) });
    logSummary(ctx, topic, agents || Object.keys(AGENTS));
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

  if (input === "/clear") {
    ctx.clear();
    console.log(chalk.dim(t("context.cleared")));
    return;
  }
  if (input === "/save")  { ctx.save(); console.log(chalk.dim(t("context.saved", { path: ctx.path }))); return; }
  if (input === "/load")  {
    const ok = ctx.load();
    const s = ctx.stats();
    console.log(ok ? chalk.dim(t("context.loaded", { msgs: s.messages })) : chalk.red(t("context.not_found")));
    return;
  }

  if (input.startsWith("/from")) {
    const key = input.slice(5).trim().toLowerCase();
    if (key === "none" || key === "off" || key === "clear") {
      contextSourceKey = null;
      console.log(chalk.dim("Context source cleared."));
    } else if (!key) {
      // Interactive picker: single-select (at most one source)
      const items = Object.entries(AGENTS).map(([k, a]) => ({ key: k, name: a.displayName }));
      const preSelected = contextSourceKey ? new Set([contextSourceKey]) : new Set();
      const selected = await repl.showPicker(items, preSelected);
      if (selected === null) {
        console.log(chalk.dim("Cancelled."));
      } else if (selected.length === 0) {
        contextSourceKey = null;
        console.log(chalk.dim("No context source selected."));
      } else {
        contextSourceKey = selected[selected.length - 1];
        console.log(chalk.green(`Context source set to: ${AGENTS[contextSourceKey].displayName}`));
        console.log(chalk.dim("The moderator will request a briefing when the topic needs it."));
      }
    } else if (AGENTS[key]) {
      contextSourceKey = key;
      console.log(chalk.green(`Context source set to: ${AGENTS[key].displayName}`));
      console.log(chalk.dim("The moderator will request a briefing when the topic needs it."));
    } else {
      console.log(chalk.red(`Unknown agent: ${key}`));
      console.log(chalk.dim(`Available: ${Object.keys(AGENTS).join(", ")}`));
    }
    return;
  }

  if (input === "/help")  { printFullHelp(); return; }
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

  // Default: moderator-led session (no slash, no @mention = full moderator mode)
  // @mention = direct targeted message, skip moderator planning
  const { targets, prompt } = parseMentions(input);
  if (!prompt) { console.log(chalk.red(t("err.empty_prompt"))); return; }
  if (targets.length > 0) {
    await debate(prompt, ctx, { maxTurns: targets.length, agents: targets, noJudge: true });
    logSummary(ctx, prompt, targets);
  } else {
    await moderatedSession(prompt, ctx, contextSourceKey
      ? { briefingProvider: runBriefing, contextSource: AGENTS[contextSourceKey]?.displayName }
      : {});
    logSummary(ctx, prompt, Object.keys(AGENTS));
  }
}

let pending = 0;

// ─── Single-shot mode ────────────────────────────────────────────────
if (inlineMsg) {
  await handleLine(inlineMsg);
  process.exit(0);
}

// ─── Command definitions for autocomplete ───────────────────────────
const REPL_COMMANDS = [
  ["/debate",      t("cmd.debate")],
  ["/panel",       t("cmd.panel")],
  ["/brainstorm",  t("cmd.brainstorm")],
  ["/challenge",   t("cmd.challenge")],
  ["/deepen",      t("cmd.deepen")],
  ["/discuss",     t("cmd.discuss")],
  ["/broadcast", t("cmd.broadcast")],
  ["/from",      t("cmd.from")],
  ["/context",   t("cmd.context")],
  ["/export",    t("cmd.export")],
  ["/last",      t("cmd.last")],
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

// Commands that produce substantial output and deserve a visual separator
// after they finish. Short info commands (/help, /context, /clear, etc.)
// are noisy enough already and don't need one.
function isSubstantiveCommand(line) {
  const l = line.trim();
  if (!l) return false;
  // Plain text, @mention, or explicit discussion commands
  if (!l.startsWith("/")) return true;
  return /^\/(debate|discuss|broadcast|bc|mod)\b/.test(l);
}

// Run the briefing phase: called by the moderator when it decides external
// context is needed. Takes the refined topic (already extracted by the
// moderator's plan). Returns true on success, false on failure.
async function runBriefing(topic) {
  const briefer = AGENTS[contextSourceKey];
  if (!briefer) return false;

  const briefingPrompt = t("prompt.briefing", { name: briefer.name, question: topic });

  // Decorate the label so the streamed output is clearly "[Briefing]"
  // rather than looking like a normal discussion reply.
  const origLabel = briefer.label;
  briefer.label = `${origLabel}${chalk.dim(" [Briefing]")}`;
  let result;
  try {
    console.log(chalk.dim(`\n${t("briefing.preparing", { name: briefer.displayName })}`));
    result = await runAgent(contextSourceKey, briefingPrompt, { timeout: 600 });
  } finally {
    briefer.label = origLabel;
  }

  if (result.stopped) {
    console.log(chalk.yellow(t("briefing.cancelled")));
    return false;
  }
  if (result.timedOut || !result.response?.trim()) {
    console.log(chalk.red(t("briefing.failed")));
    return false;
  }

  ctx.add("system", `[调用方简报 · briefing from ${briefer.displayName}]\n${result.response.trim()}`);
  console.log(chalk.dim(t("briefing.ready")));
  return true;
}

let repl; // forward ref so handleLine can call repl.showPicker
repl = createRepl({
  prompt: t("input.prompt"),
  commands: REPL_COMMANDS,
  agents: AGENTS,
  onLine: async (line) => {
    if (!line) return;
    pending++;
    if (pending === 1) repl.pause();   // only set up scroll region on first entry
    const substantive = isSubstantiveCommand(line);
    try {
      await handleLine(line);
    } catch (err) {
      console.log(chalk.red(`Error: ${err.message}`));
    }
    pending--;
    if (pending === 0) {
      // Divider + blank line between discussion tasks, so you can quickly
      // scroll back and find the start/end of each conversation.
      if (substantive) {
        console.log("\n" + chalk.dim("─".repeat(60)) + "\n");
      }
      repl.showPrompt();
    }
  },
  onSigint: () => {
    // Only called during active discussion (paused state in input.js)
    console.log(chalk.yellow(t("input.stop_signal")));
    requestStop();
  },
});
