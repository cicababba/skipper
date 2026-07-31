"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Settings as SettingsIcon } from "lucide-react";
import type { RepoIntakeSettings, RepoSettingsRow } from "@skipper/shared";
import { useOrchestrator } from "@/lib/orchestrator-context";
import { useT } from "@/lib/app-i18n";
import { Section } from "@/app/inbox/item/plan-sections";
import { repoHref } from "@/lib/inbox/nav";
import { useRepoParams } from "../use-repo-params";
import { RepoIntakeControls } from "./repo-intake-controls";
import { RepoModelControls } from "./repo-model-controls";
import { RepoBaseBranchControl } from "./repo-base-branch-control";
import { RepoInstructionsControl } from "./repo-instructions-control";
import { RepoGraphifyControl } from "./repo-graphify-control";

export function RepoSettingsView() {
  const { t } = useT();
  const { state } = useOrchestrator();
  const { owner, name, key } = useRepoParams();

  const [rows, setRows] = useState<RepoSettingsRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [followError, setFollowError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!window.skipper) return;
    return window.skipper.orchestrator.listRepoSettings().then(setRows);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const row = rows.find((r) => r.key === key);
  const global = state?.settings;

  const patch = async (p: Partial<RepoIntakeSettings>) => {
    if (!window.skipper) return;
    setBusy(true);
    try {
      await window.skipper.orchestrator.setRepoSettings(owner, name, p);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const setFollowed = async (followed: boolean) => {
    if (!window.skipper) return;
    setBusy(true);
    setFollowError(null);
    try {
      const res = await window.skipper.orchestrator.setRepoFollowed(owner, name, followed);
      if (!res.ok) {
        setFollowError(t.settings.repositories.unfollowBlocked(res.blocking.length));
      }
      await load();
    } finally {
      setBusy(false);
    }
  };

  const rp = t.inbox.repoPage;
  const isElectron = typeof window !== "undefined" && !!window.skipper;

  return (
    <div className="min-h-full p-6 space-y-6">
      <div>
        <Link
          href={repoHref({ owner, name })}
          className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-foreground transition-colors"
        >
          <ArrowLeft size={14} />
          {key}
        </Link>
        <div className="flex items-center gap-3 mt-2">
          <SettingsIcon size={20} className="text-accent shrink-0" />
          <h1 className="text-2xl font-semibold tracking-tight">{rp.settings}</h1>
        </div>
      </div>

      {isElectron && row && global && (
        <>
          <Section title={rp.intake} editable={false} editing={false}>
            <RepoIntakeControls
              row={row}
              global={global}
              busy={busy}
              onPatch={(p) => void patch(p)}
              onSetFollowed={(followed) => void setFollowed(followed)}
              followError={followError}
            />
          </Section>
          <Section title={t.settings.orchestration.agents} editable={false} editing={false}>
            <RepoModelControls row={row} busy={busy} onPatch={(p) => void patch(p)} />
          </Section>
          {row.linked && (
            <Section title={rp.baseBranch} editable={false} editing={false}>
              <RepoBaseBranchControl owner={owner} name={name} repoKey={key} />
            </Section>
          )}
          {row.linked && (
            <Section title={rp.graphify.title} editable={false} editing={false}>
              <RepoGraphifyControl
                owner={owner}
                name={name}
                enabled={row.settings.graphify === true}
                busy={busy}
                onToggle={(v) => void patch({ graphify: v ? true : undefined })}
              />
            </Section>
          )}
          {row.linked && (
            <Section title={rp.instructions.title} editable={false} editing={false}>
              <RepoInstructionsControl owner={owner} name={name} />
            </Section>
          )}
        </>
      )}
    </div>
  );
}
