import type { CodingEvent, CodingEventEnvelope } from "@skipper/shared";

// Per-turn agent activity for the chat panel (#260). The desktop event buffer is
// shared with run events and resets (seq 0) whenever a run restarts, so the
// console's appendLive is not enough on its own: this reducer archives the turns
// it has already segmented before letting a reset clear the buffer.
//
// Turns are delimited by the `resuming` details in CHAT_TURN_DETAILS — see the
// contract note in packages/shared/src/coding.ts.

export interface ChatTurn {
  /** `${at}#${seq}` of the opener — stable across re-segmentation. */
  id: string;
  detail: string;
  openedAt: string;
  envelopes: CodingEventEnvelope[];
  open: boolean;
}

export interface ChatStreamState {
  archivedTurns: ChatTurn[];
  buffer: CodingEventEnvelope[];
}

export const EMPTY_CHAT_STREAM_STATE: ChatStreamState = { archivedTurns: [], buffer: [] };

/** Phases that mean a run took the stream over — the chat turn is done. */
const RUN_PHASES: ReadonlySet<string> = new Set([
  "fetching",
  "worktree",
  "agent-start",
  "scoring",
  "graphify",
]);

function openerDetail(event: CodingEvent, turnDetails: string[]): string | null {
  if (event.kind !== "status" || event.phase !== "resuming") return null;
  return event.detail && turnDetails.includes(event.detail) ? event.detail : null;
}

/** Split a seq-ordered buffer into the chat turns it contains. */
export function segmentTurns(
  buffer: CodingEventEnvelope[],
  turnDetails: string[],
): ChatTurn[] {
  const turns: ChatTurn[] = [];
  let current: ChatTurn | null = null;

  for (const envelope of buffer) {
    const { event } = envelope;
    const opener = openerDetail(event, turnDetails);
    if (opener !== null) {
      if (current) current.open = false;
      current = {
        id: `${envelope.at}#${envelope.seq}`,
        detail: opener,
        openedAt: envelope.at,
        envelopes: [],
        open: true,
      };
      turns.push(current);
      continue;
    }
    if (!current) continue;

    if (event.kind === "status" && (RUN_PHASES.has(event.phase) || event.phase === "resuming")) {
      current.open = false;
      current = null;
      continue;
    }
    current.envelopes.push(envelope);
    if (event.kind === "result" || event.kind === "error") {
      current.open = false;
      current = null;
    }
  }

  return turns;
}

function insertBySeq(
  buffer: CodingEventEnvelope[],
  envelope: CodingEventEnvelope,
): CodingEventEnvelope[] {
  if (buffer.some((e) => e.seq === envelope.seq)) return buffer;
  return [...buffer, envelope].sort((a, b) => a.seq - b.seq);
}

/** Live event. Seq 0 restarts the upstream buffer, so archive what we had first. */
export function reduceLive(
  state: ChatStreamState,
  envelope: CodingEventEnvelope,
  turnDetails: string[],
): ChatStreamState {
  if (envelope.seq === 0) {
    const archived = segmentTurns(state.buffer, turnDetails).map((turn) => ({
      ...turn,
      open: false,
    }));
    return {
      archivedTurns: [...state.archivedTurns, ...archived],
      buffer: [envelope],
    };
  }
  const buffer = insertBySeq(state.buffer, envelope);
  return buffer === state.buffer ? state : { ...state, buffer };
}

/** Merge the replay buffer under live events already received (dedup by seq). */
export function mergeReplayIntoState(
  state: ChatStreamState,
  replay: CodingEventEnvelope[],
): ChatStreamState {
  const seen = new Set(replay.map((e) => e.seq));
  const buffer = [...replay, ...state.buffer.filter((e) => !seen.has(e.seq))].sort(
    (a, b) => a.seq - b.seq,
  );
  return { ...state, buffer };
}

/** Archived turns plus the ones the current buffer still holds. */
export function allTurns(state: ChatStreamState, turnDetails: string[]): ChatTurn[] {
  return [...state.archivedTurns, ...segmentTurns(state.buffer, turnDetails)];
}
