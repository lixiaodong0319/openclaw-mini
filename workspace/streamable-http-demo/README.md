# Streamable HTTP MCP 最小示例

先启动 Server：

```cmd
node workspace\streamable-http-demo\server.mjs
```

再打开另一个终端运行客户端：

```cmd
node workspace\streamable-http-demo\client.mjs
```

预期输出：

```text
tools/list: [ 'echo' ]
tools/call: {
  "content": [
    {
      "type": "text",
      "text": "echo: hello MCP"
    }
  ]
}
```

要让 OpenClaw Mini 连接这个 Server，在项目根目录的 `mcp.json` 加入：

```json
{
  "mcpServers": {
    "http-demo": {
      "transport": "streamable-http",
      "url": "http://127.0.0.1:3001/mcp",
      "headers": {
        "X-Demo-Header": "openclaw-http-demo-header"
      },
      "token": "demo-token",
      "timeoutMs": 5000
    }
  }
}
```

这个最小 Server 不校验 Token，Header 和 Token 只用于演示客户端如何发送它们。
