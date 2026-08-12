import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const app = createMcpExpressApp();

app.post("/mcp", async (request, response) => {
  // Stateless 模式：每个 HTTP 请求都创建独立的 MCP Server 和 Transport。
  const server = new Server(
    { name: "minimal-http-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: "echo",
      description: "Return the input text",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    }],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (mcpRequest) => ({
    content: [{
      type: "text",
      text: `echo: ${mcpRequest.params.arguments?.text ?? ""}`,
    }],
  }));

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await server.connect(transport);
  response.on("close", () => {
    void transport.close();
    void server.close();
  });
  await transport.handleRequest(request, response, request.body);
});

app.listen(3001, "127.0.0.1", () => {
  console.log("MCP Server: http://127.0.0.1:3001/mcp");
});
