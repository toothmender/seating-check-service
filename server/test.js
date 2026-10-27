// Smoke test with a stubbed Anthropic API. Run: npm test (from /server, after npm install)
import http from "node:http";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";

const JPEG = "/9j/" + "A".repeat(400);
let lastUpstreamBody = null;

const reply = (obj, stop = "end_turn") => ({ content: [{ type: "text", text: JSON.stringify(obj) }], stop_reason: stop });

const stub = http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    lastUpstreamBody = JSON.parse(b);
    const sys = lastUpstreamBody.system || "";
    let out;
    if (sys.startsWith("You find the region")) out = reply({ found: true, box: { x: 0.3, y: 0.2, w: 0.2, h: 0.4 } });
    else if (process.env.STUB_MODE === "cut") out = { content: [{ type: "text", text: '{"image_type":"xray","verdict":"cannot_determine","confidence":"low","summary":"s","findings":[{"severity":"watch","title":"t","detail":"d","box":null},{"severity":"problem","title":"x","detail":"cut' }], stop_reason: "max_tokens" };
    else
      out = reply({
        image_type: "photo",
        verdict: "seated",
        confidence: "high",
        summary: "ok",
        angulation: { rating: "poor", note: "oblique" },
        findings: [{ severity: "watch", title: "a", detail: "b", box: null }],
        fixes: [],
        better_image: [],
      });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(out));
  });
});
await new Promise((r) => stub.listen(9911, r));

async function run(mode) {
  process.env.STUB_MODE = mode; // the stub (this process) reads it
  const p = spawn("node", ["server.js"], {
    env: { ...process.env, ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: "http://localhost:9911", PORT: "8099", STATIC_DIR: "./", STUB_MODE: mode, ACCESS_PASSWORD: "pw", ACCESS_USER: "u" },
    stdio: "ignore",
  });
  await new Promise((r) => setTimeout(r, 800));
  const auth = { Authorization: "Basic " + Buffer.from("u:pw").toString("base64"), "content-type": "application/json" };
  const post = (path, body, h = auth) => fetch("http://localhost:8099" + path, { method: "POST", headers: h, body: JSON.stringify(body) });
  try {
    // auth required
    assert.equal((await post("/api/locate", { image: JPEG }, { "content-type": "application/json" })).status, 401);
    // input validation
    assert.equal((await post("/api/review", { image: "not-a-jpeg" })).status, 400);
    assert.equal((await post("/api/review", { image: JPEG, mode: "bogus" })).status, 400);
    // locate
    const loc = await (await post("/api/locate", { image: JPEG })).json();
    assert.equal(loc.found, true);
    // review + guardrails
    const r = await post("/api/review", { image: JPEG, crop: JPEG, mode: "auto", system: "Dess scan body", platform: "NC" });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("cache-control"), "no-store");
    const j = await r.json();
    if (mode === "cut") {
      assert.equal(j._partial, true);
      assert.equal(j.findings.length, 1);
    } else {
      assert.equal(j.verdict, "cannot_determine"); // poor angle blocks "seated"
      assert.equal(j.confidence, "low");
    }
    assert.ok(lastUpstreamBody.messages[0].content.some((c) => c.type === "image"));
    assert.equal(lastUpstreamBody.model, "claude-sonnet-4-6");
    console.log(`ok (${mode})`);
  } finally {
    p.kill();
  }
}
await run("normal");
await run("cut");
stub.close();
console.log("all tests passed");
