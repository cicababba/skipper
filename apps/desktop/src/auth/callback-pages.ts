// HTML served on the loopback callback after the browser round-trip.

export const SUCCESS_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Skipper — Signed in</title>
    <style>
      body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; background:#0a0a0a; color:#e5e5e5; display:grid; place-items:center; min-height:100vh; }
      .card { text-align:center; padding:48px 56px; border:1px solid #222; border-radius:14px; background:#111; max-width:420px; }
      h1 { margin:0 0 12px; font-size:22px; font-weight:600; }
      h1 span { color:#22c55e; }
      p { margin:0; color:#888; font-size:14px; line-height:1.5; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1><span>✓</span> Signed in to Skipper</h1>
      <p>You can close this tab and return to the app.</p>
    </div>
  </body>
</html>`;

export function errorHtml(message: string): string {
  const safe = message.replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c,
  );
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><title>Skipper — Sign in failed</title>
<style>body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0a0a0a;color:#e5e5e5;display:grid;place-items:center;min-height:100vh}.card{text-align:center;padding:48px 56px;border:1px solid #4a1a1a;border-radius:14px;background:#1a0e0e;max-width:480px}h1{margin:0 0 12px;font-size:22px;font-weight:600;color:#ef4444}p{margin:0;color:#aaa;font-size:14px;line-height:1.5}</style>
</head><body><div class="card"><h1>✕ Sign in failed</h1><p>${safe}</p></div></body></html>`;
}
