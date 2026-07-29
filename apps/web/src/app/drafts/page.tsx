import { Suspense } from "react";
import { DraftsView } from "./drafts-view";

export default function DraftsPage() {
  return (
    <Suspense fallback={null}>
      <DraftsView />
    </Suspense>
  );
}
