export type { LLMProviderInterface, LLMResponse } from "./llm";
export { createProvider, ClaudeCLIProvider } from "./llm";
export { PROMPTS } from "./llm";
export { OLLAMA_DEFAULT_HOST, ollamaHost } from "./llm";

export { VectorStore } from "./vectorstore";

export type {
  KnowledgeAtom,
  SourceRef,
  ExtractOptions,
  ExtractedCandidate,
  QueuePaths,
  PendingEntry,
  InstallHookOptions,
  HookStatus,
} from "./knowledge";
export {
  slugify,
  atomFilename,
  serializeAtom,
  parseAtom,
  extractFromCommit,
  readCommit,
  ensureQueueDirs,
  queuePaths,
  writePendingAtom,
  listPending,
  acceptAtom,
  rejectAtom,
  updatePendingAtom,
  installHook,
  uninstallHook,
  getHookStatus,
} from "./knowledge";

// GitHub adapter
export { pollGitHubAccount, GitHubApiError, GitHubAuthError, emptyGitHubCursor } from "./github";
export type {
  GitHubTokenProvider,
  GitHubEndpointCursor,
  GitHubAccountCursor,
  GitHubRateLimit,
  GitHubPollOptions,
  GitHubPollResult,
} from "./github";

// Planner (issue #7)
export { generatePlan, PlanGenerationError, IssuePlanSchema, planJsonSchema } from "./planner";
export type { GeneratePlanOptions, PlanIssueInput } from "./planner";

// Orchestrator (issue #6)
export {
  TRANSITIONS,
  TERMINAL_STATES,
  canTransition,
  admitItem,
  applyTransition,
  IllegalTransitionError,
  loadOrCreateOrchestratorManifest,
  saveOrchestratorManifest,
  reconcile,
} from "./orchestrator";
export type {
  OrchestratorManifest,
  AdmissionPolicy,
  ReconcileOutcome,
  ReconcilePoll,
} from "./orchestrator";

// Runtime loader that must be registered by the consumer app.
// The app uses createRequire + /* turbopackIgnore */ to load the package
// without Turbopack touching it (Turbopack's bundled externals break on
// ESM↔CJS interop for onnxruntime-common).
export { registerTransformersLoader } from "./vectorstore/embedder";
