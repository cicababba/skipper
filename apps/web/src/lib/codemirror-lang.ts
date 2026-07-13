import { languages } from "@codemirror/language-data";
import { LanguageSupport } from "@codemirror/language";

// Resolves a language pack for the given filename using CodeMirror's
// language-data index (~100 languages). The pack is loaded lazily via
// dynamic import, so only the parser for the actual file is pulled in.
// Unknown extensions return null → the file opens as plain text.
export async function loadLanguageFor(filename: string): Promise<LanguageSupport | null> {
  const desc =
    // Match by extension first (cheap)
    languages.find((l) =>
      l.extensions.some((ext) => filename.toLowerCase().endsWith("." + ext.toLowerCase())),
    ) ??
    // Then by explicit filename (Makefile, Dockerfile, etc.)
    languages.find((l) => l.filename?.test(filename.split("/").pop() ?? filename));
  if (!desc) return null;
  try {
    return await desc.load();
  } catch {
    return null;
  }
}
