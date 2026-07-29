// Sequential creation of a multi-issue draft (#136). Each card carries its own
// status: a tracker rejecting issue 2 must not lose issue 1's URL nor block
// issue 3, so the loop never short-circuits and a failed card stays retryable.

export type CardCreateState =
  | { status: "pending" }
  | { status: "creating" }
  | { status: "created"; url: string; number: number }
  | { status: "failed"; error: string };

export type CreateStates = Record<number, CardCreateState>;

export type CreateOutcome =
  | { ok: true; id: string; number: number; url: string }
  | { ok: false; error: string };

export function initialCreateStates(count: number): CreateStates {
  const states: CreateStates = {};
  for (let i = 0; i < count; i++) states[i] = { status: "pending" };
  return states;
}

export function isCreated(state: CardCreateState | undefined): boolean {
  return state?.status === "created";
}

/** A card is posted once: created cards are skipped on a retry of the batch. */
export function pendingIndexes(states: CreateStates, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) if (!isCreated(states[i])) out.push(i);
  return out;
}

export function allCreated(states: CreateStates, count: number): boolean {
  return count > 0 && pendingIndexes(states, count).length === 0;
}

export function outcomeToState(outcome: CreateOutcome): CardCreateState {
  return outcome.ok
    ? { status: "created", url: outcome.url, number: outcome.number }
    : { status: "failed", error: outcome.error };
}

/**
 * Post `indexes` one after the other, reporting each transition through
 * `onState`. Never throws: a rejected create becomes that card's failed state
 * and the run continues with the next one.
 */
export async function runCreateFlow(opts: {
  indexes: number[];
  create: (index: number) => Promise<CreateOutcome>;
  onState: (index: number, state: CardCreateState) => void;
}): Promise<CreateStates> {
  const result: CreateStates = {};
  for (const index of opts.indexes) {
    opts.onState(index, { status: "creating" });
    let state: CardCreateState;
    try {
      state = outcomeToState(await opts.create(index));
    } catch (err) {
      state = { status: "failed", error: err instanceof Error ? err.message : String(err) };
    }
    result[index] = state;
    opts.onState(index, state);
  }
  return result;
}
