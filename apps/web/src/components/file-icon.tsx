"use client";

import {
  FileText,
  FileCode2,
  FileType2,
  FileImage,
  FileVideo,
  FileAudio,
  FileArchive,
  FileSpreadsheet,
  Settings,
  Terminal,
  Lock,
  Database,
  Hash,
  Braces,
  Container,
  Package,
  GitBranch,
  BookOpen,
} from "lucide-react";

interface FileIconProps {
  name: string;
  isDirectory?: boolean;
  size?: number;
  className?: string;
}

interface IconSpec {
  Icon: typeof FileText;
  color: string;
}

/**
 * Pick an icon + tint for a filename based on its extension or a known
 * special filename. Resolution order:
 *   1. Exact filename match (Dockerfile, .gitignore, …) — case-insensitive.
 *   2. Extension match.
 *   3. Generic file fallback.
 *
 * Colors are intentionally tints of the app's accent palette (not the
 * loud ones VSCode uses) so the tree stays calm. Common-language colors
 * (TS blue, Python yellow/blue, Go cyan) are preserved as a hint.
 */
function pickIcon(filename: string): IconSpec {
  const lower = filename.toLowerCase();

  // Exact filename matches — high specificity, win first.
  const exact: Record<string, IconSpec> = {
    "dockerfile": { Icon: Container, color: "text-sky-400" },
    "docker-compose.yml": { Icon: Container, color: "text-sky-400" },
    "docker-compose.yaml": { Icon: Container, color: "text-sky-400" },
    ".dockerignore": { Icon: Container, color: "text-sky-400/60" },
    ".gitignore": { Icon: GitBranch, color: "text-orange-400/70" },
    ".gitattributes": { Icon: GitBranch, color: "text-orange-400/70" },
    "readme.md": { Icon: BookOpen, color: "text-blue-300" },
    "readme": { Icon: BookOpen, color: "text-blue-300" },
    "license": { Icon: Lock, color: "text-amber-300/80" },
    "license.md": { Icon: Lock, color: "text-amber-300/80" },
    "license.txt": { Icon: Lock, color: "text-amber-300/80" },
    "package.json": { Icon: Package, color: "text-red-400" },
    "package-lock.json": { Icon: Package, color: "text-red-400/50" },
    "pnpm-lock.yaml": { Icon: Package, color: "text-amber-400/70" },
    "pnpm-workspace.yaml": { Icon: Package, color: "text-amber-400" },
    "yarn.lock": { Icon: Package, color: "text-blue-400/60" },
    "tsconfig.json": { Icon: Settings, color: "text-blue-400" },
    "tsconfig.base.json": { Icon: Settings, color: "text-blue-400" },
    "turbo.json": { Icon: Settings, color: "text-purple-400" },
    "next.config.ts": { Icon: Settings, color: "text-foreground/70" },
    "next.config.js": { Icon: Settings, color: "text-foreground/70" },
    "claude.md": { Icon: BookOpen, color: "text-accent" },
    "skill.md": { Icon: BookOpen, color: "text-accent/80" },
    ".env": { Icon: Lock, color: "text-yellow-300/80" },
    ".env.local": { Icon: Lock, color: "text-yellow-300/80" },
    "makefile": { Icon: Settings, color: "text-rose-400" },
  };
  if (exact[lower]) return exact[lower];

  // Extension match. We pick the longest matching extension (e.g. `.d.ts`
  // beats `.ts`).
  const dotIdx = lower.lastIndexOf(".");
  if (dotIdx < 0) return { Icon: FileText, color: "text-muted/60" };
  const ext = lower.slice(dotIdx);
  // Double-extensions we treat specially:
  if (lower.endsWith(".d.ts")) return { Icon: FileType2, color: "text-blue-300/60" };
  if (lower.endsWith(".test.ts") || lower.endsWith(".test.tsx") || lower.endsWith(".spec.ts")) {
    return { Icon: FileCode2, color: "text-green-400/80" };
  }

  const byExt: Record<string, IconSpec> = {
    // TypeScript / JavaScript
    ".ts": { Icon: FileType2, color: "text-blue-400" },
    ".tsx": { Icon: FileType2, color: "text-cyan-400" },
    ".js": { Icon: FileCode2, color: "text-yellow-400" },
    ".jsx": { Icon: FileCode2, color: "text-yellow-300" },
    ".mjs": { Icon: FileCode2, color: "text-yellow-400" },
    ".cjs": { Icon: FileCode2, color: "text-yellow-400/80" },

    // Data / config
    ".json": { Icon: Braces, color: "text-amber-400" },
    ".jsonc": { Icon: Braces, color: "text-amber-400" },
    ".yaml": { Icon: FileText, color: "text-rose-300" },
    ".yml": { Icon: FileText, color: "text-rose-300" },
    ".toml": { Icon: FileText, color: "text-orange-300" },
    ".xml": { Icon: FileCode2, color: "text-orange-400/70" },

    // Markup / docs
    ".md": { Icon: FileText, color: "text-blue-300" },
    ".mdx": { Icon: FileText, color: "text-blue-300" },
    ".rst": { Icon: FileText, color: "text-blue-300/70" },
    ".txt": { Icon: FileText, color: "text-muted/70" },
    ".pdf": { Icon: FileText, color: "text-red-400" },

    // Web
    ".html": { Icon: FileCode2, color: "text-orange-400" },
    ".htm": { Icon: FileCode2, color: "text-orange-400" },
    ".css": { Icon: Hash, color: "text-blue-400" },
    ".scss": { Icon: Hash, color: "text-pink-400" },
    ".sass": { Icon: Hash, color: "text-pink-400" },
    ".less": { Icon: Hash, color: "text-blue-300" },
    ".vue": { Icon: FileCode2, color: "text-green-400" },
    ".svelte": { Icon: FileCode2, color: "text-orange-400" },

    // Other languages
    ".py": { Icon: FileCode2, color: "text-blue-400" },
    ".pyi": { Icon: FileType2, color: "text-blue-400/70" },
    ".go": { Icon: FileCode2, color: "text-cyan-400" },
    ".rs": { Icon: FileCode2, color: "text-orange-400" },
    ".java": { Icon: FileCode2, color: "text-amber-500" },
    ".kt": { Icon: FileCode2, color: "text-purple-400" },
    ".swift": { Icon: FileCode2, color: "text-orange-500" },
    ".c": { Icon: FileCode2, color: "text-blue-300" },
    ".h": { Icon: FileCode2, color: "text-purple-300" },
    ".cpp": { Icon: FileCode2, color: "text-blue-400" },
    ".hpp": { Icon: FileCode2, color: "text-purple-400" },
    ".rb": { Icon: FileCode2, color: "text-red-400" },
    ".php": { Icon: FileCode2, color: "text-purple-300" },
    ".lua": { Icon: FileCode2, color: "text-blue-500" },
    ".sql": { Icon: Database, color: "text-orange-300" },

    // Shell
    ".sh": { Icon: Terminal, color: "text-emerald-400" },
    ".bash": { Icon: Terminal, color: "text-emerald-400" },
    ".zsh": { Icon: Terminal, color: "text-emerald-400" },
    ".fish": { Icon: Terminal, color: "text-emerald-400" },
    ".bat": { Icon: Terminal, color: "text-slate-400" },
    ".ps1": { Icon: Terminal, color: "text-blue-400" },

    // Images
    ".png": { Icon: FileImage, color: "text-violet-300" },
    ".jpg": { Icon: FileImage, color: "text-violet-300" },
    ".jpeg": { Icon: FileImage, color: "text-violet-300" },
    ".gif": { Icon: FileImage, color: "text-violet-300" },
    ".webp": { Icon: FileImage, color: "text-violet-300" },
    ".svg": { Icon: FileImage, color: "text-yellow-300" },
    ".ico": { Icon: FileImage, color: "text-blue-400" },
    ".bmp": { Icon: FileImage, color: "text-violet-300" },

    // Media
    ".mp4": { Icon: FileVideo, color: "text-rose-400" },
    ".mov": { Icon: FileVideo, color: "text-rose-400" },
    ".webm": { Icon: FileVideo, color: "text-rose-400" },
    ".mp3": { Icon: FileAudio, color: "text-emerald-300" },
    ".wav": { Icon: FileAudio, color: "text-emerald-300" },
    ".flac": { Icon: FileAudio, color: "text-emerald-300" },
    ".m4a": { Icon: FileAudio, color: "text-emerald-300" },

    // Archives
    ".zip": { Icon: FileArchive, color: "text-amber-400/80" },
    ".tar": { Icon: FileArchive, color: "text-amber-400/80" },
    ".gz": { Icon: FileArchive, color: "text-amber-400/80" },
    ".bz2": { Icon: FileArchive, color: "text-amber-400/80" },
    ".7z": { Icon: FileArchive, color: "text-amber-400/80" },
    ".rar": { Icon: FileArchive, color: "text-amber-400/80" },

    // Spreadsheets / CSV
    ".csv": { Icon: FileSpreadsheet, color: "text-emerald-300" },
    ".xlsx": { Icon: FileSpreadsheet, color: "text-emerald-400" },
    ".xls": { Icon: FileSpreadsheet, color: "text-emerald-400" },
    ".ods": { Icon: FileSpreadsheet, color: "text-emerald-400" },

    // DB
    ".db": { Icon: Database, color: "text-orange-300" },
    ".sqlite": { Icon: Database, color: "text-orange-300" },
  };

  return byExt[ext] ?? { Icon: FileText, color: "text-muted/60" };
}

export function FileIcon({ name, isDirectory, size = 14, className = "" }: FileIconProps) {
  if (isDirectory) {
    // Folder icons stay with their existing accent — file-tree renders them.
    return null;
  }
  const { Icon, color } = pickIcon(name);
  return <Icon size={size} className={`${color} shrink-0 ${className}`} />;
}
