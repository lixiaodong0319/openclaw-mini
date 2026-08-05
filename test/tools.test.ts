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

  it("lists one directory level with sorted entry metadata", async () => {
    await fs.mkdir(path.join(workspaceRoot, "docs"));
    await fs.writeFile(path.join(workspaceRoot, "z.txt"), "hello", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "a.txt"), "ok", "utf8");

    const output = await executeTool("list_directory", { path: "." }, { workspaceRoot });

    expect(JSON.parse(output)).toEqual({
      path: ".",
      entries: [
        { name: "a.txt", type: "file", size: 2 },
        { name: "docs", type: "directory" },
        { name: "z.txt", type: "file", size: 5 },
      ],
      truncated: false,
    });
  });

  it("lists a nested directory without recursing", async () => {
    await fs.mkdir(path.join(workspaceRoot, "docs", "nested"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "docs", "note.txt"), "hello", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "docs", "nested", "hidden.txt"), "hidden", "utf8");

    const output = await executeTool("list_directory", { path: "docs" }, { workspaceRoot });

    expect(JSON.parse(output)).toEqual({
      path: "docs",
      entries: [
        { name: "nested", type: "directory" },
        { name: "note.txt", type: "file", size: 5 },
      ],
      truncated: false,
    });
  });

  it("rejects directory paths outside the workspace", async () => {
    await expect(executeTool("list_directory", { path: ".." }, { workspaceRoot })).rejects.toThrow("workspace");
  });

  it("rejects files passed to list_directory", async () => {
    await fs.writeFile(path.join(workspaceRoot, "note.txt"), "hello", "utf8");

    await expect(executeTool("list_directory", { path: "note.txt" }, { workspaceRoot })).rejects.toThrow("not a directory");
  });

  it("limits directory listings to 200 entries", async () => {
    await Promise.all(Array.from({ length: 201 }, (_, index) =>
      fs.writeFile(path.join(workspaceRoot, `file-${String(index).padStart(3, "0")}.txt`), "x", "utf8")
    ));

    const output = JSON.parse(await executeTool("list_directory", { path: "." }, { workspaceRoot })) as {
      entries: unknown[];
      truncated: boolean;
    };

    expect(output.entries).toHaveLength(200);
    expect(output.truncated).toBe(true);
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
