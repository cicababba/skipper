"use client";

import { useEffect, useState } from "react";
import { Check, Copy, Download } from "lucide-react";
import type { TrackedItem } from "@skipper/shared";
import { useT } from "@/lib/app-i18n";
import { exportAvailable } from "@/lib/export/availability";
import { exportFilename, type ExportArtifact } from "@/lib/export/filename";
import { planMarkdown } from "@/lib/export/plan-markdown";
import { reviewMarkdown } from "@/lib/export/review-markdown";
import { worktreeMarkdown } from "@/lib/export/worktree-markdown";
import { dossierMarkdown } from "@/lib/export/dossier-markdown";

// Tab-aware markdown export controls (#216): Copy as Markdown + Save as .md for
// the active tab's artifact (Overview → full dossier). Markdown is built on
// click so a fetch never runs until the user asks.

const BTN_CLASS =
  "flex items-center gap-1.5 text-[12px] font-medium px-3 py-1.5 rounded-md border border-border text-muted hover:text-foreground hover:bg-card-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent";

export function ExportControls({ item, artifact }: { item: TrackedItem; artifact: ExportArtifact }) {
  const { t } = useT();
  const e = t.inbox.exportControls;
  const [ready, setReady] = useState(false);
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setReady(!!window.skipper);
  }, []);

  if (!ready) return null;

  const available = exportAvailable(artifact, item);
  const disabled = !available || busy;

  async function buildMarkdown(): Promise<string | null> {
    const orch = window.skipper!.orchestrator;
    switch (artifact) {
      case "plan": {
        const stored = await orch.getPlan(item.id);
        return stored ? planMarkdown(stored) : null;
      }
      case "review":
        return item.review ? reviewMarkdown(item.review) : null;
      case "worktree": {
        const [report, diffRes] = await Promise.all([
          orch.getCoderReport(item.id),
          orch.getWorktreeDiff(item.id),
        ]);
        return worktreeMarkdown({ report, diff: diffRes.ok ? diffRes.diff : null });
      }
      case "dossier": {
        const [plan, report, diffRes] = await Promise.all([
          orch.getPlan(item.id),
          orch.getCoderReport(item.id),
          item.worktree ? orch.getWorktreeDiff(item.id) : Promise.resolve(null),
        ]);
        const diff = diffRes && diffRes.ok ? diffRes.diff : null;
        return dossierMarkdown({ item, plan, report, diff });
      }
    }
  }

  async function onCopy() {
    setError(null);
    setBusy(true);
    try {
      const text = await buildMarkdown();
      if (!text) return;
      await navigator.clipboard?.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onSave() {
    setError(null);
    setBusy(true);
    try {
      const text = await buildMarkdown();
      if (!text) return;
      const res = await window.skipper!.export.saveMarkdown(
        exportFilename(item.repo, item.key, artifact),
        text,
      );
      if (!res.ok) {
        setError(res.error);
      } else if (!res.canceled) {
        setSaved(true);
        setTimeout(() => setSaved(false), 1200);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button onClick={() => void onCopy()} disabled={disabled} className={BTN_CLASS}>
        {copied ? <Check size={13} /> : <Copy size={13} />}
        {copied ? e.copied : e.copy}
      </button>
      <button onClick={() => void onSave()} disabled={disabled} className={BTN_CLASS}>
        <Download size={13} />
        {saved ? e.saved : e.save}
      </button>
      {error && (
        <span className="text-[11px] text-danger" title={error}>
          {e.failed}
        </span>
      )}
    </>
  );
}
