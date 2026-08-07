# OpenClaw Mini

一个用于学习 Agent 原理的最小 OpenClaw-like 本地助手。它不是官方 OpenClaw 的兼容实现，不包含 Gateway、插件、消息渠道或多 Agent 系统，只保留最核心的“模型调用 → 工具调用 → 工具结果回填 → 继续对话”循环。

## 功能

- 本地命令行 REPL 对话
- 模型文本流式输出，显示工具确认、执行中、完成和失败状态
- Anthropic 与 OpenAI Provider，可通过环境变量切换
- 单一 Agent Loop，通过 Provider 适配 Anthropic Messages API 和 OpenAI Responses API
- OpenAI 默认模型为 `gpt-5.3-codex`
- 六个最小工具：
  - `calculator`：执行加、减、乘、除
  - `list_directory`：浏览 `workspace/` 内的一层目录
  - `read_text_file`：读取 `workspace/` 内的 UTF-8 文本文件
  - `write_text_file`：确认后创建或覆盖 `workspace/` 内的 UTF-8 文本文件
  - `edit_text_file`：确认后精确替换现有文本文件中的唯一内容块
  - `run_command`：确认后从 `workspace/` 启动 Shell 命令，用于构建、测试和代码检查
- JSONL 会话持久化，支持重启后继续同一 session
- 长会话自动摘要压缩，保留最近完整轮次和工具调用链
- Fake Provider 测试，不依赖真实 API Key 或网络
- TypeScript 严格类型检查

## 不包含

- 官方 OpenClaw 配置兼容
- OpenClaw Gateway / daemon
- Web UI
- Slack、Discord、Telegram 等消息渠道
- 文件删除或重命名工具
- 浏览器、网络搜索、MCP、多 Agent、记忆系统
- 模型 fallback、成本路由

## 目录结构

```text
src/
  agent-loop.ts      厂商无关的统一 Agent Loop
  cli.ts             本地命令行入口
  context-compaction.ts 上下文估算、压缩阈值和保留策略
  provider.ts        Anthropic 与 OpenAI Provider 适配器
  session-store.ts   JSONL 会话存储
  tools.ts           工具定义与执行逻辑

test/
  agent-loop.test.ts     Agent Loop 测试
  openai-adapter.test.ts OpenAI 适配器测试
  openai-provider.test.ts OpenAI HTTP Provider 测试
  fake-provider.ts       测试用 Fake Provider
  session-store.test.ts  会话存储测试
  tools.test.ts          工具边界测试

workspace/            Agent 可读取的工作区
data/                 本地会话历史，已被 .gitignore 忽略
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

### 上下文压缩配置

历史记录默认超过约 32,000 tokens 时，会在下一轮开始前调用当前 Provider 生成早期会话摘要，并保留最近 4 个完整用户轮次。可通过环境变量调整：

```bash
export OPENCLAW_COMPACT_THRESHOLD="32000"
export OPENCLAW_COMPACT_KEEP_TURNS="4"
export OPENCLAW_COMPACT_SUMMARY_TOKENS="2000"
```

token 数是根据原生历史 JSON 的 UTF-8 大小估算，不是模型 tokenizer 的精确计数。压缩切分点只选在真实用户消息之前，不会拆开工具调用和工具结果。

### Shell 工具配置

Shell 命令默认最多运行 30 秒，可通过环境变量缩短或延长，最大不能超过 120 秒：

```bash
export OPENCLAW_COMMAND_TIMEOUT_MS="30000"
```

### Anthropic SDK profile

如果本机配置了 Anthropic SDK 可识别的本地 profile，也可以使用对应凭据。

## 运行

启动默认会话：

```bash
pnpm dev
```

启动指定会话：

```bash
pnpm dev -- --session smoke
```

退出：

```text
/exit
```

模型生成的文本会直接流式显示。发生工具调用时，终端会显示执行状态：

```text
[工具] list_directory 执行中...
[工具] list_directory 完成
workspace 中包含 note.txt。
```

触发上下文压缩时，终端会显示：

```text
[会话] 正在压缩上下文（约 32840 tokens）...
[会话] 上下文压缩完成（32840 → 6210 tokens）
```

`calculator`、`list_directory` 和 `read_text_file` 是无副作用工具，会自动执行。`write_text_file`、`edit_text_file` 和 `run_command` 具有副作用，每次执行前都会显示调用参数并询问：

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
> 读取 note.txt 并总结内容
> 创建 hello.txt，内容是 Hello World
> 把 config.txt 中的 port=3000 改成 port=8080
> 运行 pnpm test 并分析失败原因
```

`list_directory`、`read_text_file`、`write_text_file` 和 `edit_text_file` 只能访问 `workspace/`。访问 `../`、绝对路径或通过符号链接逃逸到 workspace 外都会被拒绝。目录浏览每次只返回一层，最多返回 200 项；文本读写上限为 1 MiB。写入新文件时，父目录必须已存在。精确编辑只有在 `old_text` 唯一匹配时才会执行。

`run_command` 固定从 `workspace/` 启动，但这只是初始工作目录，并不是文件系统沙箱：Shell 命令仍可能通过绝对路径或 `..` 访问 workspace 外部。因此该工具不会自动放行，每次调用都必须人工确认。子进程不接收交互式 stdin；默认超时 30 秒，最长可配置为 120 秒；stdout 和 stderr 各最多返回 64 KiB，超出部分会标记为截断。常见的 Key、Token、Password、Cookie、Session 等敏感环境变量不会传给子进程。

OpenAI 和 Anthropic 使用独立的会话文件；相同 `--session` 名称不会混用两种 API 的历史格式。

## 脚本

```bash
pnpm dev          启动 TypeScript REPL
pnpm build        编译到 dist/
pnpm start        运行编译后的 CLI
pnpm typecheck    TypeScript 类型检查
pnpm test         运行测试
```

## 安全边界

当前版本暴露三个自动放行工具，以及两个文本修改工具和一个每次都需确认的 Shell 工具。模型无法访问浏览器；文件工具无法读写 workspace 外文件。

工具权限采用安全默认值：已登记的纯计算和只读工具自动放行，所有未登记工具都必须经过用户确认。拒绝后不会调用工具实现，而是把拒绝结果回填给模型，让模型继续回复。

文件读取安全由代码强制执行：

- 拒绝绝对路径
- 拒绝 `..` 路径穿越
- 使用真实路径检查阻止符号链接逃逸
- 只允许读取普通文件
- 单文件最大读取 1 MiB

计算器不使用 `eval`，只接受结构化参数和固定四则运算。

Shell 工具只把确认过的命令交给系统 Shell。它会清理常见凭据类环境变量并限制运行时间和返回内容大小，但不提供容器或操作系统级隔离。执行命令前应按终端显示的完整参数判断是否允许。

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
- 工具错误转为 `tool_result` 错误
- OpenAI reasoning item 回放和 `function_call_output`
- refusal 和迭代上限
- workspace 文件读取边界
- workspace 文件创建、覆盖、大小上限和写入边界
- workspace 文件唯一内容块替换及零匹配、多匹配保护
- Shell 命令的工作目录、退出码、超时、输出截断和敏感环境变量清理
- Anthropic 和 OpenAI 历史摘要压缩与最近工具链保留
- 压缩后 JSONL 历史原子替换
- JSONL 会话保存与加载

## 当前定位

这个项目适合作为最小 Agent Loop 学习样例。后续如果要继续扩展，建议按顺序增加：

1. Web UI
