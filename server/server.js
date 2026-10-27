import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { KNOWLEDGE, LOCATE_PROMPT } from "./prompts.js";
import { parseJson } from "./jsonrepair.js";
import { createGoogleAuth } from "./googleauth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  ANTHROPIC_API_KEY,
  ANTHROPIC_MODEL = "claude-sonnet-4-6",
  ANTHROPIC_BASE_URL = "https://api.anthropic.com",
  PORT = "8080",
  STATIC_DIR = path.join(__dirname, "public"),
  ACCESS_USER = "",
  ACCESS_PASSWORD = "",
  RATE_LIMIT_PER_MIN = "20",
  MAX_OUTPUT_TOKENS = "1800",
  GOOGLE_CLIENT_ID = "",
  GOOGLE_CLIENT_SECRET = "",
  ALLOWED_EMAIL_DOMAIN = "",
  ALLOWED_EMAILS = "",
  SESSION_SECRET = "",
  GOOGLE_TOKEN_URL = "",
} = process.env;

if (!ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set. Refusing to start.");
  process.exit(1);
}

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "img-src": ["'self'", "data:"],
        "connect-src": ["'self'"],
        // 'wasm-unsafe-eval' lets the in-browser text detector (WebAssembly) run; it does not
        // enable eval() of strings. The detector's worker is loaded from this same origin.
        "script-src": ["'self'", "'wasm-unsafe-eval'"],
        "worker-src": ["'self'"],
        "style-src": ["'self'", "'unsafe-inline'"],
      },
    },
  })
);

// Sign-in. Google sign-in limited to one email domain takes priority when it's configured;
// otherwise the optional shared login applies.
if (GOOGLE_CLIENT_ID) {
  if (!GOOGLE_CLIENT_SECRET || !ALLOWED_EMAIL_DOMAIN) {
    console.error("GOOGLE_CLIENT_ID is set but GOOGLE_CLIENT_SECRET or ALLOWED_EMAIL_DOMAIN is missing. Refusing to start.");
    process.exit(1);
  }
  const google = createGoogleAuth({
    clientId: GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
    domain: ALLOWED_EMAIL_DOMAIN,
    sessionSecret: SESSION_SECRET,
    tokenUrl: GOOGLE_TOKEN_URL || undefined,
    allowEmails: ALLOWED_EMAILS.split(","),
  });
  app.get("/auth/login", google.login);
  app.get("/auth/callback", google.callback);
  app.get("/auth/logout", google.logout);
  app.use(google.guard);
} else if (ACCESS_PASSWORD) {
  app.use((req, res, next) => {
    if (req.path === "/healthz") return next();
    const h = req.headers.authorization || "";
    const [scheme, encoded] = h.split(" ");
    if (scheme === "Basic" && encoded) {
      const [u, ...rest] = Buffer.from(encoded, "base64").toString().split(":");
      const p = rest.join(":");
      const ok =
        timingSafe(u, ACCESS_USER) && timingSafe(p, ACCESS_PASSWORD);
      if (ok) return next();
    }
    res.set("WWW-Authenticate", 'Basic realm="Seating Check"');
    res.status(401).send("Authentication required");
  });
}

function timingSafe(a, b) {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

app.use(express.json({ limit: "14mb" }));

// Patient images must never be cached by browsers or proxies.
app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

app.use(
  "/api",
  rateLimit({
    windowMs: 60_000,
    limit: Number(RATE_LIMIT_PER_MIN),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests. Wait a minute and try again." },
  })
);

app.get("/healthz", (_req, res) => res.json({ ok: true }));

// ---- helpers ---------------------------------------------------------

const MAX_IMAGE_CHARS = 7_000_000; // ~5 MB of JPEG as base64

function validImage(b64) {
  return (
    typeof b64 === "string" &&
    b64.length > 100 &&
    b64.length < MAX_IMAGE_CHARS &&
    b64.startsWith("/9j/") && // JPEG magic bytes; the client always re-encodes to JPEG
    /^[A-Za-z0-9+/=]+$/.test(b64)
  );
}

const imageBlock = (data) => ({
  type: "image",
  source: { type: "base64", media_type: "image/jpeg", data },
});

async function callClaude(system, content) {
  const r = await fetch(`${ANTHROPIC_BASE_URL}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: Number(MAX_OUTPUT_TOKENS),
      system,
      messages: [{ role: "user", content }],
    }),
  });
  let data = null;
  try {
    data = await r.json();
  } catch {
    data = null;
  }
  if (!r.ok) {
    // Log the status only. Never log request bodies (they contain patient images).
    console.error(`upstream error status=${r.status}`);
    const e = new Error("The review service is unavailable. Try again shortly.");
    e.status = 502;
    throw e;
  }
  return data;
}

const textOf = (data) =>
  (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

const clamp = (n) => Math.max(0, Math.min(1, Number(n) || 0));

// ---- routes ----------------------------------------------------------

app.post("/api/locate", async (req, res) => {
  const { image } = req.body || {};
  if (!validImage(image)) return res.status(400).json({ error: "Send the image as a JPEG." });
  try {
    const data = await callClaude(LOCATE_PROMPT, [
      imageBlock(image),
      { type: "text", text: "Locate the region." },
    ]);
    const j = parseJson(textOf(data));
    if (!j.found || !j.box) return res.json({ found: false });
    res.json({
      found: true,
      box: { x: clamp(j.box.x), y: clamp(j.box.y), w: clamp(j.box.w), h: clamp(j.box.h) },
    });
  } catch (e) {
    // Locating is an optimisation; the client falls back to the full image.
    res.status(e.status || 500).json({ error: e.message || "Locate failed." });
  }
});

const MODES = { auto: "Detect whether this is a clinical photo or an X-ray.", photo: "The user says this is an intraoral clinical photo.", xray: "The user says this is a periapical X-ray." };

app.post("/api/review", async (req, res) => {
  const { image, crop, mode = "auto", system = "Not sure / other", platform = "" } = req.body || {};
  if (!validImage(image)) return res.status(400).json({ error: "Send the image as a JPEG." });
  if (crop != null && !validImage(crop)) return res.status(400).json({ error: "Invalid crop image." });
  if (!MODES[mode]) return res.status(400).json({ error: "Invalid image type." });
  const sys = String(system).slice(0, 80);
  const plat = String(platform).slice(0, 80);

  const content = [
    { type: "text", text: "Image 1: full image." },
    imageBlock(image),
  ];
  if (crop) {
    content.push({ type: "text", text: "Image 2: enlarged crop of the implant area." });
    content.push(imageBlock(crop));
  }
  content.push({
    type: "text",
    text: `${MODES[mode]} Scan body system reported by user: ${sys}. Implant brand/platform reported by user: ${plat || "not given"}. ${
      crop ? "Box coordinates are relative to Image 2." : "Box coordinates are relative to Image 1."
    } Rate image angulation first, then evaluate seating. Return the JSON object only.`,
  });

  try {
    const data = await callClaude(KNOWLEDGE, content);
    const parsed = parseJson(textOf(data));
    if (data.stop_reason === "max_tokens") parsed._partial = true;
    parsed.findings = Array.isArray(parsed.findings) ? parsed.findings : [];
    parsed.fixes = Array.isArray(parsed.fixes) ? parsed.fixes : [];
    parsed.better_image = Array.isArray(parsed.better_image) ? parsed.better_image : [];

    // Guardrails: enforced here so the browser cannot weaken them
    const ang = parsed.angulation && parsed.angulation.rating;
    if (parsed.image_type === "photo" && parsed.verdict === "seated" && parsed.confidence === "high") {
      parsed.confidence = "medium"; // a photo cannot exclude a gap at the platform
    }
    if (ang === "poor" && parsed.verdict === "seated") {
      parsed.verdict = "cannot_determine";
      parsed.confidence = "low";
    } else if (ang === "limited" && parsed.confidence === "high") {
      parsed.confidence = "medium";
    }
    res.json(parsed);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status === 502 ? e.message : "The review could not be completed. Try again." });
  }
});

// ---- static client ---------------------------------------------------

app.use(express.static(STATIC_DIR, { index: "index.html" }));
app.get("*", (_req, res) => res.sendFile(path.join(STATIC_DIR, "index.html")));

app.use((err, _req, res, _next) => {
  if (err && err.type === "entity.too.large") return res.status(413).json({ error: "Image is too large." });
  console.error("unhandled error");
  res.status(500).json({ error: "Something went wrong." });
});

app.listen(Number(PORT), () => console.log(`Seating Check listening on ${PORT}`));
