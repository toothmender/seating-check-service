// "Sign in with Google", limited to one email domain (e.g. meetdandy.com).
// No extra dependencies: the OAuth code exchange uses fetch, sessions are HMAC-signed cookies.
//
// Flow: /auth/login -> Google -> /auth/callback -> session cookie -> app.
// The ID token comes straight from Google's token endpoint over TLS (back-channel), so per
// OpenID Connect its claims can be trusted without re-verifying the signature; we still check
// issuer, audience, expiry, nonce, email_verified and the domain.
import crypto from "node:crypto";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const SESSION_COOKIE = "sc_session";
const FLOW_COOKIE = "sc_oauth";
const SESSION_HOURS = 12;

const b64url = (buf) => Buffer.from(buf).toString("base64url");

function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function createGoogleAuth({ clientId, clientSecret, domain, sessionSecret, tokenUrl = "https://oauth2.googleapis.com/token", allowEmails = [] }) {
  const secret = sessionSecret || crypto.randomBytes(32).toString("hex"); // random: sessions end on restart
  const dom = domain.toLowerCase().replace(/^@/, "");
  const extra = new Set(allowEmails.map((e) => e.trim().toLowerCase()).filter(Boolean));

  const sign = (data) => crypto.createHmac("sha256", secret).update(data).digest("base64url");
  const seal = (obj) => {
    const data = b64url(JSON.stringify(obj));
    return `${data}.${sign(data)}`;
  };
  const unseal = (value) => {
    if (!value || typeof value !== "string") return null;
    const [data, mac] = value.split(".");
    if (!data || !mac) return null;
    const a = Buffer.from(sign(data));
    const b = Buffer.from(mac);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
      const obj = JSON.parse(Buffer.from(data, "base64url").toString());
      return obj.exp && obj.exp > Date.now() ? obj : null;
    } catch {
      return null;
    }
  };

  const cookie = (name, value, maxAgeSec) =>
    `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
  const redirectUri = (req) => `${req.protocol}://${req.get("host")}/auth/callback`;

  const allowed = (email) => {
    const e = String(email || "").toLowerCase();
    return e.endsWith("@" + dom) || extra.has(e);
  };

  const page = (res, status, title, body) =>
    res
      .status(status)
      .set("Cache-Control", "no-store")
      .type("html")
      .send(
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Seating Check</title>` +
          `<body style="font-family:system-ui,sans-serif;background:#EDF1F2;color:#12202B;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px">` +
          `<div style="background:#fff;border:1px solid #D3DCDF;border-radius:12px;padding:24px;max-width:420px"><h1 style="font-size:20px;margin:0 0 8px">${title}</h1>` +
          `<p style="color:#55656F;line-height:1.5;margin:0 0 16px">${body}</p><a href="/auth/login" style="color:#0E6E8C;font-weight:600">Sign in with Google</a></div></body>`
      );

  function login(req, res) {
    const state = b64url(crypto.randomBytes(16));
    const nonce = b64url(crypto.randomBytes(16));
    const next = typeof req.query.next === "string" && req.query.next.startsWith("/") && !req.query.next.startsWith("//") ? req.query.next : "/";
    res.set("Set-Cookie", cookie(FLOW_COOKIE, seal({ state, nonce, next, exp: Date.now() + 10 * 60_000 }), 600));
    const q = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri(req),
      response_type: "code",
      scope: "openid email",
      state,
      nonce,
      hd: dom, // Google shows only accounts from this domain; enforced again in the callback
      prompt: "select_account",
    });
    res.redirect(`${AUTH_URL}?${q}`);
  }

  async function callback(req, res) {
    const flow = unseal(parseCookies(req.headers.cookie)[FLOW_COOKIE]);
    res.append("Set-Cookie", cookie(FLOW_COOKIE, "", 0));
    if (!flow || typeof req.query.state !== "string" || req.query.state !== flow.state || typeof req.query.code !== "string") {
      return page(res, 400, "Sign-in didn't complete", "The sign-in link expired or was opened in a different browser. Start again.");
    }
    let claims;
    try {
      const r = await fetch(tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code: req.query.code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri(req),
          grant_type: "authorization_code",
        }),
      });
      if (!r.ok) throw new Error(`token status ${r.status}`);
      const { id_token } = await r.json();
      claims = JSON.parse(Buffer.from(String(id_token).split(".")[1], "base64url").toString());
    } catch (e) {
      console.error("google sign-in failed:", e.message); // no tokens or emails in logs
      return page(res, 502, "Sign-in didn't complete", "Google didn't confirm the sign-in. Try again in a moment.");
    }
    const okIssuer = claims.iss === "https://accounts.google.com" || claims.iss === "accounts.google.com";
    const okAud = claims.aud === clientId;
    const okTime = Number(claims.exp) * 1000 > Date.now();
    if (!okIssuer || !okAud || !okTime || claims.nonce !== flow.nonce || claims.email_verified !== true) {
      return page(res, 401, "Sign-in didn't complete", "Google's answer didn't check out. Start again.");
    }
    if (!allowed(claims.email)) {
      return page(res, 403, "This account can't use Seating Check", `Sign in with your @${dom} Google account.`);
    }
    res.append("Set-Cookie", cookie(SESSION_COOKIE, seal({ email: claims.email, exp: Date.now() + SESSION_HOURS * 3600_000 }), SESSION_HOURS * 3600));
    res.redirect(flow.next || "/");
  }

  function logout(_req, res) {
    res.set("Set-Cookie", cookie(SESSION_COOKIE, "", 0));
    page(res, 200, "Signed out", "You're signed out of Seating Check.");
  }

  // Everything except /healthz and /auth/* needs a session.
  function guard(req, res, next) {
    if (req.path === "/healthz" || req.path.startsWith("/auth/")) return next();
    const s = unseal(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    if (s && allowed(s.email)) {
      req.userEmail = s.email;
      return next();
    }
    if (req.path.startsWith("/api/")) {
      return res.status(401).json({ error: "Your sign-in has expired. Reload the page to sign in again." });
    }
    res.redirect(`/auth/login?next=${encodeURIComponent(req.originalUrl)}`);
  }

  return { login, callback, logout, guard, _seal: seal };
}
