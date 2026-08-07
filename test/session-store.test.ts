import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../src/session-store.js";

describe("SessionStore", () => {
  it("appends and reloads messages", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-store-"));
    const store = new SessionStore(root, "abc_123");
    const userMessage: Anthropic.MessageParam = { role: "user", content: "hello" };
    const assistantMessage: Anthropic.MessageParam = {
      role: "assistant",
      content: [{ type: "text", text: "world" }],
    };

    await store.append(userMessage);
    await store.append(assistantMessage);

    await expect(store.load()).resolves.toEqual([userMessage, assistantMessage]);
  });

  it("rejects unsafe session ids", () => {
    expect(() => new SessionStore("data", "../secret")).toThrow("session id");
  });

  it("separates namespaced provider sessions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-store-"));
    const anthropicStore = new SessionStore<string>(root, "same");
    const openAIStore = new SessionStore<string>(root, "same", "openai");

    await anthropicStore.append("anthropic");
    await openAIStore.append("openai");

    await expect(anthropicStore.load()).resolves.toEqual(["anthropic"]);
    await expect(openAIStore.load()).resolves.toEqual(["openai"]);
  });

  it("atomically replaces compacted history", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-store-"));
    const store = new SessionStore<string>(root, "compact");
    await store.append("old-1");
    await store.append("old-2");

    await store.replace(["summary", "recent"]);

    await expect(store.load()).resolves.toEqual(["summary", "recent"]);
  });

  it("reports invalid JSONL", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-store-"));
    await fs.mkdir(path.join(root, "sessions"));
    await fs.writeFile(path.join(root, "sessions", "bad.jsonl"), "not json\n", "utf8");

    await expect(new SessionStore(root, "bad").load()).rejects.toThrow("invalid JSONL");
  });
});
