"use client";

import { useParams } from "next/navigation";

/**
 * /repos/[owner]/[name] → { owner, name, key } (Next decodes segments for us).
 * Shared by the repo detail page and its /settings child route.
 */
export function useRepoParams(): { owner: string; name: string; key: string } {
  const params = useParams();
  const owner = typeof params.owner === "string" ? params.owner : "";
  const name = typeof params.name === "string" ? params.name : "";
  return { owner, name, key: `${owner}/${name}` };
}
