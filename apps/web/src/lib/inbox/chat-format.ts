// Small formatting / scroll predicates shared by the chat panel and the event
// console (#260). Kept pure: jsdom has no layout, so the components must not
// carry geometry logic of their own.

const STICKY_THRESHOLD = 24;

export function hhmm(at: string): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** True while the viewport sits close enough to the bottom to keep auto-scrolling. */
export function isStuck(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  threshold: number = STICKY_THRESHOLD,
): boolean {
  return scrollTop + clientHeight >= scrollHeight - threshold;
}
