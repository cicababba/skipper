"use client";

import { useSearchParams } from "next/navigation";

/**
 * /inbox/item?id=<id> → the item id. Replaces the old `[id]` dynamic segment
 * (#208): static export can't serve runtime-id routes. URLSearchParams already
 * decodes, so no decodeURIComponent here.
 */
export function useItemId(): string {
  return useSearchParams().get("id") ?? "";
}
