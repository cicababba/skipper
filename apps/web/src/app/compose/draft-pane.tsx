"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { repoKey as repoKeyOf, type ComposerDraft, type RepoRef } from "@skipper/shared";
import { useT } from "@/lib/app-i18n";
import { useAuth } from "@/lib/auth-context";
import { useOrchestrator } from "@/lib/orchestrator-context";
import { useToast } from "@/lib/toast-context";
import { useStoredState } from "@/lib/use-stored-state";
import { truncateLabel } from "@/lib/inbox/transition-toasts";
import { accountCandidates, ASSIGN_CAPABLE_PROVIDERS } from "@/lib/composer/derive-account";
import { renderDraftBody } from "@/lib/composer/render-issue-body";
import { relationsForIssue, type RelationLabels } from "@/lib/composer/relations-text";
import {
  allCreated,
  displayRef,
  initialCreateStates,
  isCreated,
  runCreateFlow,
  type CardCreateState,
  type CreateStates,
} from "@/lib/composer/create-flow";
import type { DraftEdit } from "@/lib/composer/draft-state";
import { DraftIssueCard } from "./draft-issue-card";

// The draft half of the composer (#136): every issue as an editable card, then
// one Create that posts them in order. Partial failure is expected and shown per
// card — a rejected issue stays editable and retryable while its siblings live.

export function DraftPane({
  repo,
  draft,
  busy,
  onEdit,
  onBlur,
  onAllCreated,
}: {
  repo: RepoRef;
  draft: ComposerDraft;
  /** A distillation is running — the cards are read-only until it lands. */
  busy: boolean;
  onEdit: (index: number, edit: DraftEdit) => void;
  onBlur: () => void;
  /** Every issue of the draft made it to the tracker (#138). */
  onAllCreated?: () => void;
}) {
  const { t } = useT();
  const c = t.composer;
  const { authState } = useAuth();
  const { state } = useOrchestrator();
  const { toast } = useToast();
  const key = repoKeyOf(repo);

  const [selfAssignStored, setSelfAssignStored] = useStoredState("composer.selfAssign", "false", "local");
  const selfAssign = selfAssignStored === "true";
  const [accountOverride, setAccountOverride] = useState<string | null>(null);
  const [createStates, setCreateStates] = useState<CreateStates>(() =>
    initialCreateStates(draft.issues.length),
  );
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const candidates = useMemo(
    () =>
      accountCandidates({
        accounts: authState.accounts.map((a) => ({ key: a.key, provider: a.provider })),
        items: (state?.items ?? []).map((i) => ({ accountId: i.accountId, repo: i.repo })),
        repoKey: key,
      }),
    [authState.accounts, state?.items, key],
  );
  const accountId = accountOverride ?? candidates[0];
  const provider = authState.accounts.find((a) => a.key === accountId)?.provider;
  const canSelfAssign = provider != null && ASSIGN_CAPABLE_PROVIDERS.includes(provider);

  const labelSuggestions = useMemo(() => {
    const seen = new Set<string>();
    for (const item of state?.items ?? []) {
      if (repoKeyOf(item.repo) !== key) continue;
      for (const label of labelsOf(item.id, state?.accounts)) seen.add(label);
    }
    return [...seen].sort();
  }, [state?.items, state?.accounts, key]);

  const relationLabels: RelationLabels = useMemo(
    () => ({ blocks: c.relBlocks, partOf: c.relPartOf, relatesTo: c.relRelatesTo }),
    [c],
  );

  const create = async (indexes: number[]) => {
    if (!window.skipper || !accountId || creating) return;
    setNotice(null);
    setCreating(true);
    try {
      let assignees: string[] | undefined;
      if (selfAssign && canSelfAssign) {
        const self = await window.skipper.composer.getSelfLogin(accountId);
        if (self.login) assignees = [self.login];
        else setNotice(c.noLogin);
      }
      await runCreateFlow({
        indexes,
        create: async (index) => {
          const issue = draft.issues[index];
          const res = await window.skipper!.orchestrator.createIssueOnTracker({
            accountId,
            repo,
            title: issue.title,
            body: renderDraftBody(issue),
            labels: issue.labels,
            ...(assignees ? { assignees } : {}),
          });
          return res;
        },
        onState: (index, cardState) => {
          setCreateStates((prev) => ({ ...prev, [index]: cardState }));
          // Created issues never enter the manifest, so the snapshot diff behind the
          // orchestrator toasts can't see them — this is their only announcement.
          if (cardState.status === "created") {
            toast({
              id: `compose-created-${cardState.url}`,
              variant: "success",
              title: c.toastCreated(displayRef(cardState)),
              message: truncateLabel(draft.issues[index].title),
              action: {
                label: c.toastView,
                onClick: () => void window.skipper?.openExternal(cardState.url),
              },
              durationMs: 5000,
            });
          }
        },
      });
    } finally {
      setCreating(false);
    }
  };

  const stateFor = (index: number): CardCreateState => createStates[index] ?? { status: "pending" };
  const pending = draft.issues.map((_, i) => i).filter((i) => !isCreated(stateFor(i)));
  const done = allCreated(
    Object.fromEntries(draft.issues.map((_, i) => [i, stateFor(i)])),
    draft.issues.length,
  );

  const notified = useRef(false);
  useEffect(() => {
    if (!done || notified.current) return;
    notified.current = true;
    onAllCreated?.();
  }, [done, onAllCreated]);

  return (
    <div className="flex flex-col min-h-0">
      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
        {draft.issues.map((issue, index) => (
          <DraftIssueCard
            key={index}
            index={index}
            issue={issue}
            relations={relationsForIssue(draft.relations, index, relationLabels)}
            labelSuggestions={labelSuggestions}
            createState={stateFor(index)}
            locked={isCreated(stateFor(index))}
            busy={busy || creating}
            onEdit={onEdit}
            onBlur={onBlur}
            onRetry={() => void create([index])}
          />
        ))}
      </div>

      <div className="shrink-0 border-t border-card-hover p-4 space-y-3">
        {candidates.length > 1 && (
          <label className="flex items-center gap-2 text-[12px] text-muted">
            <span>{c.account}</span>
            <select
              value={accountId ?? ""}
              onChange={(e) => setAccountOverride(e.target.value)}
              className="bg-background border border-border rounded-md px-2 py-1 text-[12px] focus:border-accent focus:outline-none"
            >
              {candidates.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {labelForAccount(candidate, authState.accounts)}
                </option>
              ))}
            </select>
          </label>
        )}

        {canSelfAssign && (
          <label className="flex items-start gap-2 text-[12px]">
            <input
              type="checkbox"
              checked={selfAssign}
              onChange={(e) => setSelfAssignStored(e.target.checked ? "true" : "false")}
              className="mt-0.5"
            />
            <span>
              {c.selfAssign}
              <span className="block text-[11px] text-muted/70">{c.selfAssignHint}</span>
            </span>
          </label>
        )}

        {accountId ? (
          <button
            onClick={() => void create(pending)}
            disabled={busy || creating || done}
            className="flex items-center gap-1 text-[12px] font-medium px-3 py-1.5 rounded-md border border-accent/30 bg-accent/10 text-accent hover:bg-accent/20 transition-colors disabled:opacity-50"
          >
            {creating && <Loader2 size={11} className="animate-spin" />}
            {creating ? c.creating : c.create}
          </button>
        ) : (
          <p className="text-[12px] text-warning/80">{c.noAccount}</p>
        )}

        {done && <p className="text-[12px] text-success">{c.allCreated}</p>}
        {notice && <p className="text-[12px] text-warning/80">{notice}</p>}
      </div>
    </div>
  );
}

/** Labels seen on the repo's tracked issues — the vocabulary the tracker already
 *  has, offered as suggestions; free text stays allowed. */
function labelsOf(
  itemId: string,
  accounts: Record<string, { issues: { id: string; labels: string[] }[] }> | undefined,
): string[] {
  for (const account of Object.values(accounts ?? {})) {
    const issue = account.issues.find((i) => i.id === itemId);
    if (issue) return issue.labels;
  }
  return [];
}

function labelForAccount(key: string, accounts: { key: string; name?: string; email?: string }[]): string {
  const account = accounts.find((a) => a.key === key);
  return account?.name ?? account?.email ?? key;
}
