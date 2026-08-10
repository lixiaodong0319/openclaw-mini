import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeTool } from "../src/tools.js";

describe("apply_patch tool", () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-patch-"));
  });

  it("updates an existing file with an exact hunk", async () => {
    await fs.writeFile(path.join(workspaceRoot, "config.ts"), "const port = 3000;\n", "utf8");

    const output = JSON.parse(await executeTool("apply_patch", {
      patch: `*** Begin Patch
*** Update File: config.ts
@@
-const port = 3000;
+const port = 8080;
*** End Patch`,
    }, { workspaceRoot }));

    expect(output).toEqual({
      files: [{ path: "config.ts", operation: "update", hunks: 1, bytes: 19 }],
    });
    await expect(fs.readFile(path.join(workspaceRoot, "config.ts"), "utf8"))
      .resolves.toBe("const port = 8080;\n");
  });

  it("applies multiple hunks and adds another file in one patch", async () => {
    await fs.mkdir(path.join(workspaceRoot, "docs"));
    await fs.writeFile(path.join(workspaceRoot, "notes.txt"), "one\nmiddle\nthree\n", "utf8");

    const output = JSON.parse(await executeTool("apply_patch", {
      patch: `*** Begin Patch
*** Update File: notes.txt
@@
-one
+ONE
@@
-three
+THREE
*** Add File: docs/new.txt
+first line
+second line
*** End Patch`,
    }, { workspaceRoot }));

    expect(output.files).toEqual([
      { path: "notes.txt", operation: "update", hunks: 2, bytes: 17 },
      { path: "docs/new.txt", operation: "add", hunks: 0, bytes: 23 },
    ]);
    await expect(fs.readFile(path.join(workspaceRoot, "notes.txt"), "utf8"))
      .resolves.toBe("ONE\nmiddle\nTHREE\n");
    await expect(fs.readFile(path.join(workspaceRoot, "docs", "new.txt"), "utf8"))
      .resolves.toBe("first line\nsecond line\n");
  });

  it("does not write any file when a later hunk fails validation", async () => {
    await fs.writeFile(path.join(workspaceRoot, "config.txt"), "original\n", "utf8");

    await expect(executeTool("apply_patch", {
      patch: `*** Begin Patch
*** Add File: created.txt
+should not exist
*** Update File: config.txt
@@
-missing
+changed
*** End Patch`,
    }, { workspaceRoot })).rejects.toThrow("context was not found");

    await expect(fs.readFile(path.join(workspaceRoot, "config.txt"), "utf8")).resolves.toBe("original\n");
    await expect(fs.stat(path.join(workspaceRoot, "created.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("updates a final line without adding a newline", async () => {
    await fs.writeFile(path.join(workspaceRoot, "note.txt"), "before", "utf8");

    await executeTool("apply_patch", {
      patch: `*** Begin Patch
*** Update File: note.txt
@@
-before
+after
*** End Patch`,
    }, { workspaceRoot });

    await expect(fs.readFile(path.join(workspaceRoot, "note.txt"), "utf8")).resolves.toBe("after");
  });

  it("preserves CRLF line endings in updated files", async () => {
    await fs.writeFile(path.join(workspaceRoot, "windows.txt"), "first\r\nsecond\r\n", "utf8");

    await executeTool("apply_patch", {
      patch: `*** Begin Patch
*** Update File: windows.txt
@@
-second
+updated
*** End Patch`,
    }, { workspaceRoot });

    await expect(fs.readFile(path.join(workspaceRoot, "windows.txt"), "utf8"))
      .resolves.toBe("first\r\nupdated\r\n");
  });

  it("rejects deletion, path traversal, missing parents, and existing add targets", async () => {
    await fs.writeFile(path.join(workspaceRoot, "existing.txt"), "old", "utf8");

    await expect(executeTool("apply_patch", {
      patch: "*** Begin Patch\n*** Delete File: existing.txt\n*** End Patch",
    }, { workspaceRoot })).rejects.toThrow("does not support deleting");
    await expect(executeTool("apply_patch", {
      patch: "*** Begin Patch\n*** Add File: ../outside.txt\n+no\n*** End Patch",
    }, { workspaceRoot })).rejects.toThrow("workspace");
    await expect(executeTool("apply_patch", {
      patch: "*** Begin Patch\n*** Add File: missing/new.txt\n+no\n*** End Patch",
    }, { workspaceRoot })).rejects.toThrow("parent directory");
    await expect(executeTool("apply_patch", {
      patch: "*** Begin Patch\n*** Add File: existing.txt\n+new\n*** End Patch",
    }, { workspaceRoot })).rejects.toThrow("existing path");
  });

  it.skipIf(process.platform === "win32")("rejects paths containing symbolic links", async () => {
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-patch-outside-"));
    try {
      await fs.symlink(outsideRoot, path.join(workspaceRoot, "linked"));

      await expect(executeTool("apply_patch", {
        patch: "*** Begin Patch\n*** Add File: linked/new.txt\n+no\n*** End Patch",
      }, { workspaceRoot })).rejects.toThrow("symbolic links");
      await expect(fs.stat(path.join(outsideRoot, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });
});
