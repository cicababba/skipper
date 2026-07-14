// KnowledgeAtom — the unit of project-derived knowledge.
//
// An atom is an LLM-extracted insight from a commit, conversation, or doc
// change. It lives on disk as Markdown with YAML frontmatter so it's
// hand-editable and Obsidian-compatible, and so the existing compiler can
// ingest it without a new source type once accepted.
//
// On-disk layout (under the app's <userData>/knowledge/):
//
//   pending/          ← LLM proposed, awaiting review
//   rejected/         ← user rejected, kept for re-pickup
//   accepted/<name>/  ← accepted, per-project archive

export interface SourceRef {
  /** Git SHA the atom was extracted from. Always present for commit-derived atoms. */
  commit: string;
  /** Optional path of the file the insight is about (POSIX-relative to project root). */
  file?: string;
  /** Optional line range hint, e.g. "12-45". Free-form, not parsed. */
  lines?: string;
}

export interface KnowledgeAtom {
  /** Stable slug used as the filename stem. */
  id: string;
  title: string;
  /** Project the atom was extracted from (basename of repo root unless overridden). */
  project: string;
  /** ISO date (YYYY-MM-DD). */
  created: string;
  sourceRefs: SourceRef[];
  tags: string[];
  /**
   * Self-assessed reusability score 0-10. The extractor LLM writes this; the
   * review CLI / UI can filter by it ("accept all >= 7", etc.).
   * 0-2 = trivial. 6-8 = solid pattern. 9-10 = foundational.
   */
  score: number;
  body: string;
}

/** Convert a title to a kebab-case slug usable as a filename stem. */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining marks
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** Build the on-disk filename for an atom. */
export function atomFilename(atom: KnowledgeAtom): string {
  return `${atom.created}-${atom.id}.md`;
}

/**
 * Serialize an atom as Markdown with YAML frontmatter. The format is
 * intentionally a tight subset (we control writes; we don't accept arbitrary
 * YAML) so we can parse it back without pulling in a full YAML lib.
 */
export function serializeAtom(atom: KnowledgeAtom): string {
  const escape = (s: string): string => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const lines: string[] = ["---"];
  lines.push(`id: ${atom.id}`);
  lines.push(`title: "${escape(atom.title)}"`);
  lines.push(`project: ${atom.project}`);
  lines.push(`created: ${atom.created}`);
  lines.push(`score: ${atom.score}`);
  if (atom.tags.length > 0) {
    lines.push(`tags: [${atom.tags.map((t) => escape(t)).join(", ")}]`);
  } else {
    lines.push("tags: []");
  }
  lines.push("source_refs:");
  if (atom.sourceRefs.length === 0) {
    // Empty list — keep the key for round-trip stability.
    lines[lines.length - 1] = "source_refs: []";
  } else {
    for (const ref of atom.sourceRefs) {
      lines.push(`  - commit: ${ref.commit}`);
      if (ref.file) lines.push(`    file: ${ref.file}`);
      if (ref.lines) lines.push(`    lines: "${escape(ref.lines)}"`);
    }
  }
  lines.push("---");
  lines.push("");
  lines.push(atom.body.trimEnd());
  lines.push("");
  return lines.join("\n");
}

/**
 * Parse a Markdown file produced by serializeAtom (or hand-edited keeping the
 * same shape). Defensive: tolerates missing optional fields, malformed score,
 * extra unknown keys. Returns null if frontmatter is absent.
 */
export function parseAtom(text: string): KnowledgeAtom | null {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  const frontmatter = m[1];
  const body = m[2].trim();

  const get = (key: string): string | undefined => {
    const r = new RegExp(`^${key}:\\s*(.+)$`, "m");
    const x = r.exec(frontmatter);
    return x ? x[1].trim() : undefined;
  };
  const unquote = (s: string): string => {
    const t = s.trim();
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
      return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    return t;
  };

  const id = get("id");
  const title = get("title");
  const project = get("project");
  const created = get("created");
  if (!id || !title || !project || !created) return null;

  const scoreRaw = get("score");
  const score = scoreRaw ? Math.max(0, Math.min(10, Number(scoreRaw))) : 0;
  if (!Number.isFinite(score)) return null;

  const tagsRaw = get("tags");
  const tags: string[] = [];
  if (tagsRaw && tagsRaw !== "[]") {
    const inner = tagsRaw.replace(/^\[|\]$/g, "");
    for (const t of inner.split(",")) {
      const v = unquote(t).trim();
      if (v) tags.push(v);
    }
  }

  const sourceRefs: SourceRef[] = [];
  // Block style: source_refs: followed by indented "- commit: …" entries.
  // We re-parse the source_refs block manually because regex on YAML is painful.
  const srStart = frontmatter.search(/^source_refs:\s*$/m);
  if (srStart >= 0) {
    const after = frontmatter.slice(srStart);
    const refBlock = after.split("\n").slice(1);
    let current: Partial<SourceRef> | null = null;
    for (const raw of refBlock) {
      if (/^\S/.test(raw) || raw.trim() === "") break;
      const m1 = /^\s*-\s+commit:\s*(.+)$/.exec(raw);
      const m2 = /^\s+file:\s*(.+)$/.exec(raw);
      const m3 = /^\s+lines:\s*(.+)$/.exec(raw);
      if (m1) {
        if (current?.commit) sourceRefs.push(current as SourceRef);
        current = { commit: m1[1].trim() };
      } else if (m2 && current) {
        current.file = m2[1].trim();
      } else if (m3 && current) {
        current.lines = unquote(m3[1]);
      }
    }
    if (current?.commit) sourceRefs.push(current as SourceRef);
  }

  return {
    id,
    title: unquote(title),
    project,
    created,
    score,
    tags,
    sourceRefs,
    body,
  };
}
