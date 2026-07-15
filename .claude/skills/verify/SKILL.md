---
name: verify
description: Build, launch and drive the Skipper Electron app to observe a change at runtime. Use when verifying any change to apps/web or apps/desktop.
---

# Verify Skipper at runtime

The renderer is a Next.js app, but most orchestrator UI is gated on
`isElectron` (`typeof window !== "undefined" && !!window.skipper`), so a bare
`next dev` renders those blocks as nothing. **Verify inside Electron.**

There is no display attached in WSL, so drive the app headless under Xvfb and
talk to it over the Chrome DevTools Protocol.

## Launch

```bash
# 1. Renderer — dev mode loads http://localhost:3000 (main.ts:119, SKIPPER_DEV_URL overrides)
pnpm --filter @skipper/web dev > /tmp/web-dev.log 2>&1 &
until grep -q "Ready in" /tmp/web-dev.log; do sleep 1; done

# 2. Main process — build TS first, then launch with CDP open
cd apps/desktop && pnpm build:ts
SKIPPER_DEV=1 xvfb-run -a --server-args="-screen 0 1400x1000x24" \
  npx electron . --remote-debugging-port=9222 --no-sandbox > /tmp/electron.log 2>&1 &

# 3. Wait for the renderer target
until curl -s http://localhost:9222/json/version > /dev/null; do sleep 1; done
curl -s http://localhost:9222/json    # → the page target, url = http://localhost:3000/inbox
```

`pnpm desktop:build` is **not** needed to verify and fails on Node 24 under WSL
(`cpSync EEXIST` in `prepare-standalone.mjs`) — that is a packaging step,
unrelated to running the app.

## Drive

Node 22+ has a global `WebSocket`, so a CDP driver needs no dependencies —
fetch `/json`, open `webSocketDebuggerUrl`, send `Runtime.evaluate`
(`awaitPromise: true, returnByValue: true`), `Page.navigate`,
`Page.captureScreenshot`. ~50 lines; write it to the scratchpad.

Wrap evaluated code in `(async () => { ... })()` so you can `await` IPC calls
directly in the page:

```js
await window.skipper.orchestrator.listRepoSettings()   // repo rows + resolved settings
await window.skipper.orchestrator.setRepoSettings(owner, name, patch)
```

That IPC surface is the fastest way to both **set up** state and **assert**
persistence. Cross-check the real thing on disk:
`~/.config/Skipper/orchestrator-manifest.json` (pretty-printed — grep with
context, not `"key":[0-9]*`).

Screenshot after each navigation and actually look at it; `Page.navigate`
plus ~2s settles the App Router.

## Gotchas

- **Restore state you mutate.** The dev app runs against the user's real
  `~/.config/Skipper` and their linked repos. `setRepoSettings(o, n, { k: undefined })`
  resets a key to its default — that is how you undo.
- A repo with no manifest entry has `settings: {}` and all-default `resolved`.
  That empty object is the clean baseline to restore to.
- Selectors: the sidebar repo link and an in-page back link can share an
  `href`. Disambiguate on a class (`[class*="pl-9"]` is the sidebar row).
