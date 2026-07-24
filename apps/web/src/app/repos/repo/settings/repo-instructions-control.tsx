"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import type { RepoInstructionsDoc } from "@skipper/shared";
import { useT } from "@/lib/app-i18n";

/**
 * Per-repo agent instructions (#227): the Skipper-owned conventions doc injected
 * into the planner + coder for this repo. Seeded from CLAUDE.md or generated at
 * link, editable here, regenerable. An in-flight generation is polled; a failed
 * generation never blocks planning.
 */
export function RepoInstructionsControl({ owner, name }: { owner: string; name: string }) {
  const { t } = useT();
  const ri = t.inbox.repoPage.instructions;

  const [doc, setDoc] = useState<RepoInstructionsDoc | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!window.skipper) return;
    window.skipper.orchestrator.getRepoInstructions(owner, name).then((res) => {
      if (res.ok) {
        setDoc(res.doc);
        setError(null);
      } else {
        setError(res.error);
      }
    });
  }, [owner, name]);

  useEffect(() => {
    load();
  }, [load]);

  // Poll while a generation is in flight so the doc appears when it settles.
  const generating = doc?.status === "generating";
  useEffect(() => {
    if (!generating) return;
    const id = setInterval(load, 2500);
    return () => clearInterval(id);
  }, [generating, load]);

  const content = doc?.content ?? "";
  const editing = draft !== null && draft !== content;
  const value = draft ?? content;

  const save = async () => {
    if (!window.skipper || draft === null) return;
    setBusy(true);
    setError(null);
    try {
      const res = await window.skipper.orchestrator.setRepoInstructions(owner, name, draft);
      if (res.ok) {
        setDoc(res.doc);
        setDraft(null);
      } else {
        setError(res.error);
      }
    } finally {
      setBusy(false);
    }
  };

  const regenerate = async () => {
    if (!window.skipper) return;
    setBusy(true);
    setError(null);
    try {
      const res = await window.skipper.orchestrator.regenerateRepoInstructions(owner, name);
      if (!res.ok) setError(res.error);
      else load();
    } finally {
      setBusy(false);
    }
  };

  const sourceLabel = (d: RepoInstructionsDoc): string => {
    switch (d.source) {
      case "claude-md":
        return ri.sourceClaudeMd;
      case "agents-md":
        return ri.sourceAgentsMd;
      case "copilot-instructions":
        return ri.sourceCopilot;
      case "edited":
        return ri.sourceEdited;
      default:
        return ri.sourceGenerated;
    }
  };

  // Pre-#227 repos: no doc yet. Empty state + Generate.
  if (doc === null) {
    return (
      <div className="space-y-2">
        <p className="text-[13px] text-muted leading-relaxed">{ri.empty}</p>
        <button
          onClick={() => void regenerate()}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[12px] font-medium text-muted hover:text-foreground hover:bg-card-hover transition-colors disabled:opacity-50"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          {ri.generate}
        </button>
        {error && <p className="text-[11px] text-danger leading-relaxed">{error}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-[11px] text-muted/60 leading-relaxed">{ri.desc}</p>

      {generating ? (
        <div className="flex items-center gap-2 rounded-md border border-border bg-card-hover/40 px-3 py-3 text-[13px] text-muted">
          <Loader2 size={13} className="animate-spin" />
          {ri.generating}
        </div>
      ) : (
        <textarea
          value={value}
          onChange={(e) => setDraft(e.target.value)}
          rows={12}
          disabled={busy}
          className="w-full bg-card-hover/40 border border-card-hover focus:border-accent outline-none rounded-md p-3 text-sm resize-y disabled:opacity-50"
        />
      )}

      {doc.status === "failed" && (
        <div className="rounded-md border border-warning/25 bg-warning-bg px-3 py-2 text-[12px] text-warning leading-relaxed">
          {doc.error ? ri.failed(doc.error) : ri.failedGeneric} {ri.failedHint}
        </div>
      )}

      <div className="flex items-center gap-2">
        {editing && (
          <>
            <button
              onClick={() => void save()}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-md border border-accent/30 bg-accent/10 px-2 py-1 text-[12px] font-medium text-accent hover:bg-accent/20 transition-colors disabled:opacity-50"
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : null}
              {ri.save}
            </button>
            <button
              onClick={() => setDraft(null)}
              disabled={busy}
              className="rounded-md border border-border px-2 py-1 text-[12px] font-medium text-muted hover:text-foreground transition-colors disabled:opacity-50"
            >
              {ri.cancel}
            </button>
          </>
        )}
        {!editing && (
          <button
            onClick={() => void regenerate()}
            disabled={busy || generating}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[12px] font-medium text-muted hover:text-foreground hover:bg-card-hover transition-colors disabled:opacity-50"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            {ri.regenerate}
          </button>
        )}
        <div className="flex-1" />
        {!generating && !editing && (
          <p className="text-[11px] text-muted/60">
            {ri.lastUpdated(new Date(doc.updatedAt).toLocaleString())} · {sourceLabel(doc)}
          </p>
        )}
      </div>

      {error && <p className="text-[11px] text-danger leading-relaxed">{error}</p>}
    </div>
  );
}
