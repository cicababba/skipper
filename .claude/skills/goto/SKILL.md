---
name: goto
description: Locate a feature/file in the monorepo and jump straight to it — open at the exact line in VS Code (default) or reveal it in the OS file manager (-o). Also opens the whole repo. Use when the user asks "where is X", "open X", or wants to reveal a file in Finder/Explorer.
---

# Go to code — VS Code (default) or file manager (`-o`)

Locates code by feature/file/symbol and opens it: by default it jumps the VS Code
cursor to the exact line (reusing the existing window); with `-o` it reveals the file
in the OS file manager instead. With no target it opens the whole monorepo.

`code` is on PATH on every platform (macOS, WSL, Windows, Linux) and needs no OS branching.
Only the `-o` reveal path is OS-specific — resolve it with the helper in step 3.

## Flags

Parse these from the invocation args (they are consumed by this skill, never passed to `code`/`open`):

- `--dry` / `-d` — **dry run**: report the path(s) you found, run nothing. Wins over every other flag.
- `-o` / `--reveal` — **reveal in the OS file manager** instead of opening in VS Code. On a located file this selects it; with no target it opens the repo folder.

## Instructions

### 1. Resolve the repo root

Always target the monorepo root, regardless of the current package:

```bash
ROOT=$(git rev-parse --show-toplevel)
```

### 2. Decide the intent

**A. Bare open** — args are empty (or just flags): act on the whole project.

```bash
code -r "$ROOT"          # default: open in VS Code, reuse the current window
reveal_dir "$ROOT"       # with -o: open the repo folder in the file manager (helper below)
```

`-r` reuses the current window (never spawn a second window on the same repo). In `--dry` mode, print `$ROOT` instead of running anything.

**B. Locate a target** — args name a feature, file, symbol, or area ("where is the PTY spawn", "open the git backend", "knowledge queue").

1. Map the request to a package using the monorepo layout (see CLAUDE.md):
   - `desktop` (Electron main, preload, IPC, auth, sync wiring, packaging) → `apps/desktop/`
   - `web` (UI, components, editor, terminal UI) → `apps/web/`
   - `core` (llm, vectorstore, knowledge) → `packages/core/`
   - `cli` → `packages/cli/` · `shared` → `packages/shared/` · `sync` → `packages/sync/`
   - workspace template → `skeleton/` · CI/build → `.github/` + `apps/desktop/build/`
2. Find the file(s) with Glob/Grep, scoped to the likely package(s). Prefer the definition/implementation over test files and barrels unless the user asked for those.
3. Identify the most relevant line (the symbol definition, route handler, component, etc.).

### 3. Open or report

- **Unambiguous single hit** → act on it in the selected mode:
  ```bash
  code -g "$FILE:$LINE"   # default: open at line, reusing the window
  reveal "$FILE"          # with -o: reveal + select the file in the OS file manager
  ```
  (`-g`/`--goto` opens at line. Omit `:$LINE` if there's no meaningful line. A file-manager reveal has no line concept — it just selects the file.)

- **Multiple plausible matches** → do NOT guess. List the top 2–3 candidates as `path:line` with a one-line description each, and ask which to open. Act on the chosen one in the selected mode (`code -g` or `reveal`).

- **`--dry` set** → skip `code`/`reveal` entirely; just report the resolved `path:line` candidate(s).

- **No match** → say so and suggest the closest package/directory to explore rather than opening something wrong.

### OS-agnostic reveal helper

For any `-o` reveal, define and use these helpers. They branch on `uname -s`, convert
paths for Windows Explorer (`wslpath`/`cygpath`), and tolerate `explorer.exe`'s non-zero
exit on success (`|| true`):

```bash
reveal() {  # select FILE in the OS file manager
  local f="$1"
  case "$(uname -s)" in
    Darwin) open -R "$f" ;;
    Linux)
      if grep -qiE microsoft /proc/version 2>/dev/null; then
        explorer.exe /select,"$(wslpath -w "$f")" || true            # WSL → Windows Explorer
      else
        xdg-open "$(dirname "$f")" >/dev/null 2>&1 || true           # plain Linux: opens folder (no reliable select)
      fi ;;
    MINGW*|MSYS*|CYGWIN*)
      explorer.exe /select,"$(cygpath -w "$f")" || true ;;           # Git Bash / native Windows
    *) echo "reveal: unsupported OS $(uname -s) — path: $f" ;;
  esac
}

reveal_dir() {  # open a DIRECTORY in the OS file manager
  local d="$1"
  case "$(uname -s)" in
    Darwin) open "$d" ;;
    Linux)
      if grep -qiE microsoft /proc/version 2>/dev/null; then
        explorer.exe "$(wslpath -w "$d")" || true
      else
        xdg-open "$d" >/dev/null 2>&1 || true
      fi ;;
    MINGW*|MSYS*|CYGWIN*)
      explorer.exe "$(cygpath -w "$d")" || true ;;
    *) echo "reveal_dir: unsupported OS $(uname -s) — path: $d" ;;
  esac
}
```

## Notes

- Never pass `-n` (new window) — the VS Code path always reuses the current window.
- Keep output tight: for a jump, one line naming what you opened (`opened apps/desktop/src/main.ts:142`); for a reveal, one line (`revealed packages/sync/src/engine.ts`); for candidates, a short list.
- On plain (non-WSL) Linux, file managers vary — the helper opens the containing folder via `xdg-open` rather than guessing a `--select`-capable manager. If the user names theirs (nautilus/dolphin/nemo), prefer its native `--select`.
