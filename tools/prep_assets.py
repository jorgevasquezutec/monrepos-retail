"""
prep_assets.py — Prepara texturas del pack de sistema (se ejecuta en el build).

Las texturas de pelo tienen alfa con bordes: el RGB de los texels transparentes
suele ser blanco/gris y aparece como "flecos" claros al filtrar la textura. Aquí
se rellena (dilata) el color de los píxeles opacos hacia los transparentes.
"""
import glob
import sys

import numpy as np
from PIL import Image


def dilate_rgb(path, iters=24):
    im = Image.open(path).convert("RGBA")
    a = np.asarray(im).astype(np.float32)
    rgb, alpha = a[..., :3], a[..., 3]
    known = alpha > 128
    if known.all() or not known.any():
        return False
    col = rgb * known[..., None]
    w = known.astype(np.float32)
    for _ in range(iters):
        # promedio 3x3 de los vecinos conocidos
        cs = np.zeros_like(col)
        ws = np.zeros_like(w)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                cs += np.roll(np.roll(col, dy, 0), dx, 1)
                ws += np.roll(np.roll(w, dy, 0), dx, 1)
        fill = (~known) & (ws > 0)
        if not fill.any():
            break
        col[fill] = cs[fill] / ws[fill][:, None]
        w[fill] = 1.0
        known = known | fill
    # los texels (semi)transparentes toman el color dilatado; el alfa no cambia
    out = np.where((alpha < 250)[..., None], col, rgb)
    Image.fromarray(np.dstack([out, alpha]).astype(np.uint8), "RGBA").save(path)
    return True


if __name__ == "__main__":
    root = sys.argv[1]
    for p in glob.glob(root + "/hair/*/*.png") + glob.glob(root + "/eyelashes/*/*.png") + glob.glob(root + "/eyebrows/*/*.png"):
        if "normal" in p or "_ao" in p:
            continue
        print("dilate", p, dilate_rgb(p))
