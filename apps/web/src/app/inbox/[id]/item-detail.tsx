"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { useOrchestrator } from "@/lib/orchestrator-context";
import { PlanDetailView } from "./plan-detail";
import { ReviewDetailView } from "./review-detail";

// Latches the view once when the item first resolves, so a background state
// change never swaps the screen out from under the user mid-edit.
export function ItemDetailView() {
  const params = useParams();
  const id = decodeURIComponent(String(params.id));
  const { state } = useOrchestrator();

  const [mode, setMode] = useState<"plan" | "review" | null>(null);
  const item = state?.items.find((i) => i.id === id);

  // Adjust-state-during-render latch: set once when the item first resolves.
  if (mode === null && item) setMode(item.state === "human-review" ? "review" : "plan");

  if (mode === "review") return <ReviewDetailView />;
  // While the item is unresolved (loading, non-desktop, not found),
  // PlanDetailView already renders the right empty states.
  return <PlanDetailView />;
}
