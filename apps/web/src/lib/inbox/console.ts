import type { CodingEventEnvelope } from "@skipper/shared";

// Pure merge helpers for the event console (#32): live events can arrive
// before the replay buffer resolves, so both paths dedup by seq.

/** Live event: seq 0 signals a new run (buffer reset upstream) — restart the list. */
export function appendLive(
  list: CodingEventEnvelope[],
  envelope: CodingEventEnvelope,
): CodingEventEnvelope[] {
  if (envelope.seq === 0) return [envelope];
  if (list.some((e) => e.seq === envelope.seq)) return list;
  return [...list, envelope].sort((a, b) => a.seq - b.seq);
}

/** Merge the replay buffer under live events already received. */
export function mergeReplay(
  live: CodingEventEnvelope[],
  replay: CodingEventEnvelope[],
): CodingEventEnvelope[] {
  const seen = new Set(replay.map((e) => e.seq));
  return [...replay, ...live.filter((e) => !seen.has(e.seq))].sort((a, b) => a.seq - b.seq);
}
