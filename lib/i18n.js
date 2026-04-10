import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const CONFIG_DIR = join(homedir(), ".agentalk");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

// ─── Lang persistence ────────────────────────────────────────────────
let _lang = "en";

export function loadLang() {
  try {
    if (existsSync(CONFIG_PATH)) {
      const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
      if (cfg.lang === "zh" || cfg.lang === "en") _lang = cfg.lang;
    }
  } catch {}
  return _lang;
}

export function setLang(lang) {
  if (lang !== "en" && lang !== "zh") return false;
  _lang = lang;
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    const cfg = existsSync(CONFIG_PATH)
      ? JSON.parse(readFileSync(CONFIG_PATH, "utf8"))
      : {};
    cfg.lang = lang;
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch {}
  return true;
}

export function getLang() { return _lang; }

// ─── Translation helper ──────────────────────────────────────────────
// Supports {var} placeholders: t("key", { var: value })
export function t(key, vars = {}) {
  const str = (STRINGS[_lang]?.[key] ?? STRINGS.en[key]) ?? key;
  if (!vars || typeof str !== "string") return str;
  return str.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);
}

// ─── String definitions ──────────────────────────────────────────────
const STRINGS = {
  en: {
    // ── Session ──
    "session.loaded":          "[Resuming] {msgs} messages, ~{tokens} tokens",
    "session.not_found":       "[Resuming] No history found, starting fresh",
    "session.history_footer":  "── History above · continue below ──",
    "session.history_note":    "Above is your previous session. Keep going.\n",
    "session.claude_injected": "[Claude Session] Injected {count} messages",
    "session.claude_none":     "[Claude Session] No Claude session found in current directory",

    // ── Banner ──
    "banner.title":            "🤖  AgentTalk  v2.0  ·  {agents}",
    "banner.default_mode":     "Default mode (serial):",
    "banner.msg_hint":         "  <msg>                  each agent replies in turn, building on the last",
    "banner.mention_hint":     "  {keys}  direct message",
    "banner.interject_hint":   "  type during discussion  inject your view, visible to next agent",
    "banner.more_modes":       "More modes:",
    "banner.debate_hint":      "  /debate  [@a @b] [--turns N]  <topic>   multi-round serial debate",
    "banner.discuss_hint":     "  /discuss [@a @b] [--rounds N] <topic>   parallel discussion",
    "banner.broadcast_hint":   "  /broadcast <msg>     parallel broadcast (no discussion)",
    "banner.stop_header":      "Stop discussion:",
    "banner.stop_s":           "  s + Enter    graceful stop (generates summary)",
    "banner.stop_ctrl":        "  Ctrl+C       immediate stop",
    "banner.context_header":   "Context & export:",
    "banner.context_hint":     "  /context    show context stats",
    "banner.export_hint":      "  /export [title]  export as Markdown (optional title)",
    "banner.last_hint":        "  /last       show last conclusion",
    "banner.inject_hint":      "  /inject     inject Claude session",
    "banner.clear_hint":       "  /clear      clear context",
    "banner.save_load_hint":   "  /save /load manual save / load",
    "banner.agents_header":    "Agent management:",
    "banner.agents_list":      "  /agents                  list all agents",
    "banner.agents_enable":    "  /agents enable <key>     enable agent",
    "banner.agents_disable":   "  /agents disable <key>    disable agent",
    "banner.agents_model":     "  /agents model <key> <m>  set agent model",
    "banner.agents_model_r":   "  /agents model <key>      reset to default model",
    "banner.agents_add":       "  /agents add              interactive add custom agent",
    "banner.agents_remove":    "  /agents remove <key>     remove agent",
    "banner.agents_moderator": "  /agents moderator <key>  set moderator agent",
    "banner.agents_order":     "  /agents order <k1> <k2>  set discussion order",
    "banner.agents_timeout":   "  /agents timeout [<key>] <s>  set timeout in seconds (default: 60s)",
    "banner.config_path":      "  config: {path}",
    "banner.lang_hint":        "  /lang en|zh              switch language",
    "banner.startup_header":   "Startup flags:",
    "banner.flag_c":           "  -c / --continue   resume last session",
    "banner.flag_claude":      "  --from-claude     inject Claude session on start",
    "banner.quit_hint":        "  /quit             exit\n",

    // ── Agent management ──
    "agents.list_header":      "\n  Agent list:\n",
    "agents.not_installed":    "not installed",
    "agents.enabled":          "enabled",
    "agents.disabled":         "disabled",
    "agents.active":           " ◀ active",
    "agents.model_tag":        " [model: {model}]",
    "agents.config_path":      "\n  Config: {path}\n",
    "agents.restart_required":  "Restart agentalk to apply",
    "agents.reset_done":        "Config reset to defaults, restart to apply",
    "agents.not_found":         "Agent not found: {key}",
    "agents.enabled_ok":        "Enabled {name}",
    "agents.disabled_ok":       "Disabled {name}",
    "agents.model_set":         "{name} model: {prev} → {next}",
    "agents.key_exists":        'Key "{key}" already exists, use a different key',
    "agents.added":             "Added {name}",
    "agents.removed":           "Removed {name}",
    "agents.usage":             "Usage: /agents [enable|disable|model|moderator|order|add|remove] ...",
    "agents.key_empty":         "key / name / cmd cannot be empty",
    "agents.moderator_marker":  " ⚖ moderator",
    "agents.moderator_current": "Moderator: {name}",
    "agents.moderator_auto":    "(auto — first active agent)",
    "agents.order_current":     "Current order",
    "agents.order_usage":       "Usage: /agents order <key1> <key2> ...",
    "agents.timeout_current":   "Global timeout: {s}s  (/agents timeout <N> to change)",
    "agents.timeout_label":     "⏱ timed out ({s}s)",

    // ── Wizard prompts ──
    "wizard.key":              "Unique key (letters only, e.g. mygpt): ",
    "wizard.name":             "Display name (e.g. GPT-4o): ",
    "wizard.cmd":              "Command (e.g. mycli): ",
    "wizard.args":             "Args, use {prompt} for user input (e.g. -p {prompt}): ",
    "wizard.color":            "Color hex (e.g. #FF6B6B, leave blank for default): ",
    "wizard.output":           "Output format: text or ndjson (blank = text): ",
    "wizard.note":             "Note (optional): ",

    // ── Discussion ──
    "discuss.serial_header":   "\n🎙️  Serial discussion · {agents}",
    "discuss.serial_turns":    " · max {turns} rounds",
    "discuss.parallel_header": "\n💬 Parallel discussion · max {rounds} rounds · auto-converge",
    "discuss.topic":           "Topic: {topic}",
    "discuss.round":           "\n── Round {n} ──",
    "discuss.stopped":         "\n🛑 Discussion stopped",
    "discuss.timeout_skip":    "[{name} timed out ({s}s), skipping]",
    "discuss.busy_skip":       "[{name} server busy, skipping]",
    "discuss.error_skip":      "[{name} error, skipping: {msg}]",
    "discuss.all_failed":      "\nAll agents unavailable, discussion aborted",
    "discuss.converge_all":    "\n✅ All agreed to converge, generating conclusion...",
    "discuss.converge_some":   "\n[{n}/{total} suggested converge, continuing...]",
    "discuss.converged":       "\n✅ Discussion converged: {summary}",
    "discuss.judge_continue":  "\n[Judge] Continue — {reason}",
    "discuss.judge_pending":   "\n[{name} suggests converge · {n}/{total} · waiting for others]",
    "discuss.judge_checking":  "\n[Moderator: checking convergence...]",
    "discuss.judge_no":        "[Moderator] Not yet converged — {reason}",
    "discuss.max_rounds":      "\n⚠️  Max rounds reached ({n})",
    "discuss.max_turns":       "\n⚠️  Max turns reached ({n})",
    "discuss.stop_sent":       "\n[Stop signal sent, finishing current step...]",
    "discuss.interjected":     "[Noted, next agent will see your input]",
    "discuss.summarising":     "[{judge}: generating summary...]",

    // ── Broadcast ──
    "broadcast.header":        "\n📨 → {targets}",

    // ── Context ──
    "context.stats":           "Context: {msgs} messages · {chars} chars · ~{tokens} tokens",
    "context.cleared":         "Context cleared",
    "context.saved":           "Saved: {path}",
    "context.loaded":          "Loaded: {msgs} messages",
    "context.not_found":       "No save found",
    "context.empty":           "Context is empty, nothing to export",
    "context.exported":        "Exported: {path}",
    "context.no_conclusion":   "No conclusion yet — run /discuss or /debate first",
    "context.last_header":     "\nLast conclusion:",

    // ── Inject ──
    "inject.done":             "Injected {count} Claude session messages",
    "inject.none":             "No Claude session found in current directory",
    "inject.system_label":     "[Claude Code context]\n{summary}",

    // ── Summary ──
    "summary.saved":           "\n📄 Summary saved: {path}",
    "summary.saved_local":     "📁 Also saved locally: {path}  ← coding agents can read this",
    "summary.md_title":        "# AgentTalk Discussion Summary",
    "summary.md_date":         "**Date:** {date}",
    "summary.md_topic":        "**Topic:** {topic}",
    "summary.md_participants": "**Participants:** {names}",
    "summary.md_user":         "**👤 User**",
    "summary.md_section":      "## Discussion",
    "summary.md_conclusion":   "## Conclusion",

    // ── Input ──
    "input.paste_indicator":   " [Pasted: {lines} lines, {chars} chars] ",
    "input.paste_hint":        " · Esc to cancel",
    "input.ctrlc_hint":        "\nPress Ctrl+C again to exit, or keep typing",
    "input.bye":               "\nBye! 👋",
    "input.stop_signal":       "\n[Ctrl+C] Sending stop signal...",
    "input.prompt":            "You > ",
    "spinner.thinking":        "thinking...",

    // ── History replay ──
    "history.label":           "(history)",

    // ── Errors ──
    "err.discuss_usage":       "Usage: /discuss [@agent...] <topic>",
    "err.debate_usage":        "Usage: /debate [@agent...] <topic>",
    "err.broadcast_usage":     "Usage: /broadcast <message>",
    "err.empty_prompt":        "Please enter a message",
    "err.unknown_cmd":         "Unknown command: {cmd}",
    "err.unknown_cmd_hint":    "Type /help for all commands, or / to browse",
    "err.agent_not_found":     'Agent "{key}" not found or not enabled',

    // ── LLM prompts (sent to agents) ──
    "prompt.judge": `You are a discussion judge. Below are responses from multiple AI agents. Determine if the discussion has converged.

Convergence criteria:
- All parties have reached consensus on the core question, or clearly accepted the best answer
- No new substantial disagreements or new information being introduced
- A clear conclusion or recommendation exists

Discussion:
{history}

Reply with ONLY one of:
CONVERGED: [one-sentence summary of consensus]
CONTINUE: [one-sentence description of remaining disagreement]`,

    "prompt.summarise": `The following multi-agent discussion was interrupted before completion. Summarise the current state: what consensus was reached, what remains unresolved, and the most likely conclusion direction. Under 80 words.

{history}`,

    "prompt.discuss_r1": `{history}

You are {name}. Share your view on the topic above with independent judgment, concise and direct (under 200 words). Note: no convergence allowed in round 1 — state your position fully.`,

    "prompt.discuss_rn": `{history}

You are {name}, round {round}. Respond to the other agents' views — what you agree with, what you question, what you'd add. If the core disagreements are resolved and nothing new remains, add [STOP] at the end. Concise (under 150 words).`,

    "prompt.debate_r1_first": `{history}

You are {name}, speaking first. Share your initial view on the topic, concise and direct (under 200 words). Note: no convergence in round 1 — state your full position.`,

    "prompt.debate_r1_mid": `{history}

You are {name} (speaker {pos}/{total}). Build on the previous speaker — add, challenge, or deepen. Note: no convergence in round 1 — state your full position. Concise (under 200 words).`,

    "prompt.debate_rn": `{history}

You are {name} (speaker {pos}/{total}, round {round}). First respond to others' points (agree, question, or add), then judge whether convergence is reached. If the core disagreements are resolved and nothing new remains, add [STOP] at the end. Concise (under 150 words).`,

    // ── Command descriptions (autocomplete) ──
    "cmd.debate":    "multi-round serial debate",
    "cmd.discuss":   "parallel discussion",
    "cmd.broadcast": "parallel broadcast (no discussion)",
    "cmd.context":   "show context stats",
    "cmd.export":    "export as Markdown",
    "cmd.last":      "show last conclusion",
    "cmd.inject":    "inject Claude session",
    "cmd.clear":     "clear context",
    "cmd.save":      "save session",
    "cmd.load":      "load session",
    "cmd.agents":            "manage agents",
    "cmd.agents_moderator":  "set moderator agent",
    "cmd.agents_order":      "set discussion order",
    "cmd.agents_timeout":    "set agent timeout (seconds)",
    "cmd.lang":      "switch language (en/zh)",
    "cmd.help":      "show full help",
    "cmd.quit":      "exit",
    "cmd.send_to":   "send to {name}",
  },

  zh: {
    // ── Session ──
    "session.loaded":          "[续接会话] {msgs} 条消息，约 {tokens} tokens",
    "session.not_found":       "[续接会话] 未找到历史，开始新会话",
    "session.history_footer":  "── 以上为历史记录 · 继续对话即可 ──",
    "session.history_note":    "以上为历史记录，继续对话即可\n",
    "session.claude_injected": "[Claude Session] 注入 {count} 条历史消息",
    "session.claude_none":     "[Claude Session] 未找到当前目录的 claude 会话",

    // ── Banner ──
    "banner.title":            "🤖  AgentTalk  v2.0  ·  {agents}",
    "banner.default_mode":     "默认模式（串行讨论）:",
    "banner.msg_hint":         "  <msg>                  每个 agent 依次发言，后者基于前者",
    "banner.mention_hint":     "  {keys}  定向发送",
    "banner.interject_hint":   "  讨论中直接输入      插入你的观点，下位 agent 可见",
    "banner.more_modes":       "更多模式:",
    "banner.debate_hint":      "  /debate  [@a @b] [--turns N]  <topic>   多轮串行辩论",
    "banner.discuss_hint":     "  /discuss [@a @b] [--rounds N] <topic>   并行讨论",
    "banner.broadcast_hint":   "  /broadcast <msg>     并行广播（不讨论）",
    "banner.stop_header":      "停止讨论:",
    "banner.stop_s":           "  s + 回车    优雅停止（生成摘要）",
    "banner.stop_ctrl":        "  Ctrl+C      立即停止",
    "banner.context_header":   "上下文与导出:",
    "banner.context_hint":     "  /context    查看上下文统计",
    "banner.export_hint":      "  /export [标题]  导出讨论为 Markdown 文件（可附标题）",
    "banner.last_hint":        "  /last       查看上一次讨论结论",
    "banner.inject_hint":      "  /inject     注入当前目录 claude 会话",
    "banner.clear_hint":       "  /clear      清空上下文",
    "banner.save_load_hint":   "  /save /load 手动存档/读档",
    "banner.agents_header":    "Agent 管理:",
    "banner.agents_list":      "  /agents                  列出所有 agents 及状态",
    "banner.agents_enable":    "  /agents enable <key>     启用 agent",
    "banner.agents_disable":   "  /agents disable <key>    禁用 agent",
    "banner.agents_model":     "  /agents model <key> <m>  设置 agent 使用的模型",
    "banner.agents_model_r":   "  /agents model <key>      重置为默认模型",
    "banner.agents_add":       "  /agents add              交互式添加自定义 agent",
    "banner.agents_remove":    "  /agents remove <key>     删除 agent",
    "banner.agents_moderator": "  /agents moderator <key>  设置主持人 agent",
    "banner.agents_order":     "  /agents order <k1> <k2>  设置发言顺序",
    "banner.agents_timeout":   "  /agents timeout [<key>] <s>  设置超时时间（秒，默认: 120s）",
    "banner.config_path":      "  config: {path}",
    "banner.lang_hint":        "  /lang en|zh              切换语言",
    "banner.startup_header":   "启动参数:",
    "banner.flag_c":           "  -c / --continue   续接上次会话",
    "banner.flag_claude":      "  --from-claude     启动时注入 claude 会话",
    "banner.quit_hint":        "  /quit             退出\n",

    // ── Agent management ──
    "agents.list_header":      "\n  Agent 列表:\n",
    "agents.not_installed":    "未安装",
    "agents.enabled":          "已启用",
    "agents.disabled":         "已禁用",
    "agents.active":           " ◀ 运行中",
    "agents.model_tag":        " [model: {model}]",
    "agents.config_path":      "\n  配置文件: {path}\n",
    "agents.restart_required":  "重启 agentalk 后生效",
    "agents.reset_done":        "配置已重置为默认值，重启 agentalk 后生效",
    "agents.not_found":         "未找到 agent: {key}",
    "agents.enabled_ok":        "已启用 {name}",
    "agents.disabled_ok":       "已禁用 {name}",
    "agents.model_set":         "{name} model: {prev} → {next}",
    "agents.key_exists":        'Key "{key}" 已存在，请用不同的 key',
    "agents.added":             "已添加 {name}",
    "agents.removed":           "已删除 {name}",
    "agents.usage":             "用法: /agents [enable|disable|model|moderator|order|add|remove] ...",
    "agents.key_empty":         "key / name / cmd 不能为空",
    "agents.moderator_marker":  " ⚖ 主持人",
    "agents.moderator_current": "主持人: {name}",
    "agents.moderator_auto":    "（自动 — 第一个可用 agent）",
    "agents.order_current":     "当前顺序",
    "agents.order_usage":       "用法: /agents order <key1> <key2> ...",
    "agents.timeout_current":   "全局超时: {s}s  (/agents timeout <N> 修改)",
    "agents.timeout_label":     "⏱ 超时 ({s}s)",

    // ── Wizard prompts ──
    "wizard.key":              "唯一 key（英文，如 mygpt）: ",
    "wizard.name":             "显示名称（如 GPT-4o）: ",
    "wizard.cmd":              "命令（如 mycli）: ",
    "wizard.args":             "参数，用 {prompt} 代表用户输入（如: -p {prompt}）: ",
    "wizard.color":            "颜色 hex（如 #FF6B6B，留空用默认）: ",
    "wizard.output":           "输出格式 text 或 ndjson（留空默认 text）: ",
    "wizard.note":             "备注说明（可选）: ",

    // ── Discussion ──
    "discuss.serial_header":   "\n🎙️  串行讨论 · {agents}",
    "discuss.serial_turns":    " · 最多 {turns} 轮",
    "discuss.parallel_header": "\n💬 并行讨论 · 最多 {rounds} 轮 · 自动收敛",
    "discuss.topic":           "话题: {topic}",
    "discuss.round":           "\n── Round {n} ──",
    "discuss.stopped":         "\n🛑 讨论已停止",
    "discuss.timeout_skip":    "[{name} 超时 ({s}s)，已跳过]",
    "discuss.busy_skip":       "[{name} 服务繁忙，跳过]",
    "discuss.error_skip":      "[{name} 出错，跳过: {msg}]",
    "discuss.all_failed":      "\n所有 agent 均不可用，讨论中止",
    "discuss.converge_all":    "\n✅ 全员同意收敛，生成结论...",
    "discuss.converge_some":   "\n[{n}/{total} 人建议收敛，继续讨论...]",
    "discuss.converged":       "\n✅ 讨论收敛: {summary}",
    "discuss.judge_continue":  "\n[裁判] 继续 — {reason}",
    "discuss.judge_pending":   "\n[{name} 建议收敛 · {n}/{total} 人 · 等待其余人表态]",
    "discuss.judge_checking":  "\n[主持人: 裁定中...]",
    "discuss.judge_no":        "[主持人] 尚未收敛 — {reason}",
    "discuss.max_rounds":      "\n⚠️  达到最大轮数 ({n})",
    "discuss.max_turns":       "\n⚠️  达到最大轮次 ({n})",
    "discuss.stop_sent":       "\n[停止信号已发送，等待当前步骤完成...]",
    "discuss.interjected":     "[已记录，下一位 agent 将看到你的输入]",
    "discuss.summarising":     "[{judge}: 生成摘要中...]",

    // ── Broadcast ──
    "broadcast.header":        "\n📨 → {targets}",

    // ── Context ──
    "context.stats":           "上下文: {msgs} 条消息 · {chars} 字符 · ~{tokens} tokens",
    "context.cleared":         "上下文已清空",
    "context.saved":           "已保存: {path}",
    "context.loaded":          "已加载: {msgs} 条消息",
    "context.not_found":       "未找到存档",
    "context.empty":           "上下文为空，无可导出内容",
    "context.exported":        "已导出: {path}",
    "context.no_conclusion":   "暂无讨论结论，先用 /discuss 或 /debate 进行一次讨论",
    "context.last_header":     "\n上一次讨论结论:",

    // ── Inject ──
    "inject.done":             "注入 {count} 条 claude 会话消息",
    "inject.none":             "未找到当前目录的 claude 会话",
    "inject.system_label":     "[来自 Claude Code 的工程上下文]\n{summary}",

    // ── Summary ──
    "summary.saved":           "\n📄 摘要已保存: {path}",
    "summary.saved_local":     "📁 已保存至项目目录: {path}  ← coding agent 可直接读取",
    "summary.md_title":        "# AgentTalk 讨论摘要",
    "summary.md_date":         "**时间:** {date}",
    "summary.md_topic":        "**话题:** {topic}",
    "summary.md_participants": "**参与者:** {names}",
    "summary.md_user":         "**👤 用户**",
    "summary.md_section":      "## 讨论过程",
    "summary.md_conclusion":   "## 结论",

    // ── Input ──
    "input.paste_indicator":   " [已粘贴: {lines} 行, {chars} 字符] ",
    "input.paste_hint":        " · Esc 取消",
    "input.ctrlc_hint":        "\n再按一次 Ctrl+C 退出，或继续输入",
    "input.bye":               "\nBye! 👋",
    "input.stop_signal":       "\n[Ctrl+C] 发送停止信号...",
    "input.prompt":            "You > ",
    "spinner.thinking":        "思考中...",

    // ── History replay ──
    "history.label":           "(历史)",

    // ── Errors ──
    "err.discuss_usage":       "用法: /discuss [@agent...] <话题>",
    "err.debate_usage":        "用法: /debate [@agent...] <话题>",
    "err.broadcast_usage":     "用法: /broadcast <消息>",
    "err.empty_prompt":        "请输入消息内容",
    "err.unknown_cmd":         "未知命令: {cmd}",
    "err.unknown_cmd_hint":    "输入 /help 查看所有命令，或输入 / 快速浏览",
    "err.agent_not_found":     'Agent "{key}" not found or not enabled',

    // ── LLM prompts ──
    "prompt.judge": `你是一个讨论裁判。以下是多个 AI Agent 的讨论记录，判断讨论是否已经收敛。

收敛的标准：
- 各方在核心观点上已经达成共识，或者明确接受了某个最优答案
- 不再有新的实质性分歧或新信息被引入
- 已经有清晰的结论或建议

讨论记录：
{history}

请只回复以下两种之一：
CONVERGED: [一句话总结共识]
CONTINUE: [一句话说明还有什么分歧]`,

    "prompt.summarise": `以下是一场多 Agent 讨论，因用户中断而提前结束。请总结目前的讨论进度：已达成的共识、尚未解决的分歧，以及最可能的结论方向。100字以内。

{history}`,

    "prompt.discuss_r1": `{history}

你是 {name}。请就以上话题发表你的观点，要有自己的独立判断，简洁有力（200字以内）。注意：第一轮不允许收敛，请充分表达你的独立见解。`,

    "prompt.discuss_rn": `{history}

你是 {name}，这是第 {round} 轮讨论。请先回应其他 Agent 的观点：认同哪些、质疑哪些、补充什么。如果你认为核心分歧已解决且无新信息可补充，回复末尾加 [STOP]。简洁（150字以内）。`,

    "prompt.debate_r1_first": `{history}

你是 {name}，作为第一个发言者。请就话题发表你的初始观点，简洁有力（200字以内）。注意：第一轮不允许收敛，请充分表达你的独立见解。`,

    "prompt.debate_r1_mid": `{history}

你是 {name}（第 {pos}/{total} 位发言）。请接着前面的发言，推进讨论：可以补充、反驳、或深化。注意：第一轮不允许收敛，请充分表达你的独立见解。简洁（200字以内）。`,

    "prompt.debate_rn": `{history}

你是 {name}（第 {pos}/{total} 位发言，第 {round} 轮）。请先回应其他人的观点（认同、质疑或补充），再判断是否已收敛。如果你认为核心分歧已解决且无新信息可补充，回复末尾加 [STOP]。简洁（150字以内）。`,

    // ── Command descriptions (autocomplete) ──
    "cmd.debate":              "多轮串行辩论",
    "cmd.discuss":             "并行讨论",
    "cmd.broadcast":           "并行广播（不讨论）",
    "cmd.context":             "查看上下文统计",
    "cmd.export":              "导出为 Markdown",
    "cmd.last":                "查看上次结论",
    "cmd.inject":              "注入 Claude 会话",
    "cmd.clear":               "清空上下文",
    "cmd.save":                "保存会话",
    "cmd.load":                "加载会话",
    "cmd.agents":              "管理 agents",
    "cmd.agents_moderator":    "设置主持人 agent",
    "cmd.agents_order":        "设置发言顺序",
    "cmd.agents_timeout":      "设置超时时间（秒）",
    "cmd.lang":                "切换语言 (en/zh)",
    "cmd.help":                "完整帮助",
    "cmd.quit":                "退出",
    "cmd.send_to":             "发送给 {name}",
  },
};
