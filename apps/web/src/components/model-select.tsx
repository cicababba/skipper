"use client";

import { useState } from "react";
import { DEFAULT_AGENT_RUNTIME, type AgentRuntimeId } from "@skipper/shared";
import { useT } from "@/lib/app-i18n";
import { isListedModel, modelOptionsFor } from "@/lib/agents/model-options";

// Model picker, shared by the agent pair rows, onboarding and the Settings page.
//
// The options come from the selected runtime (see lib/agents/model-options.ts):
// Claude aliases for claude-cli, the CLI's own default for the others. The
// manifest field is an opaque string though: a full model id (e.g.
// "claude-opus-4-8") is valid and must stay selectable. When the value isn't a
// listed option the select shows "Custom…" and a free-text input prefilled with
// it, so the id stays visible and is never silently overwritten. The input commits
// via onChange only on blur/Enter (per-repo consumers PATCH on every onChange); an
// empty commit reverts to the prior value.

const CUSTOM = "__custom__";

export function ModelSelect({
  value,
  onChange,
  runtime = DEFAULT_AGENT_RUNTIME,
  disabled,
  className,
}: {
  value: string;
  onChange: (model: string) => void;
  runtime?: AgentRuntimeId;
  disabled?: boolean;
  className?: string;
}) {
  const { t } = useT();
  const r = t.settings.orchestration;
  const listed = (v: string) => isListedModel(runtime, v);
  const [custom, setCustom] = useState(() => !listed(value));
  const [draft, setDraft] = useState(() => (listed(value) ? "" : value));

  // Resync when the incoming value or runtime changes (e.g. loaded async, or the
  // pair switched runtime): a listed option hides the input, anything else opens
  // Custom… prefilled. Adjusting state during render — the endorsed alternative to
  // an effect for deriving state from a prop.
  const [prev, setPrev] = useState({ value, runtime });
  if (value !== prev.value || runtime !== prev.runtime) {
    setPrev({ value, runtime });
    setCustom(!listed(value));
    setDraft(listed(value) ? "" : value);
  }

  function handleSelect(next: string) {
    if (next === CUSTOM) {
      setCustom(true);
      setDraft(listed(value) ? "" : value);
      return;
    }
    setCustom(false);
    setDraft("");
    onChange(next);
  }

  function commitDraft() {
    const trimmed = draft.trim();
    if (trimmed === "") {
      if (listed(value)) {
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
        {modelOptionsFor(runtime).map((m) => (
          <option key={m.value} value={m.value}>
            {r[m.labelKey]}
          </option>
        ))}
        <option value={CUSTOM}>{r.modelCustom}</option>
      </select>
      {custom && (
        <input
          type="text"
          value={draft}
          disabled={disabled}
          placeholder={r.modelCustomPlaceholder}
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
