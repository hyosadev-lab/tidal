import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Dashboard login against `DASHBOARD_TOKEN`: a form trades the token for a session cookie.
 * Not HTTP Basic — the browser's own prompt loops into ERR_TOO_MANY_RETRIES whenever an
 * extension or a cached credential answers the challenge wrongly. A same-origin cookie
 * rides fetch *and* EventSource, so `public/app.js` needs no change either way.
 */

const COOKIE = "tidal_session";

/** Length-blind constant-time compare. */
export function sameSecret(given: string, expected: string): boolean {
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

/** Derived from the token, so the cookie never holds it and rotating the token logs everyone out. */
function sessionValue(token: string): string {
  return createHmac("sha256", token).update("tidal-dashboard-session").digest("hex");
}

export function sessionCookie(token: string, secure: boolean): string {
  const attrs = [`${COOKIE}=${sessionValue(token)}`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=2592000"];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function hasSession(cookieHeader: string | undefined, token: string): boolean {
  const pair = (cookieHeader ?? "").split(";").map((s) => s.trim()).find((s) => s.startsWith(`${COOKIE}=`));
  return pair !== undefined && sameSecret(pair.slice(COOKIE.length + 1), sessionValue(token));
}

/**
 * A cross-site page can POST `text/plain` that parses as JSON. SameSite=Strict already keeps
 * the cookie off it; requiring `application/json` (which forces a CORS preflight this server
 * never answers) is the second lock, for browsers that ignore SameSite.
 */
export function sameOriginPost(contentType: string | undefined): boolean {
  return (contentType ?? "").split(";")[0]!.trim().toLowerCase() === "application/json";
}

/** Refuse to boot in a state where the dashboard would be open, or guessable, on the network. */
export function authProblem(host: string, token: string | undefined): string | null {
  if (token !== undefined && token.length < 32)
    return "DASHBOARD_TOKEN must be at least 32 characters (openssl rand -hex 32)";
  const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
  if (!token && !loopback) return `HOST=${host} exposes the dashboard; set DASHBOARD_TOKEN first`;
  return null;
}

/**
 * Self-contained on purpose: `/style.css` sits behind the same gate, so the page carries the
 * dashboard's tokens inline (keep them in step with `public/style.css :root`).
 * `error` is always a literal from this codebase, never request data.
 */
export function loginPage(error = ""): string {
  return `<!doctype html><html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tidal · gateway</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><text y='26' font-size='26'>🌊</text></svg>">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
<style>
  :root {
    --abyss:#071316; --hull:#0B1A1E; --hull-2:#0E2126; --rule:#17343A; --rule-2:#22474E;
    --foam:#DCEAE6; --haze:#6F8B8E; --flood:#56E0B8; --ebb:#FF7B6E; --lamp:#F0B44B;
    --serif:"Instrument Serif","Iowan Old Style",Georgia,serif;
    --mono:"JetBrains Mono",ui-monospace,"SF Mono",Menlo,monospace;
    --sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; min-height: 100dvh;
    display: grid; place-items: center; padding: 24px 16px 120px;
    background: radial-gradient(900px 480px at 50% -10%, #0E2A30 0%, transparent 65%), var(--abyss);
    color: var(--foam); font: 14px/1.5 var(--sans); overflow: hidden;
  }

  /* the tide, rolling under the gate */
  .tide { position: fixed; inset: auto 0 0 0; height: 150px; pointer-events: none; }
  .tide svg { position: absolute; bottom: 0; width: 200%; height: 100%; }
  .tide path { fill: none; stroke-width: 1; }
  .t1 { animation: roll 18s linear infinite; }
  .t2 { animation: roll 27s linear infinite reverse; bottom: -14px !important; }
  .t3 { animation: roll 40s linear infinite; bottom: -30px !important; }
  @keyframes roll { to { transform: translateX(-50%); } }

  .gate { position: relative; width: min(390px, 100%); }
  .mark { display: flex; align-items: baseline; justify-content: center; gap: 10px; margin-bottom: 22px; }
  .mark-name { font-family: var(--serif); font-size: 46px; line-height: 1; letter-spacing: .01em; }
  .mark-sub { font-family: var(--mono); font-size: 10px; letter-spacing: .22em; text-transform: uppercase; color: var(--haze); }

  .panel {
    background: linear-gradient(180deg, var(--hull) 0%, #0A171B 100%);
    border: 1px solid var(--rule); border-radius: 3px; padding: 22px 22px 20px;
    box-shadow: 0 30px 80px -30px rgba(0,0,0,.7), 0 0 0 1px rgba(86,224,184,.03) inset;
  }
  .status {
    display: flex; align-items: center; gap: 9px; margin: 0 0 18px;
    font-family: var(--mono); font-size: 10.5px; letter-spacing: .14em; text-transform: uppercase; color: var(--haze);
  }
  .beacon { width: 8px; height: 8px; border-radius: 50%; background: var(--lamp); animation: sweep 2.6s ease-in-out infinite; }
  @keyframes sweep {
    0%,100% { box-shadow: 0 0 0 0 rgba(240,180,75,.45); opacity: 1; }
    50%     { box-shadow: 0 0 0 7px rgba(240,180,75,0); opacity: .6; }
  }
  .status .chip { margin-left: auto; border: 1px solid var(--rule); border-radius: 3px; padding: 2px 7px; font-size: 9.5px; }

  label {
    display: flex; align-items: center; gap: 9px; margin: 0 0 9px;
    font-family: var(--mono); font-size: 10px; font-weight: 500; letter-spacing: .22em; text-transform: uppercase; color: var(--haze);
  }
  label::after { content: ""; flex: 1; height: 1px; background: var(--rule); }

  input {
    width: 100%; background: var(--abyss); border: 1px solid var(--rule); border-radius: 3px;
    color: var(--foam); font: 13px var(--mono); letter-spacing: .04em; padding: 12px;
    transition: border-color .12s;
  }
  input::placeholder { color: #3F6268; letter-spacing: .02em; }
  input:hover { border-color: var(--rule-2); }
  input:focus { outline: 2px solid var(--flood); outline-offset: 1px; border-color: transparent; }
  .go:focus-visible { outline: 2px solid var(--flood); outline-offset: 1px; }

  .error {
    margin: 12px 0 0; padding: 9px 12px; border: 1px solid #4E211D; border-left-width: 3px; border-left-color: var(--ebb);
    background: #1D0F0D; color: var(--ebb); font: 12px var(--mono); border-radius: 3px;
  }

  .go {
    width: 100%; margin-top: 14px; appearance: none; cursor: pointer;
    background: var(--flood); border: 1px solid var(--flood); border-radius: 3px; color: #04211A;
    font: 700 12px var(--mono); letter-spacing: .1em; text-transform: uppercase; padding: 12px 14px;
    display: flex; justify-content: center; align-items: center; gap: 10px; transition: background .12s;
  }
  .go:hover { background: #74EDC8; border-color: #74EDC8; }
  .go span { transition: transform .15s; }
  .go:hover span { transform: translateX(3px); }

  .fine { margin: 16px 0 0; font-size: 11.5px; line-height: 1.6; color: var(--haze); }  .foot { margin-top: 16px; text-align: center; font: 10px var(--mono); letter-spacing: .18em; text-transform: uppercase; color: var(--rule-2); }

  @media (prefers-reduced-motion: reduce) { .t1, .t2, .t3, .beacon { animation: none; } }
</style></head><body>

<div class="tide" aria-hidden="true">
  <svg class="t3" viewBox="0 0 1200 150" preserveAspectRatio="none"><path stroke="#17343A" d="M0 90 Q150 60 300 90 T600 90 T900 90 T1200 90"/></svg>
  <svg class="t2" viewBox="0 0 1200 150" preserveAspectRatio="none"><path stroke="#22474E" d="M0 100 Q150 75 300 100 T600 100 T900 100 T1200 100"/></svg>
  <svg class="t1" viewBox="0 0 1200 150" preserveAspectRatio="none"><path stroke="rgba(86,224,184,.35)" d="M0 110 Q150 88 300 110 T600 110 T900 110 T1200 110"/></svg>
</div>

<main class="gate">
  <div class="mark"><span class="mark-name">Tidal</span><span class="mark-sub">trading station</span></div>

  <form class="panel" method="post" action="/login">
    <p class="status"><span class="beacon"></span>Gateway terkunci<span class="chip">auth</span></p>

    <label for="token">Gateway token</label>
    <input id="token" type="password" name="token" placeholder="tempel token di sini" autocomplete="current-password" spellcheck="false" autofocus required>
    ${error ? `<p class="error" role="alert">${error}</p>` : ""}

    <button class="go" type="submit">Buka dashboard <span aria-hidden="true">→</span></button>

    <p class="fine">Sesi tersimpan 30 hari di browser ini.</p>
  </form>

  <p class="foot">cookie httponly · samesite strict</p>
</main>

</body></html>`;
}
