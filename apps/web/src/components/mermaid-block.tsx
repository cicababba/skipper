"use client";

import { useEffect, useRef, useState } from "react";
import { useTheme } from "@/lib/theme-context";
import { cssVar } from "@/lib/theme-colors";

export function MermaidBlock({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState("");
  const { theme } = useTheme();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: theme === "dark" ? "dark" : "neutral",
          darkMode: theme === "dark",
          themeVariables: {
            primaryColor: cssVar("--accent"),
            primaryTextColor: cssVar("--foreground"),
            lineColor: cssVar("--border"),
            secondaryColor: cssVar("--card-hover"),
            tertiaryColor: cssVar("--card"),
          },
        });
        const id = `mermaid-${Math.random().toString(36).slice(2, 8)}`;
        const { svg: rendered } = await mermaid.render(id, code);
        if (!cancelled) setSvg(rendered);
      } catch {
        if (!cancelled) setSvg(`<pre style="color:var(--danger);font-size:12px">Invalid mermaid diagram</pre>`);
      }
    })();
    return () => { cancelled = true; };
  }, [code, theme]);

  return (
    <div
      ref={ref}
      className="my-4 p-4 bg-code-bg border border-border/50 rounded-xl overflow-x-auto flex justify-center"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
