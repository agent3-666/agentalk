---
name: agentalk
description: Launch AgenTalk multi-agent discussions and read past AgenTalk conclusions for the current project. Use when facing genuine uncertainty, trade-offs, architecture decisions, proposal stress-tests, complex root-cause analysis, brainstorming needs, debate choices, or when the user asks about prior discussion outcomes, panel decisions, brainstorm results, conclusions, or what the agents decided. Also check inbox for cross-session messages on startup.
user-invocable: true
allowed-tools:
  - Bash
  - Read
---

# AgenTalk

## Inbox Check (run first)

Before doing anything else, check for cross-session messages:

```bash
agentalk-inbox list
```

If there are unread messages:
1. Show them to the user: who sent them, when, and what they say
2. Tell the user: "I see N message(s) in the inbox. Here's what they say: ..."
3. Ask if they want to act on any of them before continuing

If there are no unread messages, proceed silently — do not mention the inbox.

AgenTalk is a terminal multi-agent collaboration platform. It runs Claude Code, Codex, Gemini, OpenCode, and configured API model agents in structured discussions, debates, panels, brainstorms, challenges, and depth-first analysis, then saves conclusions and history locally.

## Use Cases

Use AgenTalk when:

- A decision has real trade-offs or architectural consequences.
- A proposal needs adversarial stress-testing.
- A complex bug has multiple plausible root causes.
- You need divergent ideas before narrowing options.
- The user asks what was discussed, concluded, decided, or debated previously.

Do not invoke it for routine coding tasks, simple factual questions, or decisions with an obvious single answer. The panel takes 1–3 minutes — only worth it for decisions that matter.

---

## Launching A New Discussion

Headless CLI usage:

```bash
agentalk --discuss    "your topic"   # parallel multi-round discussion
agentalk --debate     "your topic"   # serial debate, good for A vs B choices
agentalk --panel      "your topic"   # blind opening round, then debate
agentalk --brainstorm "your topic"   # divergent ideas, no convergence pressure
agentalk --challenge  "your topic"   # adversarial flaw-finding
agentalk --deepen     "your topic"   # depth-first root cause analysis
agentalk --deepen --stdin < prompt.txt
agentalk --challenge --file prompt.txt
```

Add `--verbose` to stream all agent output in real time:

```bash
agentalk --panel "your topic" --verbose
```

Do not run `cat prompt.txt | agentalk`. Piped multi-line input is not an interactive transcript and must not be used to drive REPL commands. Use `--stdin` / `--file` for long discussion topics.

Do not use `agentalk` for implementation sub-tasks such as "ask Gemini to fix this test" or "ask Codex to edit these files". Use `agentalk-delegate` for that class of work.

### Choosing the right mode

| Situation | Best mode |
|---|---|
| Architecture decision with trade-offs | `--panel` or `--discuss` |
| Stress-test an existing proposal | `--challenge` |
| Complex bug or root-cause investigation | `--deepen` |
| Explore many possible approaches | `--brainstorm` |
| Binary choice between options | `--debate` |
| Open-ended multi-agent exploration | `--discuss` |

### Framing a good topic

Include: (1) the goal, (2) the specific decision or uncertainty, (3) constraints such as stack/performance/timeline, (4) approaches already considered or ruled out.

**Weak:** `"Should we use Redis?"`

**Strong:** `"Adding rate limiting to a Node.js Express API that runs as a single process today but may scale horizontally. Options: (1) in-process token bucket, zero deps but breaks under multi-instance; (2) Redis sliding window, reliable but adds infra. Which fits better for an early-stage product, and what are the key gotchas?"`

### CLI output format

```text
[CONCLUSION] <conclusion text>
[SUMMARY] /path/to/summary.md
```

Chinese variants: `[讨论结论]` / `[辩论结论]`. If max rounds hit: `[TIMEOUT] <summary>`.

Always read the `[SUMMARY]` file — the one-line conclusion is just the headline; the transcript contains reasoning, disagreements, and token usage.

---

## Reading Past Session History

AgenTalk saves each project's history to `~/.agentalk/sessions/{key}.json` where `{key}` is the project's absolute path with the leading `/` removed and every `/` replaced by `-`.

Find the current project session:

```bash
echo ~/.agentalk/sessions/$(pwd | sed 's|^/||; s|/|-|g').json
```

Check if it exists:

```bash
ls ~/.agentalk/sessions/$(pwd | sed 's|^/||; s|/|-|g').json 2>/dev/null || echo "NOT FOUND"
```

If not found, list all available sessions:

```bash
ls ~/.agentalk/sessions/ 2>/dev/null || echo "No sessions yet"
```

If no sessions exist, tell the user to run `agentalk` in the project directory to start one.

### Session JSON structure

```json
{
  "cwd": "/path/to/project",
  "messages": [
    { "role": "user",     "content": "...", "timestamp": 1234567890 },
    { "role": "claude",   "content": "...", "timestamp": 1234567890 },
    { "role": "system",   "content": "[CONCLUSION] ...", "timestamp": 1234567890 },
    { "role": "system",   "content": "[TOKEN_USAGE] {...}", "timestamp": 1234567890 }
  ]
}
```

| role | content prefix | meaning |
|---|---|---|
| `system` | `[CONCLUSION]`, `[DEBATE_CONCLUSION]`, `[讨论结论]`, `[辩论结论]` | Auto-generated convergence conclusion |
| `system` | `[TOKEN_USAGE]` | Per-agent token usage (JSON) |
| `user` | — | User prompt or discussion topic |
| `claude`, `codex`, `gemini`, etc. | — | Individual agent responses |

Token usage: `estimated: true` = character-based estimate; `estimated: false` = real API count.

### Presenting past results

If the user asks a specific question, find the relevant thread and focus on that decision. Otherwise summarize: conclusions in order, discussion types used, topics covered, notable dissent, token cost, open questions. Keep it concise — actionable decisions over transcript replay.

---

## Availability Check

```bash
which agentalk || echo "not found"
```

If missing: `npm install -g agentalk` or `npm link` from the AgenTalk project directory.

---

## Interactive Mode (reference)

```bash
agentalk               # start fresh
agentalk -c            # resume last session
agentalk --from-claude # Claude briefs the panel on first question
```

Inside the REPL:

```text
<message>                            → moderator picks format and runs discussion
@claude @codex <msg>                 → direct message, skip moderator
/discuss [@agent] [--rounds N] <topic>
/debate  [@agent] [--turns N]  <topic>
/panel   [@agent]              <topic>
/brainstorm                    <topic>
/challenge                     <topic>
/deepen                        <topic>
/broadcast <msg>                     → send to all, no discussion structure
s + Enter                            → graceful stop (generates summary)
Ctrl+C                               → immediate stop
/last                                → show last conclusion
/context                             → show context stats
/agents                              → list agents and status
```
