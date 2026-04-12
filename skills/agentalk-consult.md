---
name: agentalk-consult
description: Consult the AgentTalk multi-agent committee when you face genuine uncertainty, real trade-offs, or a decision that benefits from multiple expert perspectives. Invoke autonomously before committing to an architecture, choosing between approaches, stress-testing a proposal, or drilling into a complex root cause. Claude frames the question; the panel debates and converges on a recommendation.
user-invocable: true
allowed-tools:
  - Bash
---

# AgentTalk Committee Consultation

AgentTalk assembles a panel of AI agents (Claude Code, Codex, Gemini, OpenCode, and any API models you've added) to debate a topic and converge on a recommendation. Think of it as calling a committee meeting — useful when you're not sure which path is right, or when the cost of a wrong decision is high.

You invoke this from Claude Code via CLI — no server, no configuration needed.

---

## When to invoke autonomously

Call the panel **without waiting for the user to ask** when you face:

| Situation | Best mode |
|-----------|-----------|
| Architecture decision with real trade-offs | `--panel` or `--discuss` |
| Proposal you want stress-tested for flaws | `--challenge` |
| Complex bug with multiple plausible root causes | `--deepen` |
| Want to explore all possible approaches before deciding | `--brainstorm` |
| Binary choice between two options | `--debate` |
| Open design exploration, parallel perspectives | `--discuss` |

**Do not invoke for**: routine coding tasks, simple factual questions, tasks with a clear single answer. The panel takes 1–3 minutes — only worth it for decisions that matter.

---

## CLI Reference (headless — use from Claude Code)

```bash
# Parallel rounds — all agents respond each round, see each other's replies
agentalk --discuss    "your topic"

# Serial debate — agents speak in turn, each building on previous
agentalk --debate     "your topic"

# Blind opening round → serial debate (best for unanchored opinions)
agentalk --panel      "your topic"

# Divergent parallel — agents maximize unique perspectives, no convergence pressure
agentalk --brainstorm "your topic"

# Adversarial serial — agents find flaws others missed (red-team)
agentalk --challenge  "your topic"

# Depth-first serial — each agent drills one layer deeper than the last
agentalk --deepen     "your topic"

# Stream all agent output in real time (add to any mode)
agentalk --discuss "your topic" --verbose
```

### Output format

The CLI prints the convergence conclusion to stdout:

```
[CONCLUSION] <conclusion text>
```

or Chinese variants:
```
[讨论结论] <conclusion text>
[辩论结论] <conclusion text>
```

If max rounds hit without convergence:
```
[TIMEOUT] <summary of current state>
```

---

## Choosing the right mode

**`--panel`** — Best default for architecture decisions. Agents state their position independently first (no anchoring bias), then debate. Guarantees at least 1 full debate cycle.

**`--challenge`** — Best for proposals you've already formed. Frame it as "here's my plan, find the flaws." Agents serially find issues the previous agent missed. Adversarial by design.

**`--deepen`** — Best for "why is X happening?" or root cause analysis. Each agent takes the previous agent's conclusion one layer deeper. Good for performance issues, mysterious bugs, cascading failures.

**`--brainstorm`** — Best when you don't know what you don't know. Divergent — agents explicitly told to NOT converge, maximize unique angles. Use this before narrowing down options.

**`--debate`** — Best for binary decisions. "Should we do A or B?" Agents take turns arguing, convergence happens when they agree.

**`--discuss`** — Default for open-ended exploration. Parallel rounds where all agents respond to each other simultaneously.

---

## How to frame a good topic

Include:
1. **The goal** — what the user is trying to accomplish
2. **The decision** — the specific choice or uncertainty to resolve
3. **Constraints** — tech stack, performance needs, existing patterns
4. **What you've considered** — approaches already explored or ruled out

**Weak:**
> "Should we use Redis?"

**Strong:**
> "Adding rate limiting to a Node.js Express API that runs as a single process today but may scale horizontally. Options: (1) in-process token bucket — zero deps, breaks under multi-instance; (2) Redis sliding window — reliable, adds infra dependency. Which fits better for an early-stage product, and what are the key gotchas?"

---

## After getting the conclusion

Tell the user:
1. That you consulted the panel (and briefly why — "this had real trade-offs between X and Y")
2. The conclusion in 1–3 sentences
3. How you're applying it

Example:
> "I consulted the AgentTalk panel on the rate limiting approach. Consensus: start with in-process token bucket, add a Redis flag from day one so migration is a config change not a rewrite. Applying that now..."

---

## Check agentalk is available

```bash
which agentalk || echo "not found"
```

If missing: `npm install -g agentalk` or `npm link` from the agentalk project directory.

---

## Interactive mode (reference)

The user can also run `agentalk` directly for a full session:

```bash
agentalk                    # start fresh, moderator picks discussion format
agentalk -c                 # resume last session
agentalk --from-claude      # Claude briefs the panel on first question
```

Inside the REPL:

```
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
