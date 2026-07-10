import { describe, it, expect } from "vitest";
import { DEFAULT_LLM_CONFIG, EMBEDDINGS_CONFIG } from "../src/constants";

describe("constants", () => {
  it("DEFAULT_LLM_CONFIG has required fields", () => {
    expect(DEFAULT_LLM_CONFIG.provider).toBe("claude-cli");
    expect(DEFAULT_LLM_CONFIG.model).toBe("sonnet");
  });

  it("EMBEDDINGS_CONFIG pins the local model", () => {
    expect(EMBEDDINGS_CONFIG.model).toBe("Xenova/all-MiniLM-L6-v2");
  });
});
