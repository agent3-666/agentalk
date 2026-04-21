---
name: agentalk-delegate
description: Delegate a sub-task to another AI CLI (Gemini, GLM, Codex, etc.) to save main-model quota and use all subscriptions effectively. Call this autonomously when a sub-task is clearly better-suited to another model (long-doc reading → Gemini 2M context; translation → GLM cheap; etc.) or when you want to preserve your own quota for the harder reasoning. Invoke via MCP tools `delegate`, `list_quotas`, `list_capabilities`, `remember`, `recall`, `task_status`.
user-invocable: true
allowed-tools:
  - mcp__agentalk__delegate
  - mcp__agentalk__list_quotas
  - mcp__agentalk__list_capabilities
  - mcp__agentalk__remember
  - mcp__agentalk__recall
  - mcp__agentalk__task_status
---

# AgentTalk Delegation

You are the **main agent**. A user is paying for multiple AI subscriptions (Claude Max, Gemini Plus, ChatGPT Pro, GLM Pro, etc.) and wants work distributed across them based on capability + remaining quota — so no subscription is wasted and your own quota lasts longer.

An external **supervisor** (deterministic code, not an LLM) owns task state, quota observation, and delegation execution. You drive it via these MCP tools. You are the **policy generator**; the supervisor is the **mechanism**.

---

## When to delegate autonomously

Delegate **without asking the user** when:

| Situation | Best delegate |
|-----------|---------------|
| Reading a long doc / PDF / large codebase slice | **Gemini** (2M context) |
| Translation, bulk low-stakes text work | **OpenCode (GLM)** (cheap) |
| One-shot code generation, shell scripting | **Codex** (fast, code-focused) |
| Complex architecture reasoning | Keep it yourself (you're the main) |
| Heavy multi-file refactor with subtle tradeoffs | Keep it yourself |

**Do NOT delegate**:
- Core reasoning the user came to you for
- Anything tied to the user's current explicit question
- Tasks that require the user-facing conversational state you hold

**DO delegate**:
- Expensive but bounded sub-tasks (reading a 50-page doc, scanning 20 files, bulk translation)
- Tasks where another model is clearly better-suited (long context → Gemini)
- Work you'd otherwise burn quota on

---

## The delegation protocol

### Step 1 — know the landscape

Before delegating, call `list_quotas` and `list_capabilities`:

- `list_quotas` → observed state per agent: `available`, `quota_exceeded`, `auth_failed`, `timeout`, `unknown`
- `list_capabilities` → strengths, context window, cost tier, good_for

Pick an agent whose `status !== "quota_exceeded"` and whose strengths match the task.

### Step 2 — construct the brief

Call `delegate(agent, task, files?, context?, output?, budget?)`:

```
{
  agent: "gemini",
  task: "Extract the 10 core design decisions from the spec",
  files: ["./spec.md", "./architecture.md"],
  context: "We're reviewing an AgentBase proposal to compare with our 2nd Neural project. User wants decisions not implementation detail.",
  output: "Numbered list, each decision in 1-2 sentences",
  budget: "concise, 500 words max"
}
```

**Brief-in rules:**
- `task` — one sentence, imperative
- `files` — point, don't paste. Let the delegate read them with its own context budget.
- `context` — 2-3 lines of what the delegate MUST know. Do not dump your full conversation — that wastes their tokens and yours.
- `output` — specify format if it matters
- `budget` — word/token hint helps the delegate calibrate detail level

### Step 3 — read the structured result

`delegate` returns:

```
{
  status: "ok" | "quota_exceeded" | "auth_failed" | "timeout" | "failed" | "blocked",
  agent: "gemini",
  task_id: "t_...",
  step_id: "s1",
  findings: "...",            // the substantive result — read this carefully
  artifacts: [...],            // files the delegate wrote — stay on disk
  unknowns: [...],             // what the delegate could NOT determine
  diagnostics: {
    outcome: ...,
    detail: ...,               // why it succeeded/failed
    reset_hint: ...,           // when quota resets, if applicable
    suggestion: ...,           // alternative agent to try
    elapsed_ms, tokens
  }
}
```

### Step 4 — act on the result

- `status: ok` → ingest `findings`, continue your work, ignore `artifacts`/`raw_response` unless you need specifics
- `status: quota_exceeded` / `auth_failed` → do NOT silently retry with same agent. Either:
  - Follow `diagnostics.suggestion` and call `delegate` again with a different agent
  - Surface to the user: "Gemini is rate-limited (resets in ~3h). I can use GLM instead, or we can pause."
- `status: timeout` → decide: retry with longer budget? Different agent? Ask user.
- `status: failed` → inspect `diagnostics.detail`, likely need to reframe the task

**Critical**: never pretend a failed delegation succeeded. The supervisor logged everything to `~/.agentalk/delegations.jsonl` — the user can see.

### Step 5 — remember what matters

After a meaningful delegation (not trivial ones), consider calling `remember(fact, context)` to persist:

- Decisions made during the task ("we chose Redis over in-process caching because scale")
- Discovered constraints ("Gemini API returns malformed JSON when response > 100k tokens — chunk requests")
- Capability learnings ("GLM is poor at Typescript generics, use Codex instead next time")

These accumulate in `.agentalk/memory.jsonl` (append-only, survives sessions). Call `recall` at the start of a new session to pick up context.

---

## Multi-step tasks

For work involving multiple delegations that share state, pass `task_id` from the first delegation back into subsequent calls:

```
r1 = delegate({ agent: "gemini", task: "extract decisions from doc" })
r2 = delegate({
  agent: "opencode",
  task: "translate r1's findings to Chinese",
  context: r1.findings,             // or reference r1.task_id's artifacts
  task_id: r1.task_id,               // same task, new step
})
```

Use `task_status(task_id)` to review progress of a multi-step task.

---

## Examples

### Good: long-doc summary to save your own context

User asks you to review a 80-page design doc.

You:
1. `list_capabilities` → Gemini has 2M context, "good_for": ["reading large docs"]
2. `list_quotas` → Gemini `available`
3. `delegate({ agent: "gemini", task: "Summarize this design doc in 15 bullets, highlighting any contradictions or gaps", files: ["./doc.md"], output: "numbered bullets" })`
4. Receive `findings` → synthesize your own opinion → respond to user

You saved 50k+ tokens of your own context. User gets a faster, cheaper answer.

### Good: rate-limit awareness

You try `delegate({ agent: "gemini", ... })` → `status: quota_exceeded`, `diagnostics.reset_hint: "resets in 2h"`, `suggestion: "try one of: opencode, codex"`.

You tell the user: "Gemini is rate-limited for the next 2 hours. I can hand this off to GLM (via OpenCode) — cheaper but smaller context. Want me to chunk the doc and use it, or wait?"

### Bad: delegating the user's actual question

User: "Explain the trade-off between X and Y."

Do NOT delegate this to another agent. The user asked YOU. Answer it yourself.

### Bad: silent fallback

Delegation to Gemini fails → you just retry with Codex and present the result as if nothing happened. The user has no idea their Gemini subscription appears broken.

**Instead**: tell them what happened, what you did about it, and whether action is needed.

---

## Quick reference

| Tool | When |
|------|------|
| `list_quotas` | Before your first delegation of a session |
| `list_capabilities` | When unsure who's best for a task |
| `delegate` | The actual work |
| `task_status` | Checking multi-step progress |
| `remember` | When you learned something non-obvious worth keeping |
| `recall` | Start of a new session on this project |

## Availability check

```bash
which agentalk-mcp || echo "not installed"
```

If missing: `npm install -g agentalk` or `npm link` from the repo.

MCP client configuration:
```json
{ "mcpServers": { "agentalk": { "command": "agentalk-mcp" } } }
```
