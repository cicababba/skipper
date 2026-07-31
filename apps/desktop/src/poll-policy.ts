import { ApiError, AuthError, type OrchestratorManifest } from "@skipper/core";
import { repoKey, resolveRepoIntakeSettings } from "@skipper/shared";
import type { Issue, OrchestratorAccountState } from "@skipper/shared";

/**
 * Admission filter handed to reconcile. The follow list (#15) is an explicit
 * set — an absent record means NOT followed, so an unfollowed repo's issues stay
 * in the raw inbox arrays and never enter the orchestrator. Linking still gates
 * planning. A repo-less issue (unmapped project, #79) is never followed.
 */
export function admissionPolicy(m: OrchestratorManifest): {
  intakePaused: boolean;
  shouldAdmit: (issue: Issue) => boolean;
} {
  return {
    intakePaused: m.settings.intakePaused,
    shouldAdmit: (issue) =>
      issue.repo !== undefined &&
      resolveRepoIntakeSettings(m.repoSettings[repoKey(issue.repo)]).followed,
  };
}

/** Backoff gate: skip this poll while the account's nextPollAt is still in the
 *  future, unless the caller forces a refetch (ignoreBackoff). */
export function shouldSkipPoll(
  state: OrchestratorAccountState | undefined,
  now: number,
  ignoreBackoff: boolean,
): boolean {
  return !ignoreBackoff && !!state?.nextPollAt && now < state.nextPollAt;
}

/** Full-vs-delta decision: force a full walk once the last one aged past
 *  fullWalkEveryMs (dropping the stored delta cursor); otherwise resume the delta
 *  from the stored cursor. */
export function selectPollCursor<C = unknown>(opts: {
  now: number;
  lastFullWalkAt: number;
  storedCursor: C | undefined;
  fullWalkEveryMs: number;
}): { forceFull: boolean; cursor: C | undefined } {
  const forceFull = opts.now - opts.lastFullWalkAt > opts.fullWalkEveryMs;
  return { forceFull, cursor: forceFull ? undefined : opts.storedCursor };
}

/** Translates a poll error into the account-state patch: an AuthError parks the
 *  account with no backoff; an ApiError with retryAfterSeconds schedules the next
 *  poll; anything else is a generic error. */
export function pollFailurePatch(
  err: unknown,
  now: number,
): Partial<OrchestratorAccountState> {
  if (err instanceof AuthError) {
    return { status: "auth-error", error: err.message };
  }
  if (err instanceof ApiError && err.retryAfterSeconds) {
    return {
      status: "error",
      error: err.message,
      nextPollAt: now + err.retryAfterSeconds * 1000,
    };
  }
  return { status: "error", error: String(err) };
}
