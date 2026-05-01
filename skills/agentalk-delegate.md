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

Never delegate implementation work by writing a multi-line prompt file and running `cat prompt.txt | agentalk`. `agentalk` is the discussion panel. For direct work assigned to one agent, always use this `agentalk-delegate` CLI.

---

## Agent selection: priority + billing

Every agent has two metadata fields (visible in `agentalk-delegate capabilities`):

- **priority**: `preferred` / `normal` / `avoid` / `main`
- **billing**: `subscription` / `pay_per_call` / `free`

**Selection rules** (in order):

1. **Prefer `priority: preferred` agents first** — user flagged these as "use freely"
2. **Prefer `billing: subscription`** over `pay_per_call` — the user's already paid, use the subscription
3. **Never delegate TO `priority: main`** — that's the main agent itself (usually `claude`)
4. **Avoid `priority: avoid` or `billing: pay_per_call`** unless no preferred subscription agent fits the task OR the user explicitly asked
5. On fit tie, match the task's nature to `good_for` and `strengths`

If you're unsure, run `agentalk-delegate capabilities` — it prints the badges and the user's notes so you can see what they want.

## When to delegate — concrete signals (Layer 3)

**Delegate autonomously** when you see ANY of these specific signals in the user's task:

| Signal | Default delegate | Why |
|--------|------------------|-----|
| Summary/review of a document > 10 pages | `gemini` | 2M context, single-pass read |
| Task requires reading > 5 files to answer | `gemini` | saves your context budget |
| PDF / OCR / image analysis | `gemini` | multimodal |
| Scan whole repo for pattern X (grep-level question) | `gemini` | reads files for you |
| Bug hunting across many files in a big codebase | `gemini` | long-context scan |
| Translation between human languages (EN↔ZH etc.) | `opencode` (GLM) | cheap, strong Chinese |
| Bulk mechanical transformation (N items → N items) | `opencode` (GLM) | low cost tier |
| Chinese-heavy text writing / rewriting | `opencode` (GLM) | native strength |
| One-shot shell script / scaffolding / `Makefile` / boilerplate | `codex` | code-focused, fast |
| "Generate N fixtures / test data" | `codex` | bounded, structural |
| Quick code edits in known files | `codex` | iteration speed |
| Bug hunting in CLI / shell / infra code | `codex` | shell strength |

These are the three **preferred subscription** agents (`gemini`, `codex`, `opencode`). Use them freely — the user has subscriptions already paid.

**Task sizing — don't over-trim out of fear.** The default delegation timeout is **600 seconds** (10 min), not 180s. If you previously saw a `timeout` error at 180s in an earlier conversation or session, that was the OLD default and is no longer relevant. Gemini can comfortably handle 9–15 file structured surveys within 600s. Trust the default; don't self-limit to 3-5 files unless the task genuinely is small. For truly heavy tasks (20+ files, long PDFs) pass `--timeout 1200`. Partial timeouts auto-return whatever was captured as `[STATUS] timeout_partial` — nothing is lost.

**`pay_per_call` agents** (e.g. `qwen3-plus` via `agentalk-model`): costs money per call. Only delegate to these if (a) the user explicitly asks, OR (b) all preferred subscription agents are unavailable/rate-limited AND the task is important.

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
  --budget "length hint" \
  --timeout 600           # optional: override default (default is already 600s)
```

**Concrete example**:

```bash
agentalk-delegate gemini "Extract the 10 core design decisions from this spec" \
  --files "./spec.md,./architecture.md" \
  --context "Reviewing an AgentBase proposal against our 2nd Neural project. User wants decisions, not implementation detail." \
  --output "Numbered list, 1-2 sentences per decision" \
  --budget "500 words"
```

**Timeout guidance** (the main tripwire for heavy tasks):
- Default is **600s** — enough for most multi-file surveys
- For **> 10 files** or **long PDFs** → bump to `--timeout 1200`
- For **> 20 files** → consider **splitting the task** into two delegations instead (one long delegation is fragile; two short ones are observable and resumable)

**If a delegation times out, you get `[STATUS] timeout_partial` + whatever was produced before the deadline** — the system streams stdout into the task log in real time, so nothing is lost. Treat partial output as potentially usable (first N out of M items); decide whether to accept, retry, or split.

### 3. Parse output

The CLI prints structured markers on stdout:

```
[STATUS] ok                    # or: timeout_partial / quota_exceeded / auth_failed / failed / system_error
[AGENT] gemini
[TASK] /Users/.../.agentalk/tasks/t_xxx.jsonl
[TASK_ID] t_xxx
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

Parse between `[FINDINGS]` / `[END_FINDINGS]`. For full detail use the `[TASK_ID]`:

```bash
agentalk-delegate task <task-id>           # structured summary
agentalk-delegate tail <task-id>           # raw stdout the delegate produced
agentalk-delegate tail <task-id> --follow  # live tail while still running (for long tasks)
```

The `[TASK]` path points to a `.jsonl` — **one event per line** (task_created, step_added, step_started, stdout chunks, stderr chunks, step_completed). You can `cat` it or `jq` it for full transparency. One file per task, append-only — mirrors Claude Code's session storage.

### 4. Handle each status

- `[STATUS] ok` → use `[FINDINGS]`, continue
- `[STATUS] timeout_partial` → **partial output is real data**. Inspect `[FINDINGS]` — often usable (e.g. "got 6/9 files analyzed"). Either (a) accept what's there + do the rest yourself, (b) retry with `--timeout 1200` for the whole thing, or (c) use `--resume-step <task-id>:<step-id>` on a second delegation to continue from where the delegate left off
- `[STATUS] timeout` (no partial) → delegate crashed before producing anything useful. Retry with larger `--timeout`, switch agent, or do it yourself
- `[STATUS] quota_exceeded` → read `[DIAGNOSTICS]` for `suggestion` (alternative agent). Either retry with that agent, OR surface to user: "Gemini is rate-limited (resets in ~3h). I can use GLM via OpenCode instead, or we can pause."
- `[STATUS] auth_failed` → surface to user: "This CLI isn't authenticated. Run `<cli> login` first."
- `[STATUS] failed` / `system_error` → read `detail`, reframe the task or fall back to doing it yourself

**Never silently retry a failed delegation with a different agent**. Always either tell the user OR keep the same agent with a different brief. Silent fallback destroys trust.

## Multi-step delegate chains (use --resume-step for continuity)

When you need the same delegate to build on its own prior output, use `--resume-step`:

```bash
# Step 1: Gemini surveys the codebase
agentalk-delegate gemini "List all exported functions in src/*.ts" \
  --files "src/a.ts,src/b.ts,src/c.ts" \
  --output "One line per function: name, file, signature"
# → [TASK_ID] t_abc

# Step 2: Gemini reasons further using its own Step 1 output, no re-briefing needed
agentalk-delegate gemini "Of those functions, which touch the auth flow?" \
  --resume-step t_abc:s1 \
  --output "Numbered list with short justification"
```

Under the hood: the prior step's stdout is read from the jsonl and prepended to the new brief as "Your prior output". Works for any CLI that takes a prompt — we don't depend on each CLI's native session feature.

**When to use `--resume-step`**:
- Multi-step reasoning where the delegate benefits from seeing its own prior work verbatim (not your summary of it)
- Continuing a `timeout_partial` delegation from where it stopped

**When NOT to use it**:
- Different task types — use fresh delegate with fresh brief instead
- You want a clean slate (sometimes priors bias the delegate)

---

## Visible value (Layer 4) — REQUIRED, MECHANICAL

Every successful (or partial) delegation prints a `[VALUE_REPORT]` block to stdout — you **MUST** surface this to the user in your reply. Not a postscript — part of the narrative.

Example CLI output:

```
[VALUE_REPORT]
agent: gemini
model: gemini-2.5-pro
display: Gemini (gemini-2.5-pro)
delegate_tokens: 749
main_context_saved: ~12,450 tokens
task_summary: Extract 10 core design decisions from spec.md
[END_VALUE_REPORT]
```

Turn this into a **one-line visible-value statement** in your user-facing reply. Required format — pick one of these phrasings (or equivalent):

- `✓ Used **Gemini (gemini-2.5-pro)** to extract design decisions — saved ~12k tokens of my context.`
- `✓ Delegated spec reading to **Gemini (gemini-2.5-pro)** (~12k main-context tokens saved).`
- `✓ Handed off to **OpenCode (GLM)** for the translation — used ~300 tokens of GLM quota, zero of mine.`

Include **agent display name + model + what was accomplished + tokens saved**. One line, in natural English/Chinese, mixed into your reply where relevant (usually right before presenting the findings or right at the top of your response).

✅ **Good** (embeds the value report in narrative):
> "I had **Gemini (gemini-2.5-pro)** read the 60-page spec — saved ~40k tokens of my working context. Here's what it found: ..."

✅ **Good, failure case** (still visible, still honest):
> "I tried **Gemini**, it's rate-limited right now. I read the spec myself — here are the findings: ..."

✅ **Good, partial case**:
> "**Gemini (gemini-2.5-pro)** got through 6 of 9 files before timing out (~8k tokens worth of context saved on those 6). I'll do the remaining 3 myself."

❌ **Bad (silent)**:
> "Here's the summary: ..."  
> *(no mention of Gemini, no tokens; user has no reason to keep paying for Gemini Plus)*

❌ **Bad (technical noise)**:
> "Invoked agentalk-delegate gemini with --files, got findings..."  
> *(user doesn't care about the mechanics; show the value)*

**Rule**: if `[VALUE_REPORT]` was printed, there MUST be a line in your user-facing reply naming the agent, the model, what was accomplished, and (when `main_context_saved` is given) the tokens saved. If the CLI says `(no --files given — can't estimate)`, state the delegate_tokens instead (e.g. "Gemini spent ~750 tokens on this so I didn't have to").

The principle: **the user paid for that subscription; show them it's working for them.**

---

## Multi-step tasks (different agents sharing a task_id)

When sub-tasks logically belong to one "piece of work" across agents, share the `task_id`:

```bash
# Step 1: Gemini reads (its context window is what we came for)
agentalk-delegate gemini "Extract decisions from ./spec.md" --files "./spec.md"
# → [TASK_ID] t_abc

# Step 2: OpenCode translates (different agent, same task)
agentalk-delegate opencode "Translate previous step's findings to Chinese" \
  --task-id t_abc \
  --context "Step 1 produced a decision list; translate preserving numbering."
```

Difference between `--task-id` and `--resume-step`:
- `--task-id` — **organizational**: same "piece of work" gets one task file holding all steps
- `--resume-step` — **contextual**: prepend prior stdout into the new brief (can combine with or be independent of `--task-id`)

Review the full task at any time:

```bash
agentalk-delegate task <task-id>     # summary
agentalk-delegate tail <task-id>     # all stdout produced across all steps
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

## Session-targeted delegation (`@<name>`)

Beyond delegating to agent types (`gemini`, `codex`, ...) you can delegate to a **specific Claude Code session** that has its own accumulated context. Example use case: you're in project A and need to know what was decided in an ongoing project B session. Instead of re-briefing from scratch, ask B's session directly.

Setup (once per session you want addressable):
```bash
agentalk-delegate register-session sumplus --cwd /path/to/Sumplus
# optionally --session-id <id> for a specific session; default: latest in cwd
```

Then delegate:
```bash
agentalk-delegate @sumplus "What was the auth token storage decision?"
agentalk-delegate @sumplus "Review this diff" --files ./patch.diff
```

Under the hood spawns `claude --resume <id> -p "..." --no-session-persistence` in the session's cwd — the delegate sees that session's full conversation history, but the question + answer are NOT written to the live session's JSONL (won't surprise you later).

**Both sides are transparent about this**:
- **You (caller)**: `[VALUE_REPORT]` includes `inbox_logged_to: /path/.agentalk/inbox.jsonl` — mention it in your user-facing line.
- **The delegated session** (when it's next used by you or others): can run `agentalk-delegate inbox` in its cwd to see `{ ts, from_caller, task_summary, findings_preview, task_id }` for every delegation it's received. Nothing is hidden.

So the honest user-facing sentence for session delegations looks like:
> `✓ Queried the **Sumplus Claude session** for the auth decision — the result is also recorded in that project's `.agentalk/inbox.jsonl` so future sessions there know this was asked.`

## Quick reference

| Command | Purpose |
|---------|---------|
| `agentalk-delegate <agent> "<task>" [opts]` | Delegate to an agent type (fresh CLI spawn) |
| `agentalk-delegate @<name> "<task>" [opts]` | Delegate to a registered session (resumes that session's context, non-persistent) |
| `agentalk-delegate register-session <name> --cwd <path>` | Register a session as an addressable target |
| `agentalk-delegate sessions` | List registered sessions |
| `agentalk-delegate inbox [--cwd X]` | See what delegations a session has received |
| `agentalk-delegate quotas` | Observed quota state (real signals, not predicted) |
| `agentalk-delegate capabilities` | What each agent is good at + priority/billing badges |
| `agentalk-delegate task <id>` | Inspect a delegation task (status + steps) |
| `agentalk-delegate tail <id> [--follow]` | Stream a task's stdout events (live or historical) |
| `agentalk-delegate remember "<fact>"` | Persist a project-level learning |
| `agentalk-delegate recall` | Read project memory |
| `agentalk-delegate review` | Per-agent success rates (after some usage) |
| `agentalk-delegate init` | Setup status + next-step hints |
| `agentalk-delegate help` | Full usage |

Key flags on the primary delegate command:
- `--timeout <sec>` — override default 600s (use 1200 for >10-file tasks)
- `--resume-step <task-id>:<step-id>` — prepend prior step's stdout as context (continues delegate's own prior work)
- `--task-id <id>` — organize a multi-step task under one ID
- `--files a,b,c` / `--context` / `--output` / `--budget` — brief-in fields

All commands accept `--json` where structured output is useful for scripting.

## Storage model (if you're debugging or curious)

Each delegation task gets **one jsonl file** at `~/.agentalk/tasks/<task-id>.jsonl`, mirroring Claude Code's session storage pattern. Each line is an event: `task_created`, `step_added`, `step_started`, `stdout`, `stderr`, `step_completed`. Current state is derived by folding events, not stored separately. Partial output on timeout is automatically preserved because stdout is streamed into the log as it arrives.
