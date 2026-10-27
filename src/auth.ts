import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Dashboard login against `DASHBOARD_TOKEN`: a form trades the token for a session cookie.
 * Not HTTP Basic — the browser's own prompt loops into ERR_TOO_MANY_RETRIES whenever an
 * extension or a cached credential answers the challenge wrongly. A same-origin cookie rides
 * every fetch the dashboard makes.
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
 * The sign-in page, per the design's Login board. Self-contained on purpose: `/app.css` sits
 * behind the same gate, so the page carries its own styles. Nothing here comes from the request.
 */
export function loginPage(wrong: boolean): string {
  const line = wrong ? "#FF8170" : "#3A3A3F";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tidal sign-in</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Urbanist:wght@400;500;600;700&display=swap">
<style>
*{box-sizing:border-box}
body{margin:0;background:#0F0F10;color:#F4F4F5;font:14px/20px Urbanist,system-ui,sans-serif}
main{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:48px 16px}
.wrap{width:100%;max-width:420px;display:flex;flex-direction:column;gap:20px}
.brand{display:flex;align-items:center;justify-content:center;gap:12px;font-size:24px;line-height:32px;font-weight:600}
.mark{display:inline-flex;align-items:center;justify-content:center;width:48px;height:48px;border-radius:50%;background:#2C2C2F}
form{display:flex;flex-direction:column;gap:20px;padding:28px;background:#161618;border-radius:32px}
.lock{display:inline-flex;align-items:center;gap:8px;font-size:13px;line-height:18px;color:#A1A1AA}
.lock i{width:8px;height:8px;border-radius:50%;background:#FFB84D}
h1{margin:0;font-size:28px;line-height:34px;font-weight:600}
p{margin:0;color:#A1A1AA}
code{font-family:'IBM Plex Mono',ui-monospace,monospace;font-size:13px;color:#F4F4F5}
label{font-size:13px;line-height:18px;font-weight:600}
.field{position:relative;display:flex}
input{flex:1;min-width:0;height:52px;padding:0 56px 0 20px;border:1px solid ${line};border-radius:26px;background:#0F0F10;font:14px 'IBM Plex Mono',ui-monospace,monospace;color:#F4F4F5}
input::placeholder{color:#8B8B93}
input:focus-visible,button:focus-visible{outline:2px solid #D7F26B;outline-offset:2px}
.eye{position:absolute;right:4px;top:4px;display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;border:0;border-radius:22px;background:transparent;color:#A1A1AA;cursor:pointer}
.err{display:flex;gap:8px;font-size:13px;line-height:18px;color:#FF8170}
.go{display:inline-flex;align-items:center;justify-content:center;gap:10px;min-height:52px;padding:0 24px;border:0;border-radius:26px;background:#D7F26B;color:#161618;font:inherit;font-size:15px;font-weight:700;cursor:pointer}
.go:hover{background:#E8FA9E}
.fine{font-size:12px;line-height:17px}
.foot{text-align:center;font-size:12px;line-height:17px;color:#8B8B93}
</style></head><body><main><div class="wrap">
<div class="brand"><span class="mark" aria-hidden="true"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#A891FF" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 14c2.2 0 2.8-4 5-4s2.8 4 5 4 2.8-4 5-4 2.4 2.4 3 4"/></svg></span>Tidal</div>
<form method="post" action="/login" aria-labelledby="signin-title">
<div style="display:flex;flex-direction:column;gap:6px">
<span class="lock"><i aria-hidden="true"></i>Dashboard locked</span>
<h1 id="signin-title">Sign in</h1>
<p>Paste the token set in <code>DASHBOARD_TOKEN</code> on the server.</p>
</div>
<div style="display:flex;flex-direction:column;gap:8px">
<label for="token">Dashboard token</label>
<div class="field">
<input id="token" name="token" type="password" autocomplete="current-password" spellcheck="false" placeholder="64-character token" required autofocus${wrong ? ' aria-invalid="true" aria-describedby="token-error"' : ""}>
<button class="eye" type="button" aria-label="Show token" aria-pressed="false" onclick="var i=document.getElementById('token'),s=i.type==='password';i.type=s?'text':'password';this.setAttribute('aria-pressed',String(s))"><svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg></button>
</div>
${wrong ? `<p id="token-error" class="err" role="alert">That token does not match. Check DASHBOARD_TOKEN on the server and paste it again.</p>` : ""}
</div>
<button class="go" type="submit">Open dashboard<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14 M13 6l6 6-6 6"/></svg></button>
<p class="fine">You stay signed in on this browser for 30 days. Changing the token signs every browser out.</p>
</form>
<p class="foot">Serve the dashboard over HTTPS. Without it the token crosses the network in plain text.</p>
</div></main></body></html>`;
}
