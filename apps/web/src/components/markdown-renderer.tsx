"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ExternalLink } from "lucide-react";
import { MermaidBlock } from "./mermaid-block";

interface MarkdownRendererProps {
  content: string;
  meta?: Record<string, string>;
}

export function MarkdownRenderer({ content, meta }: MarkdownRendererProps) {
  const body = stripFrontmatter(content);

  return (
    <div>
      {meta && (
        <div className="mb-8 pb-6 border-b border-border/50">
          {meta.type && (
            <span className={`inline-block px-2.5 py-0.5 rounded-full text-[10px] font-medium uppercase tracking-wider mb-3 ${
              meta.type === "concept"
                ? "bg-accent/10 text-accent"
                : meta.type === "source-summary"
                  ? "bg-purple-500/10 text-purple-400"
                  : "bg-green-500/10 text-green-400"
            }`}>
              {meta.type.replace("-", " ")}
            </span>
          )}
          {meta.tags && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {meta.tags
                .replace(/[\[\]"]/g, "")
                .split(",")
                .map((tag: string) => tag.trim())
                .filter(Boolean)
                .map((tag: string) => (
                  <span
                    key={tag}
                    className="px-2 py-0.5 rounded-md bg-card border border-border text-[11px] text-muted"
                  >
                    {tag}
                  </span>
                ))}
            </div>
          )}
          {meta.updated && (
            <p className="text-[11px] text-muted/50 mt-3">
              Last updated {meta.updated}
            </p>
          )}
        </div>
      )}

      <article className="
        [&>h1]:text-[1.75rem] [&>h1]:font-bold [&>h1]:tracking-tight [&>h1]:mb-4 [&>h1]:text-foreground
        [&>h2]:text-xl [&>h2]:font-semibold [&>h2]:tracking-tight [&>h2]:mt-10 [&>h2]:mb-4 [&>h2]:text-foreground
        [&>h2]:pb-2 [&>h2]:border-b [&>h2]:border-border/30
        [&>h3]:text-base [&>h3]:font-semibold [&>h3]:mt-8 [&>h3]:mb-3 [&>h3]:text-foreground
        [&>p]:text-[15px] [&>p]:leading-[1.8] [&>p]:text-foreground/85 [&>p]:mb-4
        [&>ul]:my-3 [&>ul]:pl-5 [&>ol]:my-3 [&>ol]:pl-5
        [&_li]:text-[15px] [&_li]:leading-[1.8] [&_li]:text-foreground/85 [&_li]:mb-1
        [&_li]:marker:text-accent/40
        [&>blockquote]:my-4 [&>blockquote]:pl-4 [&>blockquote]:border-l-2 [&>blockquote]:border-accent/40
        [&>blockquote]:text-muted [&>blockquote]:italic
        [&_code]:text-accent [&_code]:bg-accent/[0.06] [&_code]:px-1.5 [&_code]:py-0.5
        [&_code]:rounded [&_code]:text-[13px] [&_code]:font-mono
        [&>pre]:my-4 [&>pre]:p-4 [&>pre]:bg-[#0c0c0e] [&>pre]:border [&>pre]:border-border/50
        [&>pre]:rounded-xl [&>pre]:overflow-x-auto
        [&>pre_code]:bg-transparent [&>pre_code]:p-0 [&>pre_code]:text-foreground/80
        [&>hr]:my-8 [&>hr]:border-border/30
        [&_strong]:text-foreground [&_strong]:font-semibold
        [&_table]:w-full [&_table]:my-4 [&_table]:text-sm
        [&_th]:text-left [&_th]:text-foreground/70 [&_th]:font-medium [&_th]:pb-2 [&_th]:border-b [&_th]:border-border
        [&_td]:py-2 [&_td]:pr-4 [&_td]:text-foreground/80 [&_td]:border-b [&_td]:border-border/30
      ">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ href, children }) => {
              return (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-baseline gap-1 text-accent hover:text-accent-hover transition-colors"
                >
                  <span className="border-b border-accent/20 hover:border-accent/60 transition-colors">
                    {children}
                  </span>
                  <ExternalLink size={11} className="opacity-40" />
                </a>
              );
            },
            code: ({ className, children }) => {
              const match = /language-(\w+)/.exec(className ?? "");
              const lang = match?.[1];
              const code = String(children).replace(/\n$/, "");

              if (lang === "mermaid") {
                return <MermaidBlock code={code} />;
              }

              if (lang) {
                return (
                  <pre className="my-4 p-4 bg-[#0c0c0e] border border-border/50 rounded-xl overflow-x-auto">
                    <code className={className}>{children}</code>
                  </pre>
                );
              }

              return (
                <code className="text-accent bg-accent/[0.06] px-1.5 py-0.5 rounded text-[13px] font-mono">
                  {children}
                </code>
              );
            },
            pre: ({ children }) => <>{children}</>,
          }}
        >
          {body}
        </ReactMarkdown>
      </article>
    </div>
  );
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---[\s\S]*?---\n*/, "");
}
