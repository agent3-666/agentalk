# AgentTalk

A unified terminal interface to run **Claude Code**, **Codex CLI**, **Gemini CLI**, **OpenCode**, and more as a collaborative agent panel — with shared context, six discussion modes, a moderator that plans and fetches materials, and token usage tracking.

## Features

- **6 discussion modes** — from parallel brainstorming to adversarial review to depth-first drilling (see table below)
- **Moderator-led sessions** — every plain message gets routed through a moderator that selects the right mode, fetches URLs/files mentioned in the topic, synthesizes a briefing, then runs the session
- **API model agents** — plug in any OpenAI-compatible model (OpenRouter, DeepSeek, Groq, etc.) via `/agents add-model`
- **Token usage tracking** — per-agent token counts shown at the end of every discussion; real counts for API agents, estimates for CLI agents
- **Moderator placement** — moderator defaults to the last active agent; new agents auto-insert at second-to-last
- **22-agent registry** — 4 enabled by default (Claude, Codex, Gemini, OpenCode); enable Aider, Ollama, Amazon Q, Goose, SWE-agent and more via `/agents enable`
- **Shared context** — all agents see the same conversation history (up to 512k tokens, auto-compressed via moderator summary)
- **Moderator pre-flight** — detects URLs in your topic, fetches them, reads mentioned files, synthesizes a `[BRIEFING]` injected into context before round 1
- **Headless mode** — all six mode flags run a session and exit; `--verbose` streams output in real time
- **MCP Server** — exposes `ask`, `discuss`, `debate` as MCP tools for other AI tools to call
- **Claude Code skill** — `/agentalk` and `/agentalk-consult` skills installed into Claude Code
- **Persistent sessions** — save and resume conversations per directory with `-c`

## Discussion Modes

| Command | Structure | Best for |
|---------|-----------|----------|
| `/discuss` | Parallel rounds, converge | Multi-perspective exploration |
| `/debate` | Serial turns, converge | Decisions, tradeoffs, structured argument |
| `/panel` | Blind opening round → serial debate | Unanchored deep debate (everyone states position independently first) |
| `/brainstorm` | Parallel rounds, diverge | New directions, possibility enumeration — agents told to maximize unique perspectives |
| `/challenge` | Serial turns, adversarial | Code review, proposal evaluation, red-teaming — agents find flaws others missed |
| `/deepen` | Serial turns, depth-first | Root cause analysis, complex problem decomposition — each agent drills one layer deeper |

All modes support `@mentions` to select participants, `--rounds`/`--turns N`, and headless flags.

## Requirements

- Node.js 18+ (uses native `fetch`)
- At least one CLI installed and authenticated:

```bash
claude    # Claude Code        → claude.ai/code
codex     # OpenAI Codex CLI   → github.com/openai/codex
gemini    # Google Gemini CLI  → github.com/google-gemini/gemini-cli
opencode  # OpenCode CLI       → opencode.ai
```

AgentTalk works with any subset of the above — inactive CLIs are automatically skipped.

## Install

```bash
npm install -g agentalk
```

Or from source:

```bash
git clone https://github.com/agent3-666/agentalk.git
cd agentalk
npm install
npm link        # makes `agentalk`, `agentalk-mcp`, `agentalk-model` available globally
```

The postinstall script automatically installs the `/agentalk` Claude Code skill.

## Usage

```bash
agentalk                        # start interactive REPL
agentalk -c                     # continue last session (per directory)
agentalk --from-claude          # set Claude Code as context source for this session

# Headless (single-shot, then exit)
agentalk --discuss    "topic"   # parallel discussion, prints conclusion
agentalk --debate     "topic"   # serial debate, prints conclusion
agentalk --panel      "topic"   # blind round + serial debate
agentalk --brainstorm "topic"   # divergent parallel rounds
agentalk --challenge  "topic"   # adversarial review
agentalk --deepen     "topic"   # depth-first serial drilling
agentalk --debate     "topic" --verbose   # stream all output in real time

# Pass a one-off message without entering the REPL
agentalk "What's the best caching strategy for this project?"
```

### In the REPL

```
# Plain text → moderator decides discussion mode, fetches materials if needed
Should we use microservices or a monolith?

# @mention → send directly to specific agent(s), skip moderator
@claude explain this architecture
@codex @gemini review this diff

# Discussion modes
/discuss    Should we adopt TypeScript?
/debate     Functional vs OOP in the AI era?
/panel      Should we rewrite the auth layer?
/brainstorm What are all the ways this could fail?
/challenge  Review this architecture proposal
/deepen     Why is our cache hit rate dropping?

# Options
/discuss @codex @claude --rounds 5 What's the best error handling pattern?
/debate  --turns 8 Microservices vs monolith?

# Explicit moderator-led session
/mod Redesign our auth flow — see https://our-spec.com/auth

# Broadcast — no moderator, pure parallel fan-out
/broadcast Summarise the last 3 commits
/bc @claude @gemini What do you think of this design?

# During a running discussion
s + Enter       graceful stop (generates summary)
Ctrl+C          interrupt
/add <info>     inject supplemental info into the next round

# Context management
/context        show token and message count
/from           interactive picker to set context source agent
/from claude    set Claude Code as context source
/from none      clear context source
/export         export session to ~/.agentalk/exports/ as Markdown
/last           show the last conclusion
/clear          clear shared context
/save / /load   persist or restore session

# Agent management
/agents                           list all agents with status and model
/agents enable  <key>             enable an agent
/agents disable <key>             disable an agent
/agents model   <key> <model>     set model for an agent (e.g. claude-opus-4-5)
/agents model   <key>             reset to default model
/agents moderator                 show current moderator
/agents moderator <key>           set moderator (default: last active agent)
/agents order   <k1> <k2> ...     set discussion order
/agents timeout                   show global timeout (seconds)
/agents timeout <s>               set global timeout
/agents timeout <key> [<s>]       set per-agent timeout
/agents add                       add a custom agent (interactive wizard)
/agents add-model <model-id>      register an API model as an agent
/agents set-key  <provider> <key> save an API key for a provider
/agents remove  <key>             remove a custom agent
/agents reset                     restore factory defaults

# Other
/lang en|zh     switch interface language
/help           full help
/quit           exit
```

### Adding API model agents

Any OpenAI-compatible model can be added as an agent:

```bash
# OpenRouter
/agents set-key openrouter sk-or-v1-...
/agents add-model openrouter/qwen/qwen3.6-plus
/agents add-model openrouter/anthropic/claude-opus-4-5

# DeepSeek
/agents set-key deepseek sk-...
/agents add-model deepseek/deepseek-chat

# Groq
/agents set-key groq gsk_...
/agents add-model groq/llama-3.3-70b-versatile
```

New API agents are automatically placed second-to-last so the CLI-based moderator (default: last agent) stays at the end of the debate order.

### Stopping discussions

Agents self-terminate by writing `[STOP]` in their response. The moderator confirms convergence at cycle boundaries. Press `s + Enter` for a graceful stop that asks the moderator to summarise progress.

## Token Usage

After every discussion, AgentTalk prints a per-agent token breakdown:

```
── Token Usage ──
  Codex                 ~2,340   · 3 turns (est.)
  Gemini                ~1,890   · 3 turns (est.)
  Qwen3-Plus  (↑1,890 ↓1,566)    3,456   · 3 turns
  Claude                ~4,120   · 3 turns (est.)
  ──────────────────────────────────────────────
  Total              ~11,806
```

Real token counts (prompt + completion breakdown) are shown for API agents added via `/agents add-model`. CLI agents show character-based estimates marked with `~`. Token data is also included in exported Markdown reports.

## Moderator pre-flight

When a discussion topic contains URLs or file references, the moderator runs a pre-flight phase before round 1:

1. **Plan** — moderator reads the topic and outputs `FORMAT:`, `AGENTS:`, `ROUNDS:`, `FETCH:`, `FILES:` lines
2. **Gather** — AgentTalk fetches each URL (15s timeout, HTML stripped, 20k char cap) and reads each file (50k char cap)
3. **Synthesise** — moderator compresses all gathered content into a `[SOURCES]` / `[KEY FACTS]` / `[DISCUSSION FOCUS]` briefing
4. **Inject** — briefing is added to context as `[BRIEFING]` so all agents see it in round 1

If any fetch fails the discussion proceeds without that material — no crash.

## Extending agents

AgentTalk ships with 22 pre-defined agent slots. Enable any of them:

```bash
/agents enable aider
/agents enable ollama
/agents model ollama llama3.3
/agents enable q           # Amazon Q Developer CLI
/agents enable goose       # Goose (Block)
/agents enable sweagent    # SWE-agent
```

Or add a completely custom agent via the interactive wizard:

```bash
/agents add
# walks you through: key, name, cmd, args, color, output format, note
```

Agent args support `{prompt}` and `{model}` placeholders, plus a `model_flag` for automatic model injection.

## Claude Code Integration

AgentTalk installs two skills into Claude Code automatically on `npm install`:

### `/agentalk` — Read past discussion results

Recall what the panel decided for the current project:

```
/agentalk                          # summarize all conclusions
/agentalk what did we decide about rate limiting
```

### `/agentalk-consult` — Agent-initiated committee consultation

Claude Code can autonomously call the AgentTalk panel mid-task when it faces real uncertainty — without you asking. Think of it as Claude convening a committee before making a consequential decision.

The skill maps uncertainty type to the right discussion mode:

| Situation | Mode used |
|-----------|-----------|
| Architecture decision with trade-offs | `--panel` |
| Proposal you want stress-tested | `--challenge` |
| Complex bug / root cause analysis | `--deepen` |
| Exploring all possible approaches | `--brainstorm` |
| Binary A vs B choice | `--debate` |
| Open design question | `--discuss` |

When invoked, Claude frames the question as a well-scoped topic, runs the appropriate headless mode, then tells you the conclusion and how it's applying it:

> "I consulted the AgentTalk panel on the rate limiting approach. Consensus: start with in-process token bucket, add a Redis flag from day one so migration is a config change not a rewrite. Applying that now..."

The skill installs to `~/.claude/skills/` on postinstall. To reinstall manually:

```bash
node scripts/install-skill.js
```

## MCP Server

AgentTalk exposes itself as an MCP server so other AI tools can run panel discussions:

```bash
agentalk-mcp    # starts the MCP server over stdio
```

Three tools available:

| Tool | Description |
|------|-------------|
| `ask` | Send a message to one or all agents and get responses |
| `discuss` | Run a parallel multi-round discussion, returns conclusion + transcript |
| `debate` | Run a serial debate, returns conclusion + transcript |

Add to your MCP client config:
```json
{
  "mcpServers": {
    "agentalk": {
      "command": "agentalk-mcp"
    }
  }
}
```

## How it works

AgentTalk never calls LLM APIs directly for CLI agents. It spawns each agent's CLI in non-interactive (print) mode:

```
claude -p "..."
codex exec --skip-git-repo-check "..."
gemini -p "..."
opencode run "..." --format json
```

API model agents (`/agents add-model`) are called directly via the OpenAI-compatible `/chat/completions` endpoint — no subprocess needed.

A shared `messages[]` context is prepended to every prompt, so all agents share the same conversation history regardless of their own session state.

Sessions are saved to `~/.agentalk/sessions/` keyed by the working directory. Discussion summaries are saved both globally (`~/.agentalk/summaries/`) and to `.agentalk/` in the project directory (including a `latest.md` and `latest.json` that coding agents can reference).

## License

MIT
