import { Suspense } from "react";
import { InboxView } from "./inbox-view";

export default function InboxPage() {
  return (
    <Suspense fallback={null}>
      <InboxView />
    </Suspense>
  );
}
