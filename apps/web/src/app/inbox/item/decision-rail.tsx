"use client";

import { useRef, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, X } from "lucide-react";
import type { ConfidenceReport, CriticVerdict, IssuePlan, StoredPlan } from "@skipper/shared";
import { useT } from "@/lib/app-i18n";
import { pct } from "@/components/confidence-popover";
import { useStoredState } from "@/lib/use-stored-state";
import { docSectionDomId } from "./plan-document";

export type GateAction = "approve" | "replan" | "park";

const SIZES: IssuePlan["estimatedSize"][] = ["xs", "s", "m", "l", "xl"];

function bandText(score: number): string {
  if (score >= 0.75) return "text-success";
  if (score >= 0.5) return "text-warning";
  return "text-muted";
}

function barFill(score: number): string {
  if (score >= 0.75) return "bg-success";
  if (score >= 0.5) return "bg-warning";
  return "bg-muted";
}

function verdictColor(verdict: CriticVerdict): string {
  return verdict === "approve"
    ? "text-success"
    : verdict === "concerns"
      ? "text-warning"
      : "text-danger";
}

interface DecisionRailProps {
  itemId: string;
  stored: StoredPlan;
  plan: IssuePlan;
  gate: boolean;
  rescoring: boolean | undefined;
  prevComposite: number | null;
  editBusy: boolean;
  actionsDisabled: boolean;
  busyAction: GateAction | null;
  actionError: string | null;
  saving: boolean;
  dirtyFiles: string[] | null;
  onCleanWorktree: () => void;
  onAction: (action: GateAction, note?: string) => void;
  onSizeChange: (size: IssuePlan["estimatedSize"]) => void;
}

export function DecisionRail({
  itemId,
  stored,
  plan,
  gate,
  rescoring,
  prevComposite,
  editBusy,
  actionsDisabled,
  busyAction,
  actionError,
  saving,
  dirtyFiles,
  onCleanWorktree,
  onAction,
  onSizeChange,
}: DecisionRailProps) {
  const { t } = useT();
  const p = t.inbox.plan;
  const pop = t.inbox.popover;

  const [parkOpen, setParkOpen] = useState(false);
  const [parkNote, setParkNote] = useState("");
  const [reportOpen, setReportOpen] = useState(false);
  const [dirtyOpen, setDirtyOpen] = useState(false);
  const reportRef = useRef<HTMLDivElement>(null);

  const [, setOpenCsv] = useStoredState(`skipper-plan-doc-open:${itemId}`, "");
  const expandAndScroll = (sid: string) => {
    setOpenCsv((cur) => {
      const set = new Set(cur.split(",").filter(Boolean));
      set.add(sid);
      return [...set].join(",");
    });
    requestAnimationFrame(() =>
      document
        .getElementById(docSectionDomId(sid))
        ?.scrollIntoView({ behavior: "smooth", block: "start" }),
    );
  };

  const report = stored.confidence;
  const composite = report?.composite;
  const editedWarning =
    stored.editedAt && (!report || report.computedAt < stored.editedAt);

  const revealReport = () => {
    setReportOpen(true);
    requestAnimationFrame(() =>
      reportRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }),
    );
  };

  const groundMisses = report?.signals.groundedness
    ? [
        ...report.signals.groundedness.missingFiles,
        ...report.signals.groundedness.missingSymbols,
      ]
    : [];
  const conv = report?.signals.convergence;
  const critic = report?.signals.critic;
  const hasGroundAnomaly = groundMisses.length > 0;
  const hasConvAnomaly =
    (conv && (conv.divergent || conv.disputedFiles.length > 0)) ||
    (!conv && !!report?.convergenceSkipped);
  const hasCriticAnomaly = !!critic && (critic.objections.length > 0 || critic.verdict !== "approve");
  const hasAnomalies = hasGroundAnomaly || hasConvAnomaly || hasCriticAnomaly;

  const signalRows: { key: string; name: string; score: number | null }[] = [];
  if (report) {
    const s = report.signals;
    if (s.groundedness) signalRows.push({ key: "g", name: pop.groundedness, score: s.groundedness.score });
    if (s.convergence) signalRows.push({ key: "cv", name: pop.convergence, score: s.convergence.score });
    else if (report.convergenceSkipped)
      signalRows.push({ key: "cv", name: pop.convergence, score: null });
    if (s.critic) signalRows.push({ key: "c", name: pop.critic, score: s.critic.score });
    if (s.clarity) signalRows.push({ key: "cl", name: pop.clarity, score: s.clarity.score });
  }

  const blockingCount = report?.signals.critic?.objections.filter((o) => o.blocking).length ?? 0;
  const riskCount = plan.risks.length;
  const questionCount = plan.openQuestions.length;
  const hasAttention = blockingCount > 0 || riskCount > 0 || questionCount > 0;

  return (
    <div className="self-start wide:col-start-2 wide:row-start-1 wide:sticky wide:top-4 wide:max-h-[calc(100vh-230px)] wide:overflow-y-auto rounded-lg border border-card-hover bg-card p-4 space-y-4">
      {/* Verdict strip */}
      <div className="space-y-1">
        {editedWarning && <p className="text-[11px] text-warning/80">{p.edited}</p>}
        {rescoring ? (
          <div className="flex items-center gap-2 text-sm text-muted">
            <Loader2 size={14} className="animate-spin" />
            {p.rescoring}
          </div>
        ) : composite !== undefined ? (
          <>
            <div className={`text-[30px] leading-none font-semibold ${bandText(composite)}`}>
              {pct(composite)}
            </div>
            {prevComposite !== null && prevComposite !== composite && (
              <p
                className={`text-[12px] ${
                  composite > prevComposite ? "text-success" : "text-warning"
                }`}
              >
                {composite > prevComposite
                  ? p.rail.deltaUp(pct(prevComposite))
                  : p.rail.deltaDown(pct(prevComposite))}
              </p>
            )}
            {report && (
              <p className="text-[11px] text-muted/60">
                {p.rail.recomputed(new Date(report.computedAt).toLocaleString())}
              </p>
            )}
          </>
        ) : (
          <p className="text-sm text-muted">{pop.reportUnavailable}</p>
        )}
        {report && report.errors.length > 0 && (
          <div className="space-y-0.5 pt-1">
            {report.errors.map((e, i) => (
              <p key={i} className="text-[11px] text-danger/80 break-all">
                {e}
              </p>
            ))}
          </div>
        )}
      </div>

      {/* Signal mini-bars */}
      {!rescoring && signalRows.length > 0 && (
        <div className="space-y-1.5">
          {signalRows.map((row) => (
            <div key={row.key} className="flex items-center gap-2">
              <span className="w-[84px] shrink-0 text-[11px] text-muted truncate">{row.name}</span>
              {row.score === null ? (
                <span className="flex-1 text-[11px] text-muted/60">{pop.convergenceSkipped}</span>
              ) : (
                <>
                  <div className="flex-1 h-1 rounded-full bg-card-hover overflow-hidden">
                    <div
                      className={`h-full rounded-full ${barFill(row.score)}`}
                      style={{ width: `${Math.round(row.score * 100)}%` }}
                    />
                  </div>
                  <span className="w-9 text-right text-[11px] tabular-nums text-muted">
                    {pct(row.score)}
                  </span>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Attention list */}
      {hasAttention && (
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted/70">
            {p.rail.attention}
          </p>
          {blockingCount > 0 && (
            <AttentionRow color="bg-danger" onClick={revealReport}>
              {p.rail.attentionObjections(blockingCount)}
            </AttentionRow>
          )}
          {questionCount > 0 && (
            <AttentionRow color="bg-warning" onClick={() => expandAndScroll("openQuestions")}>
              {p.rail.attentionOpenQuestions(questionCount)}
            </AttentionRow>
          )}
          {riskCount > 0 && (
            <AttentionRow color="bg-warning" onClick={() => expandAndScroll("risks")}>
              {p.rail.attentionRisks(riskCount)}
            </AttentionRow>
          )}
        </div>
      )}

      {/* Full report — anomalies only */}
      {report && hasAnomalies && (
        <div ref={reportRef} className="space-y-2">
          <button
            onClick={() => setReportOpen((v) => !v)}
            className="flex items-center gap-1.5 text-[12px] font-medium text-muted hover:text-foreground transition-colors"
          >
            {reportOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            {p.rail.fullReport}
          </button>
          {reportOpen && (
            <div className={`text-[12px] space-y-3 ${rescoring ? "opacity-60" : ""}`}>
              <AnomalyReport report={report} />
            </div>
          )}
        </div>
      )}

      {/* Dirty worktree (#204) */}
      {dirtyFiles && dirtyFiles.length > 0 && (
        <div className="space-y-2">
          <button
            onClick={() => setDirtyOpen((v) => !v)}
            className="flex items-center gap-1.5 text-left text-[12px] font-medium text-muted hover:text-foreground transition-colors"
          >
            {dirtyOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />
            {p.rail.dirtyWorktree(dirtyFiles.length)}
          </button>
          {dirtyOpen && (
            <ul className="font-mono text-[11px] text-muted space-y-0.5 pl-5">
              {dirtyFiles.map((path) => (
                <li key={path} className="truncate">
                  {path}
                </li>
              ))}
            </ul>
          )}
          <button
            onClick={onCleanWorktree}
            className="w-full flex items-center justify-center gap-1 text-[12px] font-medium px-3 py-1.5 rounded-md border border-warning/25 bg-warning-bg text-warning hover:bg-warning/20 transition-colors"
          >
            {p.rail.cleanWorktree}
          </button>
        </div>
      )}

      {/* Actions */}
      {gate ? (
        <div className="space-y-2 pt-1">
          {parkOpen ? (
            <div className="space-y-2">
              <input
                autoFocus
                value={parkNote}
                onChange={(e) => setParkNote(e.target.value)}
                placeholder={p.parkNotePlaceholder}
                className="w-full bg-card-hover/40 border border-card-hover focus:border-accent outline-none rounded-md px-2 py-1.5 text-sm"
              />
              <div className="flex items-center gap-2">
                <button
                  onClick={() => onAction("park", parkNote.trim() || undefined)}
                  disabled={actionsDisabled}
                  className="flex-1 flex items-center justify-center gap-1 text-[12px] font-medium px-3 py-1.5 rounded-md border border-warning/25 bg-warning-bg text-warning hover:bg-warning/20 transition-colors disabled:opacity-50"
                >
                  {busyAction === "park" && <Loader2 size={11} className="animate-spin" />}
                  {p.parkConfirm}
                </button>
                <button
                  onClick={() => {
                    setParkOpen(false);
                    setParkNote("");
                  }}
                  className="p-1.5 rounded text-muted hover:text-foreground transition-colors"
                  title={p.cancel}
                >
                  <X size={14} />
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-2" title={editBusy ? p.finishEditing : undefined}>
              <button
                onClick={() => onAction("approve")}
                disabled={actionsDisabled}
                className="w-full flex items-center justify-center gap-1 text-[12px] font-medium px-3 py-2 rounded-md border border-accent/30 bg-accent/10 text-accent hover:bg-accent/20 transition-colors disabled:opacity-50"
              >
                {busyAction === "approve" && <Loader2 size={11} className="animate-spin" />}
                {t.inbox.actions.approve}
              </button>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => onAction("replan")}
                  disabled={actionsDisabled}
                  className="flex items-center justify-center gap-1 text-[12px] font-medium px-3 py-1.5 rounded-md border border-border text-muted hover:text-foreground hover:bg-card-hover transition-colors disabled:opacity-50"
                >
                  {busyAction === "replan" && <Loader2 size={11} className="animate-spin" />}
                  {t.inbox.actions.replan}
                </button>
                <button
                  onClick={() => setParkOpen(true)}
                  disabled={actionsDisabled}
                  className="flex items-center justify-center gap-1 text-[12px] font-medium px-3 py-1.5 rounded-md border border-border text-muted hover:text-foreground hover:bg-card-hover transition-colors disabled:opacity-50"
                >
                  {t.inbox.actions.park}
                </button>
              </div>
            </div>
          )}
          {actionError && <p className="text-[12px] text-danger break-all">{actionError}</p>}
        </div>
      ) : (
        <p className="text-[12px] text-muted/70">{p.readOnly}</p>
      )}

      {/* Footer meta */}
      <div className="flex items-center gap-2 flex-wrap pt-2 border-t border-border text-[12px] text-muted">
        {gate ? (
          <select
            value={plan.estimatedSize}
            onChange={(e) => onSizeChange(e.target.value as IssuePlan["estimatedSize"])}
            disabled={saving}
            className="bg-card border border-border rounded px-1.5 py-0.5 text-[11px] font-medium uppercase text-foreground focus:outline-none focus:border-accent disabled:opacity-50"
            title={p.size}
          >
            {SIZES.map((s) => (
              <option key={s} value={s}>
                {s.toUpperCase()}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-[11px] font-medium px-1.5 py-0.5 rounded border bg-card text-muted border-border uppercase">
            {plan.estimatedSize}
          </span>
        )}
        <span className="text-muted/60">
          {p.generated}: {new Date(stored.generatedAt).toLocaleString()} · {stored.model}
        </span>
      </div>
    </div>
  );
}

function AttentionRow({
  color,
  onClick,
  children,
}: {
  color: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2 text-left text-[12px] text-muted hover:text-accent transition-colors"
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${color}`} />
      {children}
    </button>
  );
}

function truncate(entries: string[], moreLabel: string): string {
  const shown = entries.slice(0, 5);
  if (entries.length <= shown.length) return shown.join(", ");
  return `${shown.join(", ")} +${entries.length - shown.length} ${moreLabel}`;
}

function AnomalyReport({ report }: { report: ConfidenceReport }) {
  const { t } = useT();
  const pop = t.inbox.popover;
  const { groundedness, convergence, critic } = report.signals;

  const groundMisses = groundedness
    ? [...groundedness.missingFiles, ...groundedness.missingSymbols]
    : [];

  return (
    <>
      {groundMisses.length > 0 && (
        <p className="text-muted break-all">
          {pop.groundedness} — {pop.missing}: {truncate(groundMisses, pop.more)}
        </p>
      )}

      {convergence && (convergence.divergent || convergence.disputedFiles.length > 0) && (
        <div className="space-y-1">
          {convergence.divergent && (
            <p className="text-warning font-medium">{pop.divergent}</p>
          )}
          {convergence.disputedFiles.length > 0 && (
            <p className="text-muted break-all">
              {pop.convergence} — {pop.disputed}: {truncate(convergence.disputedFiles, pop.more)}
            </p>
          )}
        </div>
      )}
      {!convergence && report.convergenceSkipped && (
        <p className="text-muted">
          {pop.convergence} — {report.convergenceSkipped.detail}
        </p>
      )}

      {critic && (critic.objections.length > 0 || critic.verdict !== "approve") && (
        <div className="space-y-1">
          <p className={verdictColor(critic.verdict)}>{pop.verdicts[critic.verdict]}</p>
          {critic.objections.map((o, i) => (
            <p key={i} className="text-muted break-all">
              <span className="text-[10px] uppercase tracking-wide text-muted/60">{o.kind}</span>
              {o.blocking && (
                <span className="ml-1 text-[10px] uppercase tracking-wide text-danger">
                  {pop.blocking}
                </span>
              )}{" "}
              {o.detail}
            </p>
          ))}
        </div>
      )}
    </>
  );
}
