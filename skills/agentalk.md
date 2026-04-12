---
name: agentalk
description: Read AgentTalk multi-agent discussion results for the current project. Use when the user asks about agentalk discussion outcomes, debate conclusions, panel decisions, brainstorm results, or what the agents decided. Also use when the user asks "what did we discuss", "what was the conclusion", or references a past panel discussion.
user-invocable: true
allowed-tools:
  - Bash
  - Read
---

# AgentTalk Discussion Reader

AgentTalk is a terminal multi-agent collaboration platform. It runs Claude Code, Codex, Gemini, OpenCode, and API model agents in parallel discussions and serial debates, converging on conclusions. Each project's full history is saved locally.

## Usage

```
/agentalk                          # summarize all conclusions for this project
/agentalk <question>               # focus on a specific topic or decision
```

---

## How to retrieve the session

### Step 1 — Find the session file path

AgentTalk saves sessions to `~/.agentalk/sessions/{key}.json` where `{key}` is the project's absolute path with every `/` replaced by `-`, leading `-` removed.

```bash
echo ~/.agentalk/sessions/$(pwd | sed 's|^/||; s|/|-|g').json
```

### Step 2 — Check if it exists

```bash
ls ~/.agentalk/sessions/$(pwd | sed 's|^/||; s|/|-|g').json 2>/dev/null \
  || echo "NOT FOUND"
```

If not found, list all available sessions:
```bash
ls ~/.agentalk/sessions/ 2>/dev/null || echo "No sessions yet"
```

If no sessions exist, tell the user: run `agentalk` in the project directory to start one.

### Step 3 — Read and parse

Read the JSON file. Structure:

```json
{
  "cwd": "/path/to/project",
  "messages": [
    { "role": "user",     "content": "...", "timestamp": 1234567890 },
    { "role": "claude",   "content": "...", "timestamp": 1234567890 },
    { "role": "codex",    "content": "...", "timestamp": 1234567890 },
    { "role": "gemini",   "content": "...", "timestamp": 1234567890 },
    { "role": "opencode", "content": "...", "timestamp": 1234567890 },
    { "role": "system",   "content": "[CONCLUSION] ...", "timestamp": 1234567890 },
    { "role": "system",   "content": "[TOKEN_USAGE] {...}", "timestamp": 1234567890 }
  ]
}
```

**Key message types:**

| role | content prefix | meaning |
|------|---------------|---------|
| `"system"` | `[CONCLUSION]` or `[DEBATE_CONCLUSION]` | **Auto-generated convergence conclusion** — most important |
| `"system"` | `[讨论结论]` or `[辩论结论]` | Same, Chinese variant |
| `"system"` | `[TOKEN_USAGE]` | Per-agent token usage for that discussion (JSON) |
| `"user"` | — | What the user asked / discussion topics |
| `"claude"`, `"codex"`, etc. | — | Individual agent responses |

**Token usage format** (parse if present):
```json
{
  "agents": {
    "claude": { "total": 4120, "prompt": 2800, "completion": 1320, "estimated": false },
    "codex":  { "total": 2340, "estimated": true }
  },
  "total": 6460
}
```
`estimated: true` means character-based estimate (CLI agents); `false` means real API count.

---

## Step 4 — Present the results

**If the user passed a question**: find the relevant discussion thread and focus the summary on that decision.

**Otherwise**, present:

1. **Conclusions** — all conclusion system messages in chronological order. These are the bottom-line answers.
2. **Discussion types used** — which modes ran (discuss / debate / panel / brainstorm / challenge / deepen)
3. **Topics covered** — brief list of what the user asked (from `role: "user"` messages)
4. **Notable dissent** — if any agent held out or raised unresolved concerns before converging
5. **Token cost** — summarize from `[TOKEN_USAGE]` messages if present (useful for cost awareness)
6. **Open questions** — anything explicitly left unresolved

Keep it concise. The user wants actionable decisions, not a transcript replay.

---

## Starting a new discussion

If the user wants to run a new discussion, suggest:

```bash
# Interactive — moderator picks the right discussion format automatically
agentalk

# Headless — runs discussion and prints conclusion, then exits
agentalk --discuss    "your topic"   # parallel multi-round
agentalk --debate     "your topic"   # serial debate
agentalk --panel      "your topic"   # blind opening + serial debate
agentalk --brainstorm "your topic"   # divergent, maximize unique perspectives
agentalk --challenge  "your topic"   # adversarial, find flaws
agentalk --deepen     "your topic"   # depth-first root cause analysis

# Add --verbose to stream all agent output in real time
agentalk --discuss "topic" --verbose
```

See `/agentalk-consult` for how Claude Code can autonomously invoke the panel as a decision committee during complex tasks.
