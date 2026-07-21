import { describe, it, expect } from "vitest";
import { parseJsonReply } from "../src/llm/json";

describe("parseJsonReply", () => {
  it("parses a clean reply", () => {
    expect(parseJsonReply('{"a":1}')).toEqual({ a: 1 });
  });

  it("unwraps a fenced block", () => {
    expect(parseJsonReply('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("unwraps a fence surrounded by prose on both sides", () => {
    const reply = 'Here is the plan:\n\n```json\n{"a":1}\n```\n\nLet me know if you want changes.';
    expect(parseJsonReply(reply)).toEqual({ a: 1 });
  });

  it("prefers the last fence when the model narrates with examples first", () => {
    const reply = '```json\n{"draft":true}\n```\nOn reflection, the real plan:\n```json\n{"draft":false}\n```';
    expect(parseJsonReply(reply)).toEqual({ draft: false });
  });

  it("handles braces inside string values", () => {
    const reply = 'Plan:\n{"summary":"replace the { placeholder } in the template","n":1}';
    expect(parseJsonReply(reply)).toEqual({
      summary: "replace the { placeholder } in the template",
      n: 1,
    });
  });

  it("handles an escaped quote followed by a brace", () => {
    const reply = '{"summary":"the \\"}\\" token closes it","n":1}';
    expect(parseJsonReply(reply)).toEqual({ summary: 'the "}" token closes it', n: 1 });
  });

  it("strips trailing commas in objects and arrays", () => {
    expect(parseJsonReply('{"a":[1,2,],"b":{"c":1,},}')).toEqual({ a: [1, 2], b: { c: 1 } });
  });

  it("does not strip a comma inside a string", () => {
    expect(parseJsonReply('{"a":"one, two ,]","b":1,}')).toEqual({ a: "one, two ,]", b: 1 });
  });

  it("extracts a top-level array", () => {
    expect(parseJsonReply('Sure:\n[{"a":1}]\nDone.')).toEqual([{ a: 1 }]);
  });

  it("throws when there is no JSON at all", () => {
    expect(() => parseJsonReply("I could not produce a plan.")).toThrow(
      /No parseable JSON in model reply/,
    );
  });

  it("throws when the JSON is truncated beyond deterministic repair", () => {
    expect(() => parseJsonReply('{"a":1,"b":')).toThrow(/No parseable JSON in model reply/);
  });

  it("unwraps an unlabeled fence", () => {
    expect(parseJsonReply('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("falls through to the balanced scan when the fence body is not JSON", () => {
    const reply = "```\nnot json here\n```\nThe plan is: {\"a\":1} trailing chatter";
    expect(parseJsonReply(reply)).toEqual({ a: 1 });
  });

  it("balanced scan starts at the first opener and ignores openers inside strings", () => {
    const reply = 'noise {"path":"a[0].b","n":2} more {"ignored":true}';
    expect(parseJsonReply(reply)).toEqual({ path: "a[0].b", n: 2 });
  });
});
