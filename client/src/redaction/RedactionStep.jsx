import { useEffect, useRef, useState } from "react";
import { Loader2, Undo2, Trash2, ZoomIn, ZoomOut, ShieldCheck, X } from "lucide-react";
import { clampRect, hitTest, rectFromPoints } from "./boxes.js";
import { describeMetadata } from "./metadata.js";
import { detectText } from "./ocr.js";

/*
 * Every image passes through this screen BEFORE it is read for the seating review.
 * Nothing here talks to the server: detection runs in a local Web Worker, the redaction is
 * burned into the pixels, and only the redacted copy is handed back to the app. The original
 * file is dropped as soon as this step ends.
 */

const C = {
  ink: "#12202B",
  paper: "#EDF1F2",
  panel: "#FFFFFF",
  line: "#D3DCDF",
  muted: "#55656F",
  accent: "#0E6E8C",
  bad: "#A82F27",
  badBg: "#F9E3E0",
  watch: "#8F6100",
  watchBg: "#FAEFD2",
  ok: "#17744F",
  okBg: "#E1F2E8",
};

const OUTLINE_AUTO = "#F2B919";
const OUTLINE_MANUAL = "#7FD1A8";
const OUTLINE_SELECTED = "#FFFFFF";
const MAX_BYTES = 60 * 1024 * 1024;
const MAX_HISTORY = 50;

let idCounter = 0;
const nextId = (p) => `${p}-${++idCounter}`;

const btn = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "8px 12px",
  background: C.panel,
  border: `1px solid ${C.line}`,
  borderRadius: 8,
  color: C.ink,
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
};
const btnOff = { opacity: 0.45, cursor: "not-allowed" };

function drawBoxes(ctx, boxes, { outline, selectedId, lineWidth }) {
  for (const b of boxes) {
    ctx.fillStyle = "#000";
    ctx.fillRect(b.x, b.y, b.w, b.h);
  }
  if (!outline) return;
  for (const b of boxes) {
    const sel = b.id === selectedId;
    ctx.lineWidth = sel ? lineWidth * 1.8 : lineWidth;
    ctx.strokeStyle = sel ? OUTLINE_SELECTED : b.kind === "auto" ? OUTLINE_AUTO : OUTLINE_MANUAL;
    ctx.setLineDash(sel ? [lineWidth * 4, lineWidth * 3] : []);
    ctx.strokeRect(b.x, b.y, b.w, b.h);
  }
  ctx.setLineDash([]);
}

async function loadBitmap(file) {
  const name = (file.name || "").toLowerCase();
  if (name.endsWith(".dcm") || file.type === "application/dicom") {
    throw new Error("DICOM files aren't supported. Export the X-ray as JPG or PNG first.");
  }
  if (file.size > MAX_BYTES) throw new Error("File is larger than 60 MB.");
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch (e) {
    throw new Error(
      /\.(heic|heif|tif|tiff)$/.test(name)
        ? "This browser can't open HEIC/TIFF files. Convert to JPG or PNG, or open the app in Safari."
        : "The browser couldn't decode this image. Try re-saving it as a standard PNG or JPG."
    );
  }
}

export default function RedactionStep({ file, index, remaining, onConfirm, onCancel, onError }) {
  const [bitmap, setBitmap] = useState(null);
  const [boxes, setBoxes] = useState([]);
  const [history, setHistory] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [ocr, setOcr] = useState("running"); // running | done | error
  const [progress, setProgress] = useState(0);
  const [ocrMessage, setOcrMessage] = useState("");
  const [metadata, setMetadata] = useState([]);
  const [confirmed, setConfirmed] = useState(false);
  const [draft, setDraft] = useState(null);
  const [exporting, setExporting] = useState(false);
  const canvasRef = useRef(null);
  const dragStart = useRef(null);
  const runId = useRef(0);

  // Load the file, then run detection.
  useEffect(() => {
    let cancelled = false;
    let bm = null;
    (async () => {
      try {
        const [b, meta] = await Promise.all([loadBitmap(file), describeMetadata(file)]);
        if (cancelled) {
          b.close();
          return;
        }
        bm = b;
        setBitmap(b);
        setMetadata(meta);
        runDetection(b);
      } catch (err) {
        if (!cancelled) onError(`${file.name || "Image"}: ${err.message || "couldn't be opened."}`);
      }
    })();
    return () => {
      cancelled = true;
      runId.current += 1;
      if (bm) bm.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  const runDetection = async (b) => {
    const id = ++runId.current;
    setOcr("running");
    setProgress(0);
    setOcrMessage("");
    try {
      const rects = await detectText(b, (f) => {
        if (runId.current === id) setProgress(f);
      });
      if (runId.current !== id) return;
      setBoxes((prev) => [
        ...prev.filter((x) => x.kind === "manual"),
        ...rects.map((r) => ({ ...r, id: nextId("auto"), kind: "auto" })),
      ]);
      setConfirmed(false);
      setOcr("done");
    } catch (err) {
      if (runId.current !== id) return;
      setOcr("error");
      setOcrMessage((err && err.message) || "Automatic text detection isn't available right now.");
    }
  };

  const commit = (next) => {
    setHistory((h) => [...h, boxes].slice(-MAX_HISTORY));
    setBoxes(next);
    setConfirmed(false); // any change means the person must look again
  };

  const removeSelected = () => {
    if (!selectedId) return;
    commit(boxes.filter((b) => b.id !== selectedId));
    setSelectedId(null);
  };

  const undo = () => {
    if (!history.length) return;
    setBoxes(history[history.length - 1]);
    setHistory(history.slice(0, -1));
    setSelectedId(null);
    setConfirmed(false);
  };

  // Delete / Ctrl+Z
  useEffect(() => {
    const onKey = (e) => {
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
        e.preventDefault();
        removeSelected();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Draw
  const lineWidth = bitmap ? Math.max(2, Math.max(bitmap.width, bitmap.height) / 500) : 2;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !bitmap) return;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0);
    drawBoxes(ctx, boxes, { outline: true, selectedId, lineWidth });
    if (draft) {
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      ctx.fillRect(draft.x, draft.y, draft.w, draft.h);
      ctx.strokeStyle = OUTLINE_SELECTED;
      ctx.lineWidth = lineWidth;
      ctx.setLineDash([lineWidth * 4, lineWidth * 3]);
      ctx.strokeRect(draft.x, draft.y, draft.w, draft.h);
      ctx.setLineDash([]);
    }
  }, [bitmap, boxes, selectedId, draft, lineWidth]);

  const toPoint = (e) => {
    const canvas = canvasRef.current;
    const r = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) * canvas.width) / r.width,
      y: ((e.clientY - r.top) * canvas.height) / r.height,
    };
  };

  const onPointerDown = (e) => {
    if (e.button !== 0 || !bitmap) return;
    const p = toPoint(e);
    const hit = hitTest(boxes, p.x, p.y);
    if (hit) {
      setSelectedId(hit.id);
      dragStart.current = null;
      return;
    }
    setSelectedId(null);
    canvasRef.current.setPointerCapture(e.pointerId);
    dragStart.current = p;
    setDraft({ x: p.x, y: p.y, w: 0, h: 0 });
  };
  const onPointerMove = (e) => {
    const s = dragStart.current;
    if (!s) return;
    const p = toPoint(e);
    setDraft(rectFromPoints(s.x, s.y, p.x, p.y));
  };
  const finishDrag = () => {
    const rect = draft;
    dragStart.current = null;
    setDraft(null);
    if (!rect || !bitmap) return;
    const minSize = Math.max(6, Math.max(bitmap.width, bitmap.height) / 300);
    if (rect.w < minSize || rect.h < minSize) return;
    const c = clampRect(rect, bitmap.width, bitmap.height);
    if (!c) return;
    const box = { ...c, id: nextId("manual"), kind: "manual" };
    commit([...boxes, box]);
    setSelectedId(box.id);
  };

  const useRedacted = async () => {
    if (!bitmap || !confirmed || ocr === "running") return;
    setExporting(true);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      // Solid black is painted over each box BEFORE encoding, so the covered pixels are gone.
      drawBoxes(ctx, boxes, { outline: false, selectedId: null, lineWidth: 0 });
      const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
      if (!blob) throw new Error("Could not create the redacted image.");
      // Name is deliberately not derived from the original file name.
      onConfirm(new File([blob], `redacted-image-${index}.png`, { type: "image/png" }));
    } catch (err) {
      onError((err && err.message) || "Could not create the redacted image.");
    } finally {
      setExporting(false);
    }
  };

  const detecting = ocr === "running";
  const autoCount = boxes.filter((b) => b.kind === "auto").length;
  const manualCount = boxes.length - autoCount;
  const ready = bitmap && confirmed && !detecting && !exporting;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Remove patient information before review"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        overflowY: "auto",
        background: C.paper,
        color: C.ink,
        fontFamily: "'Avenir Next','Segoe UI',system-ui,sans-serif",
      }}
    >
      <div style={{ maxWidth: 720, margin: "0 auto", padding: "20px 16px 48px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <ShieldCheck size={24} color={C.accent} />
          <h1 style={{ fontSize: 20, margin: 0 }}>Remove patient information</h1>
          <button onClick={onCancel} style={{ ...btn, marginLeft: "auto" }} aria-label="Skip this image">
            <X size={16} /> Skip image
          </button>
        </div>
        <p style={{ margin: "0 0 12px", fontSize: 14, color: C.muted, lineHeight: 1.5 }}>
          Check the picture before it&rsquo;s reviewed. Text on the image is covered in black and
          hidden file data is removed. Nothing is sent anywhere from this screen
          {remaining > 0 ? ` · ${remaining} more image${remaining === 1 ? "" : "s"} waiting` : ""}.
        </p>
        <div
          style={{
            background: C.watchBg,
            color: C.watch,
            borderRadius: 10,
            padding: "10px 12px",
            fontSize: 13,
            lineHeight: 1.45,
            marginBottom: 12,
          }}
        >
          Automatic detection misses things. Look over the whole image and draw a box over anything
          that could identify a patient. Don&rsquo;t use full-face photos; they can&rsquo;t be made anonymous here.
        </div>

        {!bitmap ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: C.muted, padding: 24 }}>
            <Loader2 size={18} className="animate-spin" /> Opening image&hellip;
          </div>
        ) : (
          <>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
              <button onClick={undo} disabled={!history.length} style={{ ...btn, ...(history.length ? {} : btnOff) }}>
                <Undo2 size={16} /> Undo
              </button>
              <button onClick={removeSelected} disabled={!selectedId} style={{ ...btn, ...(selectedId ? {} : btnOff) }}>
                <Trash2 size={16} /> Remove box
              </button>
              <button
                onClick={() => {
                  commit(boxes.filter((b) => b.kind === "manual"));
                  setSelectedId(null);
                  runDetection(bitmap);
                }}
                disabled={detecting}
                style={{ ...btn, ...(detecting ? btnOff : {}) }}
              >
                Re-run detection
              </button>
              <span style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
                <button
                  onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))}
                  style={btn}
                  aria-label="Zoom out"
                >
                  <ZoomOut size={16} />
                </button>
                <span style={{ fontSize: 13, color: C.muted, minWidth: 38, textAlign: "center" }}>
                  {Math.round(zoom * 100)}%
                </span>
                <button
                  onClick={() => setZoom((z) => Math.min(4, +(z + 0.25).toFixed(2)))}
                  style={btn}
                  aria-label="Zoom in"
                >
                  <ZoomIn size={16} />
                </button>
              </span>
            </div>

            <div role="status" style={{ fontSize: 13, color: C.muted, marginBottom: 8 }}>
              {detecting
                ? `Looking for text… ${Math.round(progress * 100)}%. You can already draw boxes.`
                : ocr === "error"
                ? `Automatic detection didn't run: ${ocrMessage} Draw boxes by hand instead.`
                : `${autoCount} found automatically · ${manualCount} drawn by hand. Drag on the image to add a box; tap a box to select it.`}
            </div>

            <div
              style={{
                overflow: "auto",
                maxHeight: "65vh",
                background: C.panel,
                border: `1px solid ${C.line}`,
                borderRadius: 10,
              }}
            >
              <canvas
                ref={canvasRef}
                width={bitmap.width}
                height={bitmap.height}
                role="img"
                aria-label="Image being redacted. Drag to draw a redaction box."
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={finishDrag}
                onPointerCancel={finishDrag}
                style={{
                  display: "block",
                  width: `${zoom * 100}%`,
                  height: "auto",
                  cursor: "crosshair",
                  touchAction: "none",
                  userSelect: "none",
                }}
              />
            </div>

            <div
              style={{
                background: C.panel,
                border: `1px solid ${C.line}`,
                borderRadius: 10,
                padding: "10px 12px",
                margin: "12px 0",
                fontSize: 13,
                color: C.muted,
                lineHeight: 1.5,
              }}
            >
              <strong style={{ color: C.ink }}>Hidden file data: </strong>
              {metadata.length === 0
                ? "none found. The copy is rebuilt from the pixels, so nothing from the original file carries over."
                : `${metadata.join("; ")}. All of it is removed.`}
            </div>

            <label
              style={{
                display: "flex",
                gap: 10,
                alignItems: "flex-start",
                fontSize: 14,
                lineHeight: 1.45,
                cursor: detecting ? "not-allowed" : "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={confirmed}
                disabled={detecting}
                onChange={(e) => setConfirmed(e.target.checked)}
                style={{ marginTop: 3, width: 18, height: 18 }}
              />
              <span>
                I&rsquo;ve looked over the whole image and nothing that identifies a patient is left: no
                names, birth dates, chart or ID numbers, faces, or dates tied to the patient.
              </span>
            </label>
            {!confirmed && (
              <p style={{ fontSize: 12, color: C.muted, margin: "6px 0 0 28px" }}>
                Any change to the boxes clears this check, so you always confirm the final result.
              </p>
            )}

            <button
              onClick={useRedacted}
              disabled={!ready}
              style={{
                marginTop: 14,
                width: "100%",
                padding: "13px 16px",
                background: C.accent,
                color: "#fff",
                border: "none",
                borderRadius: 10,
                fontSize: 16,
                fontWeight: 600,
                cursor: ready ? "pointer" : "not-allowed",
                opacity: ready ? 1 : 0.45,
              }}
            >
              {exporting ? "Preparing…" : "Use redacted image for review"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
