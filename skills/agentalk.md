---
name: agentalk
description: Read AgentTalk multi-agent discussion results for the current project. Use when the user asks about agentalk discussion outcomes, debate conclusions, agent panel decisions, or what the agents decided. Also use when the user asks "what did we discuss", "what was the conclusion", or references a past panel discussion.
user-invocable: true
allowed-tools:
  - Bash
  - Read
---

# AgentTalk Discussion Reader

AgentTalk is a terminal multi-agent collaboration platform. It runs Codex, Gemini, GLM, and Claude in parallel to discuss topics and converge on conclusions. Each project's full discussion history is saved locally and can be recalled here.

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

If not found, list all available sessions so the user can pick one:
```bash
ls ~/.agentalk/sessions/ 2>/dev/null || echo "No sessions yet"
```

If the user asks about a different project, derive that project's key from its path the same way.

If no sessions exist at all, tell the user they can start one by running `agentalk` in the project directory.

### Step 3 — Read and parse

Read the JSON file. Structure:

```json
{
  "cwd": "/path/to/project",
  "messages": [
    { "role": "user",    "content": "...", "timestamp": 1234567890 },
    { "role": "claude",  "content": "...", "timestamp": 1234567890 },
    { "role": "codex",   "content": "...", "timestamp": 1234567890 },
    { "role": "gemini",  "content": "...", "timestamp": 1234567890 },
    { "role": "opencode","content": "...", "timestamp": 1234567890 },
    { "role": "system",  "content": "[辩论结论] ...", "timestamp": 1234567890 }
  ]
}
```

**Key message types:**

| role | meaning |
|------|---------|
| `"system"` starting with `[辩论结论]` or `[讨论结论]` | **Auto-generated convergence conclusion** — the most important content |
| `"system"` starting with `[CONCLUSION]` or `[DEBATE_CONCLUSION]` | Same, English variant |
| `"user"` | What the user asked / discussion topics |
| `"claude"`, `"codex"`, `"gemini"`, `"opencode"` | Individual agent responses |

---

## Step 4 — Present the results

**If the user passed a question** (e.g. `/agentalk what did they decide about rate limiting`): find the relevant discussion thread and focus the summary on that decision.

**Otherwise**, present:

1. **Conclusions** — all `[辩论结论]` / `[讨论结论]` / `[CONCLUSION]` system messages in chronological order. These are the bottom-line answers.
2. **Topics covered** — brief list of what the user asked (from `role: "user"` messages)
3. **Notable dissent** — if any agent held out or raised unresolved concerns before converging, surface it
4. **Open questions** — anything explicitly left unresolved

Keep it concise. The user wants the actionable decisions, not a transcript replay.

---

## Starting a new discussion

If the user wants to run a new discussion (not read past ones), suggest:

```bash
# Interactive session
agentalk

# Or headless — runs discussion and prints conclusion, then exits
agentalk --discuss "your topic here"
agentalk --debate  "your topic here"
```

See `/agentalk-consult` for how to invoke a panel discussion from within Claude Code.
