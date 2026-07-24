import type { Issue } from "@skipper/shared";
import { openprojectApiBase, openprojectGet } from "./client";
import { mapOpenProjectWorkPackage, type OpenProjectWorkPackagePayload } from "./map";
import { ApiError } from "../types";
import {
  asOpenProjectCursor,
  emptyOpenProjectCursor,
  type OpenProjectAccountCursor,
  type OpenProjectPollOptions,
  type OpenProjectPollResult,
  type OpenProjectTokenProvider,
} from "./types";

// OpenProject `updatedAt` is second-granular but client↔server clock skew and
// minute-level filtering still let an edit slip; overlap by 120s so a delta never
// drops one landing in the same window.
const SINCE_OVERLAP_MS = 120_000;
// Beyond a week the relative window is meaningless — treat the cursor as stale and
// force a full walk instead of asking for a huge slice.
const MAX_DELTA_WINDOW_MINUTES = 7 * 24 * 60;
const PAGE_SIZE = 100;

interface WorkPackageCollection {
  total?: number;
  count?: number;
  _embedded?: { elements?: OpenProjectWorkPackagePayload[] };
}

interface StatusElement {
  isClosed?: boolean;
  _links?: { self?: { href?: string } };
}

interface StatusCollection {
  _embedded?: { elements?: StatusElement[] };
}

/** ISO-UTC lower bound for a delta poll's `<>d` filter, or undefined when the
 *  cursor is missing, malformed, or too stale — the caller then does a full walk. */
function deltaSince(updatedAfter: string | undefined): string | undefined {
  if (!updatedAfter) return undefined;
  const since = Date.parse(updatedAfter);
  if (!Number.isFinite(since)) return undefined;
  const from = since - SINCE_OVERLAP_MS;
  const ageMinutes = (Date.now() - from) / 60_000;
  if (ageMinutes > MAX_DELTA_WINDOW_MINUTES) return undefined;
  return new Date(from).toISOString();
}

/** Status href → isClosed, fetched once per poll to classify work-package state. */
async function fetchStatuses(
  base: string,
  getToken: OpenProjectTokenProvider,
  authMethod?: "oauth" | "pat",
): Promise<Map<string, boolean>> {
  const coll = await openprojectGet<StatusCollection>(
    `${base}/api/v3/statuses`,
    getToken,
    authMethod,
  );
  const map = new Map<string, boolean>();
  for (const s of coll._embedded?.elements ?? []) {
    const href = s._links?.self?.href;
    if (href) map.set(href, s.isClosed === true);
  }
  return map;
}

async function searchWorkPackages(
  base: string,
  filters: unknown,
  getToken: OpenProjectTokenProvider,
  authMethod?: "oauth" | "pat",
): Promise<OpenProjectWorkPackagePayload[]> {
  const out: OpenProjectWorkPackagePayload[] = [];
  // offset is the 1-based page number, not a row offset.
  let page = 1;
  for (;;) {
    const params = new URLSearchParams({
      filters: JSON.stringify(filters),
      pageSize: String(PAGE_SIZE),
      offset: String(page),
      sortBy: JSON.stringify([["updatedAt", "desc"]]),
    });
    const coll = await openprojectGet<WorkPackageCollection>(
      `${base}/api/v3/work_packages?${params.toString()}`,
      getToken,
      authMethod,
    );
    const elements = coll._embedded?.elements ?? [];
    out.push(...elements);
    if (elements.length === 0 || out.length >= (coll.total ?? 0)) break;
    page += 1;
  }
  return out;
}

export async function pollOpenProjectAccount(
  options: OpenProjectPollOptions,
): Promise<OpenProjectPollResult> {
  const cursor = asOpenProjectCursor(options.cursor);
  try {
    return await runPoll(options, cursor);
  } catch (err) {
    // A bad filter is a 400 — recover a rejected cursor (or a wrong operator) with
    // a slower-but-correct full walk.
    if (cursor && err instanceof ApiError && err.status === 400) {
      options.onProgress?.("cursor rejected (400) — falling back to full walk");
      return runPoll(options, undefined);
    }
    throw err;
  }
}

async function runPoll(
  options: OpenProjectPollOptions,
  cursor: OpenProjectAccountCursor | undefined,
): Promise<OpenProjectPollResult> {
  const { accountId, getToken, onProgress, baseUrl, authMethod } = options;
  const base = openprojectApiBase(baseUrl);

  const since = cursor ? deltaSince(cursor.issues.updatedAfter) : undefined;
  const mode = since != null ? "delta" : "full";

  const statuses = await fetchStatuses(base, getToken, authMethod);

  const assigneeFilter = { assignee: { operator: "=", values: ["me"] } };
  // Delta drops the open filter so just-closed work packages arrive and reconcile
  // closes the tracked item. De-assignments are missed until the orchestrator's
  // forced full walk — a shared limitation with the other adapters.
  const filters =
    since != null
      ? [assigneeFilter, { updatedAt: { operator: "<>d", values: [since, ""] } }]
      : [assigneeFilter, { status: { operator: "o", values: [] } }];

  const payloads = await searchWorkPackages(base, filters, getToken, authMethod);
  onProgress?.(`work packages: ${payloads.length} items`);

  const issues: Issue[] = payloads.map((p) =>
    mapOpenProjectWorkPackage(p, accountId, base, statuses),
  );

  // Empty delta keeps the previous updatedAfter so the window doesn't shrink.
  let updatedAfter = cursor?.issues.updatedAfter;
  if (payloads.length > 0) {
    const maxUpdated = Math.max(
      ...payloads.map((p) => Date.parse(p.updatedAt ?? "")).filter(Number.isFinite),
    );
    if (Number.isFinite(maxUpdated)) updatedAfter = new Date(maxUpdated).toISOString();
  }

  return {
    mode,
    issues,
    pullRequests: [],
    cursor: {
      ...emptyOpenProjectCursor(),
      issues: { updatedAfter },
      lastPolledAt: new Date().toISOString(),
    },
  };
}
