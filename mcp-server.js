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
import {
  delegate as supervisorDelegate,
  readQuotaState,
  readCapabilities,
  rememberFact,
  recallMemory,
  getTask,
} from "./lib/supervisor.js";

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
    // ─── Delegation tools ──────────────────────────────────────────
    // Main agent (this caller) delegates a sub-task to another CLI agent
    // based on capability + remaining quota. Supervisor owns task state.
    {
      name: "delegate",
      description: "把一个子任务委派给另一个 AI agent CLI 执行（比如让 Gemini 读长文档、让 GLM 翻译、让 Codex 改码），减少主 agent 消耗并充分利用所有订阅。返回结构化的 findings + artifacts + unknowns + diagnostics（含配额状态）。主 agent 负责决定调用哪个 agent、如何构造 brief。",
      inputSchema: {
        type: "object",
        properties: {
          agent: {
            type: "string",
            description: `要委派的 agent key，可选值: ${Object.keys(AGENTS).join(", ")}。用 list_capabilities 查看各 agent 擅长什么，用 list_quotas 查看当前可用状态。`,
          },
          task: { type: "string", description: "一句话说明要做什么（必填）" },
          files: {
            type: "array",
            items: { type: "string" },
            description: "需要 delegate 读取的文件路径（相对 cwd）。委派给 Gemini 处理大文档时尤其关键。",
          },
          context: {
            type: "string",
            description: "2-3 行背景说明（主 agent 当前对话中的相关信息）。不要塞全对话历史——只说 delegate 需要知道的。",
          },
          output: {
            type: "string",
            description: "期望的输出格式或重点（比如 '列出 5 个核心决策' / '返回 JSON' / '中文翻译'）。",
          },
          budget: {
            type: "string",
            description: "预算提示，比如 '简短，200 字内' 或 '详细分析，不限长度'。",
          },
          task_id: {
            type: "string",
            description: "如果在复用已有任务（多步），传入之前 delegate 返回的 task_id。省略则新建任务。",
          },
        },
        required: ["agent", "task"],
      },
    },
    {
      name: "list_quotas",
      description: "查看每个 agent 当前观察到的配额状态（available / quota_exceeded / auth_failed / timeout / unknown）。状态来自真实调用的 observed 信号，不是预测。主 agent 决策时先读这个，避免调用已爆表的 agent。",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "list_capabilities",
      description: "查看每个 agent 的能力画像：擅长、上下文窗口、成本档位、适用场景。用于帮助主 agent 决定把子任务派给谁。",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "remember",
      description: "把一条项目级的事实/决策/教训记入本项目的持久记忆（.agentalk/memory.jsonl，append-only）。之后的 delegate 调用可以被告知这些 context。只记非显然、跨 session 有价值的信息。",
      inputSchema: {
        type: "object",
        properties: {
          fact: { type: "string", description: "要记住的事实或决定（一句话）" },
          context: { type: "string", description: "可选：为什么记这个/在什么情境下产生的" },
          task_id: { type: "string", description: "可选：关联到某个 delegate task" },
        },
        required: ["fact"],
      },
    },
    {
      name: "recall",
      description: "读取本项目最近的记忆条目（.agentalk/memory.jsonl），返回时间倒序的 facts。用于在开始新任务前回忆上下文。",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "最多返回多少条（默认 20）", default: 20 },
        },
      },
    },
    {
      name: "task_status",
      description: "查询某个 delegate task 的当前状态和所有 step 的进展。用于多步任务的进度检查或失败恢复。",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "delegate 返回的 task_id" },
        },
        required: ["task_id"],
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

    // ─── Delegation tools ────────────────────────────────────────
    if (name === "delegate") {
      const { agent, task, files, context: briefContext, output, budget, task_id } = args;
      const result = await supervisorDelegate({
        agent,
        brief: { task, files, context: briefContext, output, budget },
        cwd: process.cwd(),
        taskId: task_id || null,
        mainAgent: "claude",  // assume MCP caller; main agent identity is informational
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (name === "list_quotas") {
      const state = readQuotaState();
      return { content: [{ type: "text", text: JSON.stringify(state, null, 2) }] };
    }

    if (name === "list_capabilities") {
      const caps = readCapabilities();
      return { content: [{ type: "text", text: JSON.stringify(caps, null, 2) }] };
    }

    if (name === "remember") {
      const { fact, context: memContext, task_id } = args;
      const record = rememberFact(process.cwd(), {
        fact, context: memContext || null, taskId: task_id || null,
      });
      return { content: [{ type: "text", text: `Remembered: ${JSON.stringify(record)}` }] };
    }

    if (name === "recall") {
      const { limit = 20 } = args;
      const facts = recallMemory(process.cwd(), { limit });
      if (!facts.length) {
        return { content: [{ type: "text", text: "(no memory yet for this project)" }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(facts, null, 2) }] };
    }

    if (name === "task_status") {
      const { task_id } = args;
      const task = getTask(task_id);
      if (!task) {
        return { content: [{ type: "text", text: `Task ${task_id} not found` }], isError: true };
      }
      return { content: [{ type: "text", text: JSON.stringify(task, null, 2) }] };
    }

    return { content: [{ type: "text", text: `未知工具: ${name}` }], isError: true };

  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

// ─── Start ───────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
