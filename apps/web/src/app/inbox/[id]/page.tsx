import { Suspense } from "react";
import { PlanDetailView } from "./plan-detail";

export const dynamic = "force-dynamic";

export default function PlanDetailPage() {
  return (
    <Suspense fallback={null}>
      <PlanDetailView />
    </Suspense>
  );
}
