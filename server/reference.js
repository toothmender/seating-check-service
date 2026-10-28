// Dandy's "Scan Body X-ray Examples" guide, built into server/reference/ by tools/build_reference.py.
// Provides the platform list for the screen, and the reference X-rays and context sent with reviews.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "reference");
const FILE_RE = /^[A-Za-z0-9_-]+\.jpg$/;
const MAX_PLATFORM_REFS = 2;

// The screen's "Scan body system" choices, mapped to the guide's scan body families.
const SYSTEM_FAMILY = {
  "Authentic manufacturer (OEM) scan body": "authentic",
  "3Shape scan body": "3shape",
  "Dess scan body": "dess",
  "TruAbutment scan body": "truabutment",
  "Straumann CARES Mono Scanbody (2-piece)": "authentic",
  "Straumann Scanbody (3-piece, post + cap)": "authentic",
};
const FAMILY_LABEL = { authentic: "manufacturer (OEM)", "3shape": "3Shape", dess: "Dess", truabutment: "TruAbutment", other: "other" };

function load() {
  try {
    const catalog = JSON.parse(fs.readFileSync(path.join(DIR, "catalog.json"), "utf8"));
    const byId = new Map();
    for (const m of catalog.manufacturers) {
      for (const p of m.platforms) byId.set(p.id, { ...p, manufacturer: m.manufacturer });
    }
    return { catalog, byId };
  } catch {
    console.error("reference catalog not found; platform references are off");
    return null;
  }
}

const ref = load();
const b64cache = new Map();

function imageB64(file) {
  if (!FILE_RE.test(file)) return null;
  if (!b64cache.has(file)) {
    const p = file === ref?.catalog.criteria_sheet ? path.join(DIR, file) : path.join(DIR, "images", file);
    try {
      b64cache.set(file, fs.readFileSync(p).toString("base64"));
    } catch {
      b64cache.set(file, null);
    }
  }
  return b64cache.get(file);
}

export const referenceEnabled = () => !!ref;

/** What the screen needs: manufacturers and platforms, with scan bodies and reference image names. */
export function publicCatalog() {
  if (!ref) return { manufacturers: [], notes: [], source: "" };
  const c = ref.catalog;
  return {
    source: c.source,
    notes: c.notes,
    manufacturers: c.manufacturers.map((m) => ({
      manufacturer: m.manufacturer,
      platforms: m.platforms.map((p) => ({
        id: p.id,
        platform: p.platform,
        scan_bodies: p.scan_bodies,
        references: p.references.map((r) => ({ file: r.file, scan_body: r.scan_body, family: r.family })),
      })),
    })),
  };
}

/** Absolute path of a reference image for the screen, or null. */
export function referencePath(file) {
  if (!ref || !FILE_RE.test(file)) return null;
  const p = path.join(DIR, "images", file);
  return fs.existsSync(p) ? p : null;
}

export const familyOf = (system) => SYSTEM_FAMILY[system] || null;
export const getPlatform = (id) => (ref && typeof id === "string" ? ref.byId.get(id) || null : null);

/** The labelled four-category sheet, as base64 JPEG. */
export function criteriaSheet() {
  return ref ? imageB64(ref.catalog.criteria_sheet) : null;
}

/** Up to two platform references, same scan body family first. */
export function platformReferences(platform, family) {
  if (!platform) return [];
  const refs = platform.references.filter((r) => imageB64(r.file));
  const same = family ? refs.filter((r) => r.family === family) : [];
  const rest = refs.filter((r) => !same.includes(r));
  // Without a match, show different scan bodies rather than two of the same.
  const varied = [];
  for (const r of rest) if (!varied.some((v) => v.family === r.family)) varied.push(r);
  for (const r of rest) if (!varied.includes(r)) varied.push(r);
  return [...same, ...varied].slice(0, MAX_PLATFORM_REFS).map((r) => ({ ...r, data: imageB64(r.file) }));
}

/** Text describing the selected platform for the review request. */
export function platformContext(platform, family, systemLabel) {
  if (!platform) return "";
  const names = platform.scan_bodies.map((s) => s.name);
  const families = new Set(platform.scan_bodies.map((s) => s.family));
  const lines = [
    `Implant platform selected from Dandy's guide: ${platform.manufacturer} ${platform.platform}.`,
    names.length
      ? `Scan bodies Dandy's guide lists for this platform: ${names.join("; ")}.`
      : "Dandy's guide lists no scan bodies for this platform.",
  ];
  if (family && names.length) {
    lines.push(
      families.has(family)
        ? `The selected scan body type (${systemLabel}) is in that list.`
        : `The selected scan body type (${systemLabel}) is NOT in that list: Dandy's guide has no ${FAMILY_LABEL[family] || family} scan body on file for this platform. Check carefully for "incorrect_scan_body", but don't conclude it from the list alone.`
    );
  }
  if (/^TSV\b/i.test(platform.platform)) {
    lines.push("This is a Zimmer/ZimVie TSV implant: apply the bevel exception (an apparent gap is normal if the edges touch).");
  }
  const key = `${platform.manufacturer} ${platform.platform}`.toLowerCase();
  for (const n of ref.catalog.notes || []) {
    const t = n.toLowerCase();
    if (t.includes(platform.manufacturer.toLowerCase()) || t.includes(platform.platform.toLowerCase()) || t.includes(key)) {
      lines.push(`Note from Dandy's guide: ${n}`);
    }
  }
  return lines.join(" ");
}
