"use client";

import { useEffect, useRef, useState } from "react";
import { MergeView, unifiedMergeView } from "@codemirror/merge";
import { EditorView, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { EditorState, type Extension } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { loadLanguageFor } from "@/lib/codemirror-lang";

interface MergeEditorProps {
  filePath: string;
  original: string;
  modified: string;
  mode: "split" | "unified";
  onChange: (doc: string) => void;
}

// Worktree diff (#14/#114): HEAD vs worktree, worktree side editable. `split`
// is a side-by-side MergeView (HEAD read-only left, worktree right); `unified`
// is a single editable EditorView with inline HEAD chunks via unifiedMergeView.
// Mounted imperatively — @uiw/react-codemirror doesn't cover either. `docRef`
// preserves edits across the async language rebuild and split↔unified switches;
// `modified` only seeds the initial doc.
export function MergeEditor({ filePath, original, modified, mode, onChange }: MergeEditorProps) {
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
    const updateListener = EditorView.updateListener.of((u) => {
      if (u.docChanged) {
        const doc = u.state.doc.toString();
        docRef.current = doc;
        onChangeRef.current(doc);
      }
    });
    if (mode === "unified") {
      const view = new EditorView({
        parent: hostRef.current,
        doc: docRef.current,
        extensions: [...shared, unifiedMergeView({ original, mergeControls: false }), updateListener],
      });
      return () => view.destroy();
    }
    const view = new MergeView({
      parent: hostRef.current,
      a: {
        doc: original,
        extensions: [...shared, EditorState.readOnly.of(true), EditorView.editable.of(false)],
      },
      b: {
        doc: docRef.current,
        extensions: [...shared, updateListener],
      },
    });
    return () => view.destroy();
  }, [original, langExt, mode]);

  return <div ref={hostRef} className="h-full overflow-auto text-[13px] cm-merge-host" />;
}
