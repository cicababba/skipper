// ============================================================
// NestBrain — Shared Types
// ============================================================

/** Supported raw source types */
export type SourceType =
  | "url"
  | "pdf"
  | "markdown"
  | "github"
  | "arxiv"
  | "rss"
  | "youtube";

/** YAML frontmatter for raw ingested sources */
export interface RawSourceMeta {
  id: string;
  title: string;
  sourceType: SourceType;
  sourceUrl?: string;
  filePath: string;
  ingestedAt: string;
  tags: string[];
  checksum: string;
}

/** YAML frontmatter for compiled wiki articles */
export interface WikiArticleMeta {
  id: string;
  title: string;
  created: string;
  updated: string;
  source?: string;
  type: "concept" | "source-summary" | "qa-output" | "lint-report";
  tags: string[];
  backlinks: string[];
  summary: string;
}

/** LLM provider configuration */
export type LLMProvider = "claude-cli" | "openai" | "ollama";

/** NestBrain configuration (nestbrain.yaml) */
export interface NestBrainConfig {
  wiki: {
    name: string;
    path: string;
    rawPath: string;
  };
  llm: {
    provider: LLMProvider;
    model: string;
    maxTurns: number;
    apiKey?: string;
  };
  embeddings: {
    model: string;
    chunkSize: number;
    chunkOverlap: number;
  };
  search: {
    semanticTopK: number;
    fulltextEnabled: boolean;
  };
  server: {
    port: number;
    host: string;
  };
}

/** Search result */
export interface SearchResult {
  articleId: string;
  title: string;
  snippet: string;
  score: number;
  filePath: string;
  /** Projects this article is attributed to (when available). */
  projects?: string[];
}

/** Q&A response */
export interface QAResponse {
  answer: string;
  citations: string[];
  savedTo?: string;
}

/** Lint finding */
export interface LintFinding {
  severity: "info" | "warning" | "error";
  category: "inconsistency" | "orphan" | "gap" | "missing-data";
  message: string;
  filePath?: string;
}

/** Compilation result */
export interface CompileResult {
  articlesCreated: number;
  articlesUpdated: number;
  conceptsExtracted: number;
  duration: number;
}

// ============================================================
// Auth
// ============================================================

/** Identity returned by Google's userinfo endpoint. */
export interface GoogleUser {
  sub: string;
  email: string;
  name?: string;
  picture?: string;
}

/** Auth state pushed from desktop main → renderer. */
export type AuthState =
  | { status: "signed-out" }
  | { status: "signing-in" }
  | { status: "signed-in"; user: GoogleUser }
  | { status: "error"; error: string }
  /** Source build with placeholder OAuth credentials — sign-in can't work;
   *  the UI shows a disabled control instead of a sign-in that would fail. */
  | { status: "unconfigured" };
