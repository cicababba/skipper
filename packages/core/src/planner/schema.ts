import { z } from "zod";
import type { IssuePlan } from "@skipper/shared";

export const IssuePlanSchema = z.object({
  summary: z.string().min(1),
  context: z.array(z.string()),
  files: z
    .array(
      z.object({
        path: z.string().min(1),
        reason: z.string(),
        status: z.enum(["existing", "new"]).optional(),
      }),
    )
    .min(1),
  steps: z
    .array(
      z.object({
        title: z.string().min(1),
        detail: z.string(),
        files: z.array(z.string()),
        symbols: z.array(z.string()),
        createdSymbols: z.array(z.string()).optional(),
      }),
    )
    .min(1),
  outOfScope: z.array(z.string()),
  acceptance: z.array(
    z.object({
      criterion: z.string(),
      addressedBy: z.string(),
    }),
  ),
  risks: z.array(z.string()),
  verificationCommands: z.array(z.string()),
  manualChecks: z.array(z.string()),
  openQuestions: z.array(z.string()),
  estimatedSize: z.enum(["xs", "s", "m", "l", "xl"]),
}) satisfies z.ZodType<IssuePlan>;

export function planJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(IssuePlanSchema) as Record<string, unknown>;
}
