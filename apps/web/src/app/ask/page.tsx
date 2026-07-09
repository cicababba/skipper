"use client";

import { useEffect, useState } from "react";
import { Send, Trash2 } from "lucide-react";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { ProjectFilter } from "@/components/project-filter";
import { useT } from "@/lib/app-i18n";

interface QAEntry {
  question: string;
  answer: string;
  citations: string[];
  savedTo?: string;
}

export default function AskPage() {
  const { t } = useT();
  const [question, setQuestion] = useState("");
  const [history, setHistory] = useState<QAEntry[]>([]);
  const [loading, setLoading] = useState(false);
  // Persist the user's last project pick across page reloads — they're
  // usually scoping to one thing for a few queries in a row.
  const [project, setProject] = useState<string | null>(() =>
    typeof window === "undefined" ? null : localStorage.getItem("nestbrain-ask-project"),
  );

  useEffect(() => {
    if (project) localStorage.setItem("nestbrain-ask-project", project);
    else localStorage.removeItem("nestbrain-ask-project");
  }, [project]);

  async function handleAsk(e: React.FormEvent) {
    e.preventDefault();
    if (!question.trim() || loading) return;

    const q = question;
    setQuestion("");
    setLoading(true);

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, project: project ?? undefined }),
      });
      const data = await res.json();

      if (data.error) {
        setHistory((prev) => [
          ...prev,
          { question: q, answer: t.searchask.ask.errorPrefix(data.error), citations: [] },
        ]);
      } else {
        // Auto-save to wiki outputs
        const saveRes = await fetch("/api/ask/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            question: q,
            answer: data.answer,
            citations: data.citations ?? [],
          }),
        });
        const saveData = await saveRes.json();

        setHistory((prev) => [
          ...prev,
          {
            question: q,
            answer: data.answer,
            citations: data.citations ?? [],
            savedTo: saveData.savedTo,
          },
        ]);
      }
    } catch {
      setHistory((prev) => [
        ...prev,
        { question: q, answer: t.searchask.ask.failed, citations: [] },
      ]);
    }
    setLoading(false);
  }

  // Save is now automatic — no manual save needed

  return (
    <div className="flex-1 flex flex-col">
      <div className="flex-1 overflow-auto p-8">
        <div className="max-w-3xl mx-auto space-y-8">
          {history.length === 0 && !loading && (
            <div className="flex-1 flex items-center justify-center pt-20">
              <div className="text-center text-muted">
                <div className="text-5xl mb-4">💬</div>
                <p className="text-sm">
                  {t.searchask.ask.emptyState}
                </p>
              </div>
            </div>
          )}

          {history.map((entry, i) => (
            <div key={i} className="space-y-4">
              {/* Question */}
              <div className="flex justify-end">
                <div className="bg-accent/10 border border-accent/20 rounded-xl px-4 py-3 max-w-lg">
                  <p className="text-sm">{entry.question}</p>
                </div>
              </div>

              {/* Answer */}
              <div className="bg-card border border-border rounded-xl p-6">
                <MarkdownRenderer content={entry.answer} />

                {entry.citations.length > 0 && (
                  <div className="mt-4 pt-3 border-t border-border">
                    <p className="text-xs text-muted mb-2">{t.searchask.ask.sources}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {entry.citations.map((c, j) => {
                        // Parse [[path|title]] format
                        const inner = c.replace(/^\[\[|\]\]$/g, "");
                        const parts = inner.split("|");
                        const path = parts[0].trim();
                        const title = (parts[1] ?? parts[0]).trim();
                        const filePath = path.endsWith(".md") ? path : `${path}.md`;
                        return (
                          <a
                            key={j}
                            href={`/wiki?path=${encodeURIComponent(filePath)}`}
                            className="text-xs px-2.5 py-1 rounded-full bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
                          >
                            {title}
                          </a>
                        );
                      })}
                    </div>
                  </div>
                )}

                {entry.savedTo && (
                  <div className="mt-3 flex items-center gap-3">
                    <a
                      href={`/wiki?path=${encodeURIComponent(entry.savedTo)}`}
                      className="text-xs text-accent/60 hover:text-accent transition-colors"
                    >
                      {t.searchask.ask.savedTo(entry.savedTo)}
                    </a>
                    <button
                      onClick={async () => {
                        await fetch("/api/wiki/delete", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ path: entry.savedTo }),
                        });
                        setHistory((prev) => prev.filter((_, idx) => idx !== i));
                      }}
                      className="text-xs text-red-400/50 hover:text-red-400 transition-colors flex items-center gap-1"
                    >
                      <Trash2 size={11} />
                      {t.searchask.ask.delete}
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}

          {loading && (
            <div className="bg-card border border-border rounded-xl p-6">
              <div>
                {/* Brain animation */}
                <div className="flex items-center gap-4">
                  <div className="relative w-10 h-10 flex items-center justify-center">
                    {/* Orbiting dots */}
                    <div className="absolute inset-0 animate-[spin_2s_linear_infinite]">
                      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-1.5 h-1.5 rounded-full bg-accent" />
                    </div>
                    <div className="absolute inset-0 animate-[spin_3s_linear_infinite_reverse]">
                      <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-purple-400" />
                    </div>
                    <div className="absolute inset-0 animate-[spin_2.5s_linear_infinite]">
                      <div className="absolute top-1/2 right-0 -translate-y-1/2 w-1 h-1 rounded-full bg-green-400" />
                    </div>
                    {/* Center glow */}
                    <div className="w-5 h-5 rounded-full bg-accent/20 flex items-center justify-center animate-pulse">
                      <div className="w-2.5 h-2.5 rounded-full bg-accent/60" />
                    </div>
                  </div>

                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-foreground/80">{t.searchask.ask.researching}</p>
                    </div>
                    {/* Animated progress bar */}
                    <div className="mt-2 h-0.5 w-full bg-border rounded-full overflow-hidden">
                      <div className="h-full bg-gradient-to-r from-accent via-purple-400 to-accent rounded-full animate-[shimmer_1.5s_ease-in-out_infinite] w-2/3" />
                    </div>
                  </div>
                </div>

                {/* Floating keywords */}
                <div className="mt-3 flex gap-2 overflow-hidden">
                  {t.searchask.ask.phases.map((text, i) => (
                    <span
                      key={text}
                      className="text-[10px] text-muted/40 px-2 py-0.5 rounded-full bg-border/30 animate-pulse"
                      style={{ animationDelay: `${i * 0.5}s` }}
                    >
                      {text}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Input */}
      <div className="border-t border-border p-4">
        <div className="max-w-3xl mx-auto">
          <div className="flex justify-end mb-2">
            <ProjectFilter value={project} onChange={setProject} />
          </div>
          <form onSubmit={handleAsk} className="flex items-center gap-3">
            <input
              type="text"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder={
                project
                  ? t.searchask.ask.placeholderProject(project)
                  : t.searchask.ask.placeholder
              }
              className="flex-1 px-4 py-3 bg-card border border-border rounded-xl text-sm text-foreground placeholder:text-muted/50 focus:outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20 transition-colors"
              disabled={loading}
              autoFocus
            />
            <button
              type="submit"
              disabled={loading || !question.trim()}
              className="p-3 bg-accent text-background rounded-xl hover:bg-accent-hover transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <Send size={16} />
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
