import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AttachmentQueue,
  MAX_IMAGE_ATTACHMENT_BYTES,
  MAX_QUEUED_ATTACHMENTS,
  MAX_TEXT_ATTACHMENT_BYTES,
  formatAttachmentList,
  loadAttachment,
} from "../src/attachments.js";

describe("file attachments", () => {
  const temporaryDirectories: string[] = [];

  async function createWorkspace(): Promise<string> {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-attachments-"));
    temporaryDirectories.push(workspaceRoot);
    return workspaceRoot;
  }

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, {
      recursive: true,
      force: true,
    })));
  });

  it("loads a workspace-relative UTF-8 text attachment", async () => {
    const workspaceRoot = await createWorkspace();
    await fs.mkdir(path.join(workspaceRoot, "docs"));
    await fs.writeFile(path.join(workspaceRoot, "docs", "note.txt"), "你好 attachment\n", "utf8");

    await expect(loadAttachment(workspaceRoot, "docs/note.txt")).resolves.toEqual({
      kind: "text",
      relativePath: "docs/note.txt",
      mediaType: "text/plain",
      bytes: Buffer.byteLength("你好 attachment\n"),
      text: "你好 attachment\n",
    });
  });

  it("loads a supported image as base64 after checking its signature", async () => {
    const workspaceRoot = await createWorkspace();
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    await fs.writeFile(path.join(workspaceRoot, "screen.png"), png);

    await expect(loadAttachment(workspaceRoot, "screen.png")).resolves.toEqual({
      kind: "image",
      relativePath: "screen.png",
      mediaType: "image/png",
      bytes: png.length,
      data: png.toString("base64"),
    });
  });

  it("queues at most four unique attachments and clears them explicitly", async () => {
    const workspaceRoot = await createWorkspace();
    const queue = new AttachmentQueue(workspaceRoot);
    for (let index = 0; index < MAX_QUEUED_ATTACHMENTS; index += 1) {
      await fs.writeFile(path.join(workspaceRoot, `note-${index}.txt`), `${index}`, "utf8");
      await queue.add(`note-${index}.txt`);
    }

    expect(queue.size).toBe(4);
    expect(formatAttachmentList(queue.snapshot())).toContain("4 个待发送");
    await expect(queue.add("note-0.txt")).rejects.toThrow("at most 4");
    expect(queue.clear()).toBe(4);
    expect(queue.size).toBe(0);
    await queue.add("note-0.txt");
    await expect(queue.add("note-0.txt")).rejects.toThrow("already queued");
    expect(formatAttachmentList([])).toContain("没有待发送附件");
  });

  it("rejects absolute paths, traversal, directories, and unsupported extensions", async () => {
    const workspaceRoot = await createWorkspace();
    const outside = path.join(path.dirname(workspaceRoot), "outside.txt");
    await fs.writeFile(outside, "secret", "utf8");
    temporaryDirectories.push(outside);
    await fs.mkdir(path.join(workspaceRoot, "folder"));
    await fs.writeFile(path.join(workspaceRoot, "archive.zip"), "zip", "utf8");

    await expect(loadAttachment(workspaceRoot, outside)).rejects.toThrow("relative");
    await expect(loadAttachment(workspaceRoot, "../outside.txt")).rejects.toThrow("escapes");
    await expect(loadAttachment(workspaceRoot, "folder")).rejects.toThrow("regular file");
    await expect(loadAttachment(workspaceRoot, "archive.zip")).rejects.toThrow("unsupported");
  });

  it("rejects oversized or invalid text and mismatched image content", async () => {
    const workspaceRoot = await createWorkspace();
    await fs.writeFile(
      path.join(workspaceRoot, "large.txt"),
      Buffer.alloc(MAX_TEXT_ATTACHMENT_BYTES + 1, 0x61),
    );
    await fs.writeFile(path.join(workspaceRoot, "binary.txt"), Buffer.from([0xc3, 0x28]));
    await fs.writeFile(path.join(workspaceRoot, "fake.png"), "not a png", "utf8");
    await fs.writeFile(
      path.join(workspaceRoot, "large.png"),
      Buffer.alloc(MAX_IMAGE_ATTACHMENT_BYTES + 1, 0x00),
    );

    await expect(loadAttachment(workspaceRoot, "large.txt")).rejects.toThrow("too large");
    await expect(loadAttachment(workspaceRoot, "binary.txt")).rejects.toThrow("valid UTF-8");
    await expect(loadAttachment(workspaceRoot, "fake.png")).rejects.toThrow("does not match");
    await expect(loadAttachment(workspaceRoot, "large.png")).rejects.toThrow("too large");
  });

  it.skipIf(process.platform === "win32")("rejects symbolic-link attachment targets", async () => {
    const workspaceRoot = await createWorkspace();
    await fs.writeFile(path.join(workspaceRoot, "target.txt"), "text", "utf8");
    await fs.symlink("target.txt", path.join(workspaceRoot, "link.txt"));

    await expect(loadAttachment(workspaceRoot, "link.txt")).rejects.toThrow("symbolic link");
  });
});
