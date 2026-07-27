"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type { RepoRef } from "@skipper/shared";
import { useT } from "@/lib/app-i18n";
import { FilePicker } from "./file-picker";

/**
 * Create/edit form for a manual memory note (#255). The file autocomplete is
 * fed by `git ls-files` on the linked clone; an unlinked repo just loses the
 * attachment field, the note itself is still writable.
 */
export function NoteEditor({
  repo,
  existing,
  onCancel,
  onSaved,
}: {
  repo: RepoRef;
  existing?: { id: string; title: string; body: string; files: string[] };
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { t } = useT();
  const m = t.inbox.repoPage.memory;
  const [title, setTitle] = useState(existing?.title ?? "");
  const [body, setBody] = useState(existing?.body ?? "");
  const [files, setFiles] = useState<string[]>(existing?.files ?? []);
  const [repoFiles, setRepoFiles] = useState<string[] | null>(null);
  const [filesUnavailable, setFilesUnavailable] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!window.skipper) return;
    let cancelled = false;
    window.skipper.memory
      .repoFiles(repo)
      .then((res) => {
        if (cancelled) return;
        if (res.ok) setRepoFiles(res.files);
        else setFilesUnavailable(true);
      })
      .catch(() => {
        if (!cancelled) setFilesUnavailable(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo.owner, repo.name]);

  const save = async () => {
    if (!window.skipper || !body.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const res = existing
        ? await window.skipper.memory.updateNote(existing.id, body, files, title)
        : await window.skipper.memory.createNote(repo, body, files, title);
      if (res.ok) onSaved();
      else setError(res.error ?? "");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={m.noteTitlePlaceholder}
        className="w-full bg-background border border-border rounded-md px-2.5 py-1.5 text-[13px] focus:border-accent focus:outline-none"
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={m.noteBodyPlaceholder}
        rows={6}
        className="w-full bg-background border border-border rounded-md px-2.5 py-1.5 text-[13px] leading-relaxed resize-y focus:border-accent focus:outline-none"
      />
      <div className="space-y-1">
        <span className="text-[11px] text-muted/60">{m.linkedFiles}</span>
        {filesUnavailable ? (
          <p className="text-[11px] text-muted/50">{m.linkedFilesUnavailable}</p>
        ) : (
          <FilePicker
            options={repoFiles ?? []}
            selected={files}
            onChange={setFiles}
            placeholder={m.files}
            disabled={repoFiles === null}
          />
        )}
      </div>
      {error && <p className="text-[12px] text-danger">{error}</p>}
      <div className="flex items-center gap-2">
        <button
          onClick={() => void save()}
          disabled={saving || !body.trim()}
          className="flex items-center gap-1.5 text-[12px] px-2.5 py-1 rounded-md bg-accent/10 text-accent hover:bg-accent/20 transition-colors disabled:opacity-40"
        >
          {saving && <Loader2 size={12} className="animate-spin" />}
          {m.save}
        </button>
        <button
          onClick={onCancel}
          className="text-[12px] px-2.5 py-1 rounded-md border border-border text-muted hover:text-foreground transition-colors"
        >
          {m.cancel}
        </button>
      </div>
    </div>
  );
}
