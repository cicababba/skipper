export type { LLMProviderInterface, LLMResponse, AgentOptions } from "./llm";
export {
  createProvider,
  ClaudeCLIProvider,
  ClaudeCliError,
  AgentAbortError,
  isSalvageableDeath,
  salvageableDeathSubtype,
} from "./llm";
export type { SalvageableDeathSubtype } from "./llm";
export { PROMPTS } from "./llm";
export { MEMORY_TOOLS, buildMemoryMcpArgs } from "./llm";
export type { MemoryMcp } from "./llm";
export { GRAPHIFY_TOOLS, renderGraphifySection, graphifyServerConfig, buildMcpConfigArgs } from "./llm";
export type { GraphifyMcp, GraphifyContext } from "./llm";
export {
  toClaudePathRoot,
  scopedWriteRules,
  writeApprovalRules,
  buildConfinementSettingsArgs,
  confinementEnv,
} from "./llm";
export type { RunConfinement } from "./llm";
export type { ClaudeStructuredOptions } from "./llm";

// Agent runtime seam (#238) — the capability-gated home of every agentic path.
export {
  createRuntime,
  ClaudeCliRuntime,
  CLAUDE_CLI_CAPABILITIES,
  CodexCliRuntime,
  CODEX_CLI_CAPABILITIES,
  CopilotCliRuntime,
  COPILOT_CLI_CAPABILITIES,
  GeminiCliRuntime,
  GEMINI_CLI_CAPABILITIES,
  RUNTIME_CAPABILITIES,
  structuredCall,
} from "./runtime";
export type { AgentRuntime, RuntimeCapabilities, RuntimeStructuredOptions } from "./runtime";

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
  openprojectIssueSource,
  pollOpenProjectAccount,
  listOpenProjectProjects,
  openprojectGet,
  openprojectApiBase,
  emptyOpenProjectCursor,
} from "./adapters";
export type {
  CreateIssueParams,
  IssueComment,
  IssueSource,
  PollOptions,
  PollResult,
  RateLimit,
  TokenProvider,
} from "./adapters";
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
export type {
  OpenProjectTokenProvider,
  OpenProjectStreamCursor,
  OpenProjectAccountCursor,
  OpenProjectPollOptions,
  OpenProjectPollResult,
} from "./adapters";

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
  PlanDependency,
  PlanIssueInput,
  DiscussPlanOptions,
  ApplyPlanFromDiscussionOptions,
} from "./planner";

// Repo agent instructions (issue #227)
export {
  REPO_CONVENTIONS_CHAR_BUDGET,
  renderRepoConventions,
  withRepoConventions,
  INSTRUCTIONS_SYSTEM_PROMPT,
  buildInstructionsPrompt,
  generateRepoInstructions,
} from "./instructions";
export type { GenerateRepoInstructionsOptions } from "./instructions";

// Confidence (issue #8)
export {
  computeConfidence,
  scoreGroundedness,
  scoreConvergence,
  deriveConvergenceScore,
  scoreClarity,
  buildClarityPrompt,
  deriveClarityScore,
  runCritic,
  critiquePlan,
  buildCriticPrompt,
  deriveCriticScore,
  PLAN_CRITIC_MAX_TURNS,
  resolveGate,
  ClarityError,
  ClarityJudgmentSchema,
  CriticError,
  CriticVerdictSchema,
  CriticContinuityVerdictSchema,
  DEFAULT_CONFIDENCE_WEIGHTS,
  DEFAULT_CONFIDENCE_THRESHOLDS,
  DIVERGENCE_THRESHOLD,
  GROUNDEDNESS_VETO,
} from "./confidence";
export type {
  ClarityJudgment,
  CriticInput,
  CriticPriorRound,
  RunCriticOptions,
  ComputeConfidenceOptions,
  GateTarget,
} from "./confidence";

// Threshold calibration harness (issue #314)
export {
  planDigest,
  replayScores,
  compositeOf,
  buildCalibrationRows,
  sweepThresholds,
  defaultThresholdGrid,
  renderCalibrationReport,
  porcelainPaths,
  worktreeDirtyError,
  missingSignals,
  findIncompleteSamples,
  renderIncompleteWarning,
  resolvePlannerPair,
  overridePlannerPair,
  summarizePlannerPairs,
  renderPlannerPairBanner,
} from "./confidence";
export type {
  CalibrationLabel,
  IncompleteSample,
  CalibrationMeta,
  CalibrationPlanDigest,
  CalibrationRow,
  CalibrationSample,
  CalibrationScores,
  CalibrationSignalKey,
  CalibrationTimings,
  PlannerPair,
  PlannerPairGroup,
  PlannerPairInputs,
  PlannerPairRung,
  PlannerPairSources,
  PlannerPairSummary,
  ReplayOptions,
  ReplayResult,
  SweepOptions,
  SweepResult,
  ThresholdCandidate,
  ThresholdSweep,
} from "./confidence";

// Coder (issue #9)
export {
  runCodingAgent,
  CodingAbortError,
  CodingTimeoutError,
  CODER_SYSTEM_PROMPT,
  buildCoderPrompt,
  buildCoderRecapPrompt,
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
export type {
  RunCodingAgentOptions,
  CodingRunResult,
  CoderRecapInput,
  StreamJsonParser,
} from "./coder";
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

// Composer (issue #136)
export {
  composerDraftSchema,
  COMPOSER_DRAFT_JSON_SCHEMA,
  validateComposerDraft,
  COMPOSER_SYSTEM_PROMPT,
  buildComposerSystemPrompt,
  buildComposerFallbackPrompt,
  buildComposerResumePrompt,
  renderDraftBlock,
  discussComposer,
  distillComposerDraft,
} from "./composer";
export type {
  ComposerChatContext,
  DiscussComposerOptions,
  DistillComposerDraftOptions,
} from "./composer";

// Agent chat — generic discussion dispatch shared by coder/reviewer chats (#170)
export { runAgentDiscussion, DEFAULT_AGENT_CHAT_MAX_TURNS, AGENT_CHAT_HARD_TIMEOUT_MS } from "./agent-chat";
export type { RunAgentDiscussionOptions } from "./agent-chat";

// Shepherd (issue #11)
export { buildCommitMessage, buildPrTitle, buildPrBody, buildIssueLink } from "./shepherd";
export type { IssueLinkItem } from "./shepherd";

// Solutions memory — index + retrieval (issue #44)
export {
  memoryFileName,
  writeSolutionRecord,
  readSolutionRecord,
  listSolutionRecords,
  deleteSolutionRecord,
  buildEmbedText,
  indexSolutionRecord,
  indexOneRecord,
  reconcileMemoryIndex,
  createNoteRecord,
  searchMemory,
  recencyWeight,
  feedbackWeight,
  stalenessWeight,
  applyFeedbackVote,
  applyOffered,
  applyFetched,
  bumpOffered,
  bumpFetched,
  recordFilesTouched,
  stalenessFraction,
  DISTILL_DIFF_BUDGET,
  DISTILL_REVIEW_BUDGET,
  LESSON_SCHEMA,
  buildDistillPrompt,
  formatLesson,
  distillLesson,
} from "./memory";
export type {
  SolutionRecordEntry,
  ReconcileResult,
  MemoryHit,
  SearchMemoryOptions,
  DistillInput,
  Lesson,
} from "./memory";

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
