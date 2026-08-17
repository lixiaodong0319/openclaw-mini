import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EmbeddingClient } from "../src/embedding.js";
import {
  WorkspaceMemoryIndex,
  type WorkspaceMemoryIndexOptions,
} from "../src/memory-index.js";

const SUPPORTS_NODE_SQLITE = Number(process.versions.node.split(".")[0]) >= 22;

describe.skipIf(!SUPPORTS_NODE_SQLITE)("workspace memory index", () => {
  const temporaryRoots: string[] = [];

  async function createIndex(options: WorkspaceMemoryIndexOptions = {}): Promise<{
    workspaceRoot: string;
    indexPath: string;
    index: WorkspaceMemoryIndex;
  }> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-index-"));
    temporaryRoots.push(root);
    const workspaceRoot = path.join(root, "workspace");
    const indexPath = path.join(root, "data", "memory", "index.sqlite");
    await fs.mkdir(workspaceRoot);
    return {
      workspaceRoot,
      indexPath,
      index: new WorkspaceMemoryIndex(workspaceRoot, indexPath, options),
    };
  }

  afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, {
      recursive: true,
      force: true,
    })));
  });

  it("indexes long-term and all daily Markdown, including older dates", async () => {
    const { workspaceRoot, indexPath, index } = await createIndex();
    await fs.writeFile(
      path.join(workspaceRoot, "MEMORY.md"),
      "# Preferences\n\nThe project uses TypeScript for runtime code.\n",
      "utf8",
    );
    await fs.mkdir(path.join(workspaceRoot, "memory"));
    await fs.writeFile(
      path.join(workspaceRoot, "memory", "2025-01-01.md"),
      "# Old note\n\nThe deployment codename is winter-orchid.\n",
      "utf8",
    );

    const firstSync = await index.sync();
    expect(firstSync).toMatchObject({ indexedFiles: 2, rebuilt: true });
    await expect(fs.stat(indexPath)).resolves.toMatchObject({});

    const longTerm = await index.search("TypeScript");
    expect(longTerm.results[0]).toMatchObject({ path: "MEMORY.md", startLine: 1 });
    const oldDaily = await index.search("winter-orchid");
    expect(oldDaily.results[0]?.path).toBe("memory/2025-01-01.md");
    expect((await index.sync()).rebuilt).toBe(false);
  });

  it("detects external Markdown edits before every search", async () => {
    const { workspaceRoot, index } = await createIndex();
    const memoryPath = path.join(workspaceRoot, "MEMORY.md");
    await fs.writeFile(memoryPath, "The selected database is SQLite.\n", "utf8");
    await index.sync();
    expect((await index.search("SQLite")).results).toHaveLength(1);

    await fs.writeFile(memoryPath, "The selected database is PostgreSQL.\n", "utf8");
    expect((await index.search("SQLite")).results).toHaveLength(0);
    expect((await index.search("PostgreSQL")).results[0]?.path).toBe("MEMORY.md");
  });

  it("falls back to literal matching for Chinese queries shorter than three characters", async () => {
    const { workspaceRoot, index } = await createIndex();
    await fs.writeFile(path.join(workspaceRoot, "MEMORY.md"), "用户当前居住在北京。\n", "utf8");

    const response = await index.search("北京 用户");

    expect(response.results[0]).toMatchObject({ path: "MEMORY.md", score: 0 });
    expect(response.results[0]?.snippet).toContain("北京");
  });

  it("combines semantic vectors with keyword search", async () => {
    const embeddingClient = new FakeEmbeddingClient();
    const { workspaceRoot, index } = await createIndex({ embeddingClient, vectorWeight: 0.6 });
    await fs.writeFile(
      path.join(workspaceRoot, "MEMORY.md"),
      "# Preferences\n\nThe user prefers TypeScript for application code.\n\n# Weather\n\nRain is expected tomorrow.\n",
      "utf8",
    );

    const response = await index.search("which programming language should be used");

    expect(response.searchMode).toBe("hybrid");
    expect(response.results[0]?.path).toBe("MEMORY.md");
    expect(response.results[0]?.snippet).toContain("TypeScript");
  });

  it("persists document vectors and does not embed unchanged chunks again", async () => {
    const embeddingClient = new FakeEmbeddingClient();
    const created = await createIndex({ embeddingClient });
    await fs.writeFile(
      path.join(created.workspaceRoot, "MEMORY.md"),
      "The user prefers TypeScript for application code.\n",
      "utf8",
    );
    await created.index.search("which programming language should be used");
    const documentCallsAfterFirstSearch = embeddingClient.inputs
      .filter((input) => input.includes("prefers TypeScript")).length;

    // 新实例模拟进程重启；文档向量应从 SQLite 复用，只需生成新的查询向量。
    const reopened = new WorkspaceMemoryIndex(created.workspaceRoot, created.indexPath, {
      embeddingClient,
    });
    await reopened.search("preferred coding stack");

    expect(documentCallsAfterFirstSearch).toBe(1);
    expect(embeddingClient.inputs.filter((input) => input.includes("prefers TypeScript")))
      .toHaveLength(1);
  });

  it("falls back to BM25 when embedding generation fails", async () => {
    const embeddingClient: EmbeddingClient = {
      cacheKey: "always-fails",
      embed: async () => {
        throw new Error("temporary embedding outage");
      },
    };
    const { workspaceRoot, index } = await createIndex({ embeddingClient });
    await fs.writeFile(path.join(workspaceRoot, "MEMORY.md"), "Use TypeScript for new code.\n", "utf8");

    const response = await index.search("TypeScript");

    expect(response.searchMode).toBe("keyword");
    expect(response.results[0]?.snippet).toContain("TypeScript");
  });

  it("does not call embeddings when vector weight is zero", async () => {
    const embeddingClient = new FakeEmbeddingClient();
    const { workspaceRoot, index } = await createIndex({ embeddingClient, vectorWeight: 0 });
    await fs.writeFile(path.join(workspaceRoot, "MEMORY.md"), "Use TypeScript.\n", "utf8");

    const response = await index.search("TypeScript");

    expect(response.searchMode).toBe("keyword");
    expect(embeddingClient.inputs).toHaveLength(0);
  });

  it("rebuilds the derived database after it is deleted", async () => {
    const { workspaceRoot, indexPath, index } = await createIndex();
    await fs.writeFile(path.join(workspaceRoot, "MEMORY.md"), "Remember rebuildable-index.\n", "utf8");
    await index.sync();
    await fs.unlink(indexPath);

    const response = await index.search("rebuildable-index");

    expect(response.results[0]?.path).toBe("MEMORY.md");
    await expect(fs.stat(indexPath)).resolves.toMatchObject({});
  });

  it("reads exact Markdown lines instead of returning indexed content", async () => {
    const { workspaceRoot, index } = await createIndex();
    await fs.mkdir(path.join(workspaceRoot, "memory"));
    await fs.writeFile(
      path.join(workspaceRoot, "memory", "2026-08-14.md"),
      "line one\nline two\nline three\nline four\n",
      "utf8",
    );

    await expect(index.get("memory/2026-08-14.md", 2, 2)).resolves.toEqual({
      path: "memory/2026-08-14.md",
      startLine: 2,
      endLine: 3,
      totalLines: 4,
      content: "line two\nline three",
    });
  });

  it("limits memory_get to the two Markdown memory layers", async () => {
    const { workspaceRoot, index } = await createIndex();
    await fs.writeFile(path.join(workspaceRoot, "notes.md"), "outside memory layers", "utf8");

    await expect(index.get("notes.md")).rejects.toThrow("MEMORY.md or a direct memory/*.md");
    await expect(index.get("../MEMORY.md")).rejects.toThrow("MEMORY.md or a direct memory/*.md");
  });

  it.skipIf(process.platform === "win32")("rejects symbolic links in indexed memory", async () => {
    const { workspaceRoot, index } = await createIndex();
    const targetPath = path.join(workspaceRoot, "target.md");
    await fs.writeFile(targetPath, "linked", "utf8");
    await fs.symlink(targetPath, path.join(workspaceRoot, "MEMORY.md"));

    await expect(index.sync()).rejects.toThrow("symbolic link");
  });
});

class FakeEmbeddingClient implements EmbeddingClient {
  readonly cacheKey = "fake-semantic-v1";
  readonly inputs: string[] = [];

  async embed(inputs: readonly string[]): Promise<number[][]> {
    this.inputs.push(...inputs);
    return inputs.map((input) => {
      const normalized = input.toLowerCase();
      if (
        normalized.includes("typescript")
        || normalized.includes("programming language")
        || normalized.includes("coding stack")
      ) {
        return [1, 0];
      }
      if (normalized.includes("rain") || normalized.includes("weather")) return [0, 1];
      return [0.1, 0.1];
    });
  }
}
