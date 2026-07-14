// Solutions memory — index + retrieval (#44). Public surface of the area;
// siblings are internals. Must never import @huggingface/transformers
// statically: the desktop orchestrator bundle inlines @skipper/core and the
// embedder stays behind registerTransformersLoader.

export {
  memoryFileName,
  writeSolutionRecord,
  readSolutionRecord,
  listSolutionRecords,
} from "./store";
export type { SolutionRecordEntry } from "./store";
export { buildEmbedText, indexSolutionRecord, reconcileMemoryIndex } from "./indexer";
export type { ReconcileResult } from "./indexer";
export { searchMemory } from "./search";
export type { MemoryHit, SearchMemoryOptions } from "./search";
export { recencyWeight, feedbackWeight } from "./ranking";
