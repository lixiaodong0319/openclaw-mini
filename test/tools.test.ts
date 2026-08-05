import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeTool } from "../src/tools.js";

describe("tools", () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tools-"));
  });

  it("reads text files inside the workspace", async () => {
    await fs.writeFile(path.join(workspaceRoot, "note.txt"), "hello", "utf8");

    await expect(executeTool("read_text_file", { path: "note.txt" }, { workspaceRoot })).resolves.toBe("hello");
  });

  it("rejects paths outside the workspace", async () => {
    await expect(executeTool("read_text_file", { path: "../secret.txt" }, { workspaceRoot })).rejects.toThrow("workspace");
  });

  it("rejects absolute paths", async () => {
    await expect(executeTool("read_text_file", { path: path.resolve(workspaceRoot, "note.txt") }, { workspaceRoot })).rejects.toThrow("relative");
  });

  it("runs calculator operations", async () => {
    await expect(executeTool("calculator", { operation: "multiply", a: 12, b: 7 }, { workspaceRoot })).resolves.toBe("84");
  });

  it("rejects division by zero", async () => {
    await expect(executeTool("calculator", { operation: "divide", a: 1, b: 0 }, { workspaceRoot })).rejects.toThrow("division by zero");
  });

  it("rejects unknown tools", async () => {
    await expect(executeTool("shell", {}, { workspaceRoot })).rejects.toThrow("Unknown tool");
  });
});
