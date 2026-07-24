import type { StoredCoderReport } from "@skipper/shared";
import { bullet, joinBlocks } from "./md";

// Coder-report serializer for the markdown export (#216). Empty Deviations/Open
// sections are omitted; verification renders as a task list.

function section(heading: string, body: string | null): string | null {
  return body ? `${heading}\n\n${body}` : null;
}

export function coderReportMarkdown(stored: StoredCoderReport): string {
  const report = stored.report;
  const metadata = joinBlocks(
    [bullet("Generated", stored.generatedAt), bullet("Model", stored.model)],
    "\n",
  );

  const done =
    report.done.length > 0
      ? report.done.map((d) => `- \`${d.path}\` — ${d.summary}`).join("\n")
      : null;

  const deviations =
    report.deviations.length > 0 ? report.deviations.map((d) => `- ${d}`).join("\n") : null;

  const verification =
    report.verification.length > 0
      ? report.verification
          .map(
            (v) =>
              `- [${v.passed ? "x" : " "}] \`${v.command}\`${v.detail ? ` — ${v.detail}` : ""}`,
          )
          .join("\n")
      : null;

  const open = report.open.length > 0 ? report.open.map((o) => `- ${o}`).join("\n") : null;

  return joinBlocks([
    "# Coder report",
    metadata,
    section("## Done", done),
    section("## Deviations", deviations),
    section("## Verification", verification),
    section("## Open", open),
  ]);
}
