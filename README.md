# OpenClaw Mini

一个用于学习 Agent 原理的最小 OpenClaw-like 本地助手。它不是官方 OpenClaw 的兼容实现，不包含 Gateway、插件、消息渠道或多 Agent 系统，只保留最核心的“模型调用 → 工具调用 → 工具结果回填 → 继续对话”循环。

## 功能

- 本地命令行 REPL 对话，支持状态、历史、手动压缩和清空等内置命令
- 本地 Web 对话，可选择、新建并回放 Session 历史
- 模型文本流式输出，显示工具确认、执行中、完成和失败状态
- Anthropic 与 OpenAI Provider，可通过环境变量切换
- 单一 Agent Loop，通过 Provider 适配 Anthropic Messages API 和 OpenAI Responses API
- OpenAI 默认模型为 `gpt-5.3-codex`
- 启动时读取 `workspace/AGENTS.md`，作为 CLI 与 Web 共用的工作区指令
- 从项目根目录的 `mcp.json` 连接 stdio 或 Streamable HTTP MCP Server，并动态加载工具
- 十五个本地工具；OpenAI 模式额外启用 Responses API 原生 Web Search：
  - `calculator`：执行加、减、乘、除
  - `list_directory`：浏览 `workspace/` 内的一层目录
  - `find_files`：按 glob 递归查找 `workspace/` 内的文件路径
  - `search_files`：递归搜索 `workspace/` 内的文本内容
  - `read_text_file`：读取 `workspace/` 内的 UTF-8 文本文件
  - `memory_search`：用 SQLite FTS5/BM25 与可选 Embedding 混合检索全部 Markdown 记忆
  - `memory_get`：从 Markdown 真相源读取精确行范围
  - `git_status`：查看 `workspace/` 内 Git 仓库的分支和文件状态
  - `git_diff`：查看 `workspace/` 内 Git 仓库的暂存或未暂存差异
  - `create_directory`：确认后递归创建 `workspace/` 内的目录
  - `write_text_file`：确认后创建或覆盖 `workspace/` 内的 UTF-8 文本文件
  - `edit_text_file`：确认后精确替换现有文本文件中的唯一内容块
  - `apply_patch`：确认后用统一补丁新增或更新一个或多个文件
  - `web_search`：OpenAI 模式下由 Responses API 原生搜索公网信息
  - `fetch_url`：确认后读取公网 HTTP/HTTPS URL 的文本内容
  - `run_command`：确认后从 `workspace/` 启动 Shell 命令，用于构建、测试和代码检查
- JSONL 会话持久化，支持重启后继续同一 session
- 用户可管理的长期记忆，独立保存并在所有 Session 中生效
- `/memory consolidate` 可预览并确认把近期每日记忆去重、整理到长期 `MEMORY.md`
- 长会话自动摘要压缩，压缩前把摘要写入每日记忆，并保留最近完整轮次和工具调用链
- Fake Provider 测试，不依赖真实 API Key 或网络
- TypeScript 严格类型检查

## 不包含

- 官方 OpenClaw 配置兼容
- OpenClaw Gateway / daemon
- Slack、Discord、Telegram 等消息渠道
- 文件删除或重命名工具
- 浏览器、多 Agent
- 模型 fallback、成本路由

## 目录结构

```text
src/
  apply-patch.ts     多文件补丁解析、预检和应用逻辑
  agent-loop.ts      厂商无关的统一 Agent Loop
  cli-commands.ts    CLI 命令解析、帮助和安全历史格式化
  cli.ts             本地命令行入口
  context-compaction.ts 上下文估算、压缩阈值和保留策略
  embedding.ts       OpenAI Embeddings HTTP 客户端和向量检索配置
  fetch-url.ts       公网文本请求、DNS 固定和 SSRF 防护
  git-tools.ts       只读 Git 状态、差异和进程安全边界
  mcp.ts             MCP 配置、stdio/HTTP 连接、工具发现与调用适配
  memory-index.ts    Markdown 分块、FTS5/BM25 与向量混合检索
  memory-flush.ts    压缩摘要的每日记忆落盘、去重和并发写入
  memory-consolidation.ts 每日记忆到 MEMORY.md 的提案、校验和确认写入
  workspace-memory.ts workspace/MEMORY.md 的加载、校验和注入预算
  provider.ts        Anthropic 与 OpenAI Provider 适配器
  runtime.ts         CLI 与 Web 共用的 Provider、模型和 Agent 组装逻辑
  session-history.ts 两种 Provider 原生历史到安全展示视图的转换
  session-store.ts   JSONL 会话存储
  tools.ts           工具定义与执行逻辑
  workspace-instructions.ts 工作区 AGENTS.md 的加载、校验和提示词组装
  web.ts             本地 Web 服务入口
  web-server.ts      HTTP、SSE、Session 并发和工具确认接口
  web-page.ts        无框架的单页聊天界面

test/
  agent-loop.test.ts     Agent Loop 测试
  apply-patch.test.ts    多文件补丁和安全边界测试
  cli-commands.test.ts   CLI 命令解析和历史格式化测试
  embedding.test.ts      Embeddings HTTP 请求、批处理和配置测试
  openai-adapter.test.ts OpenAI 适配器测试
  openai-provider.test.ts OpenAI HTTP Provider 测试
  fake-provider.ts       测试用 Fake Provider
  fetch-url.test.ts      URL、重定向、地址和内容边界测试
  git-tools.test.ts      临时 Git 仓库与只读边界测试
  mcp.test.ts            MCP 配置、工具发现、调用与关闭测试
  memory-index.test.ts   记忆索引、同步、搜索和原文读取测试
  memory-flush.test.ts   压缩前记忆落盘、去重和安全边界测试
  memory-consolidation.test.ts 长期记忆整理、并发保护和凭据拦截测试
  workspace-memory.test.ts MEMORY.md 加载、UTF-8 边界和截断测试
  session-store.test.ts  会话存储测试
  session-history.test.ts 会话历史展示转换测试
  tools.test.ts          工具边界测试
  web-server.test.ts     Web、SSE 和浏览器确认测试
  workspace-instructions.test.ts 工作区指令加载与安全边界测试

workspace/            Agent 可读取的工作区
data/                 本地会话历史和可重建记忆索引，已被 .gitignore 忽略
```

## 安装

要求 Node.js 22 或更高版本。

```bash
pnpm install
```

## Provider 配置

默认使用 Anthropic：

```bash
export OPENCLAW_PROVIDER="anthropic"
export ANTHROPIC_API_KEY="你的 API Key"
```

使用 OpenAI：

```bash
export OPENCLAW_PROVIDER="openai"
export OPENAI_API_KEY="你的 OpenAI Platform API Key"
```

Windows PowerShell：

```powershell
$env:OPENCLAW_PROVIDER="openai"
$env:OPENAI_API_KEY="你的 OpenAI Platform API Key"
```

Codex CLI 或 ChatGPT 登录状态不等同于 OpenAI Platform API Key，本项目不会读取 Codex CLI 登录凭据。

可以覆盖模型：

```bash
export OPENCLAW_MODEL="gpt-5.3-codex"
```

OpenAI Provider 也支持 `OPENAI_MODEL`，但 `OPENCLAW_MODEL` 优先级更高。

### MCP 配置

复制项目中的 `mcp.example.json` 为根目录下的 `mcp.json`。支持本地 stdio 和远程 Streamable HTTP MCP Server；没有这个文件时不会启动 MCP，也不影响普通工具。本地 `mcp.json` 已加入 `.gitignore`，避免其中的凭据被误提交：

```json
{
  "mcpServers": {
    "filesystem": {
      "transport": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "workspace"
      ]
    }
  }
}
```

启动后会显示加载数量，例如：

```text
MCP: 1 server(s), 14 tool(s)
```

MCP 工具以 `mcp__服务名__工具名` 暴露给模型，例如 `mcp__filesystem__read_file`；不兼容厂商命名限制的名称会被安全清洗并附加短哈希。为避免第三方 Server 未声明或错误声明副作用，所有 MCP 工具默认都需要人工确认。单次工具结果最多回填 256 KiB，图片和音频二进制不会写入文本会话。stdio 配置支持可选的 `args`、`cwd`、`env`、`enabled` 和 `timeoutMs` 字段：

```json
{
  "mcpServers": {
    "demo": {
      "transport": "stdio",
      "command": "node",
      "args": ["tools/demo-mcp.js"],
      "cwd": ".",
      "env": { "DEMO_MODE": "local" },
      "enabled": true,
      "timeoutMs": 30000
    }
  }
}
```

Streamable HTTP 示例：

```json
{
  "mcpServers": {
    "remote": {
      "transport": "streamable-http",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "X-Tenant-ID": "demo"
      },
      "token": "your-bearer-token",
      "timeoutMs": 15000,
      "enabled": true
    }
  }
}
```

`token` 会转成 `Authorization: Bearer ...`；如果服务使用其他认证方式，也可直接在 `headers` 里配置 `Authorization`，但不能与 `token` 同时使用。`timeoutMs` 是连接、发现工具和调用工具的单次请求超时，默认 30000 ms，范围 1–120000 ms。请只连接你信任的 URL，自定义请求头会随每个 MCP HTTP 请求发送。

不写 `transport` 时，存在 `command` 会按 stdio 处理，存在 `url` 会按 Streamable HTTP 处理，因此原有 stdio 配置无需修改。`command` 会直接启动进程，不经过 Shell；`cwd` 相对于项目根目录解析。修改配置后需要重启 CLI/Web。CLI 和 Web 退出时会关闭 MCP 连接；Web 的多个 Session 共享连接，不会为每个 Session 重复连接。`/mcp` 只显示 Server 名和工具，不显示 URL、Header 或 Token。

### 工作区指令

可以在 workspace 根目录创建 `AGENTS.md`，为模型提供当前项目的长期约定：

```markdown
# 项目约定

- 使用 TypeScript
- 修改后运行 pnpm test
- 用中文说明结果
```

CLI 和 Web 启动时读取这一份文件，并把内容和默认系统提示词一起传给当前 Provider。启动信息中的 `Instructions: AGENTS.md (N bytes)` 表示加载成功；`Instructions: not found` 表示文件不存在。Web 页面顶部也会显示对应状态。

只读取 `workspace/AGENTS.md`，不会递归查找子目录或父目录。文件必须是最大 32 KiB 的普通 UTF-8 文本，符号链接、目录、NUL 二进制内容和非法 UTF-8 会使启动失败。指令不会写入 Session JSONL，也不参与会话压缩；修改文件后需要重启 CLI 或 Web 才会生效。

### 长期记忆

长期记忆使用 OpenClaw 风格的 Markdown 真相源：`workspace/MEMORY.md`。可以直接编辑：

```markdown
# Long-term memory

- Prefer TypeScript for new projects.
- Run tests before reporting completion.
```

第二层是每日记忆，用于保存详细运行上下文、观察和当日记录：

```text
workspace/memory/
  2026-08-12.md
  2026-08-13.md
  2026-08-13-session-a.md
```

Agent 会自动加载本机日期中今天和昨天的 `YYYY-MM-DD.md` 以及同日 slug 变体。更早文件继续保留在磁盘，但不在这一阶段自动注入。每日记忆最多加载 20 个文件，所有加载文件共享 32 KiB 注入预算，预算不足时优先今天。

可以在对话中说“记住我喜欢 TypeScript”或“把今天的调试结果记录下来”。Agent 会根据内容选择精炼的 `MEMORY.md` 或当日 `memory/YYYY-MM-DD.md`，并调用 workspace 文件工具创建或编辑；模型主动发起的文件写入仍需用户确认。压缩前 Memory Flush 是用户启用压缩流程后由宿主执行的固定路径追加，不经过通用写文件工具确认。`/memory` 和 Web 页面的“查看记忆”会展示当前注入的长期与每日记忆。

AgentLoop 在每次模型调用前重新读取这两层文件，因此手工或工具编辑后无需重启。记忆在 Anthropic/OpenAI 和所有 Session 中共享，不写入 Session JSONL，也不会被会话压缩。磁盘原文不会被截断；`MEMORY.md` 另有 32 KiB 注入预算。

启动时会把 `MEMORY.md` 和所有直属 `memory/*.md` 分块写入 `data/memory/index.sqlite`。`memory_search` 使用 SQLite FTS5 trigram tokenizer 和 BM25 排序，因此可以找到未注入提示词的旧日期记录；不足 3 个字符的短查询会回退为字面量匹配。找到候选后，`memory_get` 直接从 Markdown 原文读取指定行，不把 SQLite 当作真相源。每次搜索前都会用 SHA-256 检查文件变化，文件工具写入后还会触发 250 ms 防抖同步；数据库被删除或 schema 变化时可自动重建。

配置 `OPENAI_API_KEY` 后，`memory_search` 还会按照 [OpenAI 官方 Embeddings 指南](https://developers.openai.com/api/docs/guides/embeddings) 使用 `text-embedding-3-small` 生成文档和查询向量，以余弦相似度补充语义召回，再与 BM25 名次加权合并。文档向量按“分块内容 Hash + 模型配置”缓存在同一个 SQLite 中，未修改的记忆不会重复生成；查询向量在进程内最多缓存 100 条。Embedding 请求失败、响应异常或没有 Key 时自动退回本地 BM25，不影响普通对话和关键词检索。

向量检索配置：

```bash
export OPENCLAW_EMBEDDING_MODEL="text-embedding-3-small"
export OPENCLAW_MEMORY_VECTOR_WEIGHT="0.5"
```

`OPENCLAW_MEMORY_VECTOR_WEIGHT` 范围为 0–1，`0` 表示只用关键词。可选的 `OPENCLAW_EMBEDDING_DIMENSIONS` 会传给支持缩短向量的第三代 Embedding 模型；`OPENCLAW_MEMORY_EMBEDDINGS=false` 可以完全关闭向量检索。Anthropic 对话模式也可单独配置 `OPENAI_API_KEY` 使用这项能力。

启用向量检索后，第一次搜索会把尚未缓存的记忆分块以及本次查询发送到 `OPENAI_BASE_URL` 对应的 Embeddings API；之后未变化的文档分块从本地缓存复用。记忆含敏感信息且不希望发送到远端时，请设置 `OPENCLAW_MEMORY_EMBEDDINGS=false`。

### 上下文压缩配置

历史记录默认超过约 320,000 tokens 时，会在下一轮开始前调用当前 Provider 生成早期会话摘要，并保留最近 4 个完整用户轮次。可通过环境变量调整：

```bash
export OPENCLAW_COMPACT_THRESHOLD="320000"
export OPENCLAW_COMPACT_KEEP_TURNS="4"
export OPENCLAW_COMPACT_SUMMARY_TOKENS="2000"
```

token 数是根据原生历史 JSON 的 UTF-8 大小估算，不是模型 tokenizer 的精确计数。压缩切分点只选在真实用户消息之前，不会拆开工具调用和工具结果。

自动压缩和 `/compact` 在摘要生成后、Session 历史真正替换前，会把同一份摘要追加到本地日期对应的 `workspace/memory/YYYY-MM-DD.md`。每段包含内容 Hash 标记，相同摘要不会重复写入；多个 Web Session 并发压缩时通过共享队列串行追加。落盘不会额外调用模型，写入后会调度 FTS5 索引同步。每日记忆不可写、过大或格式异常时会显示失败状态，但不会阻止原有上下文压缩。摘要提示词明确禁止保存 API Key、Token、密码、Cookie 等凭据。

`/memory consolidate` 会读取当前 `MEMORY.md` 和按文件名选择的最近 20 个直属 `memory/*.md`，使用当前对话 Provider 发起一次不带工具、也不写入 Session 历史的整理请求。模型只能返回完整的新 `MEMORY.md` 或 `NO_CHANGES`；宿主会校验 UTF-8、大小和常见凭据模式，再展示完整替换预览。只有明确输入 `y` 或 `yes` 才会原子更新长期记忆，且确认前若 `MEMORY.md` 已被编辑器或其他 Session 修改，会拒绝覆盖并要求重新整理。第一版不会删除、改写或归档任何每日记忆。

### Shell 工具配置

Shell 命令默认最多运行 30 秒，可通过环境变量缩短或延长，最大不能超过 120 秒：

```bash
export OPENCLAW_COMMAND_TIMEOUT_MS="30000"
```

### Anthropic SDK profile

如果本机配置了 Anthropic SDK 可识别的本地 profile，也可以使用对应凭据。

## 运行

### 命令行

启动默认会话：

```bash
pnpm dev
```

启动指定会话：

```bash
pnpm dev -- --session smoke
```

输入 `/help` 可以查看全部内置命令：

```text
/help       查看命令帮助
/status     查看当前 Provider、模型、Session、workspace 和指令状态
/history    查看当前 Session 的安全历史视图
/mcp        查看已连接的 MCP Server 和工具
/memory     查看长期记忆
/memory consolidate 预览并确认把每日记忆整理到 MEMORY.md
/compact    保存压缩前记忆并手动压缩早期会话历史
/clear      清空当前 Session 历史（需要确认）
/exit       退出
```

未知的 `/命令` 不会发送给模型。需要参数的命令会在 `/help` 中标出，命令名不区分大小写。

`/mcp` 显示启动时已经连接的 Server，并按 Server 分组列出模型实际可见的 MCP 工具名称和描述。它不会重新启动 Server、重新发现工具或执行工具，也不会展示 `mcp.json` 中的命令、环境变量和凭据。

`/history` 与 Web 使用相同的安全历史视图，不展示 OpenAI reasoning、Anthropic thinking、工具参数或工具输出；最多显示 200 项，每条长文本最多显示 2,000 个字符。

`/compact` 会跳过自动压缩的 token 阈值，但仍遵守最近轮次保留规则；默认至少需要超过 4 个完整用户轮次才有早期历史可压缩。`/clear` 只有明确输入 `y` 或 `yes` 才执行，并会同时清空当前 Agent 的内存历史和对应 Provider 的 Session JSONL。两项操作都不会影响其他 Session。

模型生成的文本会直接流式显示。发生工具调用时，终端会显示执行状态：

```text
[工具] list_directory 执行中...
[工具] list_directory 完成
workspace 中包含 note.txt。
```

触发上下文压缩时，终端会显示：

```text
[会话] 正在压缩上下文（约 328400 tokens）...
[会话] 上下文压缩完成（328400 → 62100 tokens）
```

`calculator`、`list_directory`、`find_files`、`search_files`、`read_text_file`、`memory_search`、`memory_get`、`git_status` 和 `git_diff` 是无副作用工具，会自动执行。`create_directory`、`write_text_file`、`edit_text_file`、`apply_patch`、`fetch_url` 和 `run_command` 具有副作用，每次执行前都会显示调用参数并询问：

```text
[工具] write_text_file 等待确认
参数:
{
  "path": "note.txt",
  "content": "hello"
}
允许执行 write_text_file？[y/N]
```

只有输入 `y` 或 `yes` 才会允许；直接回车、其他输入、确认回调缺失或异常都会按拒绝处理。

### Web UI

启动本地 Web 服务：

```bash
pnpm web
```

然后打开：

```text
http://127.0.0.1:3000
```

页面会显示当前 Provider、模型和 workspace，可以选择已有 Session 或新建 Session。模型回复通过 POST 请求的 SSE 响应流式显示；遇到受保护工具时，当前轮次会暂停，只有点击“允许”或“拒绝”后才会继续。刷新页面或切换 Session 时，会从对应 JSONL 回放用户消息、助手回复、压缩摘要和工具完成状态。

历史接口不会把 Provider 原生数据直接发给浏览器：OpenAI reasoning、Anthropic thinking、工具参数和工具输出都会过滤。页面最多回放 200 项；历史更长时保留压缩摘要并优先展示最近内容。

监听地址和端口可以配置：

```bash
export OPENCLAW_WEB_HOST="127.0.0.1"
export OPENCLAW_WEB_PORT="3000"
```

默认只监听本机回环地址。Web UI 没有用户账户和登录认证，不要在不可信网络中把 `OPENCLAW_WEB_HOST` 设置为 `0.0.0.0`。

## 使用示例

计算：

```text
> 计算 12 * 7
```

读取 workspace 文件：

```bash
mkdir -p workspace
printf "hello mini agent" > workspace/note.txt
pnpm dev -- --session demo
```

然后在 REPL 中输入：

```text
> 查看 workspace 里有哪些文件
> 找到所有 TypeScript 测试文件
> 在所有 TypeScript 文件中搜索 OPENAI_API_KEY
> 读取 note.txt 并总结内容
> 创建 src/components 目录
> 创建 hello.txt，内容是 Hello World
> 把 config.txt 中的 port=3000 改成 port=8080
> 用一个补丁同时修改 config.txt 和 README.md
> 查看当前 Git 状态和 src/tools.ts 的未暂存差异
> 搜索 OpenAI Responses API 最近的更新，并列出来源
> 获取 https://example.com/data.json 并总结内容
> 运行 pnpm test 并分析失败原因
```

`list_directory`、`find_files`、`search_files`、`read_text_file`、`create_directory`、`write_text_file`、`edit_text_file` 和 `apply_patch` 只能访问 `workspace/`。访问 `../`、绝对路径或通过符号链接逃逸到 workspace 外都会被拒绝。目录浏览每次只返回一层，最多返回 200 项；文件查找支持 `*`、`**` 和 `?`，默认最多返回 100 条、最高 500 条路径；文本搜索会递归扫描，支持 `**/*.ts` 形式的文件过滤，默认最多返回 50 条、最高 200 条匹配；目录创建会递归补齐缺失的父目录，目标已存在时安全返回；文本读写上限为 1 MiB。写入新文件时，父目录必须已存在。精确编辑只有在 `old_text` 唯一匹配时才会执行。

`apply_patch` 使用 `*** Begin Patch` / `*** End Patch` 格式，支持 `*** Add File:` 和 `*** Update File:`，同一更新文件可以包含多个 `@@` hunk。第一版不支持删除文件；新增文件的父目录必须已经存在。所有路径和 hunk 会在写盘前统一校验，任一上下文缺失或重复时整批拒绝。单个补丁和每个补丁结果文件最大均为 1 MiB。

`git_status` 和 `git_diff` 只允许检查顶层目录位于 `workspace/` 内的非裸 Git 仓库。它们直接启动 Git 而不经过 Shell，并关闭 pager、外部 diff、textconv、fsmonitor、全局/系统配置和可选索引写锁。`git_diff` 默认最多返回 64 KiB，最高可请求 256 KiB；可指定一个仓库相对文件，也可查看全部暂存或未暂存差异。

`web_search` 仅在 `OPENCLAW_PROVIDER=openai` 时启用，直接作为 `{ "type": "web_search" }` 传给 OpenAI Responses API。搜索由 OpenAI 在模型响应内部执行，不需要 Brave Key，也不经过本地工具确认；鉴权仍使用现有的 `OPENAI_API_KEY`。Anthropic Messages API 没有复用这项 OpenAI 原生能力。

`fetch_url` 只接受不含用户名密码的公网 HTTP/HTTPS URL，每次调用都需确认。它会解析并检查全部 DNS 地址，把连接固定到已验证的公网 IP，并对每次重定向重新验证，以阻止 localhost、内网、链路本地、云元数据地址和 DNS rebinding。请求总超时 15 秒，最多跟随 5 次重定向；只接受 UTF-8/ASCII 文本、JSON、XML 等文本响应，不携带 Cookie 或 API Key，也不使用系统代理。正文默认最多返回 64 KiB，最高 256 KiB。

`run_command` 固定从 `workspace/` 启动，但这只是初始工作目录，并不是文件系统沙箱：Shell 命令仍可能通过绝对路径或 `..` 访问 workspace 外部。因此该工具不会自动放行，每次调用都必须人工确认。子进程不接收交互式 stdin；默认超时 30 秒，最长可配置为 120 秒；stdout 和 stderr 各最多返回 64 KiB，超出部分会标记为截断。常见的 Key、Token、Password、Cookie、Session 等敏感环境变量不会传给子进程。

OpenAI 和 Anthropic 使用独立目录保存会话；相同 `--session` 名称不会混用两种 API 的历史格式：

```text
data/sessions/anthropic/default.jsonl
data/sessions/openai/default.jsonl
```

启动 Anthropic CLI 或 Web 服务时，旧版本位于 `data/sessions/*.jsonl` 的合法会话文件会自动迁移到 `data/sessions/anthropic/`。如果新目录已经存在同名文件，旧文件会保留在原位置，不会覆盖新会话。

CLI 运行期可以管理当前 Provider 的会话：

```text
/sessions         列出会话，`*` 表示当前会话
/new work         创建并切换到 work
/switch default   切换到已有会话
/rename project   把当前会话重命名为 project
/delete old       确认后删除 old
```

切换会话只会重新加载对应 JSONL 历史，不会重复启动或连接 MCP Server。重命名不会覆盖同名会话；删除当前会话后会自动切换到剩余会话，没有剩余会话时创建空的 `default`。Web 页面的新建、重命名和删除按钮使用同一套存储规则。

## 脚本

```bash
pnpm dev          启动 TypeScript REPL
pnpm web          启动 TypeScript Web UI
pnpm build        编译到 dist/
pnpm start        运行编译后的 CLI
pnpm start:web    运行编译后的 Web UI
pnpm typecheck    TypeScript 类型检查
pnpm test         运行测试
```

## 安全边界

当前版本暴露九个自动放行工具，以及六个每次都需确认的目录创建、文件修改、网络和 Shell 工具。OpenAI 模式还启用由 Responses API 托管的原生 Web Search。模型无法控制浏览器；文件工具无法读写 workspace 外文件。

工具权限采用安全默认值：已登记的纯计算和只读工具自动放行，所有未登记工具都必须经过用户确认。拒绝后不会调用工具实现，而是把拒绝结果回填给模型，让模型继续回复。

文件读取安全由代码强制执行：

- 拒绝绝对路径
- 拒绝 `..` 路径穿越
- 使用真实路径检查阻止符号链接逃逸
- 只允许读取普通文件
- 单文件最大读取 1 MiB

计算器不使用 `eval`，只接受结构化参数和固定四则运算。

Shell 工具只把确认过的命令交给系统 Shell。它会清理常见凭据类环境变量并限制运行时间和返回内容大小，但不提供容器或操作系统级隔离。执行命令前应按终端显示的完整参数判断是否允许。

Web 服务默认绑定 `127.0.0.1`，JSON 写接口只接受 `application/json`。每个 Session 同时只运行一个轮次，防止并发请求打乱内存历史和 JSONL 追加顺序；浏览器断开时，仍在等待的工具确认会自动按拒绝处理。不要让 CLI 和 Web 同时使用同一个 Session，因为当前 JSONL 存储没有跨进程文件锁。

## 测试

```bash
pnpm run typecheck
pnpm test
pnpm run build
```

当前测试覆盖：

- Anthropic 与 OpenAI 文本增量转发
- OpenAI Responses API SSE 分块解析
- 工具开始、完成和失败事件
- 安全工具自动放行，受保护工具允许、拒绝和缺省拒绝
- 普通模型文本回复
- 单工具调用
- 多工具并行调用
- 目录浏览、排序、非递归和数量上限
- 文件递归查找、glob 过滤、结果上限和路径边界
- 文本递归搜索、glob 过滤、结果上限和路径边界
- 工具错误转为 `tool_result` 错误
- OpenAI reasoning item 回放和 `function_call_output`
- refusal 和迭代上限
- workspace 文件读取边界
- workspace 目录递归创建、幂等结果和路径边界
- workspace 文件创建、覆盖、大小上限和写入边界
- workspace 文件唯一内容块替换及零匹配、多匹配保护
- 多文件补丁、新增文件、多 hunk、换行保留、预检失败零落盘和路径边界
- Git 分支/文件状态、暂存/未暂存差异、UTF-8 截断和仓库边界
- HTTP/HTTPS 文本获取、逐跳重定向校验、SSRF 地址阻断、字符集和大小限制
- OpenAI Responses API 原生 Web Search 工具注入与本地函数工具隔离
- stdio/Streamable HTTP MCP 配置解析、动态工具发现、双 Provider 定义适配、调用错误和连接关闭
- Shell 命令的工作目录、退出码、超时、输出截断和敏感环境变量清理
- Web 配置与 Session 接口、SSE 文本流和浏览器工具确认
- Anthropic/OpenAI 会话历史统一展示与内部数据过滤
- Anthropic 和 OpenAI 历史摘要压缩与最近工具链保留
- Markdown 记忆的 SQLite FTS5/BM25 + Embedding 混合检索、向量缓存、失败降级和按行读取
- CLI 命令解析、安全历史展示、阈值外手动压缩和原子清空
- 压缩后 JSONL 历史原子替换
- 旧 Anthropic 会话向独立目录的无覆盖迁移
- JSONL 会话保存与加载
- workspace 根目录指令的加载、提示词注入、大小与文本格式边界

## 当前定位

这个项目适合作为最小 Agent Loop 学习样例。后续如果要继续扩展，建议按顺序增加：

1. 在 Web UI 中重命名和删除 Session
