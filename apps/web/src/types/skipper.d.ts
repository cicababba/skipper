import type { WindowSkipper } from "@skipper/shared";

declare global {
  interface Window {
    skipper?: WindowSkipper;
  }
}

export {};
