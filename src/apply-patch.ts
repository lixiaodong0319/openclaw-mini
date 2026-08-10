import fs from "node:fs/promises";
import path from "node:path";

const MAX_PATCH_BYTES = 1024 * 1024;
const MAX_PATCH_FILE_BYTES = 1024 * 1024;
const MAX_PATCH_ACTIONS = 50;
const MAX_PATCH_HUNKS = 200;

interface PatchHunk {
  lines: string[];
}

type PatchAction =
  | { type: "add"; path: string; content: string }
  | { type: "update"; path: string; hunks: PatchHunk[] };

interface PlannedWrite {
  type: "add" | "update";
  path: string;
  target: string;
  content: string;
  hunks: number;
}

export async function applyWorkspacePatch(patchText: string, workspaceRoot: string): Promise<string> {
  if (Buffer.byteLength(patchText, "utf8") > MAX_PATCH_BYTES) {
    throw new Error(`apply_patch patch is too large; maximum is ${MAX_PATCH_BYTES} bytes`);
  }

  const actions = parsePatch(patchText);
  const root = await fs.realpath(workspaceRoot);
  const plannedWrites: PlannedWrite[] = [];
  const targets = new Set<string>();

  // 先解析路径、读取原文并应用全部 hunk，只在所有操作都通过后才开始写文件。
  for (const action of actions) {
    const resolved = await resolvePatchTarget(root, action.path, action.type);
    const targetKey = process.platform === "win32" ? resolved.target.toLowerCase() : resolved.target;
    if (targets.has(targetKey)) {
      throw new Error(`apply_patch contains more than one action for ${action.path}`);
    }
    targets.add(targetKey);

    if (action.type === "add") {
      ensurePatchedFileSize(action.content, action.path);
      plannedWrites.push({
        type: "add",
        path: resolved.relativePath,
        target: resolved.target,
        content: action.content,
        hunks: 0,
      });
      continue;
    }

    const stat = await fs.stat(resolved.target);
    if (stat.size > MAX_PATCH_FILE_BYTES) {
      throw new Error(`apply_patch file is too large: ${action.path}`);
    }
    const original = await fs.readFile(resolved.target, "utf8");
    if (original.includes("\0")) {
      throw new Error(`apply_patch cannot update a binary file: ${action.path}`);
    }

    let updated = original;
    for (const hunk of action.hunks) {
      updated = applyHunk(updated, hunk, action.path);
    }
    ensurePatchedFileSize(updated, action.path);
    plannedWrites.push({
      type: "update",
      path: resolved.relativePath,
      target: resolved.target,
      content: updated,
      hunks: action.hunks.length,
    });
  }

  // add 使用 wx，防止校验后若有其他进程创建同名文件时被意外覆盖。
  // update 在这里才写盘，因此“路径错误或 hunk 不匹配”不会产生部分修改。
  for (const write of plannedWrites) {
    await fs.writeFile(write.target, write.content, write.type === "add" ? { encoding: "utf8", flag: "wx" } : "utf8");
  }

  return JSON.stringify({
    files: plannedWrites.map((write) => ({
      path: write.path,
      operation: write.type,
      hunks: write.hunks,
      bytes: Buffer.byteLength(write.content, "utf8"),
    })),
  }, null, 2);
}

function parsePatch(patchText: string): PatchAction[] {
  const normalized = patchText.replaceAll("\r\n", "\n");
  const lines = normalized.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines[0] !== "*** Begin Patch" || lines.at(-1) !== "*** End Patch") {
    throw new Error("apply_patch must start with '*** Begin Patch' and end with '*** End Patch'");
  }

  const actions: PatchAction[] = [];
  let hunkCount = 0;
  let index = 1;
  while (index < lines.length - 1) {
    const header = lines[index] ?? "";
    if (header.startsWith("*** Add File: ")) {
      const filePath = requirePatchPath(header.slice("*** Add File: ".length));
      index += 1;
      const contentLines: string[] = [];
      while (index < lines.length - 1 && !isPatchActionHeader(lines[index] ?? "")) {
        const line = lines[index] ?? "";
        if (!line.startsWith("+")) {
          throw new Error(`apply_patch added file lines must start with '+': ${filePath}`);
        }
        contentLines.push(line.slice(1));
        index += 1;
      }
      actions.push({
        type: "add",
        path: filePath,
        content: contentLines.length === 0 ? "" : `${contentLines.join("\n")}\n`,
      });
    } else if (header.startsWith("*** Update File: ")) {
      const filePath = requirePatchPath(header.slice("*** Update File: ".length));
      index += 1;
      const hunks: PatchHunk[] = [];
      while (index < lines.length - 1 && !isPatchActionHeader(lines[index] ?? "")) {
        const hunkHeader = lines[index] ?? "";
        if (!hunkHeader.startsWith("@@")) {
          throw new Error(`apply_patch expected a hunk beginning with '@@': ${filePath}`);
        }
        index += 1;
        const hunkLines: string[] = [];
        while (
          index < lines.length - 1
          && !(lines[index] ?? "").startsWith("@@")
          && !isPatchActionHeader(lines[index] ?? "")
        ) {
          const line = lines[index] ?? "";
          if (!line.startsWith(" ") && !line.startsWith("+") && !line.startsWith("-")) {
            throw new Error(`apply_patch hunk lines must start with space, '+', or '-': ${filePath}`);
          }
          hunkLines.push(line);
          index += 1;
        }
        validateHunk(hunkLines, filePath);
        hunks.push({ lines: hunkLines });
        hunkCount += 1;
        if (hunkCount > MAX_PATCH_HUNKS) {
          throw new Error(`apply_patch has too many hunks; maximum is ${MAX_PATCH_HUNKS}`);
        }
      }
      if (hunks.length === 0) {
        throw new Error(`apply_patch update has no hunks: ${filePath}`);
      }
      actions.push({ type: "update", path: filePath, hunks });
    } else if (header.startsWith("*** Delete File: ")) {
      throw new Error("apply_patch does not support deleting files");
    } else {
      throw new Error(`apply_patch has an unknown action: ${header}`);
    }

    if (actions.length > MAX_PATCH_ACTIONS) {
      throw new Error(`apply_patch has too many file actions; maximum is ${MAX_PATCH_ACTIONS}`);
    }
  }

  if (actions.length === 0) {
    throw new Error("apply_patch contains no file actions");
  }
  return actions;
}

function validateHunk(lines: string[], filePath: string): void {
  if (lines.length === 0) {
    throw new Error(`apply_patch hunk is empty: ${filePath}`);
  }
  if (!lines.some((line) => line.startsWith("+") || line.startsWith("-"))) {
    throw new Error(`apply_patch hunk contains no changes: ${filePath}`);
  }
  if (!lines.some((line) => !line.startsWith("+"))) {
    throw new Error(`apply_patch update hunk needs context or removed text: ${filePath}`);
  }
}

function applyHunk(content: string, hunk: PatchHunk, filePath: string): string {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const oldLines = hunk.lines.filter((line) => !line.startsWith("+")).map((line) => line.slice(1));
  const newLines = hunk.lines.filter((line) => !line.startsWith("-")).map((line) => line.slice(1));
  const oldBlock = `${oldLines.join(newline)}${newline}`;
  const newBlock = newLines.length === 0 ? "" : `${newLines.join(newline)}${newline}`;

  let match = findUniqueBlock(content, oldBlock, filePath);
  let replacement = newBlock;
  if (match === -1) {
    // 文件最后一行可能没有换行符；只在旧块恰好位于 EOF 时尝试无末尾换行匹配。
    const oldWithoutFinalNewline = oldBlock.slice(0, -newline.length);
    const terminalMatch = findUniqueBlock(content, oldWithoutFinalNewline, filePath);
    if (terminalMatch === -1 || terminalMatch + oldWithoutFinalNewline.length !== content.length) {
      throw new Error(`apply_patch hunk context was not found: ${filePath}`);
    }
    match = terminalMatch;
    replacement = newBlock.endsWith(newline) ? newBlock.slice(0, -newline.length) : newBlock;
    return `${content.slice(0, match)}${replacement}`;
  }

  return `${content.slice(0, match)}${replacement}${content.slice(match + oldBlock.length)}`;
}

function findUniqueBlock(content: string, block: string, filePath: string): number {
  const first = content.indexOf(block);
  if (first === -1) return -1;
  if (content.indexOf(block, first + 1) !== -1) {
    throw new Error(`apply_patch hunk context occurs more than once: ${filePath}`);
  }
  return first;
}

async function resolvePatchTarget(
  root: string,
  requestedPath: string,
  operation: "add" | "update",
): Promise<{ target: string; relativePath: string }> {
  if (path.isAbsolute(requestedPath)) {
    throw new Error("apply_patch paths must be relative to the workspace");
  }
  const target = path.resolve(root, requestedPath);
  const relativePath = path.relative(root, target);
  if (isOutsideRoot(relativePath) || relativePath.length === 0) {
    throw new Error("apply_patch path escapes the workspace");
  }

  const segments = relativePath.split(path.sep);
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index] ?? "");
    const isTarget = index === segments.length - 1;
    let stat: import("node:fs").Stats | undefined;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) throw error;
    }

    if (stat?.isSymbolicLink()) {
      throw new Error(`apply_patch paths must not contain symbolic links: ${requestedPath}`);
    }
    if (!isTarget) {
      if (!stat?.isDirectory()) {
        throw new Error(`apply_patch parent directory does not exist: ${requestedPath}`);
      }
      continue;
    }

    if (operation === "add" && stat) {
      throw new Error(`apply_patch cannot add an existing path: ${requestedPath}`);
    }
    if (operation === "update" && !stat?.isFile()) {
      throw new Error(`apply_patch update target is not a file: ${requestedPath}`);
    }
  }

  return { target, relativePath: relativePath.split(path.sep).join("/") };
}

function requirePatchPath(filePath: string): string {
  if (filePath.trim().length === 0) {
    throw new Error("apply_patch file path must not be empty");
  }
  return filePath;
}

function isPatchActionHeader(line: string): boolean {
  return line === "*** End Patch"
    || line.startsWith("*** Add File: ")
    || line.startsWith("*** Update File: ")
    || line.startsWith("*** Delete File: ");
}

function ensurePatchedFileSize(content: string, filePath: string): void {
  if (Buffer.byteLength(content, "utf8") > MAX_PATCH_FILE_BYTES) {
    throw new Error(`apply_patch result is too large: ${filePath}`);
  }
}

function isOutsideRoot(relativePath: string): boolean {
  return relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath);
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
