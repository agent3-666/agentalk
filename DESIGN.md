# Agentalk Design Document

## 1. Overview

Agentalk 是一个终端多 Agent 协作平台，允许用户同时与多个 AI 编码助手（Claude、Codex、Gemini、OpenCode 等）对话，并支持并行讨论和串行辩论两种多 Agent 协作模式。同时提供 MCP Server，可被其他 AI 工具（如 Claude Code）作为工具调用。

```
┌─────────────────────────────────────────────────────┐
│                     User (REPL)                      │
├──────────┬──────────┬──────────┬────────────────────┤
│  Claude  │  Codex   │  Gemini  │  OpenCode (GLM..)  │
└──────────┴──────────┴──────────┴────────────────────┘
         ↕              ↕  共享上下文 (512k tokens)
┌─────────────────────────────────────────────────────┐
│              ContextManager (持久化)                  │
└─────────────────────────────────────────────────────┘
```

## 2. Architecture

### 2.1 文件结构

```
agentalk/
├── index.js          # CLI 入口，REPL 主循环，命令路由
├── mcp-server.js     # MCP Server（供外部 AI 工具调用）
├── lib/
│   ├── agents.js     # Agent 运行器：spawn 子进程执行 CLI
│   ├── config.js     # 配置管理 + 26 个 Agent 注册表
│   ├── context.js    # 共享上下文管理，512k token 限制 + 自动压缩
│   ├── discuss.js    # 讨论引擎：并行讨论 / 串行辩论 / 广播
│   └── session.js    # Claude Code 会话导入
└── package.json      # bin: agentalk (CLI) + agentalk-mcp (MCP Server)
```

### 2.2 模块依赖关系

```
index.js
  ├─→ lib/agents.js     (AGENTS 注册表 + runAgent 执行器)
  │     └─→ lib/config.js   (loadConfig → getActiveAgents)
  ├─→ lib/context.js    (ContextManager)
  │     └─→ lib/agents.js   (压缩时调用 claude)
  ├─→ lib/discuss.js    (discuss / debate / broadcast)
  │     └─→ lib/agents.js   (调用各 agent)
  ├─→ lib/session.js    (readClaudeSession)
  └─→ lib/config.js     (enable/disable/add/remove/model)

mcp-server.js
  ├─→ lib/agents.js
  ├─→ lib/context.js
  └─→ lib/discuss.js
```

## 3. Core Modules

### 3.1 Config (`lib/config.js`)

**职责**: Agent 注册表 + 配置持久化

**数据模型 — Agent 定义**:
```js
{
  key: "codex",            // 唯一标识
  name: "Codex",           // 显示名
  cmd: "codex",            // CLI 命令
  args: ["exec", "--skip-git-repo-check", "{prompt}"],  // 参数模板
  color: "#10B981",        // 终端颜色 hex
  output: "text",          // "text" | "ndjson"
  enabled: true,           // 是否启用
  model: null,             // 自定义模型（null = 默认）
  model_flag: "--model",   // 模型注入的 CLI flag
  note: "OpenAI Codex CLI" // 说明
}
```

**预注册 Agent（共 22 个）**:

| Agent | Key | CLI Command | Default |
|-------|-----|------------|---------|
| Codex | `codex` | `codex exec` | enabled |
| Gemini | `gemini` | `gemini -p` | enabled |
| OpenCode | `opencode` | `opencode run --format json` | enabled |
| Claude | `claude` | `claude -p` | enabled |
| Cline, Continue, Copilot, Devin, Trae, Goose, OpenHands, Plandex, SWE-agent, Aider, Amazon Q, Ollama, Cursor, Kiro, Cody, Tabnine, Warp(oz), Pieces | ... | ... | disabled |

**运行时过滤**: `getActiveAgents()` 只返回 `enabled=true` **且** `which cmd` 能找到的 agent。

**配置文件**: `~/.agentalk/config.json`
- 首次运行自动创建
- 新版本新增的默认 agent 自动合并进用户配置（不覆盖已有设置）

**动态模型检测**: OpenCode 特殊处理 — 通过读取 `~/.local/share/opencode/opencode.db`（SQLite）获取最后使用的模型名作为显示名。

### 3.2 Agents (`lib/agents.js`)

**职责**: 构建 Agent 运行时对象 + 执行 CLI 命令

**启动时初始化**:
```js
export const AGENTS = buildAgents(getActiveAgents());
```

**`buildAgents(defs)`**:
- 为每个 agent 创建 `chalk` 颜色函数和彩色标签（自动判断背景亮度选黑/白文字）
- 生成 `buildArgs(prompt)` 闭包，支持两种模型注入方式：
  1. **占位符模式**: args 中包含 `{model}` → 直接替换
  2. **Flag 模式**: 有 `model_flag` → 自动在 args 前插入 `[flag, model]`

**`runAgent(agentKey, prompt, { silent })`**:

核心执行函数，返回 `Promise<{ agent, response, error, elapsed }>`。

```
spawn(cmd, buildArgs(prompt))
  ├── output === "ndjson" → streamOpencode()  // 逐行解析 JSON
  └── output === "text"   → 直接读 stdout
```

**NDJSON 流式处理** (`streamOpencode`):
- OpenCode 输出 NDJSON 格式：`{"type":"text","part":{"text":"..."}}`
- 逐行解析，提取 `type === "text"` 的 `part.text`，实时显示
- 非 silent 模式下实时输出彩色文本，首 chunk 时显示 agent 标签

**统一输出格式**:
```
[AgentName]        ← 彩色标签（bgHex）
│ 回复内容行 1
│ 回复内容行 2
╰ 2.3s · ~450 tokens
```

### 3.3 Context (`lib/context.js`)

**职责**: 共享对话历史管理 + 持久化 + token 限制

**`ContextManager` 类**:

```
cwd → sessionPath → ~/.agentalk/sessions/{cwd-normalized}.json
```

**核心机制**:

1. **消息模型**: `{ role, content, timestamp }`，role 为 `"user" | "system" | agentKey`
2. **Token 限制**: 512k tokens ≈ 1,500,000 字符（按 3 字符/token 估算）
3. **自动压缩** (`_compress`):
   - 保留前 2 条 + 后 10 条消息
   - 中间部分调用 Claude 生成摘要（≤1000字）
   - 摘要作为 `system` 角色消息插入
4. **Prompt 构建** (`buildPrompt`):
   ```
   [Speaker1]
   消息内容
   [Speaker2]
   消息内容
   {instruction}
   ```
5. **持久化**: 每次消息变更后自动 `save()`，按工作目录隔离

### 3.4 Discuss (`lib/discuss.js`)

**职责**: 多 Agent 协作引擎

#### 3.4.1 广播模式 (`broadcast`)

最简单的模式 — 并行发送同一消息给所有目标 agent。

```
User message → buildPrompt() → Promise.all(runAgent(...)) → 收集响应 → save
```

#### 3.4.2 并行讨论 (`/discuss`)

```
Round 1:  [Agent1, Agent2, Agent3, Agent4]  并行发言
Round 2:  [Agent1, Agent2, Agent3, Agent4]  看到 R1 所有人回复后并行发言
  ...
收敛判定 → 结论
```

**收敛机制**（三重判定）:

| 条件 | 触发 | 结果 |
|------|------|------|
| **全员 STOP** | 所有 agent 回复含 `[STOP]` | 立即收敛，生成摘要 |
| **裁判判定** | Round ≥ 2，每轮结束后 | Claude 作为裁判审核最近 N 条消息 |
| **达到上限** | round === maxRounds | 超时摘要 |

**裁判 Prompt**: 要求 Claude 回复 `CONVERGED: [摘要]` 或 `CONTINUE: [原因]`

**Prompt 构建策略**:
- Round 1: "请发表观点，300字以内"
- Round 2+: "回应其他 Agent，认同/质疑/补充，200字以内"
- 所有 prompt 包含完整对话历史

#### 3.4.3 串行辩论 (`/debate`)

```
Turn 1: Agent1 发言
Turn 2: Agent2 看到 Agent1 的发言后回应
Turn 3: Agent3 看到 Agent1+2 后回应
Turn 4: Agent4 看到 Agent1+2+3 后回应
Turn 5: Agent1 再次发言（循环）
  ...
```

**与 discuss 的关键差异**:
- Agent 逐个发言（串行），而非并行
- 按 agent 顺序循环: `agents[turn % agents.length]`
- 收敛判定在每个完整 cycle 结束后执行
- 单个 agent 可通过 `[STOP]` 表态，需全员表态 + 裁判确认

**优雅停止**: 任何时候按 `s` 或 `Ctrl+C` 触发 `requestStop()`，等待当前步骤完成后生成进度摘要。

#### 3.4.4 输出抽象

`makeOutput(capture)`:
- `capture=false`: 直接 `console.log`（终端模式）
- `capture=true`: 收集到 `lines[]` 数组（MCP Server 模式，不向 stdout 输出）

### 3.5 Session (`lib/session.js`)

**职责**: 导入 Claude Code 会话历史

**工作原理**:
1. 将 cwd 转换为 Claude 项目 key: `/` 和 `_` → `-`
2. 读取 `~/.claude/projects/{key}/` 下最新的 `.jsonl` 文件
3. 解析 JSONL，提取 `type === "user" | "assistant"` 的文本消息
4. 返回最后 N 条（默认 20）

**注入方式**: 消息截取前 300 字符，以 `system` 角色存入上下文。

### 3.6 MCP Server (`mcp-server.js`)

**职责**: 将 Agentalk 暴露为 MCP 工具，供其他 AI 应用调用

**注册的 3 个工具**:

| Tool | 功能 | 参数 |
|------|------|------|
| `ask` | 向多个 Agent 提问 | `question`, `agents?` |
| `discuss` | 并行讨论 | `topic`, `agents?`, `max_rounds?` |
| `debate` | 串行辩论 | `topic`, `agents?`, `max_turns?` |

**传输**: StdioServerTransport（stdin/stdout 通信）

**返回格式**: 包含结论 + 完整讨论记录的 Markdown 文本

## 4. Data Flow

### 4.1 启动流程

```
index.js 启动
  ├── 解析 CLI 参数 (-c, --from-claude, inline msg)
  ├── new ContextManager(cwd)
  │     └── 可选: load() 续接 / readClaudeSession() 注入
  ├── AGENTS = buildAgents(getActiveAgents())
  │     └── loadConfig() → filter(enabled) → filter(which cmd)
  └── printBanner() → 启动 REPL
```

### 4.2 消息处理流程

```
User Input
  │
  ├─ "s" (讨论中)      → requestStop()
  ├─ "/discuss ..."    → parseDiscussArgs() → discuss()
  ├─ "/debate ..."     → parseDiscussArgs() → debate()
  ├─ "/agents ..."     → handleAgentsCommand()
  ├─ "/context"        → ctx.stats()
  ├─ "/export"         → 写 Markdown 到 ~/.agentalk/exports/
  ├─ "/inject"         → readClaudeSession() → ctx.add()
  ├─ "/clear"          → ctx.clear()
  ├─ "/save" / "/load" → ctx.save() / ctx.load()
  │
  └─ "@agent msg" / "msg"
        │
        ├── parseMentions() → 提取 @targets + prompt
        ├── 无 @ → targets = Object.keys(AGENTS)
        └── broadcast(prompt, ctx, targets)
              ├── ctx.add("user", message)
              ├── ctx.buildPrompt() → 构建含历史的完整 prompt
              ├── Promise.all(runAgent(key, prompt)) → 并行执行
              └── ctx.add(agentKey, response) → ctx.save()
```

### 4.3 Agent 执行流程

```
runAgent(key, prompt, opts)
  │
  ├── AGENTS[key].buildArgs(prompt)
  │     ├── 替换 {prompt} → 用户消息
  │     ├── 替换 {model} → 自定义模型（如有）
  │     └── 注入 model_flag（如有）
  │
  ├── spawn(cmd, args, { stdio: ["ignore","pipe","pipe"] })
  │
  ├── output === "ndjson"
  │     └── streamOpencode(): 逐行 JSON → 提取 text → 实时输出
  │
  └── output === "text"
        └── 直接读 stdout → 实时输出
  │
  └── resolve({ agent, response, error, elapsed })
```

### 4.4 上下文压缩流程

```
ctx.add(role, content)
  └── _enforceLimit()
        └── totalChars > 1,500,000 ?
              └── _compress()
                    ├── messages.length <= 20 → 截取最后 20 条
                    └── messages.length > 20
                          ├── keep_head = 前 2 条
                          ├── keep_tail = 后 10 条
                          ├── middle = 中间部分（每条截取 500 字符）
                          ├── runAgent("claude", 摘要 prompt, silent)
                          └── messages = [head, 摘要system消息, tail]
```

## 5. Key Design Decisions

### 5.1 CLI Subprocess 架构

Agentalk 不直接调用任何 LLM API，而是通过 `spawn` 调用各 Agent 的 CLI 工具。这意味着：
- 零 API key 管理 — 依赖各 CLI 自己的认证
- 新 Agent 接入只需定义 cmd + args 模板
- 每个 Agent 的输出格式独立处理（text / ndjson）

### 5.2 共享上下文而非共享对话

所有 Agent 共享同一个 `ContextManager`，但各自通过 `buildPrompt()` 获取格式化的历史，而非传递原始消息。这让每个 Agent 看到的是统一的对话格式而非其他 Agent 的原生输出结构。

### 5.3 收敛检测的双层设计

1. **Agent 自主判定**: 回复中加 `[STOP]`
2. **裁判强制判定**: Claude 审核最近几条消息判断是否收敛

两层结合避免了单 Agent 过早或过晚收敛的问题。

### 5.4 配置热合并

`loadConfig()` 每次读取时自动将新版默认 agent 合并到用户配置中，确保升级时新 Agent 自动可用（但不会覆盖用户已有的启用/禁用/模型设置）。

### 5.5 终端 / MCP 双模式

`makeOutput(capture)` 抽象让 `discuss` 和 `debate` 同时服务终端 REPL 和 MCP Server，前者实时输出到终端，后者静默收集结果返回给调用方。
