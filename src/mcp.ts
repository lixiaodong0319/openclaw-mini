import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type Anthropic from "@anthropic-ai/sdk";
import type { OpenAIToolDefinition } from "./tools.js";

const MCP_CONFIG_FILE = "mcp.json";
const DEFAULT_MCP_REQUEST_TIMEOUT_MS = 30_000;
const MAX_MCP_REQUEST_TIMEOUT_MS = 120_000;
const MAX_MCP_TOOLS = 200;
const MAX_EXPOSED_TOOL_NAME_CHARACTERS = 64;
const MAX_MCP_RESULT_BYTES = 256 * 1024;

interface McpBaseServerConfig {
  enabled: boolean;
  timeoutMs: number;
}

interface McpStdioServerConfig extends McpBaseServerConfig {
  transport: "stdio";
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
}

interface McpStreamableHttpServerConfig extends McpBaseServerConfig {
  transport: "streamable-http";
  url: string;
  headers: Record<string, string>;
  token?: string;
}

type McpServerConfig = McpStdioServerConfig | McpStreamableHttpServerConfig;

interface McpToolClient {
  listTools(params?: { cursor?: string }, options?: { timeout?: number }): Promise<{
    tools: Array<{
      name: string;
      description?: string;
      inputSchema: Record<string, unknown>;
    }>;
    nextCursor?: string;
  }>;
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    resultSchema?: undefined,
    options?: { timeout?: number },
  ): Promise<unknown>;
  close(): Promise<void>;
}

interface McpConnection {
  client: McpToolClient;
  close(): Promise<void>;
}

interface McpDependencies {
  connect(serverName: string, config: McpServerConfig, projectRoot: string): Promise<McpConnection>;
}

interface RegisteredMcpTool {
  exposedName: string;
  remoteName: string;
  serverName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  client: McpToolClient;
  timeoutMs: number;
  sensitiveValues: string[];
}

export interface McpToolDefinitions {
  anthropic: Anthropic.Tool[];
  openai: OpenAIToolDefinition[];
}

export interface McpStatusView {
  serverCount: number;
  toolCount: number;
  servers: Array<{
    name: string;
    tools: Array<{
      name: string;
      description: string;
    }>;
  }>;
}

// McpManager 是运行期 MCP 连接和动态工具定义的唯一所有者。
// AgentLoop 仍只看到普通工具名和字符串结果，不依赖 MCP SDK。
export class McpManager {
  private readonly tools = new Map<string, RegisteredMcpTool>();
  private readonly connections: McpConnection[] = [];
  private readonly serverNames: string[] = [];

  static async load(
    projectRoot: string,
    dependencyOverrides: Partial<McpDependencies> = {},
  ): Promise<McpManager> {
    const manager = new McpManager();
    const config = await loadMcpConfig(projectRoot);
    const dependencies: McpDependencies = {
      connect: connectMcpServer,
      ...dependencyOverrides,
    };

    try {
      for (const [serverName, serverConfig] of Object.entries(config)) {
        if (!serverConfig.enabled) continue;
        const connection = await dependencies.connect(serverName, serverConfig, projectRoot);
        manager.connections.push(connection);
        manager.serverNames.push(serverName);
        try {
          await manager.registerServerTools(
            serverName,
            connection.client,
            serverConfig,
          );
        } catch (error) {
          throw new Error(
            `Failed to load MCP tools from ${serverName}: ${sanitizeSensitiveText(
              errorMessage(error),
              getSensitiveValues(serverConfig),
            )}`,
          );
        }
      }
      return manager;
    } catch (error) {
      await manager.close();
      throw error;
    }
  }

  get serverCount(): number {
    return this.connections.length;
  }

  get toolCount(): number {
    return this.tools.size;
  }

  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  // CLI 只读取这个安全快照，不暴露 MCP client、启动命令、环境变量或远端原始名称。
  getStatus(): McpStatusView {
    const tools = [...this.tools.values()];
    return {
      serverCount: this.serverCount,
      toolCount: this.toolCount,
      servers: this.serverNames.map((serverName) => ({
        name: serverName,
        tools: tools
          .filter((tool) => tool.serverName === serverName)
          .map((tool) => ({
            name: tool.exposedName,
            description: tool.description,
          }))
          .sort((left, right) => left.name.localeCompare(right.name)),
      })),
    };
  }

  getDefinitions(): McpToolDefinitions {
    const tools = [...this.tools.values()];
    return {
      anthropic: tools.map((tool) => ({
        name: tool.exposedName,
        description: tool.description,
        input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
      })),
      openai: tools.map((tool) => ({
        type: "function",
        name: tool.exposedName,
        description: tool.description,
        parameters: tool.inputSchema as Anthropic.Tool.InputSchema,
        strict: false,
      })),
    };
  }

  async execute(name: string, input: unknown): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown MCP tool: ${name}`);
    if (!isRecord(input)) throw new Error(`MCP tool ${name} requires an object input`);

    let result: unknown;
    try {
      result = await tool.client.callTool(
        { name: tool.remoteName, arguments: input },
        undefined,
        { timeout: tool.timeoutMs },
      );
    } catch (error) {
      throw new Error(
        `MCP tool ${name} failed: ${sanitizeSensitiveText(errorMessage(error), tool.sensitiveValues)}`,
      );
    }
    const formatted = sanitizeSensitiveText(
      formatMcpToolResult(result),
      tool.sensitiveValues,
    );
    const limited = limitUtf8Text(formatted, MAX_MCP_RESULT_BYTES);
    if (isRecord(result) && result.isError === true) {
      throw new Error(limited || `MCP tool ${name} failed`);
    }
    return limited;
  }

  async close(): Promise<void> {
    const connections = this.connections.splice(0).reverse();
    this.serverNames.splice(0);
    this.tools.clear();
    await Promise.allSettled(connections.map((connection) => connection.close()));
  }

  private async registerServerTools(
    serverName: string,
    client: McpToolClient,
    serverConfig: McpServerConfig,
  ): Promise<void> {
    const sensitiveValues = getSensitiveValues(serverConfig);
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, {
        timeout: serverConfig.timeoutMs,
      });
      for (const tool of page.tools) {
        if (this.tools.size >= MAX_MCP_TOOLS) {
          throw new Error(`MCP tool limit exceeded; maximum is ${MAX_MCP_TOOLS}`);
        }
        const exposedName = createExposedToolName(serverName, tool.name);
        if (this.tools.has(exposedName)) {
          throw new Error(`Duplicate MCP tool name: ${exposedName}`);
        }
        if (!isObjectJsonSchema(tool.inputSchema)) {
          throw new Error(`MCP tool ${exposedName} must use an object input schema`);
        }
        this.tools.set(exposedName, {
          exposedName,
          remoteName: tool.name,
          serverName,
          description: `[MCP server: ${serverName}] ${tool.description?.trim() || tool.name}`,
          inputSchema: tool.inputSchema,
          client,
          timeoutMs: serverConfig.timeoutMs,
          sensitiveValues,
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
  }
}

async function loadMcpConfig(projectRoot: string): Promise<Record<string, McpServerConfig>> {
  const configPath = path.join(projectRoot, MCP_CONFIG_FILE);
  let text: string;
  try {
    text = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return {};
    throw error;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${MCP_CONFIG_FILE} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(payload) || !isRecord(payload.mcpServers)) {
    throw new Error(`${MCP_CONFIG_FILE} must contain an mcpServers object`);
  }

  const servers: Record<string, McpServerConfig> = {};
  for (const [name, value] of Object.entries(payload.mcpServers)) {
    if (!/^[A-Za-z0-9_-]{1,24}$/.test(name)) {
      throw new Error(`MCP server name must match [A-Za-z0-9_-]{1,24}: ${name}`);
    }
    servers[name] = parseServerConfig(name, value);
  }
  return servers;
}

function parseServerConfig(name: string, value: unknown): McpServerConfig {
  if (!isRecord(value)) {
    throw new Error(`MCP server ${name} must be an object`);
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    throw new Error(`MCP server ${name} enabled must be a boolean`);
  }
  const enabled = value.enabled ?? true;
  const timeoutMs = parseTimeoutMs(name, value.timeoutMs);
  const hasCommand = value.command !== undefined;
  const hasUrl = value.url !== undefined;
  if (hasCommand && hasUrl) {
    throw new Error(`MCP server ${name} cannot contain both command and url`);
  }

  const inferredTransport = hasUrl ? "streamable-http" : "stdio";
  const transport = value.transport ?? inferredTransport;
  if (transport !== "stdio" && transport !== "streamable-http") {
    throw new Error(`MCP server ${name} transport must be stdio or streamable-http`);
  }
  if (transport === "streamable-http") {
    if (hasCommand) {
      throw new Error(`MCP server ${name} streamable-http transport cannot contain command`);
    }
    if (value.args !== undefined || value.cwd !== undefined || value.env !== undefined) {
      throw new Error(`MCP server ${name} streamable-http transport cannot contain stdio fields`);
    }
    return parseStreamableHttpConfig(name, value, enabled, timeoutMs);
  }
  if (hasUrl) {
    throw new Error(`MCP server ${name} stdio transport cannot contain url`);
  }
  if (value.headers !== undefined || value.token !== undefined) {
    throw new Error(`MCP server ${name} stdio transport cannot contain HTTP fields`);
  }
  return parseStdioConfig(name, value, enabled, timeoutMs);
}

function parseStdioConfig(
  name: string,
  value: Record<string, unknown>,
  enabled: boolean,
  timeoutMs: number,
): McpStdioServerConfig {
  if (typeof value.command !== "string" || value.command.trim().length === 0) {
    throw new Error(`MCP server ${name} requires a non-empty command`);
  }
  const args = value.args ?? [];
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== "string")) {
    throw new Error(`MCP server ${name} args must be an array of strings`);
  }
  if (value.cwd !== undefined && typeof value.cwd !== "string") {
    throw new Error(`MCP server ${name} cwd must be a string`);
  }
  const env = value.env ?? {};
  if (!isRecord(env) || Object.values(env).some((entry) => typeof entry !== "string")) {
    throw new Error(`MCP server ${name} env must contain only string values`);
  }
  return {
    transport: "stdio",
    command: value.command.trim(),
    args: [...args],
    cwd: value.cwd,
    env: env as Record<string, string>,
    enabled,
    timeoutMs,
  };
}

function parseStreamableHttpConfig(
  name: string,
  value: Record<string, unknown>,
  enabled: boolean,
  timeoutMs: number,
): McpStreamableHttpServerConfig {
  if (typeof value.url !== "string" || value.url.trim().length === 0) {
    throw new Error(`MCP server ${name} requires a non-empty url`);
  }
  let url: URL;
  try {
    url = new URL(value.url.trim());
  } catch {
    throw new Error(`MCP server ${name} url must be an absolute HTTP(S) URL`);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) {
    throw new Error(`MCP server ${name} url must be an absolute HTTP(S) URL`);
  }
  if (url.username || url.password) {
    throw new Error(`MCP server ${name} url must not contain embedded credentials`);
  }

  const rawHeaders = value.headers ?? {};
  if (!isRecord(rawHeaders) || Object.values(rawHeaders).some((entry) => typeof entry !== "string")) {
    throw new Error(`MCP server ${name} headers must contain only string values`);
  }
  const headers = rawHeaders as Record<string, string>;
  try {
    // Headers 会校验非法名称，以及包含 CR/LF 等不能安全发送的值。
    new Headers(headers);
  } catch {
    throw new Error(`MCP server ${name} headers contain an invalid name or value`);
  }
  for (const headerName of Object.keys(headers)) {
    if (isReservedHttpHeader(headerName)) {
      throw new Error(`MCP server ${name} cannot configure reserved header ${headerName}`);
    }
  }
  if (value.token !== undefined && (typeof value.token !== "string" || value.token.trim().length === 0)) {
    throw new Error(`MCP server ${name} token must be a non-empty string`);
  }
  const authorizationHeader = Object.keys(headers)
    .find((headerName) => headerName.toLowerCase() === "authorization");
  if (value.token !== undefined && authorizationHeader !== undefined) {
    throw new Error(`MCP server ${name} cannot configure both token and Authorization header`);
  }

  return {
    transport: "streamable-http",
    url: url.toString(),
    headers: { ...headers },
    token: value.token?.trim(),
    enabled,
    timeoutMs,
  };
}

function parseTimeoutMs(name: string, value: unknown): number {
  const timeoutMs = value ?? DEFAULT_MCP_REQUEST_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || (timeoutMs as number) <= 0 || (timeoutMs as number) > MAX_MCP_REQUEST_TIMEOUT_MS) {
    throw new Error(
      `MCP server ${name} timeoutMs must be an integer between 1 and ${MAX_MCP_REQUEST_TIMEOUT_MS}`,
    );
  }
  return timeoutMs as number;
}

function isReservedHttpHeader(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized === "host"
    || normalized === "content-length"
    || normalized === "mcp-session-id"
    || normalized === "mcp-protocol-version";
}

async function connectMcpServer(
  serverName: string,
  config: McpServerConfig,
  projectRoot: string,
): Promise<McpConnection> {
  if (config.transport === "stdio") {
    return connectStdioServer(serverName, config, projectRoot);
  }
  return connectStreamableHttpServer(serverName, config);
}

async function connectStdioServer(
  serverName: string,
  config: McpStdioServerConfig,
  projectRoot: string,
): Promise<McpConnection> {
  const client = new Client({ name: "openclaw", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    cwd: config.cwd ? path.resolve(projectRoot, config.cwd) : projectRoot,
    env: { ...getDefaultEnvironment(), ...config.env },
    stderr: "inherit",
  });
  try {
    await client.connect(transport, { timeout: config.timeoutMs });
  } catch (error) {
    await transport.close().catch(() => undefined);
    throw new Error(`Failed to connect MCP server ${serverName}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    client,
    close: () => client.close(),
  };
}

async function connectStreamableHttpServer(
  serverName: string,
  config: McpStreamableHttpServerConfig,
): Promise<McpConnection> {
  const client = new Client({ name: "openclaw", version: "1.0.0" });
  const headers: Record<string, string> = { ...config.headers };
  if (config.token) headers.Authorization = `Bearer ${config.token}`;
  const transport = new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: { headers },
  });
  try {
    await client.connect(transport, { timeout: config.timeoutMs });
  } catch (error) {
    await transport.close().catch(() => undefined);
    throw new Error(
      `Failed to connect MCP server ${serverName}: ${sanitizeSensitiveText(errorMessage(error), getSensitiveValues(config))}`,
    );
  }
  return {
    client,
    close: () => client.close(),
  };
}

function getSensitiveValues(config: McpServerConfig): string[] {
  if (config.transport === "stdio") return [];
  return [config.url, config.token, ...Object.values(config.headers)]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .sort((left, right) => right.length - left.length);
}

function sanitizeSensitiveText(text: string, sensitiveValues: string[]): string {
  // 远程 Server 可能在响应或错误中回显 URL/Header，写入终端和会话前统一脱敏。
  let message = text;
  for (const value of sensitiveValues) message = message.split(value).join("[redacted]");
  return message;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatMcpToolResult(result: unknown): string {
  if (!isRecord(result)) return JSON.stringify(result);
  const output: unknown[] = [];
  if (isRecord(result.structuredContent)) {
    output.push({ structuredContent: result.structuredContent });
  }
  if (Array.isArray(result.content)) {
    for (const content of result.content) {
      if (!isRecord(content) || typeof content.type !== "string") continue;
      if (content.type === "text" && typeof content.text === "string") {
        output.push(content.text);
      } else if (content.type === "resource_link" && typeof content.uri === "string") {
        output.push({ type: content.type, uri: content.uri, name: content.name });
      } else if (content.type === "resource" && isRecord(content.resource)) {
        output.push({ type: content.type, resource: content.resource });
      } else if ((content.type === "image" || content.type === "audio") && typeof content.mimeType === "string") {
        // 当前 AgentLoop 的工具结果是文本，因此不把可能很大的 base64 媒体塞进会话。
        output.push({ type: content.type, mimeType: content.mimeType, omitted: true });
      }
    }
  }
  if (output.length === 1 && typeof output[0] === "string") return output[0];
  return JSON.stringify(output, null, 2);
}

function createExposedToolName(serverName: string, remoteName: string): string {
  const prefix = `mcp__${serverName}__`;
  const normalized = remoteName.replace(/[^A-Za-z0-9_-]/g, "_") || "tool";
  const available = MAX_EXPOSED_TOOL_NAME_CHARACTERS - prefix.length;
  if (normalized === remoteName && normalized.length <= available) return `${prefix}${normalized}`;

  // MCP 允许的工具名可能比模型厂商的 function name 更宽松或更长。
  // 保留可读前缀，并用远端原名哈希避免清洗/截断后的碰撞。
  const hash = createHash("sha256").update(remoteName).digest("hex").slice(0, 8);
  const readableLength = Math.max(1, available - hash.length - 2);
  return `${prefix}${normalized.slice(0, readableLength)}__${hash}`;
}

function limitUtf8Text(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= maxBytes) return text;
  let end = maxBytes;
  // UTF-8 continuation byte 10xxxxxx 不能作为截断后第一个被丢弃字节的内部边界。
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return `${bytes.subarray(0, end).toString("utf8")}\n[MCP result truncated at ${maxBytes} bytes]`;
}

function isObjectJsonSchema(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.type === "object";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
