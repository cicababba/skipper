import { Suspense } from "react";
import { RepoDetailView } from "./repo-detail";

export default function RepoDetailPage() {
  return (
    <Suspense fallback={null}>
      <RepoDetailView />
    </Suspense>
  );
}
