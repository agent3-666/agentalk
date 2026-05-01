# Claude Code Rate Runaway: Diagnosis And Fix

Date: 2026-05-02

## Incident

After the Claude Code five-hour rate window reset at 2026-05-01 23:00 Asia/Taipei, one Arsenal task appeared to consume the window unusually quickly.

The relevant Arsenal Claude Code session launched Agentalk with:

```bash
cat /tmp/fix-iaa-test.txt | agentalk > /tmp/fix-iaa-test.log 2>&1 &
```

The prompt file contained a multi-line task that started with `@gemini`, followed by evidence, bullets, code fences, and trailing control text such as `s` and `/quit`.

## Root Cause

`agentalk` treated non-TTY stdin as an interactive REPL transcript and executed each input line separately.

That meant one multi-line prompt became many independent Agentalk inputs:

- The first line with `@gemini` was sent to Gemini.
- Later lines such as `证据：`, bullets, code fences, and short fragments were treated as new user messages.
- Messages without an `@mention` entered the default moderator flow.
- The configured moderator was Claude, so the accidental line splitting repeatedly invoked Claude.

This was a product-boundary failure, not a single-model runaway:

- `agentalk` is the committee/discussion tool.
- `agentalk-delegate` is the direct sub-task delegation tool.
- Claude Code used the discussion REPL as if it were a delegation batch runner.
- The REPL accepted that unsafe pattern instead of refusing it.

## Fixes Applied

1. `lib/input.js`
   - Non-TTY stdin no longer runs as a line-by-line REPL.
   - One-line pipes are still accepted for simple compatibility.
   - Multi-line piped input is refused with a clear error.
   - The error points users to `agentalk --<mode> --stdin`, `agentalk --<mode> --file`, or `agentalk-delegate`.

2. `index.js`
   - Added explicit headless long-prompt inputs:
     - `agentalk --deepen --stdin < prompt.txt`
     - `agentalk --challenge --file prompt.txt`
   - Added `--agents` support for headless modes.
   - Added `@agent` mention parsing in headless topics so `@gemini` scopes the participant list instead of relying on REPL behavior.
   - Updated help output to warn against multi-line prompt pipes and point implementation work to `agentalk-delegate`.

3. Documentation and skills
   - Updated `README.md`.
   - Updated `skills/agentalk.md`.
   - Updated `skills/agentalk-delegate.md`.
   - The docs now explicitly say not to use `cat prompt.txt | agentalk` for multi-line prompts or implementation sub-tasks.

## Remaining Recommended Hardening

These were not implemented in this pass, but should be considered next:

- Add per-run call budgets, especially for Claude calls.
- In Claude Code-originated sessions, exclude Claude from participants/moderator unless explicitly requested.
- Change MCP `ask` so omitted `agents` does not default to every active agent.
- Add a run audit log recording agent call count, elapsed time, and selected participants.
- Consider a first-class `agentalk --ask <agent> --stdin` only if the project wants direct single-agent ask inside `agentalk`; otherwise keep that responsibility in `agentalk-delegate`.
