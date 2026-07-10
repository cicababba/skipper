"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  Edit2,
  Lightbulb,
  Loader2,
  RefreshCw,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { useT } from "@/lib/app-i18n";

interface SourceRef {
  commit: string;
  file?: string;
  lines?: string;
}

interface KnowledgeAtomDto {
  id: string;
  title: string;
  project: string;
  created: string;
  sourceRefs: SourceRef[];
  tags: string[];
  score: number;
  body: string;
}

interface PendingEntryDto {
  filePath: string;
  atom: KnowledgeAtomDto;
}

interface EditDraft {
  title: string;
  body: string;
  tags: string; // comma-separated for the form
  score: number;
}

function scoreClasses(score: number): string {
  if (score >= 7) return "bg-emerald-500/10 text-emerald-300 border-emerald-500/20";
  if (score >= 4) return "bg-amber-500/10 text-amber-300 border-amber-500/20";
  return "bg-muted/10 text-muted border-muted/20";
}

export default function KnowledgePage() {
  const [entries, setEntries] = useState<PendingEntryDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<EditDraft | null>(null);
  const [minScore, setMinScore] = useState(0);
  const { t } = useT();
  const tr = t.knowledge.review;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/knowledge/pending", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? tr.loadFailed);
      setEntries(data.entries ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [tr.loadFailed]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(
    () => entries.filter((e) => e.atom.score >= minScore),
    [entries, minScore],
  );

  const startEdit = (entry: PendingEntryDto) => {
    setEditingId(entry.filePath);
    setDraft({
      title: entry.atom.title,
      body: entry.atom.body,
      tags: entry.atom.tags.join(", "),
      score: entry.atom.score,
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraft(null);
  };

  const saveEdit = async (entry: PendingEntryDto) => {
    if (!draft) return;
    setBusyId(entry.filePath);
    try {
      const res = await fetch("/api/knowledge/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          filePath: entry.filePath,
          title: draft.title,
          body: draft.body,
          tags: draft.tags.split(",").map((t) => t.trim()).filter(Boolean),
          score: draft.score,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? tr.saveFailed);
      cancelEdit();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const act = async (entry: PendingEntryDto, action: "accept" | "reject") => {
    setBusyId(entry.filePath);
    try {
      const res = await fetch(`/api/knowledge/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filePath: entry.filePath }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? tr.actionFailed(action));
      // Optimistic: drop the entry locally so the user sees the queue shrink.
      setEntries((prev) => prev.filter((e) => e.filePath !== entry.filePath));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="min-h-full p-8">
      <div className="max-w-4xl mx-auto">
        <header className="flex items-start justify-between mb-6">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <Lightbulb size={22} className="text-accent" />
              <h1 className="text-2xl font-semibold tracking-tight">{tr.title}</h1>
            </div>
            <p className="text-sm text-muted">{tr.description}</p>
          </div>
          <button
            onClick={load}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm text-muted hover:text-foreground hover:bg-card transition-colors"
            title={tr.refresh}
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            <span>{tr.refresh}</span>
          </button>
        </header>

        <div className="flex items-center gap-3 mb-6 text-sm">
          <span className="text-muted">{tr.minScore}</span>
          <input
            type="range"
            min={0}
            max={10}
            step={1}
            value={minScore}
            onChange={(e) => setMinScore(Number(e.target.value))}
            className="w-40 accent-accent"
          />
          <span className="font-mono text-muted w-6 text-center">{minScore}</span>
          <span className="text-muted/60">·</span>
          <span className="text-muted">{tr.pendingCount(visible.length, entries.length)}</span>
        </div>

        {error && (
          <div className="mb-4 p-3 rounded-lg border border-red-500/20 bg-red-500/10 text-sm text-red-300">
            {error}
          </div>
        )}

        {loading && entries.length === 0 ? (
          <div className="flex items-center justify-center py-20 text-muted">
            <Loader2 className="animate-spin mr-2" size={18} /> {tr.loading}
          </div>
        ) : visible.length === 0 ? (
          <div className="text-center py-20 text-muted">
            <Lightbulb size={32} className="mx-auto mb-3 opacity-30" />
            <p className="text-sm">
              {entries.length === 0 ? tr.emptyQueue : tr.emptyFiltered}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {visible.map((entry) => {
              const editing = editingId === entry.filePath;
              const busy = busyId === entry.filePath;
              return (
                <article
                  key={entry.filePath}
                  className="rounded-lg border border-card-hover bg-card overflow-hidden"
                >
                  <header className="px-5 py-4 border-b border-card-hover flex items-start gap-4">
                    <div className="flex-1 min-w-0">
                      {editing && draft ? (
                        <input
                          type="text"
                          value={draft.title}
                          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                          className="w-full bg-transparent border-b border-card-hover focus:border-accent outline-none text-lg font-medium pb-1"
                          placeholder={tr.atomTitlePlaceholder}
                        />
                      ) : (
                        <h2 className="text-lg font-medium leading-tight">{entry.atom.title}</h2>
                      )}
                      <div className="flex flex-wrap items-center gap-2 mt-2 text-[11px]">
                        <span className={`px-1.5 py-0.5 rounded border ${scoreClasses(entry.atom.score)}`}>
                          {tr.scoreBadge(entry.atom.score)}
                        </span>
                        <span className="px-1.5 py-0.5 rounded bg-muted/10 text-muted border border-muted/20">
                          {entry.atom.project}
                        </span>
                        <span className="text-muted/60">{entry.atom.created}</span>
                        {entry.atom.sourceRefs[0]?.commit && (
                          <span className="font-mono text-muted/60">
                            {entry.atom.sourceRefs[0].commit.slice(0, 7)}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {editing ? (
                        <>
                          <button
                            onClick={() => saveEdit(entry)}
                            disabled={busy}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-accent/10 text-accent hover:bg-accent/20 transition-colors text-sm disabled:opacity-40"
                          >
                            <Save size={14} />
                            {tr.save}
                          </button>
                          <button
                            onClick={cancelEdit}
                            disabled={busy}
                            className="p-1.5 rounded-md text-muted hover:text-foreground hover:bg-card-hover transition-colors disabled:opacity-40"
                            title={tr.cancel}
                          >
                            <X size={16} />
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            onClick={() => act(entry, "accept")}
                            disabled={busy}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 transition-colors text-sm disabled:opacity-40"
                            title={tr.acceptTitle}
                          >
                            {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                            {tr.accept}
                          </button>
                          <button
                            onClick={() => startEdit(entry)}
                            disabled={busy}
                            className="p-1.5 rounded-md text-muted hover:text-foreground hover:bg-card-hover transition-colors disabled:opacity-40"
                            title={tr.editTitle}
                          >
                            <Edit2 size={16} />
                          </button>
                          <button
                            onClick={() => act(entry, "reject")}
                            disabled={busy}
                            className="p-1.5 rounded-md text-muted hover:text-red-300 hover:bg-red-500/10 transition-colors disabled:opacity-40"
                            title={tr.rejectTitle}
                          >
                            <Trash2 size={16} />
                          </button>
                        </>
                      )}
                    </div>
                  </header>

                  <div className="px-5 py-4">
                    {editing && draft ? (
                      <div className="space-y-3">
                        <div>
                          <label className="block text-[11px] uppercase tracking-wide text-muted mb-1">
                            {tr.bodyLabel}
                          </label>
                          <textarea
                            value={draft.body}
                            onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                            rows={8}
                            className="w-full bg-card-hover/40 border border-card-hover focus:border-accent outline-none rounded-md p-3 text-sm font-mono leading-relaxed resize-y"
                          />
                        </div>
                        <div className="flex gap-3">
                          <div className="flex-1">
                            <label className="block text-[11px] uppercase tracking-wide text-muted mb-1">
                              {tr.tagsLabel}
                            </label>
                            <input
                              type="text"
                              value={draft.tags}
                              onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
                              className="w-full bg-card-hover/40 border border-card-hover focus:border-accent outline-none rounded-md px-3 py-1.5 text-sm"
                            />
                          </div>
                          <div className="w-24">
                            <label className="block text-[11px] uppercase tracking-wide text-muted mb-1">
                              {tr.scoreLabel}
                            </label>
                            <input
                              type="number"
                              min={0}
                              max={10}
                              value={draft.score}
                              onChange={(e) => setDraft({ ...draft, score: Number(e.target.value) })}
                              className="w-full bg-card-hover/40 border border-card-hover focus:border-accent outline-none rounded-md px-3 py-1.5 text-sm text-center"
                            />
                          </div>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="prose-sm max-w-none">
                          <MarkdownRenderer content={entry.atom.body} />
                        </div>
                        {entry.atom.tags.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 mt-3">
                            {entry.atom.tags.map((tag) => (
                              <span
                                key={tag}
                                className="text-[11px] px-1.5 py-0.5 rounded bg-card-hover text-muted"
                              >
                                {tag}
                              </span>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
