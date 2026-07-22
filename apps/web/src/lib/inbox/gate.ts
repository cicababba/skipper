export type InboxGate = "desktop-only" | "loading" | "connect" | "no-items" | "content";

export interface InboxGateInput {
  isElectron: boolean;
  /** Auth IPC round-trip settled — before this, zero accounts means "unknown", not "none". */
  authLoaded: boolean;
  /** Connected accounts whose provider is an issue source (identity-only providers excluded). */
  issueAccounts: number;
  /** null until the orchestrator getState IPC answers. */
  orchestrator: { accounts: number; items: number } | null;
}

// Which empty state (if any) the inbox body shows (#192). The connect CTA is
// gated on auth accounts, not on the orchestrator's accounts map: that map
// starts empty and only fills after the first network poll, so it conflates
// "not yet loaded" with "genuinely zero accounts". While accounts exist but
// the first poll hasn't landed (and no persisted items to show), keep loading.
export function inboxGate(input: InboxGateInput): InboxGate {
  if (!input.isElectron) return "desktop-only";
  if (!input.authLoaded || !input.orchestrator) return "loading";
  if (input.issueAccounts === 0) return "connect";
  if (input.orchestrator.items > 0) return "content";
  if (input.orchestrator.accounts === 0) return "loading";
  return "no-items";
}
