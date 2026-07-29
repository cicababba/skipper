import { Suspense } from "react";
import { ComposerView } from "./composer-view";

export default function ComposePage() {
  return (
    <Suspense fallback={null}>
      <ComposerView />
    </Suspense>
  );
}
