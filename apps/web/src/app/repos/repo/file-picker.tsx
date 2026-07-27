"use client";

import { useMemo, useState } from "react";
import { X } from "lucide-react";

const MAX_SUGGESTIONS = 20;

/**
 * Text input filtering `options` into a suggestion dropdown (#255). Single
 * pick via `onPick`; shared by the multi-select FilePicker (note linking) and
 * the single-select file filter in the memory browser. Paths stay verbatim —
 * they are repo-relative display strings, forward slashes on every platform.
 */
export function FileSuggestInput({
  options,
  exclude,
  onPick,
  placeholder,
  disabled,
  autoFocus,
}: {
  options: string[];
  exclude?: string[];
  onPick: (file: string) => void;
  placeholder: string;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const [query, setQuery] = useState("");

  const suggestions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return options
      .filter((f) => !exclude?.includes(f) && f.toLowerCase().includes(q))
      .slice(0, MAX_SUGGESTIONS);
  }, [options, exclude, query]);

  return (
    <div className="relative">
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        className="w-full bg-background border border-border rounded-md px-2.5 py-1.5 text-[12px] font-mono focus:border-accent focus:outline-none disabled:opacity-50"
      />
      {suggestions.length > 0 && (
        <ul className="absolute z-10 left-0 right-0 mt-1 max-h-48 overflow-y-auto rounded-md border border-border bg-card shadow-lg">
          {suggestions.map((file) => (
            <li key={file}>
              <button
                onClick={() => {
                  onPick(file);
                  setQuery("");
                }}
                className="w-full text-left px-2.5 py-1 text-[12px] font-mono text-muted hover:bg-card-hover hover:text-foreground transition-colors truncate"
              >
                {file}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Multi-select repo-file autocomplete for note linking (#255): picked files stack as removable chips. */
export function FilePicker({
  options,
  selected,
  onChange,
  placeholder,
  disabled,
}: {
  options: string[];
  selected: string[];
  onChange: (files: string[]) => void;
  placeholder: string;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((file) => (
            <span
              key={file}
              className="flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-card-hover/60 text-muted font-mono"
            >
              {file}
              <button
                onClick={() => onChange(selected.filter((f) => f !== file))}
                className="hover:text-foreground transition-colors"
                aria-label={`remove ${file}`}
              >
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      )}
      <FileSuggestInput
        options={options}
        exclude={selected}
        onPick={(file) => onChange([...selected, file])}
        placeholder={placeholder}
        disabled={disabled}
      />
    </div>
  );
}
