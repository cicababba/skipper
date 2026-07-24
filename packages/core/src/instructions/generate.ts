import type { AgentRuntime } from "../runtime/types";

// Agentic generation of a repo's agent-instructions doc (#227), used when the
// repo has no CLAUDE.md to seed from. Read-only exploration modeled on the
// planner: never modifies files, stays inside cwd, emits ONLY the document.

const DEFAULT_MAX_TURNS = 16;

export const INSTRUCTIONS_SYSTEM_PROMPT = `You are a senior software engineer documenting the conventions of the repository at your current working directory, so another AI agent can work in it correctly.

Operate ONLY inside your current working directory and never modify any files anywhere, including via Bash — even if you find absolute paths elsewhere on this machine. You are only writing documentation, not code.

Explore the repository with Read, Grep and Glob before writing. Every command, path and tool you mention MUST actually exist in the repository — never invent build/test/lint commands; read them from package.json scripts, Makefiles, CI config or similar. If you cannot verify something, leave it out.

Batch independent tool calls in ONE message instead of one per turn. Once you have learned enough to describe the repo's conventions accurately, stop exploring and emit the document.`;

/**
 * Prompt the agent to produce the conventions document. Concise markdown: tech
 * stack, real commands, code conventions, layout. The reply is the document
 * itself, nothing else.
 */
export function buildInstructionsPrompt(): string {
  return [
    `Write a concise markdown document describing how to work in this repository, for another AI coding agent that will plan and implement changes here.`,
    ``,
    `Cover, only where you can verify it from the repo:`,
    `- Tech stack (languages, frameworks, package manager, notable tooling).`,
    `- The REAL build, test and lint commands (read them from package.json scripts, Makefiles, CI config — never invent them).`,
    `- Code conventions the repo follows (module system, style, patterns, testing expectations).`,
    `- Repository layout: the main directories and what lives in each.`,
    ``,
    `Keep it under ~150 lines. Do not include secrets, tokens or credentials. Do not restate this instruction.`,
    ``,
    `Reply with ONLY the markdown document — no preamble, no code fences around the whole thing, no closing remarks.`,
  ].join("\n");
}

export interface GenerateRepoInstructionsOptions {
  /** Local checkout the agent explores (cwd). */
  repoPath: string;
  /** Agentic runtime that runs the exploration (#238); the caller gates on its
   *  existence (openai has none) before calling. */
  runtime: AgentRuntime;
  maxTurns?: number;
  /** Wall-clock budget for the run. */
  hardTimeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Generate the conventions document for a repo by letting the agent explore it.
 * Throws when the reply is empty, so the caller can land the doc as "failed" and
 * let planning proceed without it.
 */
export async function generateRepoInstructions(
  opts: GenerateRepoInstructionsOptions,
): Promise<string> {
  const reply = await opts.runtime.agent(buildInstructionsPrompt(), {
    systemPrompt: INSTRUCTIONS_SYSTEM_PROMPT,
    cwd: opts.repoPath,
    maxTurns: opts.maxTurns ?? DEFAULT_MAX_TURNS,
    ...(opts.hardTimeoutMs !== undefined ? { hardTimeoutMs: opts.hardTimeoutMs } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  const text = reply.text.trim();
  if (!text) throw new Error("repository conventions generation produced an empty document");
  return text;
}
