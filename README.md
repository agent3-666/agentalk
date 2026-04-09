# AgentTalk

A unified terminal interface to chat with **Claude Code**, **Codex CLI**, **Gemini CLI**, and **OpenCode** simultaneously — with shared context, multi-round discussions, and auto-convergence.

## Features

- **Broadcast** — send a message to all agents at once
- **@mention routing** — `@claude`, `@codex`, `@gemini`, `@opencode` to target specific agents
- **`/discuss`** — parallel discussion: all agents respond each round, auto-detects convergence
- **`/debate`** — serial debate: agents take turns in order (Codex → Gemini → OpenCode → Claude), like a real discussion
- **Shared context** — all agents see the same conversation history (up to 512k tokens, auto-compressed)
- **Claude session injection** — import your current Claude Code working session as context
- **Persistent sessions** — save and resume conversations per directory with `-c`
- **Smart stopping** — agents vote `[STOP]`, requires full consensus + judge approval to end

## Requirements

All four CLIs must be installed and authenticated:

```bash
claude    # Claude Code
codex     # OpenAI Codex CLI
gemini    # Google Gemini CLI
opencode  # OpenCode CLI
```

## Install

```bash
git clone https://github.com/agent3-666/agentalk.git
cd agentalk
npm install
npm link        # makes `agentalk` available globally
```

## Usage

```bash
agentalk                   # start interactive REPL
agentalk -c                # continue last session (per directory)
agentalk --from-claude     # inject current Claude Code session as context
```

### In the REPL

```
# Send to all agents
What's the best way to structure a RAG pipeline?

# Send to specific agents
@claude explain this architecture
@codex @gemini review this code

# Parallel discussion — all agents respond each round
/discuss Should we use microservices or monolith?
/discuss --rounds 5 Is TypeScript worth it for small projects?

# Serial debate — agents take turns in order, building on each other
/debate What's the best approach for memory management in AI agents?
/debate --turns 8 Functional vs OOP in the AI era?

# Context management
/context        show token usage
/inject         inject Claude Code session from current directory
/clear          clear shared context
/save           save session to disk
/load           load session from disk

# Stop a running discussion
s + Enter       graceful stop (generates summary)
Ctrl+C          immediate stop
```

### Stopping discussions

Agents can self-terminate by writing `[STOP]` in their response:
- **`/discuss`**: requires **all agents** to write `[STOP]` in the same round
- **`/debate`**: requires **all agents** to have written `[STOP]` at least once → judge confirms convergence

## How it works

Each CLI is called in non-interactive (print) mode:
- `claude -p "..."`
- `codex exec "..."`
- `gemini -p "..."`
- `opencode run "..." --format json`

AgentTalk manages a shared `messages[]` context that gets prepended to every prompt. This means all agents share the same conversation history regardless of their own session state.

Sessions are saved to `~/.agentalk/sessions/` per directory, and Claude Code sessions are read from `~/.claude/projects/`.

## License

MIT
