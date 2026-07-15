import { NextResponse } from "next/server";
import { ollamaHost } from "@skipper/core";

/**
 * Probe the local Ollama server and list installed models in one call.
 * `running: false` means the server isn't reachable (so the UI can show the
 * "Ollama not running" popup); otherwise `models` holds the installed tags.
 *
 * Parked: no caller since Settings dropped the provider picker and pinned
 * claude-cli. Kept for the same reason as the packages/sync seams — if ollama
 * ever returns to the picker, restoring this costs a re-import, not a rewrite.
 */
export async function GET() {
  const host = ollamaHost();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    let res: Response;
    try {
      res = await fetch(`${host}/api/tags`, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      return NextResponse.json({ running: false, host, models: [], error: `Ollama responded ${res.status}` });
    }

    const data = await res.json();
    const models = ((data.models ?? []) as Array<{ name: string; model?: string; size?: number }>)
      .map((m) => ({ name: m.name, size: m.size }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return NextResponse.json({ running: true, host, models });
  } catch {
    // Connection refused / timeout / DNS → server is down.
    return NextResponse.json({
      running: false,
      host,
      models: [],
      error: `Could not reach the Ollama server at ${host}. Make sure it is installed and running (\`ollama serve\`).`,
    });
  }
}
