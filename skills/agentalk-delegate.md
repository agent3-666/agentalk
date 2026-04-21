---
name: agentalk-delegate
description: Delegate a sub-task to another AI CLI (Gemini, Codex, GLM-via-OpenCode) when you can clearly see that doing so will save main-model context or produce a better result. Invoke autonomously on CONCRETE signals — long-doc reading (>10 pages / >20 files / PDF), bulk translation, one-shot shell/boilerplate code generation, mechanical transformations. Calls via `agentalk-delegate` CLI binary (Bash tool, no MCP setup required). Returns structured [MARKER] output the skill parses into findings + artifacts + diagnostics.
user-invocable: true
allowed-tools:
  - Bash
  - Read
---

# AgentTalk Delegation

You are the **main agent** in a session where the user pays for multiple AI subscriptions (Claude Max, Gemini Plus, ChatGPT Pro, GLM Pro, etc.). Your job is to **notice when a sub-task is better handed off** to another CLI — saving your own context budget and actually using their paid subscriptions.

Delegation happens through the `agentalk-delegate` binary. You invoke it via the **Bash tool**. A deterministic supervisor (code, not an LLM) executes the delegate CLI, observes the outcome, persists task state, and prints structured `[MARKER]` lines you parse.

**No MCP configuration needed.** If `agentalk-delegate` is on PATH, you are ready.

---

## When to delegate — concrete signals (Layer 3)

**Delegate autonomously** when you see ANY of these specific signals in the user's task:

| Signal | Delegate to | Why |
|--------|-------------|-----|
| User wants a summary/review of a document > 10 pages | `gemini` | 2M context, cheap per token on long input |
| Task requires reading > 5 files to answer | `gemini` | saves your context, single-pass read |
| PDF / OCR / image analysis | `gemini` | multimodal, you aren't |
| Translation between human languages (EN↔ZH etc.) | `opencode` | GLM is cheap and strong at Chinese |
| Bulk mechanical transformation (N items → N items) | `opencode` | low cost tier |
| One-shot shell script / scaffolding / `Makefile` / boilerplate | `codex` | code-focused, fast |
| "Generate N fixtures / test data" | `codex` | bounded, structural |
| Scan whole repo for pattern X (grep-level question) | `gemini` | reads files, you don't have to |

**DO NOT delegate** (keep in your own session):

- The user's **core question** to you — answer it yourself
- Anything that needs your ongoing conversational state or prior context
- Complex multi-step architectural reasoning (your strength)
- Work where you're halfway through and have context the delegate can't easily receive
- Tasks under ~2k tokens worth of output — delegation overhead isn't worth it
- Subjective calls that need the user's trust in *your* judgment

**Rule of thumb**: if after delegation you'd still have to read the result carefully and reason over it, delegate saved no context — just do it yourself.

---

## How to delegate

### 1. Scout (once per session, optional)

If unsure who's available / best:

```bash
agentalk-delegate quotas           # who's not rate-limited right now
agentalk-delegate capabilities     # each agent's strengths + cost tier
```

Skip these if you already know from the signals above.

### 2. Delegate

```bash
agentalk-delegate <agent> "<task>" \
  --files "path1,path2" \
  --context "2-3 lines of background the delegate needs" \
  --output "format or focus" \
  --budget "length hint"
```

**Concrete example**:

```bash
agentalk-delegate gemini "Extract the 10 core design decisions from this spec" \
  --files "./spec.md,./architecture.md" \
  --context "Reviewing an AgentBase proposal against our 2nd Neural project. User wants decisions, not implementation detail." \
  --output "Numbered list, 1-2 sentences per decision" \
  --budget "500 words"
```

### 3. Parse output

The CLI prints structured markers on stdout:

```
[STATUS] ok
[AGENT] gemini
[TASK] /Users/.../.agentalk/tasks/t_xxx.json
[TOKENS] 749 (est)
[ELAPSED_MS] 38474
[FINDINGS]
1. ...
2. ...
[END_FINDINGS]
[UNKNOWNS]
- ...
[END_UNKNOWNS]
```

Parse by reading between `[FINDINGS]` and `[END_FINDINGS]`. For full detail (including the brief and per-step timing) read the `[TASK] <path>` file:

```bash
cat <path-from-TASK-line>
```

### 4. Handle each status

- `[STATUS] ok` → use `[FINDINGS]`, continue
- `[STATUS] quota_exceeded` → read `[DIAGNOSTICS]` for `suggestion` (alternative agent). Either retry with that agent, OR surface to user: "Gemini is rate-limited (resets in ~3h). I can use GLM via OpenCode instead, or we can pause."
- `[STATUS] auth_failed` → surface to user: "This CLI isn't authenticated. Run `<cli> login` first."
- `[STATUS] timeout` → decide: longer budget? different agent? ask user?
- `[STATUS] failed` / `system_error` → read `detail`, reframe the task or fall back to doing it yourself

**Never silently retry a failed delegation with a different agent**. Always either tell the user OR keep the same agent with a different brief. Silent fallback destroys trust.

---

## Visible value (Layer 4) — REQUIRED

Every time you delegate, **explicitly tell the user** what happened, in your reply to them. Not a postscript — part of the narrative.

✅ **Good**:
> "I had Gemini read the 60-page spec (its 2M context handles the full doc in one pass — saved me about 40k tokens of working context). Here's the summary: ..."

✅ **Good (failure case)**:
> "I tried to delegate this to Gemini but it's currently rate-limited (resets in ~2h). I handled the read myself instead — here are the findings: ..."

❌ **Bad (silent)**:
> "Here's the summary: ..."  
> *(user has no idea Gemini did the heavy lifting; no reinforcement for delegation habit next time)*

❌ **Bad (technical noise)**:
> "Invoked agentalk-delegate gemini with --files, got findings..."  
> *(user doesn't care about the mechanics; show the value instead)*

The principle: if the user can't see that delegation happened, they have no reason to keep this setup.

---

## Multi-step tasks

Share a task_id across delegations when they logically belong together:

```bash
# Step 1
agentalk-delegate gemini "Extract decisions from ./spec.md" --files "./spec.md"
# note [TASK] line — extract task_id from path: t_20260422nnnnnn_xxxxxx

# Step 2 (reuses task state)
agentalk-delegate opencode "Translate previous step's findings to Chinese" \
  --task-id t_20260422nnnnnn_xxxxxx \
  --context "Step 1 produced a decision list; translate preserving numbering."
```

Review the full task at any time:

```bash
agentalk-delegate task t_20260422nnnnnn_xxxxxx
```

---

## Memory — remember what matters

After a delegation taught you something non-obvious and reusable (not just the immediate answer), persist it:

```bash
agentalk-delegate remember "Gemini truncates responses around ~100k output tokens; chunk long outputs"
agentalk-delegate remember "GLM is poor at TypeScript generics; prefer codex for TS type work"
```

This appends to `.agentalk/memory.jsonl` in the current project (survives sessions). Recall at start of a new session:

```bash
agentalk-delegate recall --limit 20
```

**Don't remember**: the specific task result (that's what the task.json is for), anything trivial, things that change often.

**Do remember**: capability discoveries, gotchas, project-specific delegation patterns.

---

## Environment check

```bash
which agentalk-delegate || echo "not installed"
agentalk-delegate init   # detect CLIs, re-install skills, print status
```

If missing: `npm install -g agentalk`.

---

## Quick reference

| Command | Purpose |
|---------|---------|
| `agentalk-delegate <agent> "<task>" [opts]` | Main operation |
| `agentalk-delegate quotas` | Observed quota state (real signals, not predicted) |
| `agentalk-delegate capabilities` | What each agent is good at |
| `agentalk-delegate task <id>` | Inspect a delegation task |
| `agentalk-delegate remember "<fact>"` | Persist a project-level learning |
| `agentalk-delegate recall` | Read project memory |
| `agentalk-delegate review` | Per-agent success rates (after some usage) |
| `agentalk-delegate init` | Setup status + next-step hints |
| `agentalk-delegate help` | Full usage |

All commands accept `--json` where structured output is useful for scripting.
