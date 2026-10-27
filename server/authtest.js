// Tests Google sign-in limited to one domain, against a stubbed Google token endpoint.
// Run: npm test (from /server). No network or real Google credentials needed.
import http from "node:http";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";

let nextClaims = null;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const stub = http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id_token: `${b64({ alg: "RS256" })}.${b64(nextClaims)}.sig` }));
  });
});
await new Promise((r) => stub.listen(9912, r));

const p = spawn("node", ["server.js"], {
  env: {
    ...process.env,
    ANTHROPIC_API_KEY: "test-key",
    PORT: "8098",
    STATIC_DIR: "./",
    GOOGLE_CLIENT_ID: "cid.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "secret",
    ALLOWED_EMAIL_DOMAIN: "meetdandy.com",
    SESSION_SECRET: "test-session-secret",
    GOOGLE_TOKEN_URL: "http://localhost:9912/token",
    ACCESS_PASSWORD: "ignored-when-google-is-on",
  },
  stdio: "ignore",
});
await new Promise((r) => setTimeout(r, 800));
const base = "http://localhost:8098";
const get = (path, cookie) => fetch(base + path, { redirect: "manual", headers: cookie ? { cookie } : {} });
const cookiesOf = (r) => r.headers.getSetCookie().map((c) => c.split(";")[0]).filter((c) => !c.endsWith("="));

async function signIn(email, { verified = true, aud = "cid.apps.googleusercontent.com" } = {}) {
  const start = await get("/auth/login?next=/");
  assert.equal(start.status, 302);
  const loc = new URL(start.headers.get("location"));
  assert.equal(loc.hostname, "accounts.google.com");
  assert.equal(loc.searchParams.get("hd"), "meetdandy.com");
  const flow = cookiesOf(start).join("; ");
  nextClaims = { iss: "https://accounts.google.com", aud, exp: Math.floor(Date.now() / 1000) + 600, nonce: loc.searchParams.get("nonce"), email, email_verified: verified };
  return get(`/auth/callback?code=abc&state=${loc.searchParams.get("state")}`, flow);
}

try {
  // Health check stays open; the app and the API do not.
  assert.equal((await get("/healthz")).status, 200);
  const home = await get("/");
  assert.equal(home.status, 302);
  assert.match(home.headers.get("location"), /^\/auth\/login/);
  assert.equal((await fetch(base + "/api/locate", { method: "POST" })).status, 401);
  // The shared password no longer opens the site.
  assert.equal((await get("/", undefined).then(() => fetch(base + "/", { redirect: "manual", headers: { Authorization: "Basic " + Buffer.from("u:ignored-when-google-is-on").toString("base64") } }))).status, 302);

  // Wrong domain, unverified email, wrong audience: refused, no session.
  for (const [email, opts, code] of [["someone@gmail.com", {}, 403], ["x@meetdandy.com.evil.com", {}, 403], ["a@meetdandy.com", { verified: false }, 401], ["a@meetdandy.com", { aud: "other" }, 401]]) {
    const r = await signIn(email, opts);
    assert.equal(r.status, code, email);
    assert.ok(!cookiesOf(r).some((c) => c.startsWith("sc_session=")), email);
  }

  // State mismatch is refused.
  assert.equal((await get("/auth/callback?code=abc&state=wrong")).status, 400);

  // A Dandy account gets a session that opens the app and the API.
  const ok = await signIn("Pat.Lee@MeetDandy.com");
  assert.equal(ok.status, 302);
  const session = cookiesOf(ok).find((c) => c.startsWith("sc_session="));
  assert.ok(session);
  const page = await get("/", session);
  assert.notEqual(page.status, 302);
  const api = await fetch(base + "/api/locate", { method: "POST", headers: { cookie: session, "content-type": "application/json" }, body: "{}" });
  assert.equal(api.status, 400); // past sign-in; fails only on the missing image

  // A tampered cookie is rejected.
  const forged = session.slice(0, -3) + "AAA";
  assert.equal((await get("/", forged)).status, 302);

  // Logout clears the session cookie.
  const out = await get("/auth/logout", session);
  assert.ok(out.headers.getSetCookie().some((c) => c.startsWith("sc_session=;")));
  console.log("ok (google sign-in)");
} finally {
  p.kill();
  stub.close();
}
