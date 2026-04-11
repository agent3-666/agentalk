#!/usr/bin/env node
import { runModel } from "../lib/model-runner.js";

const args = process.argv.slice(2);
const mIdx = args.indexOf("-m");

if (mIdx === -1 || !args[mIdx + 1]) {
  process.stderr.write("Usage: agentalk-model -m <model-id> <prompt>\n");
  process.stderr.write("Example: agentalk-model -m gpt-4o \"Hello\"\n");
  process.stderr.write("         agentalk-model -m deepseek/deepseek-chat \"Hello\"\n");
  process.exit(1);
}

const modelId = args[mIdx + 1];
const rest = args.filter((_, i) => i !== mIdx && i !== mIdx + 1);
const prompt = rest.join(" ").trim();

if (!prompt) {
  process.stderr.write("No prompt provided\n");
  process.exit(1);
}

try {
  const response = await runModel(modelId, prompt);
  process.stdout.write(response + "\n");
} catch (e) {
  process.stderr.write(`Error: ${e.message}\n`);
  process.exit(1);
}
