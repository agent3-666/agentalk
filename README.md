# AgentTalk

Two complementary tools for multi-CLI AI collaboration:

- **`agentalk`** — run Claude Code, Codex CLI, Gemini CLI, OpenCode and more as a collaborative panel with shared context, six discussion modes, a moderator, and token tracking
- **`agentalk-delegate`** — separate binary for Skill+CLI sub-task delegation: a main AI agent hands off a single sub-task to another CLI based on capability + observed quota, with structured brief-in/brief-out and persistent task state

The two work independently. Use `agentalk` when you want **multiple agents to talk to each other**; use `agentalk-delegate` when you want your **main agent to quietly route a sub-task** to a specialist CLI.

## Features

### Discussion (`agentalk`)
- **6 discussion modes** — from parallel brainstorming to adversarial review to depth-first drilling (see table below)
- **Moderator-led sessions** — every plain message gets routed through a moderator that selects the right mode, fetches URLs/files mentioned in the topic, synthesizes a briefing, then runs the session
- **API model agents** — plug in any OpenAI-compatible model (OpenRouter, DeepSeek, Groq, etc.) via `/agents add-model`
- **Token usage tracking** — per-agent token counts shown at the end of every discussion; real counts for API agents, estimates for CLI agents
- **Moderator placement** — moderator defaults to the last active agent; new agents auto-insert at second-to-last
- **22-agent registry** — 4 enabled by default (Claude, Codex, Gemini, OpenCode); enable Aider, Ollama, Amazon Q, Goose, SWE-agent and more via `/agents enable`
- **Shared context** — all agents see the same conversation history (up to 512k tokens, auto-compressed via moderator summary)
- **Moderator pre-flight** — detects URLs in your topic, fetches them, reads mentioned files, synthesizes a `[BRIEFING]` injected into context before round 1
- **Headless mode** — all six mode flags run a session and exit; `--verbose` streams output in real time
- **Persistent sessions** — save and resume conversations per directory with `-c`

### Delegation (`agentalk-delegate`)
- **Deterministic supervisor kernel** — code, not an LLM. Owns task lifecycle state, observes quota signals (parses 429/rate-limit/auth from real CLI stderr), executes delegations. Main model is the policy generator; kernel is the mechanism.
- **Brief-in/brief-out protocol** — structured task + files + context + budget → structured findings + artifacts + unknowns + diagnostics
- **Persistent task state** at `~/.agentalk/tasks/{id}.json` — written before delegation executes, so any model can resume if the main agent dies
- **Project-level memory** at `.agentalk/memory.jsonl` (append-only JSONL, survives sessions)
- **Skill+CLI integration** — default path, zero extra setup. The `/agentalk-delegate` Claude Code skill invokes the CLI via Bash; no MCP registration required.

### Integration
- **Claude Code skills** — `/agentalk`, `/agentalk-consult`, `/agentalk-delegate` auto-installed on postinstall (and re-installable via `agentalk-delegate init`)
- **MCP Server (optional, secondary)** — `agentalk-mcp` exposes `ask`, `discuss`, `debate`, `delegate`, `list_quotas`, `list_capabilities`, `remember`, `recall`, `task_status` for MCP-based clients. Most users don't need this; skills use CLI directly.

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
npm link        # makes `agentalk`, `agentalk-mcp`, `agentalk-model`, `agentalk-delegate` available globally
```

The postinstall script automatically installs the three Claude Code skills (`/agentalk`, `/agentalk-consult`, `/agentalk-delegate`) into `~/.claude/skills/`. Run `agentalk-delegate init` at any time to re-install and see setup status.

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

# Cursor (uses your Pro/Business subscription quota)
/agents set-key cursor <your-cursor-api-key>
/agents enable cursor
# Get key from: cursor.com/settings → API Keys
# Switch model: /agents model cursor cursor/gpt-4o
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

# Cursor (API-based, requires Pro/Business subscription)
/agents set-key cursor <your-cursor-api-key>
/agents enable cursor
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

### `/agentalk-delegate` — Main-agent delegation across subscriptions

For users paying for multiple AI subscriptions (Claude Max + Gemini Plus + ChatGPT Pro + GLM Pro...) who want their main agent to distribute sub-tasks across all of them — spreading load, preserving main-model quota, and using all paid plans.

This is a **separate mode** from agentalk discussions. The main agent (e.g. Claude Code) invokes the `agentalk-delegate` CLI via the Bash tool — no MCP registration required. The skill lives at `~/.claude/skills/agentalk-delegate.md` (auto-installed).

```bash
agentalk-delegate <agent> "<task>" \
  --files "path1,path2" \
  --context "background" \
  --output "desired format" \
  --budget "length hint" \
  --timeout 600                              # default 600s; bump for >10-file surveys
  --resume-step <task-id>:<step-id>          # prepend prior stdout as context

agentalk-delegate quotas           # observed quota state (real signals, not predicted)
agentalk-delegate capabilities     # per-agent strengths + cost tier + priority/billing badges
agentalk-delegate remember "fact"  # persist a project-level learning
agentalk-delegate recall           # read back project memory
agentalk-delegate task <id>        # inspect a delegation task
agentalk-delegate tail <id>        # stream task stdout events ([--follow] for live)
agentalk-delegate review           # per-agent performance from delegations.jsonl
agentalk-delegate init             # setup status + next-step hints
```

Output is structured `[MARKER]` lines on stdout so skills/scripts parse deterministically:

```
[STATUS] ok
[AGENT] gemini
[TASK] /Users/.../.agentalk/tasks/t_xxx.json
[TOKENS] 749 (est)
[ELAPSED_MS] 38474
[FINDINGS]
...
[END_FINDINGS]
```

**Architecture**: an external **supervisor** (deterministic code, ~500 LOC in `lib/supervisor.js`) owns task lifecycle state, observes quota signals, and executes delegations. The main model is the policy generator — it decides WHAT to delegate; the supervisor reliably executes and persists state. If the main model hits quota mid-task, task state lives in `~/.agentalk/tasks/{id}.json` so any model can resume.

State layout (mirrors Claude Code's session storage pattern — one JSONL per task, event-stream format):
```
~/.agentalk/
├── tasks/{id}.jsonl      — event stream for one task: task_created, step_added,
│                           stdout chunks, stderr chunks, step_completed.
│                           Append-only. Current state derived by folding events.
│                           One file per task (not per step).
├── quota.json            — observed quota state per agent
├── capability.json       — capability profile per agent (editable — priority/billing/note fields)
└── delegations.jsonl     — append-only log of every delegation (for debug & learning)

{cwd}/.agentalk/
└── memory.jsonl          — project-level facts/decisions (append-only)
```

**Why JSONL event stream instead of separate state/log files**: mirrors Claude Code's `~/.claude/projects/<key>/<session>.jsonl` pattern. Single source of truth, append is atomic per line (no torn-write risk), stdout/stderr chunks are first-class events that enable (1) live `tail --follow`, (2) automatic partial-output preservation on timeout, (3) `--resume-step` session continuity by replaying prior stdout as new-brief context.

Example flow: user asks main agent to review an 80-page design doc. Main agent runs `agentalk-delegate quotas` → sees Gemini available. Runs `agentalk-delegate gemini "summarize 15 key decisions" --files ./doc.md`. Gemini reads the doc with its 2M context, CLI prints `[FINDINGS]`. Main agent synthesizes opinion without burning its own context on the raw document — and tells the user what happened: "I used Gemini to read the spec, saved ~40k tokens of my context."

The same primitives are also exposed as MCP tools in `agentalk-mcp` for MCP-based clients, but the default path is Skill+CLI.

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

Nine tools available:

| Tool | Description |
|------|-------------|
| `ask` | Send a message to one or all agents and get responses |
| `discuss` | Run a parallel multi-round discussion, returns conclusion + transcript |
| `debate` | Run a serial debate, returns conclusion + transcript |
| `delegate` | Main agent delegates a sub-task to another CLI; structured brief-in/out + observed quota |
| `list_quotas` | Observed quota state per agent (available / quota_exceeded / auth_failed / timeout / unknown) |
| `list_capabilities` | Per-agent strengths, context window, cost tier, recommended use cases |
| `remember` | Append a fact/decision/learning to `.agentalk/memory.jsonl` (survives sessions) |
| `recall` | Read recent memory entries for this project |
| `task_status` | Query a delegation task's current state and all step progress |

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
