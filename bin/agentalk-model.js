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
  const { text, usage } = await runModel(modelId, prompt);
  process.stdout.write(text + "\n");
  if (usage) {
    // Write token usage to stderr so agentalk can parse it without mixing with response text
    process.stderr.write(
      `[USAGE] prompt=${usage.prompt_tokens ?? 0} completion=${usage.completion_tokens ?? 0} total=${usage.total_tokens ?? 0}\n`
    );
  }
} catch (e) {
  process.stderr.write(`Error: ${e.message}\n`);
  process.exit(1);
}
