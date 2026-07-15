"use client";

// Per-role model picker (#58), shared by the global Orchestration section and the
// per-repo override rows.
//
// Aliases only — the claude CLI resolves each to the newest release of that tier,
// so this list never needs version bumps. The manifest field is an opaque string
// though: a hand-edited full model id (e.g. "claude-opus-4-8") is valid and must
// stay selectable, or the select would render blank and the next change would
// silently overwrite it.

const MODEL_ALIASES = [
  { value: "opus", label: "Claude Opus" },
  { value: "sonnet", label: "Claude Sonnet" },
  { value: "haiku", label: "Claude Haiku" },
] as const;

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
  const known = MODEL_ALIASES.some((m) => m.value === value);
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className={className}
    >
      {MODEL_ALIASES.map((m) => (
        <option key={m.value} value={m.value}>
          {m.label}
        </option>
      ))}
      {!known && <option value={value}>{value}</option>}
    </select>
  );
}
