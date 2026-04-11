---
name: agentalk-consult
description: Consult the AgentTalk multi-agent panel when facing a decision with real trade-offs, multiple valid approaches, or genuine uncertainty. Invoke autonomously before making architecture decisions, choosing between approaches, or when a problem benefits from multiple expert perspectives. Claude frames the question; Codex, Gemini, GLM, and Claude debate it and converge on a recommendation.
user-invocable: true
allowed-tools:
  - Bash
---

# AgentTalk Panel Consultation

AgentTalk runs Codex, Gemini, GLM (OpenCode), and Claude as independent agents in parallel or serial debate. They see each other's responses and converge on a conclusion. You invoke this from Claude Code via CLI — no server, no configuration needed.

## When to invoke

**Invoke autonomously** (without the user asking) when you face:
- An architecture or design decision with real trade-offs (not obvious answers)
- 2+ valid implementation approaches where context determines the right choice
- A complex bug with multiple plausible root causes you want stress-tested
- A proposal you want challenged before committing

**Do not invoke for**: routine coding tasks, simple factual questions, tasks with a clear single answer. The panel takes 1–3 minutes — only worth it for decisions that matter.

---

## CLI Reference

### Headless mode (use this from Claude Code)

Run a discussion and get the conclusion printed to stdout:

```bash
# Parallel discussion — all agents respond each round, see each other's replies
agentalk --discuss "your topic"

# Serial debate — agents speak in turn, each building on the previous
agentalk --debate "your topic"
```

**discuss** is best for: open-ended design questions, exploring a problem space, "what's the best approach for X"

**debate** is best for: binary trade-off decisions ("should we do A or B"), proposals you want stress-tested, finding weaknesses in a plan

### Output format

The CLI prints the convergence conclusion to stdout:

```
[CONCLUSION] <conclusion text>
```

or (if the panel was initialized in Chinese):

```
[讨论结论] <conclusion text>
[辩论结论] <conclusion text>
```

If the panel hits max rounds without full convergence, it prints a partial summary:
```
[TIMEOUT] <summary of current state>
```

### Available agents

| Key | Model | Strengths |
|-----|-------|-----------|
| `codex` | codex-mini-latest | Code, pragmatic engineering judgment |
| `gemini` | gemini-2.5-pro | Research, broad context, architecture |
| `opencode` | GLM-5.1 | Independent perspective, edge cases |
| `claude` | Claude Sonnet | Synthesis, nuance, risk identification |

All four participate by default. This is usually what you want.

---

## How to frame a good topic

Include in your topic string:
1. **The goal** — what the user is trying to accomplish
2. **The decision** — the specific choice or uncertainty to resolve
3. **Constraints** — tech stack, performance needs, existing patterns, team size
4. **What you've considered** — approaches already explored or ruled out

**Weak topic:**
> "Should we use Redis?"

**Strong topic:**
> "We're adding rate limiting to a Node.js Express API that currently runs as a single process but may scale horizontally. Options: (1) in-process token bucket using a Map — zero deps, fails under multi-instance; (2) Redis sliding window — reliable under scale, adds infra dependency. Which fits better for an early-stage product, and what are the key implementation gotchas?"

---

## After getting the conclusion

Tell the user:
1. That you consulted the panel (and briefly why — "this had real trade-offs")
2. The conclusion in 1–3 sentences
3. How you're applying it to their task

Example:
> "I consulted the AgentTalk panel on the rate limiting approach. Consensus: start with in-process token bucket, add a Redis flag from day one so migration is a config change not a rewrite. Applying that now — here's the implementation..."

If `agentalk` is not found:
```bash
which agentalk || echo "not found"
```
If missing, tell the user: `npm install -g agentalk` or run `npm link` from the agentalk project directory.

---

## Interactive mode (reference — for when the user wants to run agentalk themselves)

The user can also run `agentalk` directly for a full interactive session:

```bash
agentalk                    # start fresh
agentalk -c                 # resume last session
agentalk --from-claude      # Claude briefs the panel on first question
```

Inside the interactive REPL:

```
<message>                          → moderator picks format and runs discussion
@codex / @gemini / @opencode / @claude  → direct message, skip moderator
/discuss [@agent] [--rounds N] <topic>  → explicit parallel discussion
/debate  [@agent] [--turns N]  <topic>  → explicit serial debate
/broadcast <msg>                   → send to all, no discussion
s + Enter                          → graceful stop (generates summary)
Ctrl+C                             → immediate stop
/export [title]                    → export session as Markdown
/last                              → show last conclusion
/context                           → show context stats
/agents                            → list agents and status
```
