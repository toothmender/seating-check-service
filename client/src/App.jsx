import { useState, useRef, useEffect } from "react";
import {
  ImagePlus,
  CheckCircle2,
  AlertTriangle,
  HelpCircle,
  RotateCcw,
  ScanLine,
  Loader2,
} from "lucide-react";
import RedactionStep from "./redaction/RedactionStep.jsx";
import { terminateOcr } from "./redaction/ocr.js";

/* ------------------------------------------------------------------ */
/* Knowledge base distilled from the supplied sources                  */
/* ------------------------------------------------------------------ */

const SYSTEMS = [
  "Not sure / other",
  "Authentic manufacturer (OEM) scan body",
  "3Shape scan body",
  "Dess scan body",
  "TruAbutment scan body",
  "Dandy scan body",
  "Straumann CARES Mono Scanbody (2-piece)",
  "Straumann Scanbody (3-piece, post + cap)",
];

// How the scan body choices above map onto the families in Dandy's scan body guide.
const SYSTEM_FAMILY = {
  "Authentic manufacturer (OEM) scan body": "authentic",
  "3Shape scan body": "3shape",
  "Dess scan body": "dess",
  "TruAbutment scan body": "truabutment",
  "Straumann CARES Mono Scanbody (2-piece)": "authentic",
  "Straumann Scanbody (3-piece, post + cap)": "authentic",
};
const FAMILY_NAME = { authentic: "manufacturer (OEM)", "3shape": "3Shape", dess: "Dess", truabutment: "TruAbutment", other: "other" };
const OTHER = "__other";

// Dandy's seating categories, as the implant technicians name them.
const CATEGORY = {
  fully_seated: "Fully seated",
  slightly_lifted: "Slightly lifted",
  lifted_or_lifted_rotated: "Lifted / lifted and rotated",
  incorrect_scan_body: "Incorrect scan body",
};

/* ------------------------------------------------------------------ */
/* Palette                                                             */
/* ------------------------------------------------------------------ */

const C = {
  ink: "#12202B",
  paper: "#EDF1F2",
  panel: "#FFFFFF",
  line: "#D3DCDF",
  muted: "#55656F",
  accent: "#0E6E8C",
  ok: "#17744F",
  okBg: "#E1F2E8",
  watch: "#8F6100",
  watchBg: "#FAEFD2",
  bad: "#A82F27",
  badBg: "#F9E3E0",
  unk: "#3A5263",
  unkBg: "#E2E9EE",
};

const VERDICTS = {
  seated: { label: "Looks fully seated", fg: C.ok, bg: C.okBg, Icon: CheckCircle2 },
  likely_not_seated: { label: "Likely not fully seated", fg: C.bad, bg: C.badBg, Icon: AlertTriangle },
  cannot_determine: { label: "Can't confirm from this image", fg: C.unk, bg: C.unkBg, Icon: HelpCircle },
};

const SEV = {
  problem: { color: C.bad, bg: C.badBg, word: "Problem" },
  watch: { color: C.watch, bg: C.watchBg, word: "Check" },
  ok: { color: C.ok, bg: C.okBg, word: "Good" },
};

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function renderJpeg(img, maxEdge, quality) {
  const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(img.width * scale));
  c.height = Math.max(1, Math.round(img.height * scale));
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff"; // flatten transparency (PNG) before JPEG encoding
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", quality);
}

const loadImg = (src) =>
  new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error("Image could not be loaded."));
    i.src = src;
  });

async function prepareImage(file) {
  const name = (file.name || "").toLowerCase();
  if (name.endsWith(".dcm") || file.type === "application/dicom") {
    throw new Error("DICOM files aren't supported in this prototype. Export the X-ray as JPG or PNG first.");
  }
  // Read with FileReader (data URL). Blob URLs can be blocked inside embedded viewers.
  const raw = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(new Error("The file couldn't be read. Try saving a fresh copy and uploading again."));
    r.readAsDataURL(file);
  });
  let img;
  try {
    img = await loadImg(raw);
  } catch (e) {
    throw new Error(
      /\.(heic|heif|tif|tiff)$/.test(name)
        ? "This browser can't open HEIC/TIFF files. Convert to JPG or PNG, or open the app in Safari."
        : "The browser couldn't decode this image. Try re-saving it as a standard PNG or JPG."
    );
  }
  const dataUrl = renderJpeg(img, 1568, 0.92);
  const full = renderJpeg(img, 2400, 0.92); // kept for the zoomed second look
  return { dataUrl, base64: dataUrl.split(",")[1], full };
}

// Cut out the implant region from the high-resolution copy and enlarge it.
async function cropRegion(fullUrl, box) {
  const pad = 0.3;
  let x = box.x - box.w * pad;
  let y = box.y - box.h * pad;
  let w = box.w * (1 + 2 * pad);
  let h = box.h * (1 + 2 * pad);
  x = Math.max(0, x);
  y = Math.max(0, y);
  w = Math.min(1 - x, w);
  h = Math.min(1 - y, h);
  if (w * h > 0.65) return null; // crop would add little
  const img = await loadImg(fullUrl);
  const sx = x * img.width;
  const sy = y * img.height;
  const sw = w * img.width;
  const sh = h * img.height;
  const scale = Math.min(2, 1568 / Math.max(sw, sh));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(sw * scale));
  c.height = Math.max(1, Math.round(sh * scale));
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return { base64: c.toDataURL("image/jpeg", 0.92).split(",")[1], region: { x, y, w, h } };
}

async function postJson(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
  let data = null;
  try {
    data = await r.json();
  } catch (e) {
    data = null;
  }
  if (!r.ok) throw new Error((data && data.error) || `Request failed (${r.status})`);
  return data;
}

const clamp = (n) => Math.max(0, Math.min(1, Number(n) || 0));

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

export default function SeatingCheck() {
  const [items, setItems] = useState([]);
  const [selId, setSelId] = useState(null);
  const [mode, setMode] = useState("auto");
  const [system, setSystem] = useState(SYSTEMS[0]);
  const [platform, setPlatform] = useState(""); // free text, for implants not in the guide
  const [catalog, setCatalog] = useState(null); // Dandy's scan body guide
  const [mfr, setMfr] = useState("");
  const [platId, setPlatId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [active, setActive] = useState(null);
  const [dragging, setDragging] = useState(false);
  // Images waiting for the mandatory redaction step. Raw files never reach prepareImage().
  const [queue, setQueue] = useState([]);
  const fileRef = useRef(null);
  const idRef = useRef(0);
  const queueSeq = useRef(0);

  // Load the manufacturer/platform list from Dandy's guide. Without it, the free-text field is used.
  useEffect(() => {
    let live = true;
    fetch("/api/catalog", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((c) => live && c && c.manufacturers && c.manufacturers.length && setCatalog(c))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const mfrEntry = catalog && mfr && mfr !== OTHER ? catalog.manufacturers.find((m) => m.manufacturer === mfr) : null;
  const plat = mfrEntry ? mfrEntry.platforms.find((p) => p.id === platId) || null : null;
  const useFreeText = !catalog || mfr === OTHER;
  const family = SYSTEM_FAMILY[system] || null;
  const listedFamilies = plat ? new Set(plat.scan_bodies.map((s) => s.family)) : null;
  const notListed = !!(plat && family && plat.scan_bodies.length && !listedFamilies.has(family));
  const platRefs = plat
    ? [...plat.references].sort((a, b) => (b.family === family) - (a.family === family))
    : [];

  // Free the local text-detection worker once the redaction queue is empty.
  useEffect(() => {
    if (queue.length === 0) terminateOcr();
  }, [queue.length]);

  const img = items.find((it) => it.id === selId) || items[0] || null;
  const result = img ? img.result || null : null;
  const shownError = error || (img && img.failed) || "";

  const patchItem = (id, patch) =>
    setItems((list) => list.map((it) => (it.id === id ? { ...it, ...patch } : it)));

  const reset = () => {
    setItems([]);
    setSelId(null);
    setError("");
    setActive(null);
  };

  // Entry point for every way an image arrives (picker, drop, paste). It only QUEUES files for
  // redaction; nothing is read for review until the person has redacted and confirmed it.
  const addFiles = (fileList) => {
    const files = Array.from(fileList || []).filter(Boolean);
    if (!files.length) return;
    setError("");
    setActive(null);
    const room = Math.max(0, 12 - items.length - queue.length);
    if (files.length > room) setError("Only up to 12 images can be added at once.");
    if (room > 0) {
      const entries = files.slice(0, room).map((file) => ({ key: ++queueSeq.current, file }));
      setQueue((q) => [...q, ...entries]);
    }
  };

  // Called with the REDACTED copy only.
  const addRedacted = async (redacted) => {
    try {
      const p = await prepareImage(redacted);
      idRef.current += 1;
      const item = { id: idRef.current, name: redacted.name || "Redacted image", ...p, result: null, failed: "" };
      setItems((prev) => [...prev, item]);
      setSelId((cur) => cur || item.id);
    } catch (err) {
      setError(`${redacted.name || "Image"}: ${err.message || "couldn't be opened."}`);
    }
    setQueue((q) => q.slice(1));
  };

  const skipPending = (message) => {
    if (message) setError((e) => (e ? `${e} ${message}` : message));
    setQueue((q) => q.slice(1));
  };

  // Paste screenshots or copied images straight into the page
  useEffect(() => {
    const onPaste = (e) => {
      const files = Array.from((e.clipboardData && e.clipboardData.files) || []).filter((f) =>
        f.type.startsWith("image/")
      );
      if (files.length) {
        e.preventDefault();
        addFiles(files);
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  });

  const runReview = async (item) => {
    patchItem(item.id, { result: null, failed: "" });
    try {
      // Pass 1: find the implant area, then enlarge it for a closer second look
      let crop = null;
      try {
        const lj = await postJson("/api/locate", { image: item.base64 });
        if (lj.found && lj.box) {
          const b = { x: clamp(lj.box.x), y: clamp(lj.box.y), w: clamp(lj.box.w), h: clamp(lj.box.h) };
          if (b.w > 0.03 && b.h > 0.03) crop = await cropRegion(item.full, b);
        }
      } catch (e) {
        crop = null; // fall back to the full image only
      }

      // Pass 2: the seating review (prompts, parsing and guardrails run on the server)
      const parsed = await postJson("/api/review", {
        image: item.base64,
        crop: crop ? crop.base64 : null,
        mode,
        system,
        platformId: plat ? plat.id : "",
        platform: plat ? "" : useFreeText ? platform.trim() : mfr,
      });

      // Map boxes from the crop back onto the full image
      if (crop) {
        const r = crop.region;
        parsed.findings = parsed.findings.map((f) =>
          f.box
            ? {
                ...f,
                box: {
                  x: r.x + clamp(f.box.x) * r.w,
                  y: r.y + clamp(f.box.y) * r.h,
                  w: clamp(f.box.w) * r.w,
                  h: clamp(f.box.h) * r.h,
                },
              }
            : f
        );
      }
      parsed._zoomed = !!crop;
      patchItem(item.id, { result: parsed });
    } catch (err) {
      patchItem(item.id, {
        failed:
          "Couldn't complete the review. " + (err && err.message ? err.message : "") + " Try again; if it keeps happening, check your connection.",
      });
    }
  };

  const analyze = async () => {
    if (!img) return;
    setBusy(true);
    setError("");
    setActive(null);
    await runReview(img);
    setBusy(false);
  };

  const analyzeAll = async () => {
    setBusy(true);
    setError("");
    setActive(null);
    for (const it of items) {
      if (!it.result) await runReview(it);
    }
    setBusy(false);
  };

  const pending = items.filter((it) => !it.result).length;

  const verdict = result && (VERDICTS[result.verdict] || VERDICTS.cannot_determine);
  const needsXray =
    result &&
    result.image_type !== "xray" &&
    result.verdict !== "likely_not_seated";

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        addFiles(e.dataTransfer.files);
      }}
      style={{
        background: C.paper,
        minHeight: "100vh",
        color: C.ink,
        fontFamily: "'Avenir Next','Segoe UI',system-ui,sans-serif",
        outline: dragging ? `3px dashed ${C.accent}` : "none",
        outlineOffset: -8,
      }}
    >
      {queue.length > 0 && (
        <RedactionStep
          key={queue[0].key}
          file={queue[0].file}
          index={idRef.current + 1}
          remaining={queue.length - 1}
          onConfirm={addRedacted}
          onCancel={() => skipPending("")}
          onError={skipPending}
        />
      )}
      <div style={{ maxWidth: 560, margin: "0 auto", padding: "20px 16px 48px" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
          <ScanLine size={26} color={C.accent} />
          <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, letterSpacing: "-0.01em" }}>Seating Check</h1>
        </div>
        <p style={{ margin: "0 0 18px", color: C.muted, fontSize: 15, lineHeight: 1.45 }}>
          Upload a photo or periapical X-ray of an implant scan body. You'll get a read on seating, what looks off, and how to fix it.
        </p>

        {/* Controls */}
        <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, padding: 14, marginBottom: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Image type</div>
          <div role="group" aria-label="Image type" style={{ display: "flex", border: `1px solid ${C.line}`, borderRadius: 8, overflow: "hidden", marginBottom: 12 }}>
            {[
              ["auto", "Auto-detect"],
              ["photo", "Photo"],
              ["xray", "X-ray"],
            ].map(([v, l], i) => (
              <button
                key={v}
                onClick={() => setMode(v)}
                aria-pressed={mode === v}
                style={{
                  flex: 1,
                  padding: "10px 4px",
                  fontSize: 14,
                  fontWeight: 600,
                  border: "none",
                  borderLeft: i ? `1px solid ${C.line}` : "none",
                  background: mode === v ? C.ink : C.panel,
                  color: mode === v ? "#fff" : C.ink,
                  cursor: "pointer",
                }}
              >
                {l}
              </button>
            ))}
          </div>

          <label htmlFor="sys" style={{ fontSize: 13, fontWeight: 600, display: "block", marginBottom: 6 }}>
            Scan body system
          </label>
          <select
            id="sys"
            value={system}
            onChange={(e) => setSystem(e.target.value)}
            style={{ width: "100%", padding: "10px 8px", fontSize: 15, borderRadius: 8, border: `1px solid ${C.line}`, background: C.panel, color: C.ink }}
          >
            {SYSTEMS.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>

          {catalog && (
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 12 }}>
              <div style={{ flex: "1 1 200px", minWidth: 0 }}>
                <label htmlFor="mfr" style={{ fontSize: 13, fontWeight: 600, display: "block", marginBottom: 6 }}>
                  Implant manufacturer (optional)
                </label>
                <select
                  id="mfr"
                  value={mfr}
                  onChange={(e) => {
                    setMfr(e.target.value);
                    setPlatId("");
                  }}
                  style={{ width: "100%", padding: "10px 8px", fontSize: 15, borderRadius: 8, border: `1px solid ${C.line}`, background: C.panel, color: C.ink }}
                >
                  <option value="">Not sure</option>
                  {catalog.manufacturers.map((m) => (
                    <option key={m.manufacturer} value={m.manufacturer}>
                      {m.manufacturer}
                    </option>
                  ))}
                  <option value={OTHER}>Not listed (type it in)</option>
                </select>
              </div>
              {mfrEntry && (
                <div style={{ flex: "1 1 200px", minWidth: 0 }}>
                  <label htmlFor="platsel" style={{ fontSize: 13, fontWeight: 600, display: "block", marginBottom: 6 }}>
                    Platform
                  </label>
                  <select
                    id="platsel"
                    value={platId}
                    onChange={(e) => setPlatId(e.target.value)}
                    style={{ width: "100%", padding: "10px 8px", fontSize: 15, borderRadius: 8, border: `1px solid ${C.line}`, background: C.panel, color: C.ink }}
                  >
                    <option value="">Not sure</option>
                    {mfrEntry.platforms.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.platform}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )}

          {useFreeText && (
            <>
              <label htmlFor="plat" style={{ fontSize: 13, fontWeight: 600, display: "block", margin: "12px 0 6px" }}>
                Implant brand and platform (optional)
              </label>
              <input
                id="plat"
                type="text"
                value={platform}
                onChange={(e) => setPlatform(e.target.value)}
                placeholder="e.g. Straumann BLX RB, Zimmer TSV 4.5"
                style={{ width: "100%", boxSizing: "border-box", padding: "10px 8px", fontSize: 15, borderRadius: 8, border: `1px solid ${C.line}`, background: C.panel, color: C.ink }}
              />
            </>
          )}

          {plat && (
            <div style={{ marginTop: 10, fontSize: 13, lineHeight: 1.45, color: C.muted }}>
              {plat.scan_bodies.length ? (
                <>
                  Dandy's guide has these scan bodies on file for {plat.platform}:{" "}
                  <span style={{ color: C.ink }}>{plat.scan_bodies.map((s) => s.name).join(", ")}</span>.
                </>
              ) : (
                <>Dandy's guide has no scan bodies on file for {plat.platform}.</>
              )}
              {notListed && (
                <div role="note" style={{ marginTop: 8, background: C.watchBg, color: C.watch, borderRadius: 8, padding: "8px 10px" }}>
                  There's no {FAMILY_NAME[family]} scan body for this platform in Dandy's guide. Check it's the right scan body for the implant
                  and the right library in the design software.
                </div>
              )}
              {/^TSV\b/.test(plat.platform) && (
                <div style={{ marginTop: 8 }}>
                  TSV implants have a bevel, so a gap often appears between scan body and implant. It's seated if the edges touch.
                </div>
              )}
              {platRefs.length > 0 && (
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontWeight: 600, color: C.ink, marginBottom: 6 }}>Reference X-rays from Dandy's guide</div>
                  <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 4 }}>
                    {platRefs.map((r) => (
                      <a
                        key={r.file}
                        href={`/api/reference/${r.file}`}
                        target="_blank"
                        rel="noreferrer"
                        title={`Open ${r.scan_body || "reference"} full size`}
                        style={{ flex: "0 0 auto", width: 92, textDecoration: "none", color: C.muted }}
                      >
                        <img
                          src={`/api/reference/${r.file}`}
                          alt={`${r.scan_body || "Scan body"} on ${plat.platform}`}
                          loading="lazy"
                          style={{
                            width: 92,
                            height: 120,
                            objectFit: "cover",
                            borderRadius: 6,
                            display: "block",
                            background: "#000",
                            border: `2px solid ${family && r.family === family ? C.accent : "transparent"}`,
                          }}
                        />
                        <span style={{ display: "block", fontSize: 11.5, lineHeight: 1.3, marginTop: 4 }}>{r.scan_body || "Unlabelled"}</span>
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {system !== SYSTEMS[0] && !system.startsWith("Straumann") && !plat && (
            <p style={{ fontSize: 12.5, color: C.muted, margin: "8px 0 0", lineHeight: 1.45 }}>
              Manufacturer-specific rules are built in for Straumann only. Pick the implant platform to compare against Dandy's
              reference X-rays; otherwise the check uses general seating criteria.
            </p>
          )}
        </div>

        {/* Upload / preview */}
        <input
          ref={fileRef}
          type="file"
          multiple
          accept="image/*,.heic,.heif,.tif,.tiff,.bmp,.webp"
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = "";
          }}
          style={{ display: "none" }}
        />
        {items.length === 0 ? (
          <button
            onClick={() => fileRef.current && fileRef.current.click()}
            style={{
              width: "100%",
              padding: "36px 16px",
              background: C.panel,
              border: `2px dashed ${C.accent}`,
              borderRadius: 12,
              color: C.accent,
              fontSize: 16,
              fontWeight: 600,
              cursor: "pointer",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 8,
            }}
          >
            <ImagePlus size={32} />
            Choose, drop or paste images
            <span style={{ fontSize: 13, fontWeight: 400, color: C.muted, lineHeight: 1.4 }}>
              JPG, PNG, WebP or BMP, up to 12 at once. Use the original image file, not a screenshot or a re-sent copy, for the sharpest result.
            </span>
          </button>
        ) : (
          <div style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 8, marginBottom: 4 }}>
              {items.map((it) => {
                const v = it.result && (VERDICTS[it.result.verdict] || VERDICTS.cannot_determine);
                const on = img && it.id === img.id;
                return (
                  <button
                    key={it.id}
                    onClick={() => {
                      setSelId(it.id);
                      setActive(null);
                    }}
                    aria-label={`Show ${it.name}`}
                    aria-pressed={on}
                    style={{
                      flex: "0 0 auto",
                      width: 64,
                      height: 64,
                      padding: 0,
                      borderRadius: 8,
                      overflow: "hidden",
                      position: "relative",
                      cursor: "pointer",
                      background: "#000",
                      border: `3px solid ${on ? C.accent : "transparent"}`,
                    }}
                  >
                    <img src={it.dataUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                    {v && (
                      <span
                        style={{ position: "absolute", right: 3, bottom: 3, width: 14, height: 14, borderRadius: 7, background: v.fg, border: "2px solid #fff" }}
                      />
                    )}
                  </button>
                );
              })}
              {items.length < 12 && (
                <button
                  onClick={() => fileRef.current && fileRef.current.click()}
                  aria-label="Add more images"
                  style={{ flex: "0 0 auto", width: 64, height: 64, borderRadius: 8, border: `2px dashed ${C.accent}`, background: C.panel, color: C.accent, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
                >
                  <ImagePlus size={22} />
                </button>
              )}
            </div>
            <div style={{ position: "relative", borderRadius: 12, overflow: "hidden", background: "#000", lineHeight: 0 }}>
              <img src={img.dataUrl} alt="Uploaded for review" style={{ width: "100%", display: "block" }} />
              {result &&
                result.findings.map((f, i) => {
                  if (!f.box || f.severity === "ok") return null;
                  const b = { x: clamp(f.box.x), y: clamp(f.box.y), w: clamp(f.box.w), h: clamp(f.box.h) };
                  const col = SEV[f.severity] ? SEV[f.severity].color : C.watch;
                  const on = active === i;
                  return (
                    <div
                      key={i}
                      style={{
                        position: "absolute",
                        left: `${b.x * 100}%`,
                        top: `${b.y * 100}%`,
                        width: `${b.w * 100}%`,
                        height: `${b.h * 100}%`,
                        border: `${on ? 3 : 2}px solid ${f.severity === "problem" ? "#FF6B5E" : "#FFC247"}`,
                        borderRadius: 6,
                        boxShadow: on ? "0 0 0 2000px rgba(0,0,0,0.35)" : "none",
                        pointerEvents: "none",
                        opacity: active === null || on ? 1 : 0.5,
                      }}
                    >
                      <span
                        role="button"
                        aria-label={`Finding ${i + 1}: ${f.title}`}
                        onClick={() => setActive(on ? null : i)}
                        style={{
                          position: "absolute",
                          top: b.y < 0.06 ? 2 : -13,
                          left: b.x < 0.04 ? 2 : -13,
                          width: 24,
                          height: 24,
                          lineHeight: "20px",
                          textAlign: "center",
                          borderRadius: 12,
                          fontSize: 13,
                          fontWeight: 800,
                          color: f.severity === "problem" ? "#fff" : "#2B1D00",
                          background: f.severity === "problem" ? "#D93A2E" : "#FFC247",
                          border: "2px solid #fff",
                          boxSizing: "border-box",
                          pointerEvents: "auto",
                          cursor: "pointer",
                          boxShadow: "0 1px 4px rgba(0,0,0,0.5)",
                        }}
                      >
                        {i + 1}
                      </span>
                    </div>
                  );
                })}
            </div>
            {result && result.findings.some((f) => f.box && f.severity !== "ok") && (
              <p style={{ fontSize: 12, color: C.muted, margin: "6px 2px 0" }}>
                Numbers match the findings below. Outlines are approximate. Tap a number to focus its area.
              </p>
            )}
            <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
              <button
                onClick={analyze}
                disabled={busy}
                style={{
                  flex: 1,
                  padding: "13px 12px",
                  fontSize: 16,
                  fontWeight: 700,
                  color: "#fff",
                  background: busy ? C.muted : C.accent,
                  border: "none",
                  borderRadius: 10,
                  cursor: busy ? "default" : "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                }}
              >
                {busy ? <Loader2 size={18} className="animate-spin" /> : null}
                {busy ? "Reviewing" : result ? "Review again" : "Check seating"}
              </button>
              {items.length > 1 && pending > 0 && (
                <button
                  onClick={analyzeAll}
                  disabled={busy}
                  style={{ padding: "0 12px", background: C.panel, border: `1px solid ${C.accent}`, borderRadius: 10, color: C.accent, cursor: busy ? "default" : "pointer", fontSize: 14, fontWeight: 700 }}
                >
                  Check all ({pending})
                </button>
              )}
              <button
                onClick={reset}
                aria-label="Start over with a new image"
                style={{ padding: "0 14px", background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10, color: C.ink, cursor: "pointer", display: "flex", alignItems: "center", gap: 6, fontSize: 14, fontWeight: 600 }}
              >
                <RotateCcw size={16} /> New
              </button>
            </div>
          </div>
        )}

        {shownError && (
          <div role="alert" style={{ background: C.badBg, color: C.bad, border: `1px solid ${C.bad}`, borderRadius: 10, padding: 12, fontSize: 14, margin: "12px 0" }}>
            {shownError}
          </div>
        )}

        {/* Result */}
        {result && (
          <div style={{ marginTop: 16 }}>
            {result.image_type === "not_scanbody" ? (
              <div style={{ background: C.unkBg, color: C.unk, borderRadius: 12, padding: 14 }}>
                <div style={{ fontWeight: 700, fontSize: 17, marginBottom: 4 }}>No scan body found</div>
                <div style={{ fontSize: 15, lineHeight: 1.45 }}>{result.summary}</div>
              </div>
            ) : (
              <>
                <div style={{ background: verdict.bg, color: verdict.fg, borderRadius: 12, padding: 14 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700, fontSize: 19 }}>
                    <verdict.Icon size={22} />
                    {verdict.label}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, margin: "8px 0", fontSize: 13, fontWeight: 600 }}>
                    <span>Confidence</span>
                    {["low", "medium", "high"].map((lvl, i) => {
                      const rank = { low: 0, medium: 1, high: 2 }[result.confidence] ?? 0;
                      return (
                        <span
                          key={lvl}
                          style={{ width: 28, height: 8, borderRadius: 4, background: i <= rank ? verdict.fg : "rgba(0,0,0,0.15)" }}
                        />
                      );
                    })}
                    <span style={{ fontWeight: 500 }}>{result.confidence}</span>
                  </div>
                  {CATEGORY[result.dandy_category] && (
                    <div style={{ margin: "0 0 8px", fontSize: 13, color: C.ink }}>
                      Dandy category:{" "}
                      <span style={{ fontWeight: 700, padding: "2px 8px", borderRadius: 6, background: "rgba(255,255,255,0.7)", color: verdict.fg }}>
                        {CATEGORY[result.dandy_category]}
                      </span>
                    </div>
                  )}
                  <div style={{ color: C.ink, fontSize: 15, lineHeight: 1.5 }}>{result.summary}</div>
                  {result.angulation && result.angulation.rating && (
                    <div style={{ marginTop: 8, fontSize: 13, color: C.ink, display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                      <span
                        style={{
                          fontWeight: 700,
                          padding: "2px 8px",
                          borderRadius: 6,
                          background: result.angulation.rating === "adequate" ? C.okBg : result.angulation.rating === "limited" ? C.watchBg : C.badBg,
                          color: result.angulation.rating === "adequate" ? C.ok : result.angulation.rating === "limited" ? C.watch : C.bad,
                        }}
                      >
                        Angle: {result.angulation.rating === "adequate" ? "good" : result.angulation.rating}
                      </span>
                      {result.angulation.note && <span style={{ color: C.muted }}>{result.angulation.note}</span>}
                    </div>
                  )}
                  {result.scan_body_description && (
                    <div style={{ color: C.muted, fontSize: 13, marginTop: 6 }}>
                      Seen: {result.scan_body_description}
                      {result.image_type === "photo" || result.image_type === "xray"
                        ? ` (${result.image_type === "xray" ? "X-ray" : "photo"})`
                        : ""}
                    </div>
                  )}
                </div>

                {result._partial && (
                  <div style={{ background: C.unkBg, color: C.unk, borderRadius: 10, padding: "10px 12px", marginTop: 10, fontSize: 14, lineHeight: 1.45 }}>
                    Part of this review was cut off, so some findings or steps may be missing. Tap Review again for the full list.
                  </div>
                )}

                {needsXray && (
                  <div style={{ background: C.watchBg, color: C.watch, borderRadius: 10, padding: "10px 12px", marginTop: 10, fontSize: 14, lineHeight: 1.45 }}>
                    A photo can't rule out a gap at the platform. If there's any doubt, confirm with a periapical X-ray before scanning.
                  </div>
                )}

                {/* Findings */}
                {result.findings.length > 0 && (
                  <section style={{ marginTop: 18 }}>
                    <h2 style={{ fontSize: 17, margin: "0 0 8px" }}>What I found</h2>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {result.findings.map((f, i) => {
                        const s = SEV[f.severity] || SEV.watch;
                        const on = active === i;
                        const clickable = !!f.box && f.severity !== "ok";
                        return (
                          <button
                            key={i}
                            onClick={() => clickable && setActive(on ? null : i)}
                            style={{
                              textAlign: "left",
                              background: C.panel,
                              border: `1px solid ${on ? s.color : C.line}`,
                              borderLeft: `5px solid ${s.color}`,
                              borderRadius: 10,
                              padding: "10px 12px",
                              cursor: clickable ? "pointer" : "default",
                              color: C.ink,
                            }}
                          >
                            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
                              <span
                                style={{
                                  flex: "0 0 auto",
                                  width: 24,
                                  height: 24,
                                  lineHeight: "24px",
                                  textAlign: "center",
                                  borderRadius: 12,
                                  fontSize: 13,
                                  fontWeight: 800,
                                  color: f.severity === "problem" ? "#fff" : f.severity === "watch" ? "#2B1D00" : "#fff",
                                  background: f.severity === "problem" ? "#D93A2E" : f.severity === "watch" ? "#FFC247" : C.ok,
                                }}
                              >
                                {i + 1}
                              </span>
                              <span style={{ fontWeight: 700, fontSize: 15, flex: 1 }}>{f.title}</span>
                              <span style={{ fontSize: 12, fontWeight: 700, color: s.color, background: s.bg, padding: "2px 7px", borderRadius: 6 }}>
                                {s.word}
                              </span>
                            </div>
                            <div style={{ fontSize: 14, lineHeight: 1.45, color: C.muted }}>{f.detail}</div>
                            <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>
                              {clickable ? (on ? "Showing on image. Tap to clear." : "Tap to show on image") : f.severity === "ok" ? "" : "Not marked on the image"}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                )}

                {/* Fixes */}
                {result.fixes.length > 0 && (
                  <section style={{ marginTop: 18 }}>
                    <h2 style={{ fontSize: 17, margin: "0 0 8px" }}>How to fix it</h2>
                    <ol style={{ margin: 0, paddingLeft: 22, display: "flex", flexDirection: "column", gap: 8, fontSize: 15, lineHeight: 1.5 }}>
                      {result.fixes.map((t, i) => (
                        <li key={i}>{t}</li>
                      ))}
                    </ol>
                  </section>
                )}

                {result.better_image.length > 0 && (
                  <section style={{ marginTop: 18 }}>
                    <h2 style={{ fontSize: 17, margin: "0 0 8px" }}>For a clearer image</h2>
                    <ul style={{ margin: 0, paddingLeft: 20, display: "flex", flexDirection: "column", gap: 6, fontSize: 15, lineHeight: 1.5 }}>
                      {result.better_image.map((t, i) => (
                        <li key={i}>{t}</li>
                      ))}
                    </ul>
                  </section>
                )}
              </>
            )}
          </div>
        )}

        <p style={{ marginTop: 24, fontSize: 12.5, color: C.muted, lineHeight: 1.5 }}>
          Seating Check is decision support, not a diagnosis. It reads one image and can miss gaps that aren't visible in it. The clinician confirms seating by sight, by feel and, when in doubt, by X-ray. Remove patient names and other identifying details from images before uploading.
        </p>
      </div>
    </div>
  );
}
