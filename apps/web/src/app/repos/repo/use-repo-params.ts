"use client";

import { useSearchParams } from "next/navigation";

/**
 * /repos/repo?owner=&name= → { owner, name, key }. Replaces the old
 * [owner]/[name] dynamic segments (#208); static export can't serve runtime-id
 * routes. Shared by the repo detail page and its /settings child route.
 */
export function useRepoParams(): { owner: string; name: string; key: string } {
  const params = useSearchParams();
  const owner = params.get("owner") ?? "";
  const name = params.get("name") ?? "";
  return { owner, name, key: `${owner}/${name}` };
}
