# AgentTalk

A unified terminal interface to run **Claude Code**, **Codex CLI**, **Gemini CLI**, **OpenCode**, and more as a collaborative agent panel — with shared context, parallel discussions, serial debates, and a moderator that plans, fetches materials, and drives convergence.

## Features

- **Moderator-led sessions** — every plain message gets routed through a moderator that selects the right discussion mode, fetches URLs/files mentioned in the topic, synthesizes a briefing, then runs the session
- **`/discuss`** — parallel discussion: all agents respond each round, auto-detects convergence
- **`/debate`** — serial debate: agents take turns in order, building on each other
- **`/mod`** — explicit moderator-led session (same as plain input)
- **`/broadcast` / `/bc`** — fan out to all agents simultaneously, no moderator
- **@mention routing** — `@claude`, `@codex`, `@gemini` etc. to target specific agents directly
- **Moderator pre-flight** — detects URLs in your topic, fetches them, reads mentioned files, synthesizes a `[BRIEFING]` injected into context before round 1
- **22-agent registry** — 4 enabled by default (Claude, Codex, Gemini, OpenCode); enable Aider, Ollama, Amazon Q, Goose, SWE-agent and more via `/agents enable`
- **Shared context** — all agents see the same conversation history (up to 512k tokens, auto-compressed via moderator summary)
- **Context source** — `/from` sets an agent as a live briefing provider; on `/mod` runs the moderator can pull a project briefing from it on demand
- **Persistent sessions** — save and resume conversations per directory with `-c`
- **Headless mode** — `--discuss` / `--debate` flags run a single session and exit, suitable for scripts and CI
- **MCP Server** — exposes `ask`, `discuss`, `debate` as MCP tools for other AI tools to call
- **Claude Code skill** — `/agentalk` and `/agentalk-consult` skills installed into Claude Code

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
git clone https://github.com/agent3-666/agentalk.git
cd agentalk
npm install
npm link        # makes `agentalk` and `agentalk-mcp` available globally
```

The postinstall script automatically installs the `/agentalk` Claude Code skill.

## Usage

```bash
agentalk                        # start interactive REPL
agentalk -c                     # continue last session (per directory)
agentalk --from-claude          # set Claude Code as context source for this session

# Headless (single-shot, then exit)
agentalk --discuss "topic"      # run a parallel discussion and print conclusion
agentalk --debate  "topic"      # run a serial debate and print conclusion

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

# Parallel discussion — all agents respond each round
/discuss Should we adopt TypeScript?
/discuss @codex @claude --rounds 5 What's the best error handling pattern?

# Serial debate — agents take turns in order
/debate What's the best approach for memory management in AI agents?
/debate --turns 8 Functional vs OOP in the AI era?

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
/agents                         list all agents with status and model
/agents enable  <key>           enable an agent
/agents disable <key>           disable an agent
/agents model   <key> <model>   set model for an agent
/agents moderator               show current moderator
/agents moderator <key>         set moderator (default: first active agent)
/agents order   <k1> <k2> ...   set discussion order
/agents timeout                 show global timeout (seconds)
/agents timeout <s>             set global timeout
/agents timeout <key> [<s>]     set per-agent timeout
/agents add                     add a custom agent (interactive wizard)
/agents remove  <key>           remove a custom agent
/agents reset                   restore factory defaults

# Other
/lang en|zh     switch interface language
/help           full help
/quit           exit
```

### Stopping discussions

Agents self-terminate by writing `[STOP]` in their response:
- **`/discuss`**: requires **all agents** to write `[STOP]` in the same round
- **`/debate`**: requires **all agents** to have written `[STOP]` at least once → moderator confirms convergence at cycle boundary

Press `s + Enter` for a graceful stop that asks the moderator to summarise progress.

## Moderator pre-flight

When a discussion topic contains URLs or file references, the moderator runs a pre-flight phase before round 1:

1. **Plan** — moderator reads the topic and outputs `TYPE:`, `AGENTS:`, `ROUNDS:`, `FETCH:`, `FILES:` lines
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

Or add a completely custom agent:

```bash
/agents add
# walks you through: key, name, cmd, args, color, output format, note
```

Agent args support `{prompt}` and `{model}` placeholders, plus a `model_flag` for automatic model injection.

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

AgentTalk never calls LLM APIs directly. It spawns each agent's CLI in non-interactive (print) mode:

```
claude -p "..."
codex exec --skip-git-repo-check "..."
gemini -p "..."
opencode run "..." --format json
```

A shared `messages[]` context is prepended to every prompt, so all agents share the same conversation history regardless of their own session state.

Sessions are saved to `~/.agentalk/sessions/` keyed by the working directory. Discussion summaries are saved both globally and to `.agentalk/` in the project directory.

## License

MIT
