import { Suspense } from "react";
import { RepoSettingsView } from "./repo-settings";

export const dynamic = "force-dynamic";

export default function RepoSettingsPage() {
  return (
    <Suspense fallback={null}>
      <RepoSettingsView />
    </Suspense>
  );
}
