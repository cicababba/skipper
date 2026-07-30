import type { Issue } from "@skipper/shared";
import type { CreateIssueParams } from "../types";
import { openprojectApiBase, openprojectGet, openprojectPost } from "./client";
import { mapOpenProjectWorkPackage, type OpenProjectWorkPackagePayload } from "./map";
import type { OpenProjectTokenProvider } from "./types";

interface TypeElement {
  id: number;
  name?: string;
  _links?: { self?: { href?: string | null } | null };
}

interface TypeCollection {
  _embedded?: { elements?: TypeElement[] };
}

/** A work package needs a type, and the set is per-project and configurable —
 *  prefer "Task", else take the first one the project offers. */
async function resolveTypeHref(
  project: string,
  getToken: OpenProjectTokenProvider,
  base: string,
  authMethod?: "oauth" | "pat",
): Promise<string> {
  const coll = await openprojectGet<TypeCollection>(
    `${base}/api/v3/projects/${encodeURIComponent(project)}/types`,
    getToken,
    authMethod,
  );
  const elements = coll._embedded?.elements ?? [];
  const chosen = elements.find((t) => t.name?.toLowerCase() === "task") ?? elements[0];
  if (!chosen) {
    throw new Error(`OpenProject project ${project} offers no work-package types`);
  }
  return chosen._links?.self?.href ?? `/api/v3/types/${chosen.id}`;
}

/** Creates an OpenProject work package (#274) and returns it fully mapped. Labels
 *  and assignees are dropped: OpenProject has no labels, and assigning needs a
 *  principal lookup that is out of scope. ApiError propagates. */
export async function createOpenProjectIssue(
  params: CreateIssueParams,
  getToken: OpenProjectTokenProvider,
  baseUrl?: string,
  authMethod?: "oauth" | "pat",
): Promise<Issue> {
  const project = params.project;
  if (!project) {
    throw new Error(
      "an OpenProject work package needs a project — map this repo to an OpenProject project in Settings",
    );
  }
  const base = openprojectApiBase(baseUrl);
  const typeHref = await resolveTypeHref(project, getToken, base, authMethod);
  const payload = await openprojectPost<OpenProjectWorkPackagePayload>(
    `${base}/api/v3/work_packages`,
    getToken,
    {
      subject: params.title,
      ...(params.body !== undefined && {
        description: { format: "markdown", raw: params.body },
      }),
      _links: {
        project: { href: `/api/v3/projects/${project}` },
        type: { href: typeHref },
      },
    },
    authMethod,
  );
  return mapOpenProjectWorkPackage(payload, params.accountId, base, new Map());
}
