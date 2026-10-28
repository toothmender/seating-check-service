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
    const s = lastUpstreamBody.system || "";
    const sys = typeof s === "string" ? s : s.map((b) => b.text).join("");
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
    // Rules are sent cacheable; the category sheet comes first and is cacheable too.
    assert.equal(lastUpstreamBody.system[0].cache_control.type, "ephemeral");
    assert.match(lastUpstreamBody.system[0].text, /DANDY SEATING CATEGORIES/);
    const first = lastUpstreamBody.messages[0].content;
    assert.match(first[0].text, /Reference sheet/);
    assert.equal(first[1].type, "image");
    assert.equal(first[1].cache_control.type, "ephemeral");

    if (mode === "normal") {
      // Category follows the verdict (the guardrail turned "seated" into cannot_determine).
      assert.equal(j.dandy_category, "cannot_determine");

      // Catalog for the screen.
      const cat = await (await fetch("http://localhost:8099/api/catalog", { headers: auth })).json();
      const straumann = cat.manufacturers.find((m) => m.manufacturer === "Straumann");
      const rc = straumann.platforms.find((p) => p.platform === "BL RC");
      assert.equal(rc.id, "straumann-bl-rc");
      assert.ok(rc.references.length >= 2);
      assert.equal(cat.manufacturers.length, 22);

      // Reference images are served; anything else is refused.
      const img = await fetch(`http://localhost:8099/api/reference/${rc.references[0].file}`, { headers: auth });
      assert.equal(img.status, 200);
      assert.equal(img.headers.get("content-type"), "image/jpeg");
      assert.equal((await fetch("http://localhost:8099/api/reference/..%2Fcatalog.json", { headers: auth })).status, 404);
      assert.equal((await fetch("http://localhost:8099/api/reference/criteria_sheet.jpg", { headers: auth })).status, 404);

      // Choosing a platform adds its references (same scan body family first) and Dandy's list.
      const r2 = await (await post("/api/review", { image: JPEG, crop: JPEG, system: "3Shape scan body", platformId: "straumann-bl-rc" })).json();
      const content = lastUpstreamBody.messages[0].content;
      const refTexts = content.filter((c) => c.type === "text" && /^Platform reference/.test(c.text));
      assert.equal(refTexts.length, 2);
      assert.match(refTexts[0].text, /3Shape on Straumann BL RC/);
      assert.equal(content.filter((c) => c.type === "image").length, 5); // sheet + full + crop + 2 refs
      const last = content[content.length - 1].text;
      assert.match(last, /Straumann BL RC/);
      assert.match(last, /is in that list/);
      assert.equal(r2._references.length, 2);

      // A scan body type the guide doesn't list for the platform is flagged to the reviewer.
      await post("/api/review", { image: JPEG, system: "Dess scan body", platformId: "straumann-blx-rb" });
      const last2 = lastUpstreamBody.messages[0].content.at(-1).text;
      assert.match(last2, /is NOT in that list/);

      // TSV gets the bevel reminder; an unknown platform id is ignored safely.
      await post("/api/review", { image: JPEG, system: "3Shape scan body", platformId: "zimvie-zimmer-biomet-tsv-4-5" });
      assert.match(lastUpstreamBody.messages[0].content.at(-1).text, /bevel exception/);
      const r3 = await (await post("/api/review", { image: JPEG, platformId: "../../etc/passwd", platform: "Something 4.0" })).json();
      assert.equal(r3._references.length, 0);
      assert.match(lastUpstreamBody.messages[0].content.at(-1).text, /Something 4\.0/);
    }
    console.log(`ok (${mode})`);
  } finally {
    p.kill();
  }
}
await run("normal");
await run("cut");
stub.close();
console.log("all tests passed");
