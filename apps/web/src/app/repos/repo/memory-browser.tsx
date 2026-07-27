"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ChevronRight,
  Filter,
  GitPullRequest,
  List,
  Loader2,
  Plus,
  Search,
  Sparkles,
  StickyNote,
  ThumbsDown,
  ThumbsUp,
  Waypoints,
  X,
} from "lucide-react";
import { displayKey, type MemoryHit, type RepoRef, type SolutionRecord } from "@skipper/shared";
import { useT } from "@/lib/app-i18n";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import {
  chronological,
  fileOptions,
  filterHitsByFile,
  filterRecordsByFile,
} from "@/lib/inbox/memory-filters";
import { pruneCandidates, type PruneReason } from "@/lib/inbox/memory-review";
import { FileSuggestInput } from "./file-picker";
import { ReasonBadges, StalenessBadge } from "./memory-badges";
import { MemoryGraphView } from "./memory-graph-view";
import { MemoryRecordView } from "./memory-record";
import { NoteEditor } from "./note-editor";

const SEARCH_K = 20;

/**
 * Memory tab for one repo (#255): semantic search over this repo's captured
 * solutions and manual notes, chronological browsing when the query is empty,
 * curation votes and deletion on the record view, and note authoring.
 */
export function MemoryBrowser({ repo, initialQuery }: { repo: RepoRef; initialQuery?: string }) {
  const { t } = useT();
  const m = t.inbox.repoPage.memory;
  const [records, setRecords] = useState<SolutionRecord[] | null>(null);
  const [query, setQuery] = useState(initialQuery ?? "");
  const debounced = useDebouncedValue(query.trim());
  const [hits, setHits] = useState<MemoryHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchAttempt, setSearchAttempt] = useState(0);
  const [everSearched, setEverSearched] = useState(false);
  const [fileFilter, setFileFilter] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<"list" | "graph">("list");
  const [distilling, setDistilling] = useState(false);
  const [distillNote, setDistillNote] = useState<string | null>(null);
  const [reviewOnly, setReviewOnly] = useState(false);

  const load = useCallback(() => {
    if (!window.skipper) return;
    return window.skipper.memory.list(repo).then(setRecords);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo.owner, repo.name]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!window.skipper || !debounced) {
      setHits(null);
      setSearchError(null);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    setSearchError(null);
    window.skipper.memory
      .search(repo, debounced, SEARCH_K)
      .then((res) => {
        if (cancelled) return;
        setEverSearched(true);
        if (res.ok) {
          setHits(res.hits);
          setSearchError(null);
        } else {
          setHits(null);
          setSearchError(res.error);
        }
        setSearching(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setHits(null);
        setSearchError(err instanceof Error ? err.message : String(err));
        setSearching(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced, repo.owner, repo.name, searchAttempt]);

  const byId = useMemo(
    () => new Map((records ?? []).map((r) => [r.itemId, r] as const)),
    [records],
  );
  const files = useMemo(() => fileOptions(records ?? []), [records]);
  const candidates = useMemo(() => pruneCandidates(records ?? [], Date.now()), [records]);
  const reasonsById = useMemo(
    () => new Map(candidates.map((c) => [c.record.itemId, c.reasons] as const)),
    [candidates],
  );
  const rows = useMemo(() => {
    if (reviewOnly) {
      return candidates.map(({ record }) => ({ id: record.itemId, record, hit: undefined }));
    }
    if (debounced && hits) {
      return filterHitsByFile(hits, fileFilter).map((hit) => ({
        id: hit.id,
        record: byId.get(hit.id),
        hit,
      }));
    }
    return filterRecordsByFile(chronological(records ?? []), fileFilter).map((record) => ({
      id: record.itemId,
      record,
      hit: undefined,
    }));
  }, [debounced, hits, fileFilter, records, byId, reviewOnly, candidates]);

  const selectedRecord = records?.find((r) => r.itemId === selected) ?? null;
  const undistilled = (records ?? []).filter((r) => r.kind !== "note" && !r.lesson).length;

  const distill = async () => {
    if (!window.skipper) return;
    setDistilling(true);
    setDistillNote(null);
    try {
      const res = await window.skipper.memory.distill(repo);
      if (res.ok) {
        setDistillNote(
          res.failed > 0
            ? `${m.distillDone(res.distilled)} · ${m.distillFailed(res.failed)}`
            : m.distillDone(res.distilled),
        );
        await load();
      } else {
        setDistillNote(res.error);
      }
    } finally {
      setDistilling(false);
    }
  };

  const remove = async (rec: SolutionRecord) => {
    if (!window.skipper || !window.confirm(m.deleteConfirm)) return;
    setBusy(true);
    try {
      const res = await window.skipper.memory.delete(rec.itemId);
      if (res.ok) {
        setSelected(null);
        await load();
      }
    } finally {
      setBusy(false);
    }
  };

  const keep = async (rec: SolutionRecord) => {
    if (!window.skipper) return;
    setBusy(true);
    try {
      await window.skipper.memory.dismissReview(rec.itemId);
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (selectedRecord) {
    return (
      <MemoryRecordView
        record={selectedRecord}
        busy={busy}
        reasons={reasonsById.get(selectedRecord.itemId) ?? []}
        onBack={() => setSelected(null)}
        onDelete={() => void remove(selectedRecord)}
        onKeep={() => void keep(selectedRecord)}
        onChanged={() => void load()}
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted/50" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={m.searchPlaceholder}
            className="w-full bg-background border border-border rounded-lg pl-9 pr-3 py-2 text-sm focus:border-accent focus:outline-none"
          />
          {searching && (
            <Loader2
              size={13}
              className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-muted/60"
            />
          )}
        </div>
        <div className="flex items-center shrink-0 rounded-lg border border-border overflow-hidden">
          <ViewToggle
            active={view === "list"}
            label={m.viewList}
            onClick={() => setView("list")}
          >
            <List size={13} />
          </ViewToggle>
          <ViewToggle
            active={view === "graph"}
            label={m.viewGraph}
            onClick={() => setView("graph")}
          >
            <Waypoints size={13} />
          </ViewToggle>
        </div>
        {(undistilled > 0 || distilling) && (
          <button
            onClick={() => void distill()}
            disabled={distilling}
            className="flex items-center gap-1.5 shrink-0 text-[12px] px-2.5 py-2 rounded-lg border border-border text-muted hover:text-foreground hover:border-accent/40 transition-colors disabled:opacity-50"
          >
            {distilling ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
            {distilling ? m.distilling : m.distill}
          </button>
        )}
        <button
          onClick={() => setComposing((v) => !v)}
          className="flex items-center gap-1.5 shrink-0 text-[12px] px-2.5 py-2 rounded-lg border border-border text-muted hover:text-foreground hover:border-accent/40 transition-colors"
        >
          <Plus size={13} />
          {m.newNote}
        </button>
      </div>

      {distillNote && <p className="text-[11px] text-muted/70">{distillNote}</p>}

      {candidates.length > 0 && (
        <button
          onClick={() => setReviewOnly((v) => !v)}
          aria-pressed={reviewOnly}
          className={`flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-md border transition-colors ${
            reviewOnly
              ? "border-warning/40 bg-warning-bg text-warning"
              : "border-warning/25 text-warning/80 hover:bg-warning-bg"
          }`}
        >
          <AlertTriangle size={11} />
          {m.reviewQueueCount(candidates.length)}
        </button>
      )}

      {composing && (
        <NoteEditor
          repo={repo}
          onCancel={() => setComposing(false)}
          onSaved={() => {
            setComposing(false);
            void load();
          }}
        />
      )}

      {files.length > 0 && (
        <div className="flex items-center gap-2">
          {fileFilter ? (
            <span className="flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-accent/15 text-accent font-mono">
              {fileFilter}
              <button
                onClick={() => setFileFilter(null)}
                className="hover:text-foreground transition-colors"
                aria-label={`clear filter ${fileFilter}`}
              >
                <X size={10} />
              </button>
            </span>
          ) : (
            <>
              <button
                onClick={() => setFilterOpen((v) => !v)}
                className="flex items-center gap-1.5 text-[11px] text-muted/60 hover:text-foreground transition-colors"
              >
                <Filter size={11} />
                {m.fileFilterLabel}
              </button>
              {filterOpen && (
                <div className="flex-1 max-w-sm">
                  <FileSuggestInput
                    options={files}
                    onPick={(file) => {
                      setFileFilter(file);
                      setFilterOpen(false);
                    }}
                    placeholder={m.files}
                    autoFocus
                  />
                </div>
              )}
            </>
          )}
        </div>
      )}

      {searchError ? (
        <div className="flex items-center gap-2 py-4 text-[13px] text-muted">
          <span>
            {m.searchFailed}: {searchError}
          </span>
          <button
            onClick={() => setSearchAttempt((n) => n + 1)}
            className="text-accent hover:underline"
          >
            {m.retry}
          </button>
        </div>
      ) : searching && !everSearched ? (
        <div className="flex items-center gap-2 text-xs text-muted py-4">
          <Loader2 size={13} className="animate-spin" />
          {m.preparingIndex}
        </div>
      ) : records === null ? (
        <div className="flex items-center gap-2 text-xs text-muted py-4">
          <Loader2 size={13} className="animate-spin" />
        </div>
      ) : view === "graph" ? (
        <MemoryGraphView
          records={records}
          hits={debounced ? hits : null}
          fileFilter={fileFilter}
          busy={busy}
          candidateIds={new Set(reasonsById.keys())}
          onFileFilter={setFileFilter}
          onOpen={setSelected}
          onDelete={(rec) => void remove(rec)}
          onKeep={(rec) => void keep(rec)}
          onChanged={() => void load()}
        />
      ) : rows.length === 0 ? (
        <p className="text-[13px] text-muted/60 py-4">
          {reviewOnly ? m.reviewEmpty : debounced ? m.noResults : m.empty}
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border overflow-hidden">
          {rows.map((row) => (
            <li key={row.id}>
              <MemoryRow
                record={row.record}
                hit={row.hit}
                noteBadge={m.noteBadge}
                reasons={reasonsById.get(row.id) ?? []}
                showReasons={reviewOnly}
                onOpen={() => setSelected(row.id)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ViewToggle({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      title={label}
      className={`px-2.5 py-2 transition-colors ${
        active ? "bg-accent/10 text-accent" : "text-muted hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function MemoryRow({
  record,
  hit,
  noteBadge,
  reasons,
  showReasons,
  onOpen,
}: {
  record: SolutionRecord | undefined;
  hit: MemoryHit | undefined;
  noteBadge: string;
  reasons: PruneReason[];
  showReasons: boolean;
  onOpen: () => void;
}) {
  const title = record?.title ?? hit?.title ?? "";
  const isNote = (record?.kind ?? hit?.kind) === "note";
  const pr = record?.pr ?? hit?.pr;
  const key = record ? (record.issueKey ?? String(record.issueNumber ?? "")) : (hit?.issueKey ?? "");
  const feedback = record?.feedback ?? hit?.feedback ?? { up: 0, down: 0 };
  const snippet = isNote
    ? record?.note?.body
    : (record?.lesson ?? hit?.lesson ?? record?.plan?.plan.summary ?? hit?.planSummary);

  return (
    <button
      onClick={onOpen}
      className="w-full flex items-start gap-3 px-3 py-2.5 text-left hover:bg-card transition-colors"
    >
      <span className="shrink-0 pt-0.5">
        {isNote ? (
          <StickyNote size={12} className="text-accent/70" />
        ) : (
          <span className="font-mono text-[12px] text-muted">{displayKey(key)}</span>
        )}
      </span>
      <span className="flex-1 min-w-0">
        <span className="block truncate text-[13px]">{title}</span>
        {snippet && (
          <span className="block text-[11px] text-muted/70 line-clamp-2">{snippet}</span>
        )}
      </span>
      {isNote && <span className="shrink-0 text-[10px] uppercase text-muted/50">{noteBadge}</span>}
      {showReasons ? (
        <ReasonBadges reasons={reasons} />
      ) : (
        record && <StalenessBadge record={record} />
      )}
      {pr && (
        <span className="flex items-center gap-1 shrink-0 font-mono text-[11px] text-muted/70">
          <GitPullRequest size={11} />
          {pr.number}
        </span>
      )}
      {(feedback.up > 0 || feedback.down > 0) && (
        <span className="flex items-center gap-1 shrink-0 text-[11px] text-muted/70">
          <ThumbsUp size={11} className="text-accent/70" />
          {feedback.up}
          <ThumbsDown size={11} className="ml-1" />
          {feedback.down}
        </span>
      )}
      <ChevronRight size={14} className="shrink-0 text-muted/40" />
    </button>
  );
}
