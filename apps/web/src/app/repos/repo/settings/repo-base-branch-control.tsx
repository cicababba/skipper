"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type { BaseChangeReport } from "@skipper/shared";
import { useT } from "@/lib/app-i18n";
import { Row, selectClass } from "./settings-row";

/**
 * Per-repo base branch override. Worktrees are cut from origin/HEAD unless
 * this is set; the value is validated against origin before it lands. The
 * empty selection clears the override back to the repository default.
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
  const [branches, setBranches] = useState<string[]>([]);
  const [defaultBranch, setDefaultBranch] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<BaseChangeReport | null>(null);

  const load = useCallback(() => {
    if (!window.skipper) return;
    window.skipper.orchestrator.listRepos().then((res) => {
      setValue(res.linked.find((r) => r.key === repoKey)?.baseBranch ?? "");
    });
    window.skipper.orchestrator.listRepoBranches(owner, name).then((res) => {
      if (res.ok) {
        setBranches(res.branches);
        setDefaultBranch(res.defaultBranch);
        setError(null);
      } else {
        setBranches([]);
        setError(res.error);
      }
    });
  }, [owner, name, repoKey]);

  useEffect(() => {
    load();
  }, [load]);

  const save = async (next: string) => {
    if (!window.skipper) return;
    const prev = value;
    setValue(next);
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      const res = await window.skipper.orchestrator.setRepoBaseBranch(
        owner,
        name,
        next === "" ? null : next,
      );
      if (!res.ok) {
        setValue(prev);
        setError(res.error);
      } else if (res.replan) {
        setReport(res.replan);
      }
    } finally {
      setBusy(false);
    }
  };

  // Show a deleted-but-saved override so the UI never silently drops it.
  const options = value && !branches.includes(value) ? [value, ...branches] : branches;

  return (
    <div className="space-y-2">
      <Row label={rp.baseBranch} hint={rp.baseBranchDesc} busy={busy}>
        <div className="flex items-center gap-2">
          {busy && <Loader2 size={12} className="animate-spin text-muted" />}
          <select
            value={value}
            disabled={busy}
            onChange={(e) => void save(e.target.value)}
            className={`${selectClass} w-44`}
          >
            <option value="">
              {defaultBranch ? rp.baseBranchDefault(defaultBranch) : rp.baseBranchPlaceholder}
            </option>
            {options.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </div>
      </Row>
      {error && <p className="text-[11px] text-danger leading-relaxed">{error}</p>}
      {report && (
        <p className="text-[11px] text-muted leading-relaxed">
          {rp.baseBranchReplanned(report.replanned.length)}
          {report.skipped.length > 0 ? ` · ${rp.baseBranchSkipped(report.skipped.length)}` : ""}
        </p>
      )}
    </div>
  );
}
