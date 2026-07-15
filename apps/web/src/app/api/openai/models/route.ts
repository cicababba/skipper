import { NextRequest, NextResponse } from "next/server";
import { loadSettings } from "@/lib/settings";

// Parked: no caller since Settings dropped the provider picker and pinned
// claude-cli. Kept for the same reason as the packages/sync seams — if OpenAI
// ever returns to the picker, restoring this costs a re-import, not a rewrite.

export async function GET(request: NextRequest) {
  try {
    // Check if API key was passed as query param (for testing) or use saved one
    const { searchParams } = new URL(request.url);
    const queryKey = searchParams.get("key");

    const settings = await loadSettings();
    const apiKey = queryKey || settings.llm.openaiApiKey;

    if (!apiKey) {
      return NextResponse.json({ error: "No OpenAI API key configured" }, { status: 400 });
    }

    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!res.ok) {
      const errStatus = Math.min(Math.max(res.status, 200), 599);
      return NextResponse.json(
        { error: `OpenAI API error: ${res.status}` },
        { status: errStatus === 200 ? 502 : errStatus }
      );
    }

    const data = await res.json();

    // Filter to chat models only, sort by ID
    const models = (data.data as Array<{ id: string; owned_by: string }>)
      .filter((m) =>
        m.id.startsWith("gpt-") ||
        m.id.startsWith("o1") ||
        m.id.startsWith("o3") ||
        m.id.startsWith("o4") ||
        m.id.startsWith("chatgpt")
      )
      .map((m) => ({ id: m.id, owned_by: m.owned_by }))
      .sort((a, b) => a.id.localeCompare(b.id));

    return NextResponse.json({ models });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
