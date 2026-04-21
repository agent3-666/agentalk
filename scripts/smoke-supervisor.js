#!/usr/bin/env node
// Smoke test for lib/supervisor.js primitives.
// Does NOT spawn real agents — tests state/memory/quota parsing only.
// Run: node scripts/smoke-supervisor.js

import {
  createTask, getTask, addTaskStep, updateTaskStep,
  parseQuotaSignal, readQuotaState, updateQuotaState,
  readCapabilities,
  rememberFact, recallMemory,
  logDelegation,
} from "../lib/supervisor.js";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let pass = 0, fail = 0;
function ok(name, cond, detail = "") {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name} ${detail ? "— " + detail : ""}`); fail++; }
}

// ─── Task lifecycle ──────────────────────────────────────────────
console.log("\nTask lifecycle:");
const t = createTask({ intent: "smoke test task", mainAgent: "test" });
ok("createTask returns id", !!t.id && t.id.startsWith("t_"));
ok("createTask status = pending", t.status === "pending");

const step = addTaskStep(t.id, {
  brief: { task: "do a thing" }, agent: "gemini",
});
ok("addTaskStep returns s1", step.id === "s1");

updateTaskStep(t.id, "s1", { status: "running" });
let reloaded = getTask(t.id);
ok("step status -> running", reloaded.plan.steps[0].status === "running");
ok("task status rolled up to running", reloaded.status === "running");

updateTaskStep(t.id, "s1", { status: "done", result: { findings: "ok" } });
reloaded = getTask(t.id);
ok("step status -> done", reloaded.plan.steps[0].status === "done");
ok("task status rolled up to done", reloaded.status === "done");
ok("checkpoints recorded", reloaded.checkpoints.length >= 3);

// ─── Quota signal parsing ────────────────────────────────────────
console.log("\nQuota signal parsing:");
ok("429 detected",
  parseQuotaSignal({ error: "API error: 429 Too Many Requests" }).outcome === "quota_exceeded");
ok("rate limit detected",
  parseQuotaSignal({ error: "you have been rate-limited" }).outcome === "quota_exceeded");
ok("quota exceeded detected",
  parseQuotaSignal({ response: "", error: "Quota exceeded for this period" }).outcome === "quota_exceeded");
ok("auth failure detected",
  parseQuotaSignal({ error: "401 unauthorized" }).outcome === "auth_failed");
ok("invalid key detected",
  parseQuotaSignal({ error: "Invalid API key" }).outcome === "auth_failed");
ok("timeout surfaced",
  parseQuotaSignal({ timedOut: true, timeoutSec: 120 }).outcome === "timeout");
ok("stopped surfaced",
  parseQuotaSignal({ stopped: true }).outcome === "stopped");
ok("ok when success",
  parseQuotaSignal({ response: "here is the answer", error: "" }).outcome === "ok");
ok("reset hint extracted",
  parseQuotaSignal({ error: "429, resets in 3 hours" }).reset_hint?.includes("resets"));

// ─── Quota state persistence ─────────────────────────────────────
console.log("\nQuota state:");
updateQuotaState("gemini", { outcome: "quota_exceeded", detail: "test", reset_hint: null });
const qs = readQuotaState();
ok("gemini marked quota_exceeded", qs.gemini?.status === "quota_exceeded");
updateQuotaState("gemini", { outcome: "ok", detail: null, reset_hint: null });
const qs2 = readQuotaState();
ok("gemini reset to available", qs2.gemini?.status === "available");

// ─── Capabilities ────────────────────────────────────────────────
console.log("\nCapabilities:");
const caps = readCapabilities();
ok("capabilities loaded", !!caps.gemini);
ok("gemini has strengths", Array.isArray(caps.gemini?.strengths));
ok("gemini has long context", caps.gemini?.context_window >= 1000000);

// ─── Memory (isolated temp dir) ──────────────────────────────────
console.log("\nMemory (JSONL append-only):");
const tmp = mkdtempSync(join(tmpdir(), "agentalk-smoke-"));
rememberFact(tmp, { fact: "first fact", context: "initial test" });
rememberFact(tmp, { fact: "second fact" });
rememberFact(tmp, { fact: "third fact", taskId: t.id });
const memory = recallMemory(tmp);
ok("three facts recalled", memory.length === 3);
ok("first fact content", memory[0].fact === "first fact");
ok("last fact has task_id", memory[2].task_id === t.id);

// ─── Delegation log ──────────────────────────────────────────────
console.log("\nDelegation log:");
const logRes = logDelegation({
  task_id: t.id, step_id: "s1", agent: "gemini",
  outcome: "ok", detail: null, elapsed_ms: 1234,
});
ok("logDelegation returns ok:true", logRes.ok === true);

// ─── Atomic write survives sequential task updates ──────────────
console.log("\nAtomic write + sequential step additions:");
const sup = await import("../lib/supervisor.js");
const concurrentTask = sup.createTask({ intent: "sequential add test" });
for (let i = 0; i < 5; i++) {
  sup.addTaskStep(concurrentTask.id, {
    brief: { task: `step ${i}` }, agent: "gemini",
  });
}
const concurrentReloaded = sup.getTask(concurrentTask.id);
ok(`5 step additions → ${concurrentReloaded.plan.steps.length} steps present`,
   concurrentReloaded.plan.steps.length === 5);
ok("unique step ids",
   new Set(concurrentReloaded.plan.steps.map(s => s.id)).size === 5);

// ─── Validation errors still throw ────────────────────────────
console.log("\nValidation (should throw, not return system_error):");
let threw = false;
try { await sup.delegate({ agent: "nonexistent", brief: { task: "x" } }); }
catch (e) { threw = e.message.includes("Unknown agent"); }
ok("delegate throws on unknown agent", threw);

threw = false;
try { await sup.delegate({ agent: "gemini", brief: {} }); }
catch (e) { threw = /brief\.task is required/.test(e.message); }
ok("delegate throws on missing brief.task", threw);

// ─── Summary ─────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
