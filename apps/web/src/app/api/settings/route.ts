import { NextRequest, NextResponse } from "next/server";
import { loadSettings, saveSettings } from "@/lib/settings";

export async function GET() {
  try {
    const settings = await loadSettings();
    // Don't expose the full API key to the client
    return NextResponse.json({
      ...settings,
      llm: {
        ...settings.llm,
        openaiApiKey: settings.llm.openaiApiKey
          ? `sk-...${settings.llm.openaiApiKey.slice(-4)}`
          : "",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const current = await loadSettings();

    const updated = {
      ...current,
      llm: {
        ...current.llm,
        ...body.llm,
        // Only update API key if a real key was sent (not the masked one)
        openaiApiKey:
          body.llm?.openaiApiKey && !body.llm.openaiApiKey.startsWith("sk-...")
            ? body.llm.openaiApiKey
            : current.llm.openaiApiKey,
      },
      autoExtractAtoms:
        typeof body.autoExtractAtoms === "boolean"
          ? body.autoExtractAtoms
          : (current.autoExtractAtoms ?? true),
      onboardingCompleted:
        typeof body.onboardingCompleted === "boolean"
          ? body.onboardingCompleted
          : (current.onboardingCompleted ?? false),
    };

    await saveSettings(updated);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
