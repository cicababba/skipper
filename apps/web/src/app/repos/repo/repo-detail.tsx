"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ExternalLink, FolderGit2, Settings as SettingsIcon } from "lucide-react";
import type { RepoSettingsRow } from "@skipper/shared";
import { useT } from "@/lib/app-i18n";
import { Section } from "@/app/inbox/item/plan-sections";
import { InboxView } from "@/app/inbox/inbox-view";
import { repoHref, repoSettingsHref } from "@/lib/inbox/nav";
import { MemoryBrowser } from "./memory-browser";
import { useRepoParams } from "./use-repo-params";

export function RepoDetailView() {
  const { t } = useT();
  const router = useRouter();
  const { owner, name, key, tab, mq } = useRepoParams();

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
          href={repoSettingsHref({ owner, name })}
          className="text-muted hover:text-accent transition-colors"
          title={rp.settings}
        >
          <SettingsIcon size={15} />
        </Link>
      </div>

      <div className="flex items-center gap-1 border-b border-border">
        {(["inbox", "memory"] as const).map((tk) => (
          <button
            key={tk}
            onClick={() =>
              router.replace(repoHref({ owner, name }, tk === "memory" ? { tab: tk } : undefined))
            }
            className={`px-3 py-1.5 text-[12px] font-medium rounded-t-md border-b-2 transition-colors ${
              tab === tk
                ? "border-accent text-foreground"
                : "border-transparent text-muted hover:text-foreground"
            }`}
          >
            {rp.tabs[tk]}
          </button>
        ))}
      </div>

      {tab === "memory" ? (
        <Section title={rp.memory.title} editable={false} editing={false}>
          <MemoryBrowser repo={repo} initialQuery={mq} />
        </Section>
      ) : (
        /* Items — the repo's dedicated inbox (table + sticky rail, scoped). */
        <InboxView repo={key} />
      )}
    </div>
  );
}
