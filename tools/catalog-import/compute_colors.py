#!/usr/bin/env python3
"""Precalcula el color dominante de cada prenda desde su foto y lo añade a
catalogo.json (campo "color", hex). Muestrea la ZONA CENTRAL de la foto (donde
suele estar la prenda, no el fondo ni la cabeza) y toma el color MÁS FRECUENTE
(no el promedio), ignorando blanco de fondo y sombras negras. Mucho mejor que el
promedio global para fotos sobre modelo.

Uso:
    python compute_colors.py <carpeta_shirley>
    # carpeta con catalogo.json y fotos/ (por defecto apps/web/public/shirley)
"""
import json
import sys
from collections import Counter
from pathlib import Path

from PIL import Image

DEF = Path("apps/web/public/shirley")
BASE = Path(sys.argv[1]) if len(sys.argv) > 1 else DEF
CAT = BASE / "catalogo.json"
FOTOS = BASE / "fotos"


def dominant_color(path: Path) -> str | None:
    try:
        img = Image.open(path).convert("RGB")
    except Exception:
        return None
    w, h = img.size
    # Ventana central: evita cabeza/zapatos/fondo de los bordes.
    box = (int(w * 0.25), int(h * 0.20), int(w * 0.75), int(h * 0.74))
    crop = img.crop(box).resize((56, 56))
    cnt: Counter = Counter()
    for r, g, b in crop.getdata():
        if r > 235 and g > 235 and b > 235:
            continue  # fondo blanco
        if r < 24 and g < 24 and b < 24:
            continue  # sombra negra
        # cuantiza a cubos de 24 para agrupar tonos cercanos
        cnt[(r // 24 * 24, g // 24 * 24, b // 24 * 24)] += 1
    if not cnt:
        return None
    r, g, b = cnt.most_common(1)[0][0]
    # centra el cubo (+12) para no sesgar siempre a la baja
    r, g, b = min(r + 12, 255), min(g + 12, 255), min(b + 12, 255)
    return f"#{r:02x}{g:02x}{b:02x}"


def main() -> None:
    cat = json.loads(CAT.read_text())
    done = 0
    for item in cat:
        foto = item.get("foto")
        if not foto:
            item["color"] = None
            continue
        color = dominant_color(FOTOS / foto)
        item["color"] = color
        if color:
            done += 1
    CAT.write_text(json.dumps(cat, ensure_ascii=False, indent=2))
    print(f"colores calculados: {done}/{len(cat)}")
    # muestra algunos conocidos
    for m in ("01-159", "01-139", "01-137"):  # TAYRA (crema), LINKS (azul), BIDDY (teal)
        it = next((x for x in cat if x["modelo"] == m), None)
        if it:
            print(f"  {m} {it['descripcion'][:28]:28} -> {it.get('color')}")


if __name__ == "__main__":
    main()
