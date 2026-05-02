let _state = null;

export function initBudget({ maxTotalAgentCalls = 12, maxClaudeCalls = 3, maxModeratorCalls = 4 } = {}) {
  _state = {
    total: 0,
    perAgent: {},
    moderatorCalls: 0,
    limits: {
      maxTotalAgentCalls,
      maxClaudeCalls,
      maxModeratorCalls
    }
  };
}

export function tryConsume(agentKey, { isModerator = false } = {}) {
  if (!_state) return { ok: true };

  // 1. Check total limit
  if (_state.total >= _state.limits.maxTotalAgentCalls) {
    return { ok: false, reason: "total_exceeded" };
  }

  // 2. Check claude limit
  if (agentKey === "claude") {
    const claudeCalls = _state.perAgent["claude"] || 0;
    if (claudeCalls >= _state.limits.maxClaudeCalls) {
      return { ok: false, reason: "claude_exceeded" };
    }
  }

  // 3. Check moderator limit
  if (isModerator) {
    if (_state.moderatorCalls >= _state.limits.maxModeratorCalls) {
      return { ok: false, reason: "moderator_exceeded" };
    }
  }

  // All checks passed, increment counters
  _state.total++;
  _state.perAgent[agentKey] = (_state.perAgent[agentKey] || 0) + 1;
  if (isModerator) {
    _state.moderatorCalls++;
  }

  return { ok: true };
}

export function disable() {
  _state = null;
}

export function getStats() {
  if (!_state) return null;
  return {
    total: _state.total,
    perAgent: { ..._state.perAgent },
    moderatorCalls: _state.moderatorCalls,
    limits: { ..._state.limits }
  };
}

export function isEnabled() {
  return _state !== null;
}

export function reset() {
  if (_state) {
    _state.total = 0;
    _state.perAgent = {};
    _state.moderatorCalls = 0;
  }
}

// Parse --max-calls / --max-claude-calls / --max-moderator-calls / --no-budget
// from process.argv and apply to the singleton. Returns the limits actually
// applied (or null if disabled). Call once per entry point at startup.
//
// Defaults are intentionally generous: a 5-agent / 4-round discuss is 20 agent
// calls + ~5 moderator calls = 25 total. The cap is a safety net for runaway,
// not a bound on legitimate use.
export function applyBudgetFromArgv(argv = process.argv) {
  if (argv.includes("--no-budget")) {
    disable();
    return null;
  }
  function intArg(flag, fallback) {
    const idx = argv.indexOf(flag);
    if (idx === -1) return fallback;
    const v = parseInt(argv[idx + 1], 10);
    return (Number.isFinite(v) && v >= 0) ? v : fallback;
  }
  const limits = {
    maxTotalAgentCalls: intArg("--max-calls", 30),
    maxClaudeCalls:     intArg("--max-claude-calls", 5),
    maxModeratorCalls:  intArg("--max-moderator-calls", 8),
  };
  initBudget(limits);
  return limits;
}
