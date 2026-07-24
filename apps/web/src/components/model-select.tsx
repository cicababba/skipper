"use client";

import { useState } from "react";

// Claude model picker (#58, #123), shared by the global Orchestration section,
// the per-repo override rows, onboarding and the Settings page.
//
// Aliases only — the claude CLI resolves each to the newest release of that tier,
// so this list never needs version bumps. The manifest field is an opaque string
// though: a full model id (e.g. "claude-opus-4-8") is valid and must stay
// selectable. When the value isn't a known alias the select shows "Custom…" and a
// free-text input prefilled with it, so the id stays visible and is never silently
// overwritten. The input commits via onChange only on blur/Enter (per-repo
// consumers PATCH on every onChange); an empty commit reverts to the prior value.

const CUSTOM = "__custom__";

const MODEL_ALIASES = [
  { value: "opus", label: "Claude Opus" },
  { value: "sonnet", label: "Claude Sonnet" },
  { value: "haiku", label: "Claude Haiku" },
  { value: "fable", label: "Claude Fable" },
] as const;

function isAlias(value: string): boolean {
  return MODEL_ALIASES.some((m) => m.value === value);
}

export function ModelSelect({
  value,
  onChange,
  disabled,
  className,
}: {
  value: string;
  onChange: (model: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const [custom, setCustom] = useState(() => !isAlias(value));
  const [draft, setDraft] = useState(() => (isAlias(value) ? "" : value));

  // Resync when the incoming value changes (e.g. loaded async): an alias hides the
  // input, a full id opens Custom… prefilled. Adjusting state during render — the
  // endorsed alternative to an effect for deriving state from a prop.
  const [prevValue, setPrevValue] = useState(value);
  if (value !== prevValue) {
    setPrevValue(value);
    setCustom(!isAlias(value));
    setDraft(isAlias(value) ? "" : value);
  }

  function handleSelect(next: string) {
    if (next === CUSTOM) {
      setCustom(true);
      setDraft(isAlias(value) ? "" : value);
      return;
    }
    setCustom(false);
    setDraft("");
    onChange(next);
  }

  function commitDraft() {
    const trimmed = draft.trim();
    if (trimmed === "") {
      if (isAlias(value)) {
        setCustom(false);
        setDraft("");
      } else {
        setDraft(value);
      }
      return;
    }
    setDraft(trimmed);
    if (trimmed !== value) onChange(trimmed);
  }

  return (
    <>
      <select
        value={custom ? CUSTOM : value}
        disabled={disabled}
        onChange={(e) => handleSelect(e.target.value)}
        className={className}
      >
        {MODEL_ALIASES.map((m) => (
          <option key={m.value} value={m.value}>
            {m.label}
          </option>
        ))}
        <option value={CUSTOM}>Custom…</option>
      </select>
      {custom && (
        <input
          type="text"
          value={draft}
          disabled={disabled}
          placeholder="model id"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitDraft}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitDraft();
            }
          }}
          className={className}
        />
      )}
    </>
  );
}
