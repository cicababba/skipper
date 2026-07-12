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

// Confidence (issue #8)
export {
  computeConfidence,
  scoreGroundedness,
  scoreConvergence,
  scoreClarity,
  runCritic,
  critiquePlan,
  buildCriticPrompt,
  resolveGate,
  CriticError,
  CriticVerdictSchema,
  DEFAULT_CONFIDENCE_WEIGHTS,
  DEFAULT_CONFIDENCE_THRESHOLDS,
  DIVERGENCE_THRESHOLD,
} from "./confidence";
export type { CriticInput, ComputeConfidenceOptions, GateTarget } from "./confidence";

// Coder (issue #9)
export {
  runCodingAgent,
  CodingAbortError,
  CODER_SYSTEM_PROMPT,
  buildCoderPrompt,
  buildResumePrompt,
  mapStreamLine,
  createStreamJsonParser,
} from "./coder";
export type { RunCodingAgentOptions, CodingRunResult, StreamJsonParser } from "./coder";

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
  DEFAULT_ORCHESTRATOR_SETTINGS,
  reconcile,
} from "./orchestrator";
export type {
  OrchestratorManifest,
  OrchestratorSettings,
  AdmissionPolicy,
  ReconcileOutcome,
  ReconcilePoll,
} from "./orchestrator";

// Runtime loader that must be registered by the consumer app.
// The app uses createRequire + /* turbopackIgnore */ to load the package
// without Turbopack touching it (Turbopack's bundled externals break on
// ESM↔CJS interop for onnxruntime-common).
export { registerTransformersLoader } from "./vectorstore/embedder";
