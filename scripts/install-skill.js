#!/usr/bin/env node
import { cp, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const claudeDir = join(homedir(), ".claude");

async function install() {
  if (!existsSync(claudeDir)) {
    console.log("Claude Code not found (~/.claude missing). Skipping skill install.");
    return;
  }

  const skillsDir = join(claudeDir, "skills");
  await mkdir(skillsDir, { recursive: true });

  const skillFiles = ["agentalk.md", "agentalk-consult.md"];
  for (const file of skillFiles) {
    const src = join(__dirname, "../skills", file);
    if (existsSync(src)) {
      await cp(src, join(skillsDir, file));
      console.log(`✓ Skill installed: ${file}`);
    }
  }

  console.log("\nAgentTalk Claude Code integration installed.");
  console.log("  /agentalk         — read discussion results for current project");
  console.log("  /agentalk-consult — Claude self-initiates a panel discussion");
}

install().catch(err => {
  // postinstall failures must not break npm install
  console.warn("AgentTalk skill install skipped:", err.message);
});
