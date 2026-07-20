// Per-section plan editing at the gate (#13). Drafts hold the editable slice of
// one IssuePlan section; validity mirrors IssuePlanSchema so the IPC backstop
// rarely fires. Pure module — no React.

import type { IssuePlan, PlanAcceptance, PlanFileRef } from "@skipper/shared";

export type SectionId =
  | "summary"
  | "context"
  | "files"
  | "steps"
  | "outOfScope"
  | "acceptance"
  | "risks"
  | "verificationCommands"
  | "manualChecks"
  | "openQuestions"
  | "size";

export interface StepDraft {
  title: string;
  detail: string;
  /** One repo-relative path per line. */
  filesText: string;
  /** One symbol per line. */
  symbolsText: string;
}

export type SectionDraft =
  | { section: "summary"; text: string }
  | { section: "context"; lines: string[] }
  | { section: "files"; files: PlanFileRef[] }
  | { section: "steps"; steps: StepDraft[] }
  | { section: "outOfScope"; lines: string[] }
  | { section: "acceptance"; acceptance: PlanAcceptance[] }
  | { section: "risks"; lines: string[] }
  | { section: "verificationCommands"; lines: string[] }
  | { section: "manualChecks"; lines: string[] }
  | { section: "openQuestions"; lines: string[] }
  | { section: "size"; size: IssuePlan["estimatedSize"] };

export function splitLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function draftFor(plan: IssuePlan, section: SectionId): SectionDraft {
  switch (section) {
    case "summary":
      return { section, text: plan.summary };
    case "context":
      return { section, lines: [...(plan.context ?? [])] };
    case "files":
      return { section, files: plan.files.map((f) => ({ ...f })) };
    case "steps":
      return {
        section,
        steps: plan.steps.map((s) => ({
          title: s.title,
          detail: s.detail,
          filesText: s.files.join("\n"),
          symbolsText: s.symbols.join("\n"),
        })),
      };
    case "outOfScope":
      return { section, lines: [...(plan.outOfScope ?? [])] };
    case "acceptance":
      return { section, acceptance: plan.acceptance.map((a) => ({ ...a })) };
    case "risks":
      return { section, lines: [...plan.risks] };
    case "verificationCommands":
      return { section, lines: [...(plan.verificationCommands ?? [])] };
    case "manualChecks":
      return { section, lines: [...(plan.manualChecks ?? [])] };
    case "openQuestions":
      return { section, lines: [...plan.openQuestions] };
    case "size":
      return { section, size: plan.estimatedSize };
  }
}

export function sectionIsValid(draft: SectionDraft): boolean {
  switch (draft.section) {
    case "summary":
      return draft.text.trim().length > 0;
    case "files":
      return draft.files.length > 0 && draft.files.every((f) => f.path.trim().length > 0);
    case "steps":
      return draft.steps.length > 0 && draft.steps.every((s) => s.title.trim().length > 0);
    default:
      return true;
  }
}

export function applySection(plan: IssuePlan, draft: SectionDraft): IssuePlan {
  switch (draft.section) {
    case "summary":
      return { ...plan, summary: draft.text.trim() };
    case "files":
      return {
        ...plan,
        files: draft.files.map((f) => ({
          path: f.path.trim(),
          reason: f.reason.trim(),
          ...(f.status ? { status: f.status } : {}),
        })),
      };
    case "steps":
      return {
        ...plan,
        steps: draft.steps.map((s) => ({
          title: s.title.trim(),
          detail: s.detail.trim(),
          files: splitLines(s.filesText),
          symbols: splitLines(s.symbolsText),
        })),
      };
    case "acceptance":
      return {
        ...plan,
        acceptance: draft.acceptance
          .map((a) => ({ criterion: a.criterion.trim(), addressedBy: a.addressedBy.trim() }))
          .filter((a) => a.criterion || a.addressedBy),
      };
    case "context":
      return { ...plan, context: draft.lines.map((l) => l.trim()).filter(Boolean) };
    case "outOfScope":
      return { ...plan, outOfScope: draft.lines.map((l) => l.trim()).filter(Boolean) };
    case "risks":
      return { ...plan, risks: draft.lines.map((l) => l.trim()).filter(Boolean) };
    case "verificationCommands":
      return { ...plan, verificationCommands: draft.lines.map((l) => l.trim()).filter(Boolean) };
    case "manualChecks":
      return { ...plan, manualChecks: draft.lines.map((l) => l.trim()).filter(Boolean) };
    case "openQuestions":
      return { ...plan, openQuestions: draft.lines.map((l) => l.trim()).filter(Boolean) };
    case "size":
      return { ...plan, estimatedSize: draft.size };
  }
}
