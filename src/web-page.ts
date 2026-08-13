// 页面刻意保持为单文件原生 HTML/JS：不引入前端框架和打包器，便于直接研究
// fetch ReadableStream 如何消费服务端的 SSE 文本增量。
export const WEB_PAGE = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OpenClaw Mini</title>
</head>
<body>
  <h1>OpenClaw Mini</h1>
  <p id="runtime">正在读取配置...</p>

  <label for="session">Session：</label>
  <select id="session"></select>
  <button id="new-session" type="button">新建 Session</button>
  <button id="rename-session" type="button">重命名 Session</button>
  <button id="delete-session" type="button">删除 Session</button>

  <hr>
  <main id="messages"></main>

  <form id="chat-form">
    <p><label for="message">消息：</label></p>
    <textarea id="message" rows="5" cols="80" required></textarea>
    <p><button id="send" type="submit">发送</button></p>
  </form>

  <script>
    const runtimeElement = document.querySelector("#runtime");
    const sessionElement = document.querySelector("#session");
    const messagesElement = document.querySelector("#messages");
    const formElement = document.querySelector("#chat-form");
    const messageElement = document.querySelector("#message");
    const sendElement = document.querySelector("#send");
    const newSessionElement = document.querySelector("#new-session");
    const renameSessionElement = document.querySelector("#rename-session");
    const deleteSessionElement = document.querySelector("#delete-session");
    let assistantOutput = null;
    let historyLoadVersion = 0;

    function appendMessage(label, text) {
      const container = document.createElement("section");
      const heading = document.createElement("strong");
      const content = document.createElement("pre");
      heading.textContent = label;
      content.textContent = text;
      container.append(heading, content);
      messagesElement.append(container);
      return { container, content };
    }

    function appendAssistantText(text) {
      if (!assistantOutput) assistantOutput = appendMessage("助手", "").content;
      assistantOutput.textContent += text;
    }

    function resetMessages() {
      messagesElement.replaceChildren();
      assistantOutput = null;
    }

    function renderHistoryEntry(entry) {
      if (entry.type === "message") {
        appendMessage(entry.role === "user" ? "你" : "助手", entry.text);
        return;
      }
      if (entry.type === "summary") {
        appendMessage("早期会话摘要", entry.text);
        return;
      }
      if (entry.type === "tool") {
        const status = entry.status === "completed"
          ? "完成"
          : entry.status === "failed" ? "失败" : "等待结果";
        appendMessage("历史工具", "[工具] " + entry.name + " " + status);
      }
    }

    async function loadHistory(sessionId) {
      const version = ++historyLoadVersion;
      resetMessages();
      const response = await fetch("/api/sessions/" + encodeURIComponent(sessionId) + "/history");
      if (!response.ok) throw new Error("无法读取 Session 历史");
      const history = await response.json();
      // 用户可能在请求返回前又切换了 Session，旧响应不能覆盖新页面。
      if (version !== historyLoadVersion || sessionElement.value !== sessionId) return;
      if (history.truncated) appendMessage("提示", "历史较长，仅展示最近 200 项。");
      history.entries.forEach(renderHistoryEntry);
    }

    function addSession(sessionId) {
      if ([...sessionElement.options].some((option) => option.value === sessionId)) return;
      const option = document.createElement("option");
      option.value = sessionId;
      option.textContent = sessionId;
      sessionElement.append(option);
    }

    async function loadPageData() {
      const [configResponse, sessionsResponse] = await Promise.all([
        fetch("/api/config"),
        fetch("/api/sessions"),
      ]);
      if (!configResponse.ok || !sessionsResponse.ok) throw new Error("无法读取 Web 配置");
      const config = await configResponse.json();
      const sessions = await sessionsResponse.json();
      runtimeElement.textContent = "Provider: " + config.provider
        + " | Model: " + config.model
        + " | Workspace: " + config.workspace
        + " | Instructions: " + (config.instructions || "not found");
      if (sessions.sessions.length === 0) {
        const createResponse = await fetch("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: "default" }),
        });
        if (!createResponse.ok && createResponse.status !== 409) {
          throw new Error("无法创建默认 Session");
        }
        sessions.sessions.push("default");
      }
      sessions.sessions.forEach(addSession);
      if ([...sessionElement.options].some((option) => option.value === "default")) {
        sessionElement.value = "default";
      }
      await loadHistory(sessionElement.value);
    }

    async function createNewSession() {
      const sessionId = prompt("输入 Session 名称（字母、数字、下划线或连字符）：");
      if (sessionId === null) return;
      if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
        alert("Session 名称不合法");
        return;
      }
      const response = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "无法新建 Session");
      }
      addSession(sessionId);
      sessionElement.value = sessionId;
      await loadHistory(sessionId);
    }

    async function renameCurrentSession() {
      const oldSessionId = sessionElement.value;
      const newSessionId = prompt("输入新 Session 名称：", oldSessionId);
      if (newSessionId === null || newSessionId === oldSessionId) return;
      if (!/^[A-Za-z0-9_-]+$/.test(newSessionId)) throw new Error("Session 名称不合法");
      const response = await fetch("/api/sessions/" + encodeURIComponent(oldSessionId), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newSessionId }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "无法重命名 Session");
      }
      const option = [...sessionElement.options].find((item) => item.value === oldSessionId);
      if (option) {
        option.value = newSessionId;
        option.textContent = newSessionId;
      }
      sessionElement.value = newSessionId;
      await loadHistory(newSessionId);
    }

    async function deleteCurrentSession() {
      const sessionId = sessionElement.value;
      if (!confirm("确认删除 Session " + sessionId + " 的全部历史？")) return;
      const response = await fetch("/api/sessions/" + encodeURIComponent(sessionId), {
        method: "DELETE",
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "无法删除 Session");
      }
      const option = [...sessionElement.options].find((item) => item.value === sessionId);
      option?.remove();
      if (sessionElement.options.length === 0) {
        const createResponse = await fetch("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: "default" }),
        });
        if (!createResponse.ok) throw new Error("无法创建默认 Session");
        addSession("default");
      }
      await loadHistory(sessionElement.value);
    }

    newSessionElement.addEventListener("click", () => createNewSession().catch(showError));
    renameSessionElement.addEventListener("click", () => renameCurrentSession().catch(showError));
    deleteSessionElement.addEventListener("click", () => deleteCurrentSession().catch(showError));

    sessionElement.addEventListener("change", () => {
      loadHistory(sessionElement.value).catch(showError);
    });

    function describeAgentEvent(event) {
      if (event.type === "tool_start") return "[工具] " + event.name + " 执行中...";
      if (event.type === "tool_approved") return "[工具] " + event.name + " 已允许";
      if (event.type === "tool_denied") return "[工具] " + event.name + " 已拒绝";
      if (event.type === "tool_end") return "[工具] " + event.name + (event.isError ? " 失败" : " 完成");
      if (event.type === "context_compaction_start") return "[会话] 正在压缩上下文...";
      if (event.type === "context_compaction_end") return "[会话] 上下文压缩完成";
      return null;
    }

    async function decideConfirmation(requestId, sessionId, approved, buttons) {
      buttons.forEach((button) => { button.disabled = true; });
      const response = await fetch("/api/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, sessionId, approved }),
      });
      if (!response.ok) throw new Error("确认请求已失效");
    }

    function showConfirmation(payload, sessionId) {
      let input = JSON.stringify(payload.request.input, null, 2) ?? String(payload.request.input);
      if (input.length > 2000) input = input.slice(0, 2000) + "\n...（已截断）";
      const view = appendMessage("工具确认", payload.request.name + "\n" + input);
      const allow = document.createElement("button");
      const deny = document.createElement("button");
      allow.textContent = "允许";
      deny.textContent = "拒绝";
      view.container.append(allow, deny);
      const buttons = [allow, deny];
      allow.addEventListener("click", () => decideConfirmation(payload.requestId, sessionId, true, buttons).catch(showError));
      deny.addEventListener("click", () => decideConfirmation(payload.requestId, sessionId, false, buttons).catch(showError));
    }

    function handlePayload(payload, sessionId) {
      if (payload.type === "agent_event") {
        if (payload.event.type === "text_delta") appendAssistantText(payload.event.text);
        const description = describeAgentEvent(payload.event);
        if (description) appendMessage("状态", description);
        return;
      }
      if (payload.type === "confirmation_required") showConfirmation(payload, sessionId);
      if (payload.type === "error") appendMessage("错误", payload.message);
    }

    function consumeSseFrame(frame, sessionId) {
      const data = frame.split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data.length > 0) handlePayload(JSON.parse(data), sessionId);
    }

    async function streamChat(sessionId, message) {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, message }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error(body.error || "请求失败");
      }
      if (!response.body) throw new Error("浏览器不支持流式响应");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const result = await reader.read();
        buffer += decoder.decode(result.value, { stream: !result.done });
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) !== -1) {
          consumeSseFrame(buffer.slice(0, boundary), sessionId);
          buffer = buffer.slice(boundary + 2);
        }
        if (result.done) break;
      }
      if (buffer.trim().length > 0) consumeSseFrame(buffer, sessionId);
    }

    function showError(error) {
      appendMessage("错误", error instanceof Error ? error.message : String(error));
    }

    formElement.addEventListener("submit", async (event) => {
      event.preventDefault();
      const sessionId = sessionElement.value;
      const message = messageElement.value.trim();
      if (!sessionId || !message) return;
      // 发送消息后以当前页面为准，取消仍在途的历史回放响应。
      historyLoadVersion += 1;
      addSession(sessionId);
      appendMessage("你", message);
      assistantOutput = null;
      messageElement.value = "";
      sendElement.disabled = true;
      sessionElement.disabled = true;
      newSessionElement.disabled = true;
      renameSessionElement.disabled = true;
      deleteSessionElement.disabled = true;
      try {
        await streamChat(sessionId, message);
      } catch (error) {
        showError(error);
      } finally {
        sendElement.disabled = false;
        sessionElement.disabled = false;
        newSessionElement.disabled = false;
        renameSessionElement.disabled = false;
        deleteSessionElement.disabled = false;
        messageElement.focus();
      }
    });

    loadPageData().catch(showError);
  </script>
</body>
</html>
`;
