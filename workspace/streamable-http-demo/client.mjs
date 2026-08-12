import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({ name: "minimal-http-client", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(
  new URL("http://127.0.0.1:3001/mcp"),
  {
    requestInit: {
      headers: {
        "X-Demo-Header": "openclaw-http-demo-header",
        Authorization: "Bearer demo-token",
      },
    },
  },
);

try {
  await client.connect(transport, { timeout: 5_000 });

  const tools = await client.listTools(undefined, { timeout: 5_000 });
  console.log("tools/list:", tools.tools.map((tool) => tool.name));

  const result = await client.callTool(
    { name: "echo", arguments: { text: "hello MCP" } },
    undefined,
    { timeout: 5_000 },
  );
  console.log("tools/call:", JSON.stringify(result, null, 2));
} finally {
  await client.close();
}
