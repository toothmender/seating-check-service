# Seating Check service

Standalone web service for the scan body seating checker. A browser UI plus a small Node backend that keeps the API key and review rules on the server. Built to sit outside the vibe-apps platform and be linked from implant-information.dandy-vibes.com.

## What it does
1. The browser resizes the image and asks `/api/locate` for the implant area.
2. It crops and enlarges that area, then calls `/api/review` with the full image and the crop.
3. The server runs the review prompt, repairs cut-off output, applies guardrails (poor angle can't return "seated"; photos can't be high-confidence "seated"), and returns the result.
4. The browser shows the verdict, numbered findings on the image, and fix steps.

Nothing is written to disk. Request bodies are never logged. API responses are `Cache-Control: no-store`.

## Run locally
```bash
cd client && npm install && npm run build && cp -r dist ../server/public && cd ..
cd server && npm install
ANTHROPIC_API_KEY=sk-... npm start        # http://localhost:8080
npm test                                  # smoke tests with a stubbed API, no key needed
```
For UI work: run the server, then `cd client && npm run dev`.

## Deploy
```bash
docker build -t seating-check .
docker run -p 8080:8080 --env-file .env seating-check
```
Any container host works (Cloud Run, ECS, Fly, Kubernetes). Copy `.env.example` to `.env` and fill it in. Store the key in your host's secret manager, not in the image.

## Sign-in (Google, @meetdandy.com only)

When `GOOGLE_CLIENT_ID` is set, every page and API route requires signing in with a Google account on `ALLOWED_EMAIL_DOMAIN` (default in `render.yaml`: `meetdandy.com`). Only `/healthz` stays open. Code is in `server/googleauth.js`; there are no extra dependencies.

- Settings: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ALLOWED_EMAIL_DOMAIN`, `SESSION_SECRET` (any long random string; Render generates it). Optional: `ALLOWED_EMAILS`, a comma-separated list of extra addresses outside the domain.
- Google Cloud: create an OAuth client of type "Web application" with these redirect URIs: `https://seating-check.onrender.com/auth/callback` and `https://app.seatingcheck.com/auth/callback`. An "Internal" consent screen in the meetdandy.com Workspace is best; the server checks the domain either way.
- The server checks issuer, audience, expiry, nonce, `email_verified` and the domain before creating a session. Sessions are HMAC-signed, HttpOnly, Secure cookies that last 12 hours. Sign out at `/auth/logout`.
- If `GOOGLE_CLIENT_ID` is not set, the shared `ACCESS_USER`/`ACCESS_PASSWORD` login applies as before.
- `npm test` runs `authtest.js` against a stubbed Google token endpoint.

## Redaction step (runs before every review)

Every image goes through an in-browser redaction screen before it is read for the seating check, whether it arrives by picker, drag-and-drop or paste. Nothing on that screen talks to the server.

- Hidden file data (EXIF, GPS, dates, device details) is dropped by re-drawing the image onto a canvas. The screen lists what the original contained.
- Text burned into the picture is found with Tesseract (WebAssembly, in a local Web Worker) and covered with solid black boxes. Detection runs twice, normal and inverted, because X-ray labels are usually light text on a dark field.
- The person can add boxes by hand, remove or undo, and must tick a confirmation before the "Use redacted image" button unlocks. Any later change clears the tick.
- Only the redacted PNG is passed on. The original file is dropped when the step ends, and the redacted copy is named `redacted-image-N.png`, never the original file name. `prepareImage()` in `client/src/App.jsx` is only ever called with that redacted copy; keep it that way.

What it does **not** do: it cannot anonymize full-face photos, detection misses things, and the human review is the real control. It lowers risk; it does not replace the review and agreements below.

Implementation notes:

- Code is in `client/src/redaction/`. The OCR worker, WASM core and English model are bundled in `client/public/tesseract/` and served from this service. Nothing loads from a CDN.
- `tesseract.js` is pinned to `7.0.0` in `client/package.json` **on purpose**: the bundled core files must match that version. If you upgrade it, replace the files in `client/public/tesseract/` with the matching `tesseract.js-core` and worker from the new version.
- `server/server.js` CSP gained `'wasm-unsafe-eval'` in `script-src` (needed to run WebAssembly; it does not allow `eval()` of strings) and `worker-src 'self'`.
- Not supported: DICOM, TIFF/HEIC (same as before), non-English text.

## Before real patient images go through it
This is a prototype. Get these settled first:
- **Security/compliance review** by whoever owns that at Dandy. Radiographs and clinical photos are likely patient data.
- **Agreements:** confirm what data-processing or business-associate terms are available and signed with Anthropic and with the hosting provider, and what retention applies to API traffic.
- **Access control:** put the service behind SSO or an identity-aware proxy. `ACCESS_USER`/`ACCESS_PASSWORD` is only a stopgap shared login.
- **HTTPS only,** and no analytics or third-party scripts on the page.
- **Logging:** keep the current behavior (status codes only). Do not add request or image logging.
- **Validation:** test against labelled cases (see the build plan's evaluation section) before anyone relies on it. Include the screw-channel false positive, tapered bases, wrong-size bodies and angled images.

## Linking from implant-information
Add a plain link or button in that app that opens this service's URL. A link carries no patient data, so it doesn't change that app's data profile.

## Known limits
- JPEG/PNG/WebP/BMP only in the browser. DICOM and HEIC conversion are listed in the build plan.
- Only Straumann has product-specific rules built in. Other systems use the general criteria.
- Not run against the live Anthropic API or real images yet; only against a stub.

## Files
- `client/` React UI (Vite). `client/src/App.jsx` is the app.
- `server/server.js` routes, validation, guardrails. `server/prompts.js` review rules (edit here to improve accuracy). `server/jsonrepair.js` output parsing.
- `server/test.js` smoke tests.
