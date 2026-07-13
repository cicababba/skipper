"use client";

import { useEffect, useRef, useState } from "react";
import { MergeView } from "@codemirror/merge";
import { EditorView, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { EditorState, type Extension } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { loadLanguageFor } from "@/lib/codemirror-lang";

interface MergeEditorProps {
  filePath: string;
  original: string;
  modified: string;
  onChange: (doc: string) => void;
}

// Side-by-side worktree diff (#14): HEAD on the left (read-only), worktree on
// the right (editable). Mounted imperatively — @uiw/react-codemirror doesn't
// cover MergeView. Parents mount with key={filePath} so file switches
// destroy/recreate cleanly; `modified` only seeds the initial doc.
export function MergeEditor({ filePath, original, modified, onChange }: MergeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });
  // Latest editable doc, so the async language-pack rebuild never loses edits.
  const docRef = useRef(modified);

  const [langExt, setLangExt] = useState<Extension[]>([]);
  useEffect(() => {
    let cancelled = false;
    loadLanguageFor(filePath).then((pack) => {
      if (!cancelled) setLangExt(pack ? [pack] : []);
    });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  useEffect(() => {
    if (!hostRef.current) return;
    const shared: Extension[] = [lineNumbers(), highlightActiveLine(), oneDark, ...langExt];
    const view = new MergeView({
      parent: hostRef.current,
      a: {
        doc: original,
        extensions: [...shared, EditorState.readOnly.of(true), EditorView.editable.of(false)],
      },
      b: {
        doc: docRef.current,
        extensions: [
          ...shared,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) {
              const doc = u.state.doc.toString();
              docRef.current = doc;
              onChangeRef.current(doc);
            }
          }),
        ],
      },
    });
    return () => view.destroy();
  }, [original, langExt]);

  return <div ref={hostRef} className="h-full overflow-auto text-[13px] cm-merge-host" />;
}
