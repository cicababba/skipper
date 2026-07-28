// Composer autosize (#260): the textarea reports its natural height, this
// clamps it. Pure so the growth rule is testable without layout (jsdom reports
// scrollHeight 0, which clamps to the minimum).

export const COMPOSER_MIN_HEIGHT = 36;
export const COMPOSER_MAX_HEIGHT = 160;

export function clampAutosizeHeight(
  scrollHeight: number,
  min: number = COMPOSER_MIN_HEIGHT,
  max: number = COMPOSER_MAX_HEIGHT,
): number {
  if (!Number.isFinite(scrollHeight)) return min;
  return Math.min(Math.max(scrollHeight, min), max);
}
