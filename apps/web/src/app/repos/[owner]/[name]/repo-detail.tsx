"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ExternalLink, FolderGit2, GitBranch, Settings as SettingsIcon } from "lucide-react";
import { displayKey, type RepoSettingsRow } from "@skipper/shared";
import { useOrchestrator } from "@/lib/orchestrator-context";
import { useT } from "@/lib/app-i18n";
import { repoKey } from "@/lib/inbox/model";
import { Section } from "@/app/inbox/[id]/plan-sections";
import { InboxView } from "@/app/inbox/inbox-view";
import { MemoryBrowser } from "./memory-browser";
import { useRepoParams } from "./use-repo-params";

export function RepoDetailView() {
  const { t } = useT();
  const { state } = useOrchestrator();
  const { owner, name, key } = useRepoParams();
  const pathname = usePathname();

  const [rows, setRows] = useState<RepoSettingsRow[]>([]);

  const load = useCallback(() => {
    if (!window.skipper) return;
    return window.skipper.orchestrator.listRepoSettings().then(setRows);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const row = rows.find((r) => r.key === key);
  const repo = row?.repo ?? { owner, name };

  const worktrees = useMemo(
    () =>
      (state?.items ?? []).filter((it) => repoKey(it.repo) === key && it.worktree),
    [state, key],
  );

  const rp = t.inbox.repoPage;

  return (
    <div className="min-h-full p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <FolderGit2 size={20} className="text-accent shrink-0" />
        <h1 className="text-2xl font-semibold tracking-tight truncate">{key}</h1>
        <button
          onClick={() => void window.skipper?.openExternal(`https://github.com/${key}`)}
          className="text-muted hover:text-accent transition-colors"
          title={`https://github.com/${key}`}
        >
          <ExternalLink size={15} />
        </button>
        <Link
          href={`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/settings`}
          className="text-muted hover:text-accent transition-colors"
          title={rp.settings}
        >
          <SettingsIcon size={15} />
        </Link>
      </div>

      {/* Items — the repo's dedicated inbox (tiles + table/kanban, scoped). */}
      <InboxView repo={key} />

      {/* Active worktrees */}
      <Section title={rp.worktrees} count={worktrees.length} editable={false} editing={false}>
        {worktrees.length === 0 ? (
          <p className="text-[13px] text-muted/60">{rp.worktreesEmpty}</p>
        ) : (
          <ul className="divide-y divide-border">
            {worktrees.map((it) => (
              <li key={it.id}>
                <Link
                  href={`/inbox/${encodeURIComponent(it.id)}?from=${encodeURIComponent(pathname)}`}
                  className="flex items-center gap-3 py-2.5 hover:text-accent transition-colors"
                >
                  <span className="font-mono text-[12px] text-muted shrink-0">{displayKey(it.key)}</span>
                  <span className="flex-1 min-w-0 truncate text-[13px]">{it.title}</span>
                  {it.worktree && (
                    <span className="flex items-center gap-1 shrink-0 font-mono text-[11px] text-muted/70">
                      <GitBranch size={11} />
                      {it.worktree.branch}
                    </span>
                  )}
                  <span className="shrink-0 text-[11px] text-muted/50">
                    {t.inbox.states[it.state]}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* Solutions memory browser */}
      <Section title={rp.memory.title} editable={false} editing={false}>
        <MemoryBrowser repo={repo} />
      </Section>
    </div>
  );
}
