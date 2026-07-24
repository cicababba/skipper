export type { LLMProviderInterface, LLMResponse, AgentOptions } from "./llm";
export { createProvider, ClaudeCLIProvider, ClaudeCliError, AgentAbortError, isSalvageableDeath } from "./llm";
export { PROMPTS } from "./llm";
export { MEMORY_TOOLS, buildMemoryMcpArgs } from "./llm";
export type { MemoryMcp } from "./llm";
export {
  toClaudePathRoot,
  scopedWriteRules,
  buildConfinementSettingsArgs,
  confinementEnv,
} from "./llm";
export type { RunConfinement } from "./llm";
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

// Issue-source adapters (epic #68) — port + registry, GitHub adapter included
export {
  ApiError,
  AuthError,
  issueSources,
  issueSourceFor,
  issueSourceForAuthProvider,
  codeHosts,
  codeHostFor,
  codeHostForProvider,
  bitbucketCodeHost,
  githubIssueSource,
  githubCodeHost,
  pollGitHubAccount,
  emptyGitHubCursor,
  gitlabIssueSource,
  pollGitLabAccount,
  emptyGitLabCursor,
  listUserInstallationRepos,
  listMembershipProjects,
  listJiraProjects,
  jiraGet,
  jiraApiBase,
} from "./adapters";
export type { IssueComment, IssueSource, PollOptions, PollResult, RateLimit, TokenProvider } from "./adapters";
export type {
  CodeHost,
  CreatePrParams,
  CreatedPr,
  PrReviews,
  FailingCheck,
  PushCredentials,
  InstallationRepo,
  InstallationsResult,
} from "./adapters";
export type {
  GitHubTokenProvider,
  GitHubEndpointCursor,
  GitHubAccountCursor,
  GitHubRateLimit,
  GitHubPollOptions,
  GitHubPollResult,
} from "./adapters";
export type {
  GitLabTokenProvider,
  GitLabStreamCursor,
  GitLabAccountCursor,
  GitLabRateLimit,
  GitLabPollOptions,
  GitLabPollResult,
} from "./adapters";
export type { JiraTokenProvider, JiraTarget } from "./adapters";

// Planner (issue #7)
export {
  generatePlan,
  validatePlanReply,
  PlanGenerationError,
  IssuePlanSchema,
  planJsonSchema,
  PLAN_CHAT_SYSTEM_PROMPT,
  discussPlan,
  applyPlanFromDiscussion,
} from "./planner";
export type {
  GeneratePlanOptions,
  PlanIssueInput,
  DiscussPlanOptions,
  ApplyPlanFromDiscussionOptions,
} from "./planner";

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
  CriticContinuityVerdictSchema,
  DEFAULT_CONFIDENCE_WEIGHTS,
  DEFAULT_CONFIDENCE_THRESHOLDS,
  DIVERGENCE_THRESHOLD,
} from "./confidence";
export type { CriticInput, CriticPriorRound, ComputeConfidenceOptions, GateTarget } from "./confidence";

// Coder (issue #9)
export {
  runCodingAgent,
  CodingAbortError,
  CodingTimeoutError,
  CODER_SYSTEM_PROMPT,
  buildCoderPrompt,
  buildResumePrompt,
  buildCoderSalvagePrompt,
  buildFixPrompt,
  buildPrFixPrompt,
  CoderReportSchema,
  coderReportJsonSchema,
  tryParseCoderReport,
  repairCoderReport,
  reportContractBlock,
  CoderReportParseError,
  mapStreamLine,
  createStreamJsonParser,
} from "./coder";
export type { RunCodingAgentOptions, CodingRunResult, StreamJsonParser } from "./coder";
export {
  CODER_CHAT_SYSTEM_PROMPT,
  discussCoder,
  distillCoderChatInstructions,
  renderCoderReportBlock,
  renderReviewBlock,
} from "./coder";
export type {
  CoderChatContext,
  CoderChatInstruction,
  CoderChatReviewInfo,
  DiscussCoderOptions,
  DistillCoderChatOptions,
} from "./coder";

// Agent chat — generic discussion dispatch shared by coder/reviewer chats (#170)
export { runAgentDiscussion, DEFAULT_AGENT_CHAT_MAX_TURNS, AGENT_CHAT_HARD_TIMEOUT_MS } from "./agent-chat";
export type { RunAgentDiscussionOptions } from "./agent-chat";

// Shepherd (issue #11)
export { buildCommitMessage, buildPrTitle, buildPrBody } from "./shepherd";

// Solutions memory — index + retrieval (issue #44)
export {
  memoryFileName,
  writeSolutionRecord,
  readSolutionRecord,
  listSolutionRecords,
  deleteSolutionRecord,
  buildEmbedText,
  indexSolutionRecord,
  reconcileMemoryIndex,
  searchMemory,
  recencyWeight,
  feedbackWeight,
  applyFeedbackVote,
} from "./memory";
export type { SolutionRecordEntry, ReconcileResult, MemoryHit, SearchMemoryOptions } from "./memory";

// Reviewer (issue #10)
export {
  critiqueDiff,
  truncateDiff,
  resolveReviewMode,
  DIFF_CHAR_BUDGET,
  AUTO_MAX_CHANGED_LINES,
  AUTO_MAX_FILES,
  RISKY_FILE_PATTERNS,
} from "./reviewer";
export type { CritiqueDiffArgs, ReviewMode, DiffStats, ReviewModeInput } from "./reviewer";
export { REVIEWER_CHAT_SYSTEM_PROMPT, discussReviewer } from "./reviewer";
export type { ReviewerChatContext, DiscussReviewerOptions } from "./reviewer";

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
  remapProjectItems,
  resolveProjectRepos,
  compareQueueCandidates,
} from "./orchestrator";
export type {
  OrchestratorManifest,
  OrchestratorSettings,
  AdmissionPolicy,
  ReconcileOutcome,
  ReconcilePoll,
  RemapProjectItemsResult,
  ResolveProjectReposResult,
  QueueCandidate,
} from "./orchestrator";

// Runtime loader that must be registered by the consumer app.
// The app uses createRequire + /* turbopackIgnore */ to load the package
// without Turbopack touching it (Turbopack's bundled externals break on
// ESM↔CJS interop for onnxruntime-common).
export { registerTransformersLoader } from "./vectorstore/embedder";
