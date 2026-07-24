"use client";

import { useEffect, useState } from "react";
import { OnboardingFlow } from "@/components/onboarding";
import { getAppSettings } from "@/lib/app-settings";

type GateState = "loading" | "needed" | "done";

export function OnboardingGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<GateState>("loading");

  useEffect(() => {
    async function checkOnboarding() {
      // Only Electron triggers the onboarding flow
      if (typeof window === "undefined" || !window.skipper) {
        setState("done");
        return;
      }
      try {
        const settingsRes = await getAppSettings();
        const completed = settingsRes?.onboardingCompleted === true;
        setState(completed ? "done" : "needed");
      } catch {
        // If anything fails, show the onboarding to be safe
        setState("needed");
      }
    }
    void checkOnboarding();
  }, []);

  if (state === "loading") {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-background z-[100]">
        <div className="w-8 h-8 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <>
      {children}
      {state === "needed" && (
        <OnboardingFlow onFinish={() => setState("done")} />
      )}
    </>
  );
}
