import { Suspense } from "react";
import { EditorView, EditorFallback } from "./editor-view";

export default function EditorPage() {
  return (
    <Suspense fallback={<EditorFallback />}>
      <EditorView />
    </Suspense>
  );
}
