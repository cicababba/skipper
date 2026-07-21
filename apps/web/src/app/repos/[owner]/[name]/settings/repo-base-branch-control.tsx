"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useT } from "@/lib/app-i18n";
import { Row } from "./settings-row";

/**
 * Per-repo base branch override. Worktrees are cut from origin/HEAD unless
 * this is set; the value is validated against origin before it lands. An empty
 * input clears the override back to the repository default.
 */
export function RepoBaseBranchControl({
  owner,
  name,
  repoKey,
}: {
  owner: string;
  name: string;
  repoKey: string;
}) {
  const { t } = useT();
  const rp = t.inbox.repoPage;

  const [value, setValue] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!window.skipper) return;
    window.skipper.orchestrator.listRepos().then((res) => {
      const current = res.linked.find((r) => r.key === repoKey)?.baseBranch ?? "";
      setValue(current);
      setSaved(current);
    });
  }, [repoKey]);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    if (!window.skipper) return;
    const trimmed = value.trim();
    if (trimmed === saved) return;
    setBusy(true);
    setError(null);
    try {
      const res = await window.skipper.orchestrator.setRepoBaseBranch(
        owner,
        name,
        trimmed === "" ? null : trimmed,
      );
      if (res.ok) {
        setValue(trimmed);
        setSaved(trimmed);
      } else {
        setError(res.error);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <Row label={rp.baseBranch} hint={rp.baseBranchDesc} busy={busy}>
        <div className="flex items-center gap-2">
          {busy && <Loader2 size={12} className="animate-spin text-muted" />}
          <input
            type="text"
            value={value}
            placeholder={rp.baseBranchPlaceholder}
            disabled={busy}
            onChange={(e) => setValue(e.target.value)}
            onBlur={() => void save()}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
            className="w-44 bg-background border border-border rounded-md px-2 py-1.5 text-sm focus:border-accent focus:outline-none disabled:opacity-50"
          />
        </div>
      </Row>
      {error && <p className="text-[11px] text-red-300 leading-relaxed">{error}</p>}
    </div>
  );
}
