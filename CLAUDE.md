# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Agentalk is a terminal multi-agent collaboration platform. It spawns AI coding assistant CLIs (Claude, Codex, Gemini, OpenCode, etc.) as child processes in non-interactive mode, manages a shared conversation context, and orchestrates parallel discussions and serial debates with automatic convergence detection. It also exposes itself as an MCP Server for other AI tools to call.

## Commands

```bash
npm install          # install dependencies
npm link             # make `agentalk` and `agentalk-mcp` available globally
node index.js        # run CLI directly
node mcp-server.js   # run MCP server directly
```

No build step, no test suite. Pure ESM (`"type": "module"` in package.json).

## Architecture

### Entry Points

- **`index.js`** — CLI entry. Parses args (`-c`, `--from-claude`), initializes ContextManager, starts a readline REPL that routes input through `handleLine()` to commands or broadcast.
- **`mcp-server.js`** — MCP Server entry. Registers 3 tools (`ask`, `discuss`, `debate`) via `@modelcontextprotocol/sdk` over stdio transport.

### Core Modules (`lib/`)

**`config.js`** — Agent registry and configuration persistence at `~/.agentalk/config.json`. Contains `DEFAULT_AGENTS` array (22 agents). `getActiveAgents()` filters to `enabled=true` AND `which cmd` succeeds. OpenCode gets special `detect_name` treatment reading its SQLite DB for the current model name. New default agents auto-merge into existing user config on load without overwriting settings.

**`agents.js`** — Runtime agent objects and the universal `runAgent(key, prompt, {silent})` function. `buildAgents()` creates closures with `buildArgs(prompt)` that handle two model injection patterns: `{model}` placeholder in args, or `[model_flag, model]` prepended. `runAgent()` spawns CLI child processes; supports two output formats:
- `"text"` — plain stdout capture
- `"ndjson"` — line-delimited JSON streaming (for OpenCode), parsing `{"type":"text","part":{"text":"..."}}`

**`context.js`** — `ContextManager` class. Messages: `{role, content, timestamp}`. 512k token limit (~1.5M chars). Auto-compresses by calling Claude to summarize middle messages when limit exceeded (keeps first 2 + last 10). Sessions persisted per cwd in `~/.agentalk/sessions/`. `buildPrompt(agentKey, instruction)` formats full history as `[Speaker]\ncontent` blocks.

**`discuss.js`** — Three collaboration modes:
- `broadcast()` — parallel send to targets, collect all responses
- `discuss()` — parallel rounds, all agents respond simultaneously each round. Convergence: all agents emit `[STOP]` OR Claude-judge rules `CONVERGED` after round ≥ 2
- `debate()` — serial turns, agents speak one at a time in rotation. Convergence: all agents have emitted `[STOP]` at least once + judge confirms at cycle boundary

All three share `makeOutput(capture)` abstraction — `capture=false` prints to terminal, `capture=true` collects lines for MCP responses.

**`session.js`** — Reads Claude Code's JSONL session files from `~/.claude/projects/{cwd-key}/` to import recent conversation context.

### Key Design Pattern

Agentalk never calls LLM APIs directly. It spawns each agent's CLI tool in non-interactive print mode, piping the shared context as a formatted prompt. This means:
- No API key management — each CLI handles its own auth
- Adding a new agent = adding a `{key, cmd, args, color, output}` definition to `DEFAULT_AGENTS`
- The `{prompt}` placeholder in `args` is replaced at call time with the full formatted context + instruction

### Agent Args Template System

Agent args arrays support two substitution patterns:
1. `{prompt}` — replaced with the user's message + context
2. `{model}` — replaced with the agent's configured model (if set)

Plus flag-based injection: if `model_flag` is set (e.g., `"--model"`) and model is configured but `{model}` is not in args, `[model_flag, model]` is prepended to args automatically.

### Stop Signal Flow

`stopSignal` is a shared `{requested: false}` object in `discuss.js`. REPL sends `requestStop()` on `s` keypress or `SIGINT`. Discuss/debate loops check it at each iteration boundary and trigger `gracefulStop()` which calls Claude to summarize current progress.
