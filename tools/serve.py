"""
serve.py — Servicio HTTP mínimo (CPU) que envuelve gen_avatar.py.

Recibe medidas, ejecuta Blender headless (MPFB2) y produce el GLB.
Pensado para correr dentro del contenedor (ver Dockerfile). No necesita GPU.

Endpoints:
  POST /generate          -> devuelve el GLB (binario)
  POST /generate-to-file  -> escribe OUTPUT_DIR/avatar-body.glb (que el front sirve)
  GET  /health
"""

import os
import re
import threading
import subprocess
import tempfile

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

app = FastAPI(title="Croma · generador de cuerpo CC0")

# Permite que el front (localhost:5173) llame al servicio desde el navegador.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

BLENDER_BIN = os.environ.get("BLENDER_BIN", "blender")
OUTPUT_DIR = os.environ.get("OUTPUT_DIR", "/out")
SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gen_avatar.py")
CLOTHES_DIR = os.environ.get("CLOTHES_DIR", os.path.join(os.path.dirname(SCRIPT), "assets", "clothes"))


class Measurements(BaseModel):
    bust: float
    waist: float
    hip: float
    height: float = 168.0
    shoulder: float = 0.0
    gender: str = "female"
    # Prendas a vestir: nombres de asset (carpeta en CLOTHES_DIR) o rutas .mhclo.
    clothes: list[str] = []
    # Escala de cada prenda (por talla), en paralelo a `clothes`. 1.0 = base.
    clothes_scales: list[float] = []
    # Etiquetas de silueta de cada prenda (paralelo a `clothes`).
    clothes_styles: list[list[str]] = []
    # Peinado: auto | none | short | bob | long | ponytail | braids | afro
    hair: str = "auto"


HAIR_STYLES = {"auto", "none", "short", "bob", "long", "ponytail", "braids", "afro"}

# Qué región del cuerpo cubre cada carpeta de prenda (categoría del catálogo:
# top→camiseta, outerwear→chaqueta, bottom→pantalon, dress→vestido).
COVERS = {
    # La chaqueta es capa EXTERIOR: debajo siempre va una camiseta básica.
    "camiseta": {"top"}, "chaqueta": set(), "sudadera": set(), "blazer": set(), "cardigan": set(),
    "pantalon": {"bottom"}, "falda": {"bottom"}, "vestido": {"top", "bottom"},
}


def _uncovered_regions(names: list[str]) -> list[str]:
    covered: set[str] = set()
    for n in names or []:
        key = os.path.basename(os.path.dirname(n)) if n.endswith(".mhclo") else n
        covered |= COVERS.get(key.lower(), set())
    return [r for r in ("top", "bottom") if r not in covered]


def _resolve_clothes(names: list[str], scales: list[float], styles: list[list[str]] | None = None) -> list[tuple[str, float, str]]:
    """Resuelve nombres de prenda a (ruta .mhclo, escala), manteniendo el par.

    Acepta: ruta absoluta a un .mhclo, o un nombre de carpeta en CLOTHES_DIR
    (coge el primer .mhclo que haya dentro, sin importar cómo se llame el fichero).
    """
    import glob

    out = []
    for i, n in enumerate(names or []):
        scale = scales[i] if i < len(scales) else 1.0
        styl = ",".join(re.sub(r"[^a-z0-9-]", "", t.lower()) for t in (styles[i] if styles and i < len(styles) else []))
        if os.path.isabs(n) and n.endswith(".mhclo") and os.path.exists(n):
            out.append((n, scale, styl))
            continue
        folder = os.path.join(CLOTHES_DIR, n)
        hits = sorted(glob.glob(os.path.join(folder, "*.mhclo")))
        if hits:
            out.append((hits[0], scale, styl))
    return out


_SLOTS = threading.Semaphore(int(os.environ.get("MAX_PARALLEL", "2")))


def _run_blender(m: Measurements, out_path: str) -> None:
    cmd = [
        BLENDER_BIN, "--background", "--python", SCRIPT, "--",
        "--bust", str(m.bust), "--waist", str(m.waist), "--hip", str(m.hip),
        "--shoulder", str(m.shoulder), "--height", str(m.height),
        "--gender", m.gender, "--out", out_path,
        "--hair", m.hair if m.hair in HAIR_STYLES else "auto",
        "--basewear", ",".join(_uncovered_regions(m.clothes)),
    ]
    for path, scale, styl in _resolve_clothes(m.clothes, m.clothes_scales, m.clothes_styles):
        cmd += ["--clothes", path, "--clothes-scale", str(scale), "--clothes-style", styl]
    # Acota la concurrencia (Blender emulado es pesado) y reintenta una vez si
    # falla (p. ej. por memoria/timeouts transitorios).
    with _SLOTS:
        for attempt in range(2):
            if os.path.exists(out_path):
                os.unlink(out_path)
            try:
                proc = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
            except subprocess.TimeoutExpired as e:
                proc = subprocess.CompletedProcess(cmd, -9, e.stdout or "", "timeout")
            ok = proc.returncode == 0 and os.path.exists(out_path) and os.path.getsize(out_path) > 0
            if ok:
                break
            print("[serve] Blender falló (intento %d): rc=%s %s" % (attempt + 1, proc.returncode, str(proc.stderr)[-400:]), flush=True)
    if not ok:
        raise HTTPException(
            status_code=500,
            detail={
                "error": "Blender/MPFB2 falló",
                "returncode": proc.returncode,
                "stdout_tail": proc.stdout[-1500:],
                "stderr_tail": proc.stderr[-1500:],
            },
        )


@app.post("/generate")
def generate(m: Measurements):
    out = tempfile.NamedTemporaryFile(suffix=".glb", delete=False)
    out.close()
    _run_blender(m, out.name)
    return FileResponse(out.name, media_type="model/gltf-binary", filename="avatar-body.glb")


@app.post("/generate-to-file")
def generate_to_file(m: Measurements):
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    out_path = os.path.join(OUTPUT_DIR, "avatar-body.glb")
    _run_blender(m, out_path)
    return {"ok": True, "path": out_path, "bytes": os.path.getsize(out_path)}


@app.get("/health")
def health():
    return {"ok": True, "blender": BLENDER_BIN, "output_dir": OUTPUT_DIR}
