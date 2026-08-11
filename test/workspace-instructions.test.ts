import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_SYSTEM_PROMPT } from "../src/agent-loop.js";
import {
  MAX_WORKSPACE_INSTRUCTIONS_BYTES,
  buildSystemPrompt,
  describeWorkspaceInstructions,
  loadWorkspaceInstructions,
} from "../src/workspace-instructions.js";

describe("workspace instructions", () => {
  const temporaryDirectories: string[] = [];

  async function createWorkspace(): Promise<string> {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-instructions-"));
    temporaryDirectories.push(workspaceRoot);
    return workspaceRoot;
  }

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, {
      recursive: true,
      force: true,
    })));
  });

  it("returns undefined when the root AGENTS.md does not exist", async () => {
    const workspaceRoot = await createWorkspace();

    await expect(loadWorkspaceInstructions(workspaceRoot)).resolves.toBeUndefined();
    expect(describeWorkspaceInstructions()).toBe("not found");
  });

  it("loads UTF-8 text from the workspace root and reports its byte length", async () => {
    const workspaceRoot = await createWorkspace();
    const content = "# 项目指令\n请使用中文回答。\n";
    await fs.writeFile(path.join(workspaceRoot, "AGENTS.md"), content, "utf8");

    const instructions = await loadWorkspaceInstructions(workspaceRoot);

    expect(instructions).toEqual({
      relativePath: "AGENTS.md",
      content,
      bytes: Buffer.byteLength(content),
    });
    expect(describeWorkspaceInstructions(instructions)).toBe(
      `AGENTS.md (${Buffer.byteLength(content)} bytes)`,
    );
  });

  it("adds instructions to the default system prompt", () => {
    const prompt = buildSystemPrompt({
      relativePath: "AGENTS.md",
      content: "Run tests before reporting completion.",
      bytes: 38,
    });

    expect(prompt).toContain(DEFAULT_SYSTEM_PROMPT);
    expect(prompt).toContain('<workspace_instructions file="AGENTS.md">');
    expect(prompt).toContain("Run tests before reporting completion.");
    expect(prompt).toContain("</workspace_instructions>");
    expect(buildSystemPrompt()).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  it("rejects a file larger than 32 KiB", async () => {
    const workspaceRoot = await createWorkspace();
    await fs.writeFile(
      path.join(workspaceRoot, "AGENTS.md"),
      Buffer.alloc(MAX_WORKSPACE_INSTRUCTIONS_BYTES + 1, 0x61),
    );

    await expect(loadWorkspaceInstructions(workspaceRoot)).rejects.toThrow("too large");
  });

  it("rejects NUL bytes and invalid UTF-8", async () => {
    const workspaceRoot = await createWorkspace();
    const instructionPath = path.join(workspaceRoot, "AGENTS.md");

    await fs.writeFile(instructionPath, Buffer.from([0x74, 0x65, 0x00, 0x78, 0x74]));
    await expect(loadWorkspaceInstructions(workspaceRoot)).rejects.toThrow("UTF-8 text file");

    await fs.writeFile(instructionPath, Buffer.from([0xc3, 0x28]));
    await expect(loadWorkspaceInstructions(workspaceRoot)).rejects.toThrow("valid UTF-8 text");
  });

  it("rejects a directory named AGENTS.md", async () => {
    const workspaceRoot = await createWorkspace();
    await fs.mkdir(path.join(workspaceRoot, "AGENTS.md"));

    await expect(loadWorkspaceInstructions(workspaceRoot)).rejects.toThrow("regular file");
  });

  it.skipIf(process.platform === "win32")("rejects a symbolic link named AGENTS.md", async () => {
    const workspaceRoot = await createWorkspace();
    const targetPath = path.join(workspaceRoot, "instructions-target.md");
    await fs.writeFile(targetPath, "linked instructions", "utf8");
    await fs.symlink(targetPath, path.join(workspaceRoot, "AGENTS.md"));

    await expect(loadWorkspaceInstructions(workspaceRoot)).rejects.toThrow("symbolic link");
  });

  it("does not search nested directories for AGENTS.md", async () => {
    const workspaceRoot = await createWorkspace();
    const nestedDirectory = path.join(workspaceRoot, "project");
    await fs.mkdir(nestedDirectory);
    await fs.writeFile(path.join(nestedDirectory, "AGENTS.md"), "nested", "utf8");

    await expect(loadWorkspaceInstructions(workspaceRoot)).resolves.toBeUndefined();
  });
});
