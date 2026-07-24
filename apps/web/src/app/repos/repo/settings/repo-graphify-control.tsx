"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import type { GraphifyDoc } from "@skipper/shared";
import { useT } from "@/lib/app-i18n";

/**
 * Per-repo Graphify knowledge-graph index (#233): a local, opt-in tree-sitter
 * index of the repo the planner queries while exploring the code. Toggle enables
 * it; an in-flight install/index is polled so the status appears when it settles.
 * A failed index never blocks planning — it just runs without the graph.
 */
export function RepoGraphifyControl({
  owner,
  name,
  enabled,
  busy,
  onToggle,
}: {
  owner: string;
  name: string;
  enabled: boolean;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  const { t } = useT();
  const g = t.inbox.repoPage.graphify;

  const [doc, setDoc] = useState<GraphifyDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reindexing, setReindexing] = useState(false);

  const load = useCallback(() => {
    if (!window.skipper) return;
    window.skipper.orchestrator.getRepoGraphify(owner, name).then((res) => {
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
  }, [load, enabled]);

  // Poll while a run is in flight — or while the doc hasn't appeared yet after
  // enabling (the toggle kicks the first index asynchronously) — so the status
  // shows up without a page reload.
  const inFlight = doc?.status === "installing" || doc?.status === "indexing";
  const waiting = enabled && (doc === null || inFlight);
  useEffect(() => {
    if (!waiting) return;
    const id = setInterval(load, 2500);
    return () => clearInterval(id);
  }, [waiting, load]);

  const reindex = async () => {
    if (!window.skipper) return;
    setReindexing(true);
    setError(null);
    try {
      const res = await window.skipper.orchestrator.reindexRepoGraphify(owner, name);
      if (!res.ok) setError(res.error);
      else load();
    } finally {
      setReindexing(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted leading-relaxed">{g.desc}</p>

      <div className="flex items-center justify-between">
        <span className="text-[13px]">{g.toggle}</span>
        <button
          onClick={() => onToggle(!enabled)}
          disabled={busy}
          className={`relative w-10 h-[22px] rounded-full transition-colors shrink-0 disabled:opacity-50 ${
            enabled ? "bg-accent" : "bg-border"
          }`}
        >
          <span
            className={`absolute top-[3px] h-4 w-4 rounded-full bg-white transition-transform ${
              enabled ? "left-[22px]" : "left-[3px]"
            }`}
          />
        </button>
      </div>

      {enabled && doc?.status === "installing" && (
        <div className="flex items-center gap-2 rounded-md border border-border bg-card-hover/40 px-3 py-3 text-[13px] text-muted">
          <Loader2 size={13} className="animate-spin" />
          {g.installing}
        </div>
      )}

      {enabled && doc?.status === "indexing" && (
        <div className="flex items-center gap-2 rounded-md border border-border bg-card-hover/40 px-3 py-3 text-[13px] text-muted">
          <Loader2 size={13} className="animate-spin" />
          {g.indexing}
        </div>
      )}

      {enabled && doc?.status === "ready" && doc.indexedSha && (
        <div className="flex items-center gap-2">
          <p className="text-[11px] text-muted/60 flex-1">
            {g.ready(doc.indexedSha.slice(0, 7), new Date(doc.updatedAt).toLocaleString())}
          </p>
          <button
            onClick={() => void reindex()}
            disabled={busy || reindexing}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[12px] font-medium text-muted hover:text-foreground hover:bg-card-hover transition-colors disabled:opacity-50"
          >
            {reindexing ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            {g.reindex}
          </button>
        </div>
      )}

      {enabled && doc?.status === "failed" && (
        <div className="space-y-2">
          <div className="rounded-md border border-warning/25 bg-warning-bg px-3 py-2 text-[12px] text-warning leading-relaxed">
            {doc.error ? g.failed(doc.error) : g.failedGeneric}
          </div>
          <button
            onClick={() => void reindex()}
            disabled={busy || reindexing}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[12px] font-medium text-muted hover:text-foreground hover:bg-card-hover transition-colors disabled:opacity-50"
          >
            {reindexing ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            {g.retry}
          </button>
        </div>
      )}

      {error && <p className="text-[11px] text-danger leading-relaxed">{error}</p>}
    </div>
  );
}
