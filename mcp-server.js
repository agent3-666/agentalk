#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { AGENTS, runAgent } from "./lib/agents.js";
import { ContextManager } from "./lib/context.js";
import { discuss, debate } from "./lib/discuss.js";

// ─── Helper: parse agent list from comma/space string ────────────────
function parseAgents(str) {
  if (!str) return null;
  const valid = Object.keys(AGENTS);
  const list = str.toLowerCase().split(/[\s,]+/).filter(a => valid.includes(a));
  return list.length > 0 ? list : null;
}

// ─── Helper: get last conclusion (or partial outcome) from context ──
// Looks for any terminal marker set by discuss.js: CONCLUSION (converged),
// DEBATE_CONCLUSION (debate converged), TIMEOUT (hit max rounds), or
// ABORTED (user stopped). Returns { status, text } so the caller can tell
// the difference between a real conclusion and a timed-out / aborted run.
function getLastConclusion(ctx) {
  const markers = /^\[(CONCLUSION|DEBATE_CONCLUSION|TIMEOUT|ABORTED)\]\s*/;
  const last = ctx.messages.findLast(
    m => m.role === "system" && markers.test(m.content)
  );
  if (!last) return null;
  const match = last.content.match(markers);
  const status = match[1];
  const text = last.content.replace(markers, "").trim();
  return { status, text };
}

// ─── Helper: build transcript from context messages ──────────────────
function buildTranscript(messages) {
  return messages
    .filter(m => m.role !== "system")
    .map(m => {
      const speaker = m.role === "user" ? "User" : AGENTS[m.role]?.name || m.role;
      return `**${speaker}**: ${m.content}`;
    })
    .join("\n\n");
}

// Format a discussion/debate result so the calling agent gets both the
// bottom-line answer AND the transcript, with a clear status header.
function formatDiscussionResult(ctx, kind) {
  const outcome = getLastConclusion(ctx);
  const transcript = buildTranscript(ctx.messages);

  let header;
  if (!outcome) {
    header = `## ${kind}未收敛（未产生结论）`;
  } else if (outcome.status === "CONCLUSION" || outcome.status === "DEBATE_CONCLUSION") {
    header = `## 结论\n${outcome.text}`;
  } else if (outcome.status === "TIMEOUT") {
    header = `## ${kind}达到最大轮次（以下是当前进度摘要）\n${outcome.text}`;
  } else if (outcome.status === "ABORTED") {
    header = `## ${kind}被用户中断（以下是当前进度摘要）\n${outcome.text}`;
  }

  return `${header}\n\n## ${kind}记录\n${transcript}`;
}

// ─── MCP Server ──────────────────────────────────────────────────────
const server = new Server(
  { name: "agentalk", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "ask",
      description: "向一个或多个 AI Agent（Claude、Codex、Gemini、OpenCode/GLM）提问，获取各自的独立回答。适合需要多角度快速参考的场景。",
      inputSchema: {
        type: "object",
        properties: {
          question: { type: "string", description: "要提问的内容" },
          agents: {
            type: "string",
            description: "指定 agents，逗号分隔，如 'claude,codex'。留空则发给全部。可选值: claude, codex, gemini, opencode",
          },
        },
        required: ["question"],
      },
    },
    {
      name: "discuss",
      description: "让多个 AI Agent 就某话题进行并行多轮讨论，直到达成共识。每轮所有 agent 同时发言，看到上一轮所有人的回复。",
      inputSchema: {
        type: "object",
        properties: {
          topic: { type: "string", description: "讨论话题" },
          agents: {
            type: "string",
            description: "参与的 agents，逗号分隔。留空则全部参与。",
          },
          max_rounds: {
            type: "number",
            description: "最大讨论轮数（默认 4，建议 2-6）",
            default: 4,
          },
        },
        required: ["topic"],
      },
    },
    {
      name: "debate",
      description: "让多个 AI Agent 就某话题进行串行辩论，按 Codex → Gemini → GLM → Claude 顺序接力发言，每人都能看到前面所有人刚说的。",
      inputSchema: {
        type: "object",
        properties: {
          topic: { type: "string", description: "辩论话题" },
          agents: {
            type: "string",
            description: "参与的 agents，逗号分隔。留空则全部参与。",
          },
          max_turns: {
            type: "number",
            description: "最大发言轮次（默认 8，建议 4-12）",
            default: 8,
          },
        },
        required: ["topic"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const ctx = new ContextManager(process.cwd());

  try {
    if (name === "ask") {
      const { question, agents: agentsStr } = args;
      const targets = parseAgents(agentsStr) || Object.keys(AGENTS);

      ctx.add("user", question);
      const prompt = ctx.buildPrompt(null, "请回应以上消息。");
      const results = await Promise.all(
        targets.map(key => runAgent(key, prompt, { silent: true }))
      );

      const responses = results
        .filter(r => r.response)
        .map(r => `### ${AGENTS[r.agent].name} (${r.elapsed}s)\n${r.response}`)
        .join("\n\n---\n\n");

      return {
        content: [{ type: "text", text: responses || "所有 agents 均无响应" }],
      };
    }

    if (name === "discuss") {
      const { topic, agents: agentsStr, max_rounds = 4 } = args;
      const agents = parseAgents(agentsStr) || undefined;

      await discuss(topic, ctx, {
        maxRounds: max_rounds,
        capture: true,
        ...(agents && { agents }),
      });

      return { content: [{ type: "text", text: formatDiscussionResult(ctx, "讨论") }] };
    }

    if (name === "debate") {
      const { topic, agents: agentsStr, max_turns = 8 } = args;
      const agents = parseAgents(agentsStr) || undefined;

      await debate(topic, ctx, {
        maxTurns: max_turns,
        capture: true,
        ...(agents && { agents }),
      });

      return { content: [{ type: "text", text: formatDiscussionResult(ctx, "辩论") }] };
    }

    return { content: [{ type: "text", text: `未知工具: ${name}` }], isError: true };

  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

// ─── Start ───────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
