#!/usr/bin/env python3
"""Extrae fotos del xlsx parseando drawing1.xml (anclaje celda->imagen) + rels.
Mapea cada imagen a su MODELO por la fila del ancla. Salida: photos/ + photos_map.json."""
import json, sys, zipfile, re
from pathlib import Path
import xml.etree.ElementTree as ET
import openpyxl

BASE = Path("/Users/jorge/Documents/shirley")
XLSX = BASE / "Catálogo cliente con fotos.xlsx"
OUTDIR = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("photos")
OUTDIR.mkdir(parents=True, exist_ok=True)

NS = {
    "xdr": "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing",
    "a":   "http://schemas.openxmlformats.org/drawingml/2006/main",
    "r":   "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "rel": "http://schemas.openxmlformats.org/package/2006/relationships",
}

def norm(v): return "" if v is None else str(v).strip()

# 1) fila -> modelo (forward-fill) con openpyxl
wb = openpyxl.load_workbook(XLSX, read_only=True, data_only=True)
ws = wb["Catálogo"]
rows = list(ws.iter_rows(values_only=True))
# localizar columna MODELO
hdr_i = next(i for i, r in enumerate(rows) if "MODELO" in [norm(x).upper() for x in r])
header = [norm(x).upper() for x in rows[hdr_i]]
mcol = header.index("MODELO")
row_to_model = {}
cur = None
for i in range(hdr_i + 1, len(rows)):
    m = norm(rows[i][mcol]) if mcol < len(rows[i]) else ""
    if m: cur = m
    row_to_model[i] = cur  # i es 0-indexado, igual que xdr:row
wb.close()

# 2) rels del drawing: rId -> media file
z = zipfile.ZipFile(XLSX)
rels = ET.fromstring(z.read("xl/drawings/_rels/drawing1.xml.rels"))
rid_to_media = {}
for rel in rels.findall("rel:Relationship", NS):
    tgt = rel.get("Target")  # ../media/imageN.jpeg
    rid_to_media[rel.get("Id")] = "xl/media/" + tgt.split("media/")[-1]

# 3) drawing: por cada anchor, fila origen + rId de la imagen
draw = ET.fromstring(z.read("xl/drawings/drawing1.xml"))
mapping = {}
counts = {}
saved = 0
anchors = draw.findall("xdr:twoCellAnchor", NS) + draw.findall("xdr:oneCellAnchor", NS)
for anc in anchors:
    frm = anc.find("xdr:from", NS)
    row = int(frm.find("xdr:row", NS).text) if frm is not None else None
    blip = anc.find(".//a:blip", NS)
    if blip is None or row is None:
        continue
    rid = blip.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}embed")
    media = rid_to_media.get(rid)
    if not media:
        continue
    model = row_to_model.get(row)
    if not model:
        # la imagen puede anclarse una fila antes/después; probar vecinas
        for d in (0, -1, 1, -2, 2):
            if row_to_model.get(row + d):
                model = row_to_model[row + d]; break
    if not model:
        continue
    data = z.read(media)
    ext = media.rsplit(".", 1)[-1].lower()
    if ext == "jpeg": ext = "jpg"
    base = model.replace("/", "-")
    n = counts.get(model, 0)
    fname = f"{base}.{ext}" if n == 0 else f"{base}_{n}.{ext}"
    (OUTDIR / fname).write_bytes(data)
    counts[model] = n + 1
    mapping.setdefault(model, fname)
    saved += 1

Path("photos_map.json").write_text(json.dumps(mapping, ensure_ascii=False, indent=2))
print(f"Anchors: {len(anchors)}  guardadas: {saved}  modelos con foto: {len(mapping)}")
print("Ejemplos:", list(mapping.items())[:6])
