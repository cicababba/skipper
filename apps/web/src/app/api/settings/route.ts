import { NextRequest, NextResponse } from "next/server";
import { loadSettings, saveSettings } from "@/lib/settings";

const MASK_PREFIX = "sk-...";

const mask = (key: string) => (key ? `${MASK_PREFIX}${key.slice(-4)}` : "");

/** Keep the stored key when the client echoes the mask back. */
const unmask = (sent: string | undefined, current: string) =>
  sent && !sent.startsWith(MASK_PREFIX) ? sent : current;

export async function GET() {
  try {
    const settings = await loadSettings();
    // Don't expose the full API key to the client
    return NextResponse.json({
      ...settings,
      llm: {
        ...settings.llm,
        openaiApiKey: mask(settings.llm.openaiApiKey),
        codexApiKey: mask(settings.llm.codexApiKey),
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
        // Only update an API key if a real one was sent (not the masked echo)
        openaiApiKey: unmask(body.llm?.openaiApiKey, current.llm.openaiApiKey),
        codexApiKey: unmask(body.llm?.codexApiKey, current.llm.codexApiKey),
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
