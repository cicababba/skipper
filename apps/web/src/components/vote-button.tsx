"use client";

/** 👍/👎 toggle shared by the "memories used" card (#46) and memory curation (#255). */
export function VoteButton({
  active,
  disabled,
  label,
  count,
  onClick,
  children,
}: {
  active: boolean;
  disabled: boolean;
  label: string;
  /** Aggregate tally rendered inside the button (memory curation, #255). */
  count?: number;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      title={label}
      aria-label={label}
      className={`flex items-center gap-1 p-1 rounded transition-colors disabled:opacity-40 ${
        active ? "text-accent bg-accent/10" : "text-muted hover:text-foreground"
      }`}
    >
      {children}
      {count !== undefined && <span className="text-[11px]">{count}</span>}
    </button>
  );
}
