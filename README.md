# OpenClaw Mini

一个用于学习 Agent 原理的最小 OpenClaw-like 本地助手。它不是官方 OpenClaw 的兼容实现，不包含 Gateway、插件、消息渠道或多 Agent 系统，只保留最核心的“模型调用 → 工具调用 → 工具结果回填 → 继续对话”循环。

## 功能

- 本地命令行 REPL 对话
- Anthropic 与 OpenAI Provider，可通过环境变量切换
- 单一 Agent Loop，通过 Provider 适配 Anthropic Messages API 和 OpenAI Responses API
- OpenAI 默认模型为 `gpt-5.3-codex`
- 三个最小工具：
  - `calculator`：执行加、减、乘、除
  - `list_directory`：浏览 `workspace/` 内的一层目录
  - `read_text_file`：读取 `workspace/` 内的 UTF-8 文本文件
- JSONL 会话持久化，支持重启后继续同一 session
- Fake Provider 测试，不依赖真实 API Key 或网络
- TypeScript 严格类型检查

## 不包含

- 官方 OpenClaw 配置兼容
- OpenClaw Gateway / daemon
- Web UI
- Slack、Discord、Telegram 等消息渠道
- 文件写入或编辑工具
- Shell 执行
- 浏览器、网络搜索、MCP、多 Agent、记忆系统
- 流式输出、上下文压缩、模型 fallback、成本路由

## 目录结构

```text
src/
  agent-loop.ts      厂商无关的统一 Agent Loop
  cli.ts             本地命令行入口
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
```

`list_directory` 和 `read_text_file` 只能访问 `workspace/`。访问 `../`、绝对路径或通过符号链接逃逸到 workspace 外都会被拒绝。目录浏览每次只返回一层，最多返回 200 项。

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

当前版本只暴露两个无副作用工具。模型无法获得写文件、执行 shell、访问浏览器或访问 workspace 外文件的工具能力。

文件读取安全由代码强制执行：

- 拒绝绝对路径
- 拒绝 `..` 路径穿越
- 使用真实路径检查阻止符号链接逃逸
- 只允许读取普通文件
- 单文件最大读取 1 MiB

计算器不使用 `eval`，只接受结构化参数和固定四则运算。

## 测试

```bash
pnpm run typecheck
pnpm test
pnpm run build
```

当前测试覆盖：

- 普通模型文本回复
- 单工具调用
- 多工具并行调用
- 目录浏览、排序、非递归和数量上限
- 工具错误转为 `tool_result` 错误
- OpenAI reasoning item 回放和 `function_call_output`
- refusal 和迭代上限
- workspace 文件读取边界
- JSONL 会话保存与加载

## 当前定位

这个项目适合作为最小 Agent Loop 学习样例。后续如果要继续扩展，建议按顺序增加：

1. 流式输出
2. 更完整的工具确认机制
3. 文件编辑工具
4. 上下文压缩或摘要
5. 多模型或 fallback
6. Web UI
