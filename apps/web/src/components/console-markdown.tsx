"use client";

import type { ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Compact markdown for the agent event console (#113): tight spacing, no
// mermaid/wikilinks/frontmatter — just the prose an agent streams in a run.
export function ConsoleMarkdown({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <p className="my-1 first:mt-0 last:mb-0">{children}</p>,
        ul: ({ children }) => <ul className="my-1 pl-4 list-disc space-y-0.5">{children}</ul>,
        ol: ({ children }) => <ol className="my-1 pl-4 list-decimal space-y-0.5">{children}</ol>,
        li: ({ children }) => <li>{children}</li>,
        h1: ({ children }) => <p className="my-1 font-semibold text-foreground">{children}</p>,
        h2: ({ children }) => <p className="my-1 font-semibold text-foreground">{children}</p>,
        h3: ({ children }) => <p className="my-1 font-semibold text-foreground">{children}</p>,
        h4: ({ children }) => <p className="my-1 font-semibold text-foreground">{children}</p>,
        h5: ({ children }) => <p className="my-1 font-semibold text-foreground">{children}</p>,
        h6: ({ children }) => <p className="my-1 font-semibold text-foreground">{children}</p>,
        a: ({ href, children }) => (
          <a
            href={href}
            onClick={(e) => {
              e.preventDefault();
              if (href) void window.skipper?.openExternal(href);
            }}
            className="text-accent underline hover:no-underline"
          >
            {children}
          </a>
        ),
        code: ({ className, children, ...props }: ComponentPropsWithoutRef<"code">) => {
          const inline = !className?.includes("language-");
          if (inline) {
            return (
              <code className="rounded bg-card-hover px-1 py-0.5 text-[11px]" {...props}>
                {children}
              </code>
            );
          }
          return <code className={className}>{children}</code>;
        },
        pre: ({ children }) => (
          <pre className="my-1 max-h-64 overflow-auto rounded bg-card-hover p-2 text-[11px]">
            {children}
          </pre>
        ),
        blockquote: ({ children }) => (
          <blockquote className="my-1 border-l-2 border-border pl-2 text-muted">{children}</blockquote>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
