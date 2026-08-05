import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs/promises";
import path from "node:path";

// 直接复用 SDK 的 Tool 类型，确保工具定义形状和 Anthropic SDK 保持一致。
// 不额外声明自定义 Tool interface，可以避免 SDK 升级后字段含义或类型漂移。
export type ToolDefinition = Anthropic.Tool;

export interface OpenAIToolDefinition {
  type: "function";
  name: string;
  description: string;
  parameters: Anthropic.Tool["input_schema"];
  strict: boolean;
}

// ToolContext 是工具执行时的可信上下文，由宿主程序提供，不由模型决定。
// 目前只包含 workspaceRoot；模型只能提供相对路径，不能指定根目录。
// 如果后续加入权限确认、审计日志、用户 ID，也应该从这里传入。
export interface ToolContext {
  workspaceRoot: string;
}

// read_text_file 的模型输入结构。
// 只允许一个 workspace 相对路径，避免工具层出现“读取任意 URL / 任意绝对路径”的能力扩张。
interface ReadTextFileInput {
  path: string;
}

// list_directory 的模型输入结构。
// 和 read_text_file 一样只接受 workspace 相对路径；使用 "." 表示 workspace 根目录。
interface ListDirectoryInput {
  path: string;
}

// calculator 的模型输入结构。
// operation 使用联合类型限定四则运算，避免接收表达式字符串后被迫 eval。
interface CalculatorInput {
  operation: "add" | "subtract" | "multiply" | "divide";
  a: number;
  b: number;
}

// 单次读取 1 MiB 是刻意的 MVP 限制。
// 它既能防止误读大文件撑爆上下文，也让工具错误更容易解释和测试。
const MAX_FILE_BYTES = 1024 * 1024;

// 限制单次目录列表的规模，防止大型目录一次性占满模型上下文。
const MAX_DIRECTORY_ENTRIES = 200;

// 这是传给 Claude 的工具清单，也是模型“看得见”的全部外部能力。
// 工具描述不仅说明工具做什么，也说明什么时候应该调用，帮助模型减少误用。
// strict: true 要求模型按 JSON Schema 生成参数；工具实现层仍会二次校验，因为模型输出不能被视作可信输入。
export const toolDefinitions: ToolDefinition[] = [
  {
    name: "calculator",
    description: "Call this when arithmetic is needed. Performs one basic operation on two finite numbers without evaluating expressions.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["add", "subtract", "multiply", "divide"],
          description: "The arithmetic operation to perform.",
        },
        a: { type: "number", description: "The left operand." },
        b: { type: "number", description: "The right operand." },
      },
      required: ["operation", "a", "b"],
      additionalProperties: false,
    },
  },
  {
    name: "list_directory",
    description: "Call this to discover files and directories inside the workspace before reading them. Lists one directory level only. Use '.' for the workspace root.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative path to a directory. Use '.' for the workspace root.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "read_text_file",
    description: "Call this when the user asks about a text file inside the workspace. The path must be relative to the workspace root.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative path to a UTF-8 text file.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
];

// OpenAI Responses API 使用 parameters 字段描述函数参数。
// 从同一份 Anthropic 工具定义派生，避免两个 Provider 的名称、描述和 schema 漂移。
export const openAIToolDefinitions: OpenAIToolDefinition[] = toolDefinitions.map((tool) => ({
  type: "function",
  name: tool.name,
  description: tool.description ?? "",
  parameters: tool.input_schema,
  strict: tool.strict ?? true,
}));

// 工具分发器是唯一把“模型请求的工具名”映射到“本地函数”的位置。
// 这里使用 switch allowlist，故意不做动态属性访问，避免模型用任意字符串触发宿主对象上的其他方法。
// 抛出的错误会在 AgentLoop 中被转换成 is_error tool_result，让模型看到失败原因并继续对话。
export async function executeTool(
  name: string,
  input: unknown,
  context: ToolContext,
): Promise<string> {
  console.log("执行工具:", name, input, context);
  switch (name) {
    case "calculator":
      return runCalculator(parseCalculatorInput(input));
    case "list_directory":
      return listDirectory(parseListDirectoryInput(input), context);
    case "read_text_file":
      return readTextFile(parseReadTextFileInput(input), context);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function parseListDirectoryInput(input: unknown): ListDirectoryInput {
  if (!isRecord(input) || typeof input.path !== "string") {
    throw new Error("list_directory requires a string path");
  }

  return { path: input.path };
}

// 工具参数来自模型输出，即使 schema 是 strict，也仍然属于系统边界输入。
// 所以这里先判断 input 是普通对象，再检查 path 类型，防止 null、数组或错误字段进入文件逻辑。
function parseReadTextFileInput(input: unknown): ReadTextFileInput {
  if (!isRecord(input) || typeof input.path !== "string") {
    throw new Error("read_text_file requires a string path");
  }

  return { path: input.path };
}

// calculator 参数校验分两层：先校验 operation 是否属于枚举，再校验两个操作数是否为有限数字。
// Number.isFinite 可以排除 NaN、Infinity 和 -Infinity，避免输出不可解释的结果。
function parseCalculatorInput(input: unknown): CalculatorInput {
  if (!isRecord(input)) {
    throw new Error("calculator input must be an object");
  }

  const { operation, a, b } = input;
  if (operation !== "add" && operation !== "subtract" && operation !== "multiply" && operation !== "divide") {
    throw new Error("calculator operation must be add, subtract, multiply, or divide");
  }
  if (typeof a !== "number" || !Number.isFinite(a) || typeof b !== "number" || !Number.isFinite(b)) {
    throw new Error("calculator operands must be finite numbers");
  }

  return { operation, a, b };
}

// 计算器只做固定分支运算，不支持表达式字符串。
// 这是最小实现里重要的安全边界：不引入 eval、Function、shell 或任意脚本执行能力。
function runCalculator(input: CalculatorInput): string {
  switch (input.operation) {
    case "add":
      return String(input.a + input.b);
    case "subtract":
      return String(input.a - input.b);
    case "multiply":
      return String(input.a * input.b);
    case "divide":
      if (input.b === 0) {
        throw new Error("division by zero is not allowed");
      }
      return String(input.a / input.b);
  }
}

async function readTextFile(input: ReadTextFileInput, context: ToolContext): Promise<string> {
  const { realTarget } = await resolveWorkspacePath(input.path, context);

  // 只允许读取普通文件，不允许读取目录、设备文件或其他特殊文件。
  // 目录浏览由 list_directory 独立处理，避免两个工具的能力边界混在一起。
  const stat = await fs.stat(realTarget);
  if (!stat.isFile()) {
    throw new Error("path is not a file");
  }
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(`file is too large; maximum is ${MAX_FILE_BYTES} bytes`);
  }

  // MVP 只按 UTF-8 文本读取。
  // 二进制、图片、PDF 等文件类型需要不同的内容块格式，暂不放进最小工具面。
  return fs.readFile(realTarget, "utf8");
}

async function listDirectory(input: ListDirectoryInput, context: ToolContext): Promise<string> {
  const { root, realTarget } = await resolveWorkspacePath(input.path, context);
  const stat = await fs.stat(realTarget);
  if (!stat.isDirectory()) {
    throw new Error("path is not a directory");
  }

  const allEntries = await fs.readdir(realTarget, { withFileTypes: true });
  allEntries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);

  const selectedEntries = allEntries.slice(0, MAX_DIRECTORY_ENTRIES);
  const entries = await Promise.all(selectedEntries.map(async (entry) => {
    const type = getDirectoryEntryType(entry);
    if (type !== "file") {
      return { name: entry.name, type };
    }

    // lstat 不跟随符号链接；即使目录内容在读取期间发生变化，也不会借此读取 workspace 外部目标。
    const entryStat = await fs.lstat(path.join(realTarget, entry.name));
    return { name: entry.name, type, size: entryStat.size };
  }));

  const relativePath = path.relative(root, realTarget);
  return JSON.stringify({
    path: relativePath.length === 0 ? "." : relativePath.split(path.sep).join("/"),
    entries,
    truncated: allEntries.length > MAX_DIRECTORY_ENTRIES,
  }, null, 2);
}

function getDirectoryEntryType(entry: import("node:fs").Dirent): "file" | "directory" | "symbolic_link" | "other" {
  if (entry.isFile()) return "file";
  if (entry.isDirectory()) return "directory";
  if (entry.isSymbolicLink()) return "symbolic_link";
  return "other";
}

async function resolveWorkspacePath(
  requestedPath: string,
  context: ToolContext,
): Promise<{ root: string; realTarget: string }> {
  // 第一层：直接拒绝绝对路径。
  // 这样模型不能绕过 workspaceRoot，去指定 C:\、/etc 或其他系统位置。
  if (path.isAbsolute(requestedPath)) {
    throw new Error("path must be relative to the workspace");
  }

  // 第二层：在语法路径层面阻止 .. 逃逸。
  const root = await fs.realpath(context.workspaceRoot);
  const target = path.resolve(root, requestedPath);
  const relative = path.relative(root, target);
  if (isOutsideRoot(relative)) {
    throw new Error("path escapes the workspace");
  }

  // 第三层：检查真实路径，阻止 workspace 内的符号链接指向外部位置。
  const realTarget = await fs.realpath(target);
  const realRelative = path.relative(root, realTarget);
  if (isOutsideRoot(realRelative)) {
    throw new Error("path resolves outside the workspace");
  }

  return { root, realTarget };
}

function isOutsideRoot(relativePath: string): boolean {
  return relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath);
}

// 判断 unknown 是否为普通对象，供工具参数解析复用。
// 排除数组是为了避免把数组下标误当成对象字段处理。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
