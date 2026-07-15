import { Suspense } from "react";
import { RepoDetailView } from "./repo-detail";

export const dynamic = "force-dynamic";

export default function RepoDetailPage() {
  return (
    <Suspense fallback={null}>
      <RepoDetailView />
    </Suspense>
  );
}
