#!/usr/bin/env python3
"""Build server/reference/ from Dandy's "Scan Body X-ray Examples" export.

Usage (from the repo root; needs Pillow: pip install pillow):
    python3 tools/build_reference.py path/to/scan_body_seating_data_folder

The folder must contain scan_body_seating_data.json and its images/ folder.
Writes, replacing what is there:
    server/reference/catalog.json        manufacturers, platforms, scan bodies, reference images
    server/reference/images/*.jpg        the reference X-rays, re-encoded as plain JPEG
    server/reference/criteria_sheet.jpg  the 16 labelled seating-category examples on one sheet
    server/reference/DATA_ISSUES.md      problems found in the source (fix them in the guide)

Run it again whenever the guide changes, then commit server/reference/.
"""
import hashlib
import json
import re
import shutil
import sys
from collections import defaultdict
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "server" / "reference"
MAX_SIDE = 800

# The four categories in the guide, in the order the guide presents them.
CATEGORIES = [
    ("fully_seated", "A. Fully seated"),
    ("slightly_lifted", "B. Slightly lifted"),
    ("lifted_or_lifted_rotated", "C. Lifted / lifted and rotated"),
    ("incorrect_scan_body", "D. Incorrect scan body"),
]

# Some images in the guide are labelled with the platform they really show. When a duplicate
# image is filed under several platforms, keep it only where its own label confirms the platform.
CONFIRMED_BY_LABEL = {("ZimVie (Zimmer Biomet)", "Certain 4.1")}


def family(name):
    """Group the guide's scan body names into the families the app asks about."""
    n = (name or "").strip().lower()
    if not n:
        return None
    if n.startswith("3shape"):
        return "3shape"
    if n.startswith("dess"):
        return "dess"
    if n.startswith("truabutment"):
        return "truabutment"
    if n.startswith("authentic") or n == "long 2022 sb":
        return "authentic"
    return "other"  # e.g. Medentika SB on AB Dental


def slug(*parts):
    s = "-".join(parts).lower()
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")


def load_image(path):
    im = Image.open(path)
    im = im.convert("RGB")
    im.thumbnail((MAX_SIDE, MAX_SIDE))
    return im


def font(size):
    for f in ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/Library/Fonts/Arial Bold.ttf", "C:/Windows/Fonts/arialbd.ttf"):
        try:
            return ImageFont.truetype(f, size)
        except OSError:
            pass
    return ImageFont.load_default()


def main(src):
    src = Path(src)
    data = json.loads((src / "scan_body_seating_data.json").read_text())
    issues = []

    # --- where each image is used, and which images are byte-identical -------------------------
    uses = defaultdict(list)  # file -> [(manufacturer, platform)]
    for m in data["manufacturers"]:
        for p in m["platforms"]:
            for im in p.get("images", []):
                uses[im["file"]].append((m["manufacturer"], p["platform"]))
    digest = {f: hashlib.md5((src / f).read_bytes()).hexdigest() for f in uses}
    groups = defaultdict(list)
    for f, h in digest.items():
        groups[h].append(f)

    drop = set()  # (file, manufacturer, platform) to leave out
    for files in groups.values():
        if len(files) < 2:
            continue
        places = {pl for f in files for pl in uses[f]}
        if len(places) == 1:
            # Same image twice under one platform: keep the first labelled copy.
            continue
        confirmed = places & CONFIRMED_BY_LABEL
        for f in files:
            for pl in uses[f]:
                if pl not in confirmed:
                    drop.add((f, *pl))
        where = "; ".join(f"{a} {b} ({f.split('/')[-1]})" for f in files for a, b in uses[f])
        kept = f" Kept only for {', '.join(' '.join(c) for c in confirmed)}, where the image's own label confirms it." if confirmed else " Left out everywhere until the guide is fixed."
        issues.append(f"- The same image is filed under different platforms: {where}.{kept}")

    # --- copy images and build the catalog --------------------------------------------------------
    if OUT.exists():
        shutil.rmtree(OUT)
    (OUT / "images").mkdir(parents=True)

    copied = {}

    def copy(f):
        if f not in copied:
            name = Path(f).stem + ".jpg"
            load_image(src / f).save(OUT / "images" / name, "JPEG", quality=90)
            copied[f] = name
        return copied[f]

    manufacturers = []
    for m in data["manufacturers"]:
        plats = []
        for p in m["platforms"]:
            # One entry per distinct image; when the same image appears twice here, keep the copy
            # that names its scan body.
            chosen = {}
            for im in p.get("images", []):
                f = im["file"]
                if (f, m["manufacturer"], p["platform"]) in drop:
                    continue
                h = digest[f]
                if h not in chosen or (not chosen[h].get("scan_body") and im.get("scan_body")):
                    chosen[h] = im
            refs = []
            for im in chosen.values():
                f, sb = im["file"], im.get("scan_body")
                if not sb:
                    issues.append(f"- {m['manufacturer']} {p['platform']}: image {f.split('/')[-1]} has no scan body name. Used with the name left blank.")
                refs.append({"file": copy(f), "scan_body": sb or "", "family": family(sb)})
            if not p.get("scan_bodies") and not refs:
                issues.append(f"- {m['manufacturer']} {p['platform']}: no scan bodies or images listed.")
            elif not refs:
                issues.append(f"- {m['manufacturer']} {p['platform']}: no usable reference image after removing duplicates.")
            plats.append({
                "id": slug(m["manufacturer"], p["platform"]),
                "platform": p["platform"],
                "scan_bodies": [{"name": s, "family": family(s)} for s in p.get("scan_bodies", [])],
                "references": refs,
            })
        manufacturers.append({"manufacturer": m["manufacturer"], "platforms": plats})

    # --- criteria sheet: the 16 labelled examples on one image ------------------------------------
    cell_h, gap, label_h, pad = 300, 12, 40, 16
    rows = []
    for key, label in CATEGORIES:
        ims = [load_image(src / f) for f in data["seating_criteria_images"].get(key, [])]
        ims = [im.resize((max(1, round(im.width * cell_h / im.height)), cell_h)) for im in ims]
        rows.append((label, ims))
    width = max(sum(im.width for im in ims) + gap * (len(ims) - 1) for _, ims in rows) + pad * 2
    height = pad + sum(label_h + cell_h + gap for _ in rows) + pad
    sheet = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(sheet)
    f_label = font(26)
    y = pad
    for label, ims in rows:
        draw.text((pad, y + 6), label, fill="black", font=f_label)
        y += label_h
        x = pad
        for im in ims:
            sheet.paste(im, (x, y))
            x += im.width + gap
        y += cell_h + gap
    sheet.save(OUT / "criteria_sheet.jpg", "JPEG", quality=88)

    catalog = {
        "source": data.get("source", ""),
        "seating_criteria": data.get("seating_criteria", {}),
        "notes": data.get("notes", []),
        "criteria_sheet": "criteria_sheet.jpg",
        "manufacturers": manufacturers,
    }
    (OUT / "catalog.json").write_text(json.dumps(catalog, indent=1, ensure_ascii=False) + "\n")

    n_plat = sum(len(m["platforms"]) for m in manufacturers)
    n_ref = sum(len(p["references"]) for m in manufacturers for p in m["platforms"])
    (OUT / "DATA_ISSUES.md").write_text(
        "# Issues found in the scan body guide data\n\n"
        f"Source: {catalog['source']}\n\n"
        "Fix these in the guide, export again, and re-run `tools/build_reference.py`.\n\n"
        + ("\n".join(issues) if issues else "None.") + "\n"
    )
    print(f"{len(manufacturers)} manufacturers, {n_plat} platforms, {n_ref} reference images, {len(issues)} issues")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
