import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { embed, cosineSimilarity, EMBEDDING_MODEL } from "./embedder";

interface VectorEntry {
  id: string;
  title: string;
  filePath: string;
  type: string;
  content: string;     // first ~500 chars for snippet
  embedding: number[];
  /**
   * Projects that contributed to this entry. Empty/undefined = generic
   * knowledge (no specific project attribution). For source summaries
   * derived from a project atom this is `[<project>]`; for concepts that
   * may span projects it can hold the union of contributing project tags.
   */
  projects?: string[];
}

interface VectorIndex {
  entries: VectorEntry[];
  modelName: string;
  updatedAt: string;
}

const INDEX_FILE = "vector-index.json";

export class VectorStore {
  private index: VectorIndex = { entries: [], modelName: EMBEDDING_MODEL, updatedAt: "" };
  private indexPath: string;
  private loaded = false;

  constructor(private dataPath: string) {
    this.indexPath = join(dataPath, INDEX_FILE);
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.indexPath, "utf-8");
      this.index = JSON.parse(raw);
    } catch {
      this.index = { entries: [], modelName: EMBEDDING_MODEL, updatedAt: "" };
    }
    // Drop an index built by a different embedding model: its vectors are
    // incomparable with the live model's, so searching them scores garbage.
    // Force an empty index that the next reindex rebuilds cleanly.
    if (this.index.entries.length > 0 && this.index.modelName !== EMBEDDING_MODEL) {
      this.index = { entries: [], modelName: EMBEDDING_MODEL, updatedAt: "" };
    }
    this.loaded = true;
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.indexPath), { recursive: true });
    this.index.updatedAt = new Date().toISOString();
    await writeFile(this.indexPath, JSON.stringify(this.index), "utf-8");
  }

  /** Add or update a document in the vector store */
  async upsert(
    id: string,
    title: string,
    filePath: string,
    type: string,
    fullContent: string,
    projects?: string[],
  ): Promise<void> {
    await this.load();

    // Strip frontmatter for embedding
    const body = fullContent.replace(/^---[\s\S]*?---\n*/, "").trim();
    const snippet = body.slice(0, 500);

    // Generate embedding from title + first chunk of content
    const textToEmbed = `${title}. ${body.slice(0, 1500)}`;
    const [embedding] = await embed([textToEmbed]);

    // Remove existing entry if present
    this.index.entries = this.index.entries.filter((e) => e.id !== id);

    this.index.entries.push({
      id,
      title,
      filePath,
      type,
      content: snippet,
      embedding,
      ...(projects && projects.length > 0 ? { projects } : {}),
    });
  }

  /** Remove a document */
  async remove(id: string): Promise<void> {
    await this.load();
    this.index.entries = this.index.entries.filter((e) => e.id !== id);
  }

  /** Semantic search. `project` filter is RESTRICTIVE: when set, only return
   * entries whose `projects` array contains it. Untagged ("generic") entries
   * are excluded — they show up only when no filter is set. When `project`
   * is unset, all entries participate (no scoping). */
  async search(
    query: string,
    topK: number = 10,
    project?: string,
  ): Promise<Array<{
    id: string;
    title: string;
    filePath: string;
    type: string;
    snippet: string;
    score: number;
    projects?: string[];
  }>> {
    await this.load();

    if (this.index.entries.length === 0) return [];

    const candidates = project
      ? this.index.entries.filter((e) => e.projects?.includes(project))
      : this.index.entries;
    if (candidates.length === 0) return [];

    // Embed the query
    const [queryEmbedding] = await embed([query]);

    // Score all entries
    const scored = candidates.map((entry) => ({
      id: entry.id,
      title: entry.title,
      filePath: entry.filePath,
      type: entry.type,
      snippet: entry.content,
      score: cosineSimilarity(queryEmbedding, entry.embedding),
      projects: entry.projects,
    }));

    // Sort by score descending, take top K
    scored.sort((a, b) => b.score - a.score);

    // Only return entries with a reasonable similarity (> 0.2)
    return scored.filter((s) => s.score > 0.2).slice(0, topK);
  }

  /** Enumerate distinct project tags + a count of indexed entries per project. */
  async projectCounts(): Promise<Array<{ project: string; count: number }>> {
    await this.load();
    const counts = new Map<string, number>();
    for (const e of this.index.entries) {
      for (const p of e.projects ?? []) {
        counts.set(p, (counts.get(p) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .map(([project, count]) => ({ project, count }))
      .sort((a, b) => b.count - a.count);
  }

  /** Ids of every indexed document. */
  async ids(): Promise<string[]> {
    await this.load();
    return this.index.entries.map((e) => e.id);
  }

  /** Check if a document is indexed */
  async has(id: string): Promise<boolean> {
    await this.load();
    return this.index.entries.some((e) => e.id === id);
  }

  /** Number of indexed documents */
  async count(): Promise<number> {
    await this.load();
    return this.index.entries.length;
  }
}
