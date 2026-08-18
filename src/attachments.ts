import fs from "node:fs/promises";
import path from "node:path";

export const MAX_QUEUED_ATTACHMENTS = 4;
export const MAX_TEXT_ATTACHMENT_BYTES = 256 * 1024;
export const MAX_IMAGE_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export interface TextAttachment {
  kind: "text";
  relativePath: string;
  mediaType: "text/plain";
  bytes: number;
  text: string;
}

export interface ImageAttachment {
  kind: "image";
  relativePath: string;
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  bytes: number;
  data: string;
}

export type UserAttachment = TextAttachment | ImageAttachment;

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".json", ".jsonl", ".csv", ".log", ".xml", ".yaml", ".yml",
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".css", ".html", ".py",
  ".java", ".c", ".h", ".cpp", ".hpp", ".rs", ".go", ".sh", ".ps1", ".sql",
  ".toml", ".ini",
]);

const IMAGE_MEDIA_TYPES = new Map<string, ImageAttachment["mediaType"]>([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

/**
 * CLI 附件是“一次性待发送队列”，不复制文件到 data/，也不允许读取 workspace 外部。
 * add 时就保存内容快照，因此用户随后修改源文件不会让已经预览过的附件悄悄变化。
 */
export class AttachmentQueue {
  private readonly attachments: UserAttachment[] = [];

  constructor(private readonly workspaceRoot: string) {}

  async add(requestedPath: string): Promise<UserAttachment> {
    if (this.attachments.length >= MAX_QUEUED_ATTACHMENTS) {
      throw new Error(`at most ${MAX_QUEUED_ATTACHMENTS} attachments may be queued`);
    }
    const attachment = await loadAttachment(this.workspaceRoot, requestedPath);
    if (this.attachments.some((item) => item.relativePath === attachment.relativePath)) {
      throw new Error(`attachment is already queued: ${attachment.relativePath}`);
    }
    const totalBytes = this.attachments.reduce((sum, item) => sum + item.bytes, 0)
      + attachment.bytes;
    if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new Error(
        `attachments exceed the ${formatBytes(MAX_TOTAL_ATTACHMENT_BYTES)} total size limit`,
      );
    }
    this.attachments.push(attachment);
    return attachment;
  }

  snapshot(): readonly UserAttachment[] {
    return [...this.attachments];
  }

  clear(): number {
    return this.attachments.splice(0).length;
  }

  get size(): number {
    return this.attachments.length;
  }
}

export async function loadAttachment(
  workspaceRoot: string,
  requestedPath: string,
): Promise<UserAttachment> {
  const rawPath = requestedPath.trim();
  // readline 已把命令后整段作为一个参数，路径含空格不要求引号；同时兼容用户按普通
  // Shell 习惯输入 /attach "screenshots/error shot.png"。
  const trimmedPath = rawPath.length >= 2
    && ((rawPath.startsWith('"') && rawPath.endsWith('"'))
      || (rawPath.startsWith("'") && rawPath.endsWith("'")))
    ? rawPath.slice(1, -1)
    : rawPath;
  if (trimmedPath.length === 0) throw new Error("attachment path is required");
  if (trimmedPath.includes("\0")) throw new Error("attachment path contains a NUL byte");
  // win32 检查使测试和 WSL 下也能拒绝 C:\secret.txt、UNC 等 Windows 绝对路径。
  if (path.isAbsolute(trimmedPath) || path.win32.isAbsolute(trimmedPath)) {
    throw new Error("attachment path must be relative to the workspace");
  }

  const root = await fs.realpath(workspaceRoot);
  const requestedTarget = path.resolve(root, trimmedPath);
  if (isOutsideRoot(path.relative(root, requestedTarget))) {
    throw new Error("attachment path escapes the workspace");
  }

  await rejectSymbolicLinkSegments(root, requestedTarget);
  const finalStat = await fs.lstat(requestedTarget);
  if (finalStat.isSymbolicLink()) throw new Error("attachment must not be a symbolic link");
  if (!finalStat.isFile()) throw new Error("attachment must be a regular file");
  const realTarget = await fs.realpath(requestedTarget);
  if (isOutsideRoot(path.relative(root, realTarget))) {
    throw new Error("attachment resolves outside the workspace");
  }

  const extension = path.extname(realTarget).toLowerCase();
  const imageMediaType = IMAGE_MEDIA_TYPES.get(extension);
  const byteLimit = imageMediaType ? MAX_IMAGE_ATTACHMENT_BYTES : MAX_TEXT_ATTACHMENT_BYTES;
  if (!imageMediaType && !TEXT_EXTENSIONS.has(extension)) {
    throw new Error(`unsupported attachment type: ${extension || "no extension"}`);
  }
  if (finalStat.size > byteLimit) {
    throw new Error(`attachment is too large; maximum is ${formatBytes(byteLimit)}`);
  }

  const buffer = await fs.readFile(realTarget);
  // lstat 和 readFile 之间文件仍可能变化，必须按实际读到的字节再检查一次。
  if (buffer.length > byteLimit) {
    throw new Error(`attachment is too large; maximum is ${formatBytes(byteLimit)}`);
  }
  const relativePath = path.relative(root, realTarget).split(path.sep).join("/");

  if (imageMediaType) {
    validateImageSignature(buffer, imageMediaType);
    return {
      kind: "image",
      relativePath,
      mediaType: imageMediaType,
      bytes: buffer.length,
      data: buffer.toString("base64"),
    };
  }

  if (buffer.includes(0)) throw new Error("text attachment must not contain NUL bytes");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new Error("text attachment must contain valid UTF-8");
  }
  return {
    kind: "text",
    relativePath,
    mediaType: "text/plain",
    bytes: buffer.length,
    text,
  };
}

export function formatAttachment(attachment: UserAttachment): string {
  return `${attachment.relativePath} (${attachment.kind}, ${formatBytes(attachment.bytes)})`;
}

/** 用明确边界包装文本附件；内容仍是 user 数据，不能获得 system 指令优先级。 */
export function formatTextAttachmentContent(attachment: TextAttachment): string {
  return `[Attached text file: ${JSON.stringify(attachment.relativePath)}]\n<attachment>\n${attachment.text}\n</attachment>`;
}

export function formatAttachmentList(attachments: readonly UserAttachment[]): string {
  if (attachments.length === 0) return "[附件] 当前没有待发送附件。";
  const totalBytes = attachments.reduce((sum, attachment) => sum + attachment.bytes, 0);
  const lines = [`[附件] ${attachments.length} 个待发送，共 ${formatBytes(totalBytes)}`];
  for (const attachment of attachments) lines.push(`  - ${formatAttachment(attachment)}`);
  lines.push("  这些附件将在下一条普通消息成功发送后清空。");
  return lines.join("\n");
}

function validateImageSignature(buffer: Buffer, mediaType: ImageAttachment["mediaType"]): void {
  const matches = mediaType === "image/png"
    ? buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : mediaType === "image/jpeg"
      ? buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
      : mediaType === "image/gif"
        ? buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))
        : buffer.length >= 12
          && buffer.subarray(0, 4).toString("ascii") === "RIFF"
          && buffer.subarray(8, 12).toString("ascii") === "WEBP";
  if (!matches) throw new Error(`file content does not match ${mediaType}`);
}

function isOutsideRoot(relativePath: string): boolean {
  return relativePath === ".."
    || relativePath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativePath);
}

async function rejectSymbolicLinkSegments(root: string, target: string): Promise<void> {
  const relative = path.relative(root, target);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat: import("node:fs").Stats;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new Error("attachment file was not found");
      }
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error("attachment path must not contain symbolic links");
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
