import { test } from "node:test";
import assert from "node:assert/strict";
import { sameSecret, sessionCookie, hasSession, sameOriginPost, authProblem } from "../src/auth.ts";

const TOKEN = "a".repeat(40);

test("sameSecret: exact match only", () => {
  assert.equal(sameSecret(TOKEN, TOKEN), true);
  assert.equal(sameSecret(TOKEN.slice(1), TOKEN), false);
  assert.equal(sameSecret("", TOKEN), false);
});

test("session cookie: issued for the token, never contains it, dies on rotation", () => {
  const set = sessionCookie(TOKEN, false);
  assert.ok(!set.includes(TOKEN));
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Strict/);
  assert.doesNotMatch(set, /Secure/);
  assert.match(sessionCookie(TOKEN, true), /; Secure$/);

  const pair = set.split(";")[0]!;
  assert.equal(hasSession(`other=1; ${pair}`, TOKEN), true);
  assert.equal(hasSession(pair, "b".repeat(40)), false); // token rotated
  assert.equal(hasSession(`${pair}x`, TOKEN), false);
  assert.equal(hasSession("tidal_session=", TOKEN), false);
  assert.equal(hasSession(undefined, TOKEN), false);
});

test("sameOriginPost: only application/json", () => {
  assert.equal(sameOriginPost("application/json; charset=utf-8"), true);
  assert.equal(sameOriginPost("text/plain"), false);
  assert.equal(sameOriginPost(undefined), false);
});

test("authProblem: no open or weak dashboard on the network", () => {
  assert.equal(authProblem("127.0.0.1", undefined), null);
  assert.match(authProblem("0.0.0.0", undefined)!, /DASHBOARD_TOKEN/);
  assert.match(authProblem("0.0.0.0", "short")!, /32/);
  assert.equal(authProblem("0.0.0.0", TOKEN), null);
});
