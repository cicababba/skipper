import type { PlanStep, StoredPlan } from "@skipper/shared";
import { bullet, joinBlocks, pct } from "./md";

// Plan serializer for the markdown export (#216). Renders StoredPlan as a plain
// markdown document; absent/empty sections are omitted, never rendered as
// placeholders.

function inlineList(items: string[]): string {
  return items.map((i) => `\`${i}\``).join(", ");
}

function section(heading: string, body: string | null): string | null {
  return body ? `${heading}\n\n${body}` : null;
}

function listBody(items: string[] | undefined): string | null {
  return items && items.length > 0 ? items.map((i) => `- ${i}`).join("\n") : null;
}

function stepBlock(step: PlanStep, n: number): string {
  const meta = joinBlocks(
    [
      step.files.length > 0 ? `Files: ${inlineList(step.files)}` : null,
      step.symbols.length > 0 ? `Symbols: ${inlineList(step.symbols)}` : null,
      step.createdSymbols && step.createdSymbols.length > 0
        ? `Creates: ${inlineList(step.createdSymbols)}`
        : null,
    ],
    "\n",
  );
  return joinBlocks([`### ${n}. ${step.title}`, step.detail || null, meta], "\n\n");
}

export function planMarkdown(stored: StoredPlan): string {
  const plan = stored.plan;
  const metadata = joinBlocks(
    [
      bullet("Generated", stored.generatedAt),
      bullet("Model", stored.model),
      stored.confidence ? bullet("Confidence", pct(stored.confidence.composite)) : null,
      bullet("Estimated size", plan.estimatedSize),
    ],
    "\n",
  );

  const files =
    plan.files.length > 0
      ? plan.files
          .map(
            (f) =>
              `- \`${f.path}\` — ${f.reason}${f.status === "new" ? " _(new)_" : ""}`,
          )
          .join("\n")
      : null;

  const steps =
    plan.steps.length > 0 ? plan.steps.map((s, i) => stepBlock(s, i + 1)).join("\n\n") : null;

  const acceptance =
    plan.acceptance.length > 0
      ? plan.acceptance.map((a) => `- ${a.criterion} — ${a.addressedBy}`).join("\n")
      : null;

  const verification =
    plan.verificationCommands && plan.verificationCommands.length > 0
      ? plan.verificationCommands.map((c) => `- \`${c}\``).join("\n")
      : null;

  return joinBlocks([
    "# Plan",
    metadata,
    section("## Summary", plan.summary || null),
    section("## Context", listBody(plan.context)),
    section("## Files", files),
    section("## Steps", steps),
    section("## Out of scope", listBody(plan.outOfScope)),
    section("## Acceptance", acceptance),
    section("## Risks", listBody(plan.risks)),
    section("## Verification commands", verification),
    section("## Manual checks", listBody(plan.manualChecks)),
    section("## Open questions", listBody(plan.openQuestions)),
  ]);
}
