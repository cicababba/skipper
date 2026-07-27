"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ExternalLink, GitPullRequest, Loader2, Search, ThumbsDown, ThumbsUp } from "lucide-react";
import {
  displayKey,
  type MemoryPhase,
  type RepoRef,
  type SolutionRecord,
  type UsedMemoryRef,
} from "@skipper/shared";
import { useT } from "@/lib/app-i18n";
import { VoteButton } from "@/components/vote-button";
import { repoHref } from "@/lib/inbox/nav";
import { Section } from "./plan-sections";

type RecordState = SolutionRecord | "error" | undefined;

/**
 * "Memories used" card (#46): the solutions the run fetched in full via
 * get_memory, each with a 👍/👎 that writes back to SolutionRecord.feedback and
 * re-weights future retrieval (#44). Renders nothing when the run used no
 * memory. `refs` (and each `ref.vote`) come from orchestrator state, so a
 * feedback write broadcasts back and the button state stays authoritative.
 */
export function MemoriesCard({
  itemId,
  phase,
  refs,
  title,
  repo,
  queryText,
}: {
  itemId: string;
  phase: MemoryPhase;
  refs: UsedMemoryRef[] | undefined;
  title: string;
  repo?: RepoRef;
  queryText?: string;
}) {
  if (!refs || refs.length === 0) return null;
  return (
    <Section title={title} count={refs.length} editable={false} editing={false}>
      <MemoriesList itemId={itemId} phase={phase} refs={refs} repo={repo} queryText={queryText} />
    </Section>
  );
}

export function MemoriesList({
  itemId,
  phase,
  refs,
  repo,
  queryText,
}: {
  itemId: string;
  phase: MemoryPhase;
  refs: UsedMemoryRef[] | undefined;
  repo?: RepoRef;
  queryText?: string;
}) {
  const { t } = useT();
  const m = t.inbox.plan.memories;
  const [records, setRecords] = useState<Record<string, RecordState>>({});
  const [pending, setPending] = useState<string | null>(null);

  // Refetch display metadata whenever the set of consulted ids changes (votes
  // don't change the ids, so they don't re-trigger this).
  const ids = (refs ?? []).map((r) => r.id);
  const idsKey = ids.join("\n");
  useEffect(() => {
    if (!window.skipper || ids.length === 0) return;
    let cancelled = false;
    Promise.all(
      ids.map((id) =>
        window
          .skipper!.memory.get(id)
          .then((rec) => [id, rec ?? ("error" as const)] as const)
          .catch(() => [id, "error" as const] as const),
      ),
    ).then((pairs) => {
      if (!cancelled) setRecords(Object.fromEntries(pairs));
    });
    return () => {
      cancelled = true;
    };
    // idsKey captures the id set; ids/itemId are derived from the same source.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  if (!refs || refs.length === 0) return null;

  const vote = async (ref: UsedMemoryRef, kind: "up" | "down") => {
    if (!window.skipper) return;
    const next = ref.vote === kind ? null : kind;
    setPending(ref.id);
    try {
      await window.skipper.memory.feedback(itemId, phase, ref.id, next);
    } finally {
      setPending(null);
    }
  };

  return (
    <ul className="space-y-2 text-[12px]">
      {refs.map((ref) => {
        const rec = records[ref.id];
        return (
          <li key={ref.id} className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              {rec === undefined ? (
                <span className="flex items-center gap-1.5 text-muted">
                  <Loader2 size={12} className="animate-spin" />
                </span>
              ) : rec === "error" ? (
                <span className="text-muted/70">{m.loadFailed}</span>
              ) : (
                <div className="min-w-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <button
                      onClick={() => void window.skipper?.openExternal(rec.url)}
                      className="flex items-center gap-1.5 min-w-0 text-left hover:text-accent transition-colors"
                      title={rec.url}
                    >
                      <span className="font-mono text-muted shrink-0">
                        {displayKey(rec.issueKey ?? String(rec.issueNumber ?? ""))}
                      </span>
                      <span className="truncate">{rec.title}</span>
                      <ExternalLink size={11} className="shrink-0 opacity-50" />
                    </button>
                    {rec.pr && (
                      <button
                        onClick={() => void window.skipper?.openExternal(rec.pr!.url)}
                        className="flex items-center gap-1 shrink-0 font-mono text-[11px] text-muted hover:text-accent transition-colors"
                        title={rec.pr.url}
                      >
                        <GitPullRequest size={11} />
                        {rec.pr.number}
                      </button>
                    )}
                  </div>
                  {rec.plan?.plan.summary && (
                    <p className="text-[11px] text-muted/70 line-clamp-2">
                      {rec.plan.plan.summary}
                    </p>
                  )}
                </div>
              )}
            </div>
            {rec !== "error" && (
              <div className="flex items-center gap-1 shrink-0">
                <VoteButton
                  active={ref.vote === "up"}
                  disabled={pending === ref.id}
                  label={m.helpful}
                  onClick={() => void vote(ref, "up")}
                >
                  <ThumbsUp size={13} />
                </VoteButton>
                <VoteButton
                  active={ref.vote === "down"}
                  disabled={pending === ref.id}
                  label={m.notHelpful}
                  onClick={() => void vote(ref, "down")}
                >
                  <ThumbsDown size={13} />
                </VoteButton>
              </div>
            )}
          </li>
        );
      })}
      {repo && (
        <li>
          <Link
            href={repoHref(repo, { tab: "memory", mq: queryText })}
            className="flex items-center gap-1.5 text-[11px] text-muted hover:text-accent transition-colors"
          >
            <Search size={11} />
            {m.searchMemory}
          </Link>
        </li>
      )}
    </ul>
  );
}
