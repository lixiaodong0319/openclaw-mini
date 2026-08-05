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
    case "read_text_file":
      return readTextFile(parseReadTextFileInput(input), context);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
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
  // 第一层：直接拒绝绝对路径。
  // 这样模型不能绕过 workspaceRoot，去指定 C:\、/etc 或其他系统位置。
  if (path.isAbsolute(input.path)) {
    throw new Error("path must be relative to the workspace");
  }

  // 第二层：解析 workspace 的真实路径，再把模型给的相对路径拼进去。
  // path.relative(root, target) 如果以 .. 开头，说明 target 已经在语法层面逃出了 root。
  // path.isAbsolute(relative) 是 Windows 场景的补充防线，例如不同盘符时 relative 可能表现为绝对路径。
  const root = await fs.realpath(context.workspaceRoot);
  const target = path.resolve(root, input.path);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("path escapes the workspace");
  }

  // 第三层：解析目标文件的真实路径后再次检查。
  // 这一步用于阻止 workspace 内部的符号链接指向外部敏感文件。
  // 例如 workspace/link -> ../secret.txt，语法路径在 workspace 内，但真实路径已经逃逸。
  const realTarget = await fs.realpath(target);
  const realRelative = path.relative(root, realTarget);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw new Error("path resolves outside the workspace");
  }

  // 只允许读取普通文件，不允许读取目录、设备文件或其他特殊文件。
  // 目录 listing 不是本工具的能力，后续如果需要应单独新增 list_files 工具并独立设计权限。
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

// 判断 unknown 是否为普通对象，供工具参数解析复用。
// 排除数组是为了避免把数组下标误当成对象字段处理。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
