#!/usr/bin/env python3
"""Extrae un catálogo estructurado desde los Excel de la fábrica (carpeta shirley).

Salida: catalog.json  (lista de modelos con descripción, colores, tallas con stock,
tipo de prenda inferido y peso). Las fotos se extraen aparte.
Fuente principal: 'Catálogo cliente con fotos.xlsx' (FOTO|MODELO|DESCRIPCIÓN|COLOR|XS..OTRA|TOTAL|PESO).
"""
import json, re, sys
from pathlib import Path
import openpyxl

BASE = Path("/Users/jorge/Documents/shirley")
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("catalog.json")

SIZE_COLS = ["XS", "S", "M", "L", "XL", "O/S", "OTRA"]

# Mapa descripción → (categoria interna, tipo-prenda para tabla por defecto)
def infer_type(desc: str):
    d = (desc or "").upper()
    def has(*ws): return any(w in d for w in ws)
    if has("COAT", "ABRIGO", "PARKA"):            return "outerwear", "coat"
    if has("CARDIGAN", "CÁRDIGAN", "CARDI"):      return "outerwear", "cardigan"
    if has("BLAZER", "JACKET", "CHAQUETA"):       return "outerwear", "jacket"
    if has("PONCHO", "CAPE", "CAPA"):             return "outerwear", "poncho"
    if has("SHAWL", "CHAL", "SCARF", "BUFANDA", "ESTOLA"): return "accessory", "shawl"
    if has("SWEATER", "JERSEY", "PULLOVER", "PTO", "PUNTO", "KNIT"): return "top", "sweater"
    if has("VEST", "CHALECO"):                    return "top", "vest"
    if has("DRESS", "VESTIDO"):                   return "dress", "dress"
    if has("SKIRT", "FALDA"):                     return "bottom", "skirt"
    if has("PANT", "PANTALON", "PANTALÓN", "TROUSER", "LEGGING"): return "bottom", "pants"
    if has("TOP", "BLUSA", "BLOUSE", "SHIRT", "CAMISA", "TEE", "T-SHIRT"): return "top", "top"
    return "top", "sweater"  # la fábrica es casi todo punto → default sweater

def norm(v):
    return "" if v is None else str(v).strip()

def to_int(v):
    try:
        f = float(v)
        return int(f) if f == int(f) else 0
    except Exception:
        return 0

def clean_desc(s: str) -> str:
    # arregla artefactos de codificación tipo "BIDDY┤S" y recorta
    s = (s or "").replace("┤", "'").replace("´", "'").strip()
    s = re.sub(r"\s+", " ", s)
    return s

def main():
    p = BASE / "Catálogo cliente con fotos.xlsx"
    wb = openpyxl.load_workbook(p, read_only=True, data_only=True)
    ws = wb["Catálogo"]

    # localizar fila de cabecera (la que tiene MODELO y DESCRIPCIÓN)
    header_row = None
    rows = list(ws.iter_rows(values_only=True))
    for i, r in enumerate(rows):
        vals = [norm(x).upper() for x in r]
        if "MODELO" in vals and "DESCRIPCIÓN" in vals:
            header_row = i
            header = [norm(x).upper() for x in r]
            break
    if header_row is None:
        print("No encuentro cabecera", file=sys.stderr); sys.exit(1)

    col = {h: idx for idx, h in enumerate(header)}
    def cell(r, name):
        idx = col.get(name)
        return r[idx] if idx is not None and idx < len(r) else None

    catalog = {}
    cur = None  # modelo actual (forward-fill)
    for r in rows[header_row + 1:]:
        modelo = norm(cell(r, "MODELO"))
        desc = clean_desc(norm(cell(r, "DESCRIPCIÓN")))
        color = norm(cell(r, "COLOR"))
        if modelo:
            cur = modelo
            if cur not in catalog:
                catalog[cur] = {
                    "modelo": cur, "descripcion": desc,
                    "colores": [], "stock": {s: 0 for s in SIZE_COLS},
                    "peso_kg": None,
                }
            elif desc and not catalog[cur]["descripcion"]:
                catalog[cur]["descripcion"] = desc
        if cur is None:
            continue
        g = catalog[cur]
        if color and color not in g["colores"]:
            g["colores"].append(color)
        for s in SIZE_COLS:
            g["stock"][s] += to_int(cell(r, s))
        peso = cell(r, "PESO UNIT. (KG)") or cell(r, "PESO UNIT. (kg)")
        if peso and g["peso_kg"] is None:
            try: g["peso_kg"] = round(float(peso), 3)
            except Exception: pass
    wb.close()

    out = []
    for m, g in catalog.items():
        cat, tipo = infer_type(g["descripcion"])
        sizes_avail = [s for s in SIZE_COLS if g["stock"][s] > 0]
        total = sum(g["stock"].values())
        out.append({
            "modelo": m,
            "descripcion": g["descripcion"],
            "categoria": cat,
            "tipo": tipo,
            "tejido": "punto",  # fábrica de tejido de punto
            "colores": g["colores"],
            "tallas_disponibles": sizes_avail,
            "stock": {s: g["stock"][s] for s in SIZE_COLS if g["stock"][s] > 0},
            "total": total,
            "peso_kg": g["peso_kg"],
        })
    out.sort(key=lambda x: x["modelo"])
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=2))

    # resumen
    from collections import Counter
    tc = Counter(x["tipo"] for x in out)
    print(f"Modelos: {len(out)}  | unidades totales: {sum(x['total'] for x in out)}")
    print("Por tipo:", dict(tc))
    print("Tallas usadas:", sorted({s for x in out for s in x['stock']}))
    print("\nEjemplos:")
    for x in out[:6]:
        print(f"  {x['modelo']:8} [{x['tipo']:8}] {x['descripcion'][:34]:34} "
              f"colores={len(x['colores'])} tallas={x['tallas_disponibles']} tot={x['total']}")

if __name__ == "__main__":
    main()
