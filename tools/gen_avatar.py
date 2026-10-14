"""
gen_avatar.py — Genera un cuerpo humano CC0 desde medidas, en Blender headless.

Usa MakeHuman/MPFB2. Estrategia robusta: en vez de encadenar llamadas internas
de MPFB2 (que cambian entre versiones), se genera un archivo .mhm (formato
ESTABLE de MakeHuman) con los modificadores y se carga con UNA sola llamada
(`HumanService.deserialize_from_mhm`). El único punto sensible a versión queda
así aislado y con fallback.

USO
---
    blender --background --python tools/gen_avatar.py -- \
        --bust 158 --waist 159 --hip 145 --shoulder 110 --height 168 \
        --gender female \
        --out apps/web/public/models/avatar-body.glb

REQUISITOS
----------
    Blender 4.x + addon MPFB2 instalado y habilitado
    (github.com/makehumancommunity/mpfb2 — assets CC0, uso comercial libre).

CALIBRACIÓN
-----------
    La conversión medida(cm) -> modificador de MakeHuman (0..1, 0.5 = neutro) es
    APROXIMADA. Tras la primera generación real, mide el GLB y ajusta las
    constantes del bloque CALIBRACIÓN hasta que cuadren. Es un ajuste único.
"""

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import json
import math
import tempfile
import importlib

# --------------------------------------------------------------------------
# CALIBRACIÓN  (ajusta estos valores tras la primera pasada real)
# --------------------------------------------------------------------------

# Circunferencias "neutras" de referencia (cm) que corresponden al valor 0.5
# del modificador. Medias adultas aproximadas.
NEUTRAL = {"bust": 90.0, "waist": 76.0, "hip": 100.0}

# Cuántos cm cubre medio rango del modificador (de 0.5 a 1.0). Mayor => menos
# sensible. ~35 cm hace que +35 cm ≈ modificador al máximo.
CM_PER_HALF_RANGE = 35.0

# Altura: el macro Height de MakeHuman (0..1) cubre aprox. este rango en cm.
HEIGHT_MIN_CM = 150.0
HEIGHT_MAX_CM = 192.0

# El macro Weight (0..1) es el que más engrosa el cuerpo entero. Se deriva del
# "índice de contorno" medio frente a este neutro.
WEIGHT_NEUTRAL_CM = 88.0
WEIGHT_CM_PER_HALF_RANGE = 62.0

# Grados extra que se bajan los brazos sobre la A-pose por defecto de MPFB.
ARM_ANGLE_DEG = 11.0

# Assets del pack oficial CC0 de MakeHuman (se descarga en el Dockerfile).
SYSTEM_ASSETS = os.environ.get("SYSTEM_ASSETS_DIR", "/opt/croma-assets/system")
HAIR_ASSETS = {
    "short": "hair/short02/short02.mhclo",
    "bob": "hair/bob02/bob02.mhclo",
    "long": "hair/long01/long01.mhclo",
    "ponytail": "hair/ponytail01/ponytail01.mhclo",
    "braids": "hair/braid01/braid01.mhclo",
    "afro": "hair/afro01/afro01.mhclo",
}
EYEBROWS_ASSET = "eyebrows/eyebrow001/eyebrow001.mhclo"
EYELASHES_ASSET = "eyelashes/eyelashes01/eyelashes01.mhclo"
EYES_ASSET = "eyes/low-poly/low-poly.mhclo"
# Ropa básica (traje de dos piezas que se parte en parte alta / baja).
BASEWEAR_ASSET = {
    "female": "clothes/female_sportsuit01/female_sportsuit01.mhclo",
    "male": "clothes/male_casualsuit02/male_casualsuit02.mhclo",
}

BASEWEAR_OFFSET = 0.004  # m
CLOTHES_OFFSET = 0.004  # m
# Capas exteriores derivadas del pack de sistema: carpeta -> (asset, extras).
SYSTEM_OUTER = {
    "sudadera": ("clothes/male_casualsuit02/male_casualsuit02.mhclo", ["capucha", "_hoodie"]),
    "cardigan": ("clothes/male_casualsuit02/male_casualsuit02.mhclo", ["_cardigan"]),
    "blazer": ("clothes/male_elegantsuit01/male_elegantsuit01.mhclo", []),
}
OUTER_FOLDERS = {"chaqueta", "sudadera", "cardigan", "blazer"}
OUTER_EXTRA_OFFSET = 0.006  # m: chaqueta = capa exterior sobre la ropa básica

SCALE_FACTOR = 0.1  # MakeHuman -> Blender (decímetros a metros aprox.)


def clamp01(v: float) -> float:
    return max(0.0, min(1.0, v))


def measure_to_modifier(cm: float, key: str) -> float:
    """cm -> valor de modificador bidireccional (0..1, 0.5 neutro)."""
    return clamp01(0.5 + (cm - NEUTRAL[key]) / (2.0 * CM_PER_HALF_RANGE))


def height_to_modifier(cm: float) -> float:
    return clamp01((cm - HEIGHT_MIN_CM) / (HEIGHT_MAX_CM - HEIGHT_MIN_CM))


def weight_to_modifier(bust: float, waist: float, hip: float) -> float:
    # La cintura pesa MENOS en el promedio: es la medida más sensible a la pose
    # de la foto (brazos/codos), así que no debe engordar el cuerpo entero.
    avg = bust * 0.4 + hip * 0.4 + waist * 0.2
    return clamp01(0.5 + (avg - WEIGHT_NEUTRAL_CM) / (2.0 * WEIGHT_CM_PER_HALF_RANGE))


def belly_modifier(waist: float, bust: float, hip: float, gender: str) -> float:
    """Protuberancia abdominal DISCRETA; solo cinturas realmente grandes o
    figura manzana clara la marcan. En hombres se limita más (el modificador
    'stomach-pregnant' de MakeHuman crea una panza redonda irreal si se abusa)."""
    is_female = gender.lower().startswith("f")
    # Neutro alto (95) y rango ancho (70) => cintura normal ≈ barriga casi nula.
    base = 0.12 + (waist - 95.0) / (2.0 * 70.0)
    if waist >= bust and waist >= hip:  # apple: algo más, menos en hombres
        base += 0.10 if is_female else 0.05
    cap = 0.68 if is_female else 0.5
    return min(cap, clamp01(base))


def tone_from_weight(weight_mod: float) -> float:
    """Menos tono muscular (barriga/brazos más blandos) cuanto mayor el peso."""
    return clamp01(0.5 - (weight_mod - 0.5) * 0.6)


def limb_from_weight(weight_mod: float) -> float:
    """Grosor de brazos/muslos/pantorrillas acompañando al volumen general."""
    return min(0.9, clamp01(0.5 + (weight_mod - 0.5) * 0.85))


# --------------------------------------------------------------------------
# Generación del .mhm
# --------------------------------------------------------------------------

def build_mhm(args) -> str:
    """Devuelve el contenido de un archivo .mhm de MakeHuman."""
    # MakeHuman: macrodetails/Gender 0.0 = mujer, 1.0 = hombre.
    gender = 0.0 if args.gender.lower().startswith("f") else 1.0

    height = height_to_modifier(args.height)
    weight = weight_to_modifier(args.bust, args.waist, args.hip)
    m_bust = measure_to_modifier(args.bust, "bust")
    m_waist = measure_to_modifier(args.waist, "waist")
    m_hip = measure_to_modifier(args.hip, "hip")
    m_underbust = measure_to_modifier(args.bust * 0.95, "bust")

    belly = belly_modifier(args.waist, args.bust, args.hip, args.gender)
    tone = tone_from_weight(weight)
    limb = limb_from_weight(weight)

    lines = [
        "version v1.2.0",
        "modifier macrodetails/Gender %.6f" % gender,
        "modifier macrodetails/Age 0.500000",
        "modifier macrodetails/African 0.333333",
        "modifier macrodetails/Asian 0.333333",
        "modifier macrodetails/Caucasian 0.333333",
        "modifier macrodetails-height/Height %.6f" % height,
        "modifier macrodetails-universal/Muscle 0.500000",
        "modifier macrodetails-universal/Weight %.6f" % weight,
        "modifier macrodetails-proportions/BodyProportions 0.500000",
        # contornos principales
        "modifier measure/measure-bust-circ-decr|incr %.6f" % m_bust,
        "modifier measure/measure-underbust-circ-decr|incr %.6f" % m_underbust,
        "modifier measure/measure-waist-circ-decr|incr %.6f" % m_waist,
        "modifier measure/measure-hips-circ-decr|incr %.6f" % m_hip,
        # barriga (forma manzana) y flacidez
        "modifier stomach/stomach-pregnant-decr|incr %.6f" % belly,
        "modifier stomach/stomach-tone-decr|incr %.6f" % tone,
        # extremidades acompañando el volumen
        "modifier measure/measure-upperarm-circ-decr|incr %.6f" % limb,
        "modifier measure/measure-thigh-circ-decr|incr %.6f" % limb,
        "modifier measure/measure-calf-circ-decr|incr %.6f" % limb,
        "skeleton default.mhskel",
    ]
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------
# Blender / MPFB2
# --------------------------------------------------------------------------

def parse_args(argv):
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--bust", type=float, required=True)
    parser.add_argument("--waist", type=float, required=True)
    parser.add_argument("--hip", type=float, required=True)
    parser.add_argument("--shoulder", type=float, default=0.0)  # reservado
    parser.add_argument("--height", type=float, default=168.0)
    parser.add_argument("--gender", type=str, default="female")
    parser.add_argument("--out", type=str, required=True)
    # Prendas a vestir (rutas .mhclo). Repetible: --clothes a.mhclo --clothes b.mhclo
    parser.add_argument("--clothes", type=str, action="append", default=[])
    # Escala por talla de cada prenda, en paralelo a --clothes (1.0 = base).
    parser.add_argument("--clothes-scale", type=float, action="append", default=[])
    # Etiquetas de silueta de cada prenda (coma), en paralelo a --clothes.
    parser.add_argument("--clothes-style", type=str, action="append", default=[])
    # Peinado: auto | none | short | bob | long | ponytail | braids | afro
    parser.add_argument("--hair", type=str, default="auto")
    # Regiones SIN cubrir que se visten con ropa básica: "top", "bottom" (coma).
    parser.add_argument("--basewear", type=str, default="")
    parser.add_argument("--arm-angle", type=float, default=None)  # None = según cadera/busto
    return parser.parse_args(argv)


def ensure_addon_enabled():
    """Habilita MPFB. En Blender 4.2 es una EXTENSIÓN (namespace bl_ext.*.mpfb)."""
    import bpy  # type: ignore

    last = None
    for mod in ("bl_ext.user_default.mpfb", "mpfb"):
        try:
            bpy.ops.preferences.addon_enable(module=mod)
            print("[gen_avatar] MPFB habilitado:", mod)
            return
        except Exception as e:  # noqa: BLE001
            last = e
    print("[gen_avatar] aviso: no pude habilitar MPFB explícitamente:", repr(last))


def _find_human_service():
    """Localiza HumanService, ya venga como extensión (bl_ext.*) o addon legacy."""
    import importlib
    import sys

    candidates = [
        "bl_ext.user_default.mpfb.services.humanservice",
        "mpfb.services.humanservice",
    ]
    for name in list(sys.modules):
        if name.endswith(".mpfb"):
            candidates.append(name + ".services.humanservice")

    seen = set()
    for c in candidates:
        if c in seen:
            continue
        seen.add(c)
        try:
            return importlib.import_module(c).HumanService
        except Exception:  # noqa: BLE001
            continue
    raise ImportError("No encuentro HumanService de MPFB. Candidatos: %s" % candidates)


def _find_mpfb(subpath, attr):
    """Devuelve <attr> de un módulo MPFB (extensión bl_ext.* o legacy mpfb.*)."""
    candidates = [
        "bl_ext.user_default.mpfb." + subpath,
        "mpfb." + subpath,
    ]
    for name in list(sys.modules):
        if name.endswith(".mpfb"):
            candidates.append(name + "." + subpath)
    for c in candidates:
        try:
            mod = importlib.import_module(c)
            obj = getattr(mod, attr, None)
            if obj is not None:
                return obj
        except Exception:  # noqa: BLE001
            continue
    return None


def _apply_size_scale(clothes_obj, scale, ctx=None):
    """Talla: escala el contorno de la prenda (más que el largo). Con tallas
    pequeñas se conserva el ancho de hombros y mangas (si no, el deltoides
    asoma); la holgura se pierde sobre todo en pecho, cintura y bajo."""
    sy = 1.0 + (scale - 1.0) * 0.4
    zs = [v.co.z for v in clothes_obj.data.vertices]
    zc = (min(zs) + max(zs)) / 2
    zsh = ctx.Z(0.70) if ctx is not None else None
    for v in clothes_obj.data.vertices:
        k = scale
        if scale < 1.0 and zsh is not None:
            w = max(garment_shapes_smooth((v.co.z - zsh) / 0.06), garment_shapes_smooth((abs(v.co.x) - 0.12) / 0.04))
            k = 1.0 + (scale - 1.0) * (1.0 - w)
        cy = ctx.center_y(v.co.z) if ctx is not None else 0.0
        v.co.x *= k
        v.co.y = cy + (v.co.y - cy) * k
        v.co.z = zc + (v.co.z - zc) * (1.0 + (k - 1.0) * 0.4)
    clothes_obj.data.update()


def garment_shapes_smooth(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


_SKIRT_ZMAX = {}
_BRAID_STRANDS = []
_OUTER_HEM = {}


def _carve_front_opening(obj, ctx):
    """Quita camisa/corbata del traje y deja el blazer abierto con un borde
    suave (curva en V) y una vista (revés de solapa) fina."""
    import bmesh  # type: ignore

    zt = ctx.Z(0.6)

    def half_w(z):  # semiancho de la abertura: más ancha arriba (V suave)
        t = max(0.0, min(1.0, (z - zt) / (ctx.Z(0.84) - zt)))
        return 0.012 + 0.032 * t * t * (3 - 2 * t)

    bm = bmesh.new()
    bm.from_mesh(obj.data)
    cy = ctx.center_y(ctx.Z(0.7))
    kill = []
    for f in bm.faces:
        c = f.calc_center_median()
        if c.z > zt and c.y < cy + 0.02 and abs(c.x) < half_w(c.z):
            kill.append(f)
    bmesh.ops.delete(bm, geom=kill, context="FACES")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    border = [e for e in bm.edges if e.is_boundary and abs((e.verts[0].co.x + e.verts[1].co.x) / 2) < 0.07
              and (e.verts[0].co.z + e.verts[1].co.z) / 2 > zt - 0.01]
    bv = {v for e in border for v in e.verts}
    for v in bv:  # borde suave: los vértices se pegan a la curva
        if v.co.z > zt:
            v.co.x = math.copysign(half_w(v.co.z), v.co.x)
    for _ in range(3):
        bmesh.ops.smooth_vert(bm, verts=list(bv), factor=0.4, use_axis_x=False, use_axis_y=True, use_axis_z=True)
    if border:  # vista: tira fina doblada hacia el interior
        ext = bmesh.ops.extrude_edge_only(bm, edges=border)
        for g in ext["geom"]:
            if isinstance(g, bmesh.types.BMVert):
                g.co.y += 0.007
                g.co.x -= math.copysign(0.006, g.co.x) if abs(g.co.x) > 1e-4 else 0.0
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(obj.data)
    bm.free()


def _keep_outside_body(obj, tree, margin=0.004):
    """Ninguna prenda puede quedar dentro del cuerpo (p. ej. tallas pequeñas: la
    prenda encoge y el hombro/deltoides asoma): los vértices dentro o a menos de
    `margin` se sacan a `margin` por encima de la superficie."""
    moved = 0
    for v in obj.data.vertices:
        loc, nrm, _i, dist = tree.find_nearest(v.co)
        if loc is None:
            continue
        if (v.co - loc).dot(nrm) < 0 or dist < margin:
            v.co = loc + nrm * margin
            moved += 1
    return moved


def _keep_main_upper_island(obj, zmin_keep):
    """De un traje de varias piezas, conserva la isla grande de la parte alta."""
    import bmesh  # type: ignore

    bm = bmesh.new()
    bm.from_mesh(obj.data)
    seen, comps = set(), []
    for v0 in bm.verts:
        if v0 in seen:
            continue
        stack, comp = [v0], []
        seen.add(v0)
        while stack:
            v = stack.pop()
            comp.append(v)
            for e in v.link_edges:
                o = e.other_vert(v)
                if o not in seen:
                    seen.add(o)
                    stack.append(o)
        comps.append(comp)
    upper = [c for c in comps if sum(v.co.z for v in c) / len(c) > zmin_keep]
    keep = set(max(upper or comps, key=len))
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if v not in keep], context="VERTS")
    bm.to_mesh(obj.data)
    bm.free()
    print("[gen_avatar] isla conservada (%d vértices de %d islas)" % (len(keep), len(comps)))


def _cut_skirt(obj, zcut):
    """Falda = vestido recortado en la cintura, con un cinturón cerrado: se
    extruye el borde cortado hacia arriba y un poco hacia dentro (queda
    remetido bajo la camiseta)."""
    import bmesh  # type: ignore

    bm = bmesh.new()
    bm.from_mesh(obj.data)
    geom = list(bm.verts) + list(bm.edges) + list(bm.faces)
    bmesh.ops.bisect_plane(bm, geom=geom, plane_co=(0.0, 0.0, zcut), plane_no=(0.0, 0.0, 1.0),
                           clear_outer=True, clear_inner=False)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    border = [e for e in bm.edges if e.is_boundary]
    if border:
        ext = bmesh.ops.extrude_edge_only(bm, edges=border)
        nv = [g for g in ext["geom"] if isinstance(g, bmesh.types.BMVert)]
        cx = sum(v.co.x for v in nv) / len(nv)
        cy = sum(v.co.y for v in nv) / len(nv)
        for v in nv:
            v.co.z += 0.016
            v.co.x = cx + (v.co.x - cx) * 0.992
            v.co.y = cy + (v.co.y - cy) * 0.992
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(obj.data)
    bm.free()


def load_clothes_onto_human(human, mhclo_paths, scales=None, styles=None, outer_present=False):
    """Viste al humano con las prendas .mhclo, ajustándolas a su forma.

    API real de MPFB v2.0.17 (fijada con inspect_mpfb.py):
      mhclo = Mhclo(); mhclo.load(path); mhclo.load_mesh(context)
      ClothesService.fit_clothes_to_human(clothes_obj, human, mhclo)
    `scales` (paralelo a mhclo_paths) escala cada prenda por talla.
    Nunca rompe la generación del cuerpo: si algo falla, exporta el cuerpo solo.
    """
    if not mhclo_paths:
        return []
    import bpy  # type: ignore

    scales = scales or []
    styles = styles or []
    ctx = None
    body_tree = None
    ClothesService = _find_mpfb("services.clothesservice", "ClothesService")
    Mhclo = _find_mpfb("services.clothesservice", "Mhclo")  # se re-exporta ahí
    if ClothesService is None or Mhclo is None:
        print("[gen_avatar] aviso: sin ClothesService/Mhclo; no visto la prenda.")
        return []

    loaded = []
    for i, path in enumerate(mhclo_paths):
        if not os.path.exists(path):
            print("[gen_avatar] aviso: asset no existe:", path)
            continue
        try:
            folder = os.path.basename(os.path.dirname(path)).lower()
            extra_tags = []
            real_path = path
            early = [t for t in (styles[i] if i < len(styles) else "").split(",") if t]
            from_system = folder in SYSTEM_OUTER
            if from_system:
                real_path = os.path.join(SYSTEM_ASSETS, SYSTEM_OUTER[folder][0])
                extra_tags = list(SYSTEM_OUTER[folder][1])
            elif folder == "camiseta" and "cuello-redondo" in early and not (set(early) & {"camisa", "punto"}):
                # Camiseta de cuello redondo: jersey del pack (cuello redondo) con mangas cortas.
                from_system = True
                real_path = os.path.join(SYSTEM_ASSETS, "clothes/male_casualsuit02/male_casualsuit02.mhclo")
                extra_tags = ["_shortsleeve"]
            elif folder == "camiseta" and (set(early) & {"camisa", "punto"}):
                # Camisa oxford / jersey de punto: manga larga (jersey del pack).
                from_system = True
                real_path = os.path.join(SYSTEM_ASSETS, "clothes/male_casualsuit02/male_casualsuit02.mhclo")
                extra_tags = ["_camisa"] if "camisa" in early else ["_punto"]
            mhclo = Mhclo()
            mhclo.load(real_path)
            # load_mesh(context) importa la malla .obj y DEVUELVE el objeto prenda.
            clothes_obj = mhclo.load_mesh(bpy.context)
            # Firma real (MPFB 2.0.17): fit_clothes_to_human(CLOTHES, basemesh, mhclo).
            ClothesService.fit_clothes_to_human(clothes_obj, human, mhclo)
            # Escala por talla (si se pidió).
            scale = scales[i] if i < len(scales) else 1.0
            if abs(scale - 1.0) > 1e-3:
                import garment_shapes as _gs
                if ctx is None:
                    ctx = _gs.BodyCtx(human, next((o for o in bpy.data.objects if o.type == 'ARMATURE'), None))
                _apply_size_scale(clothes_obj, scale, ctx)
            # Nombre predecible por ORDEN, para que la web coloree cada prenda.
            try:
                ClothesService.update_delete_group(
                    mhclo, human, replace_delete_group=False,
                    delete_group_name="Delete.clothes_%d" % i, add_modifier=False)
            except Exception as e:  # noqa: BLE001
                print("[gen_avatar] aviso: sin delete group para", path, repr(e))
            clothes_obj.name = "clothes_%d" % i
            if getattr(clothes_obj, "data", None) is not None:
                clothes_obj.data.name = "clothes_%d" % i
            clothes_obj.data.update()
            kind = {"camiseta": "top", "chaqueta": "outer", "sudadera": "outer", "cardigan": "outer",
                    "blazer": "outer", "pantalon": "bottom", "vestido": "dress", "falda": "skirt"}.get(folder, "top")
            # capas: exterior > camiseta > falda/pantalón; con capa exterior las
            # interiores se quedan por debajo de ella.
            top_extra = 0.0 if outer_present else 0.009
            lift = CLOTHES_OFFSET + {"outer": OUTER_EXTRA_OFFSET, "top": top_extra, "dress": 0.0 if outer_present else 0.002}.get(kind, 0.0)
            for v in clothes_obj.data.vertices:  # separa un poco del cuerpo: evita que asome
                v.co += v.normal * lift
            try:
                import garment_shapes
                if ctx is None:
                    arm = next((o for o in bpy.data.objects if o.type == "ARMATURE"), None)
                    ctx = garment_shapes.BodyCtx(human, arm)
                zeye = ctx.zmax - 0.104 * ctx.H / 1.58
                if kind == "skirt":
                    _cut_skirt(clothes_obj, ctx.Z(0.605))
                if from_system:
                    _keep_main_upper_island(clothes_obj, ctx.Z(0.55))
                    if folder == "blazer":
                        _carve_front_opening(clothes_obj, ctx)
                    # Prenda de corte masculino sobre pecho femenino: se abulta en el busto.
                    cyb = ctx.center_y(ctx.Z(0.7))
                    for v in clothes_obj.data.vertices:
                        w = (garment_shapes.smooth((v.co.z - ctx.Z(0.62)) / 0.03)
                             * (1.0 - garment_shapes.smooth((v.co.z - ctx.Z(0.77)) / 0.04))
                             * (1.0 if v.co.y < cyb else 0.0) * (1.0 - garment_shapes.smooth((abs(v.co.x) - 0.12) / 0.05)))
                        if w > 0:
                            v.co.y -= 0.022 * w
                tags = [t for t in (styles[i] if i < len(styles) else "").split(",") if t] + extra_tags
                garment_shapes.apply(clothes_obj, kind, tags, ctx, zeye, ctx.center_y(zeye), outer_present)
                print("[gen_avatar] siluetas", tags, "->", kind)
                zs = [v.co.z for v in clothes_obj.data.vertices]
                zlo, zhi = min(zs), max(zs)
                # Piel que se oculta: solo donde la prenda realmente llega (el borde
                # irregular del bajo/cintura deja agujeros si se oculta de más).
                zlo = zlo + 0.02 if kind in ("top", "outer", "dress", "skirt") else -9.0
                zhi = zhi - 0.03 if kind in ("bottom", "skirt") else 9.0
                _SKIRT_ZMAX["Delete.clothes_%d" % i] = {"range": (zlo, zhi), "xmax": 0.14 if "_shortsleeve" in extra_tags else 9.0}
                if kind == "outer":
                    _OUTER_HEM["z"] = min(zs)
            except Exception as e:  # noqa: BLE001
                import traceback
                traceback.print_exc()
                print("[gen_avatar] aviso: silueta no aplicada:", repr(e))
            try:
                if body_tree is None:
                    from mathutils.bvhtree import BVHTree  # type: ignore
                    body_tree = BVHTree.FromObject(human, bpy.context.evaluated_depsgraph_get())
                n_out = _keep_outside_body(clothes_obj, body_tree, 0.004 if kind != "outer" else 0.01)
                if n_out:
                    print("[gen_avatar] prenda separada del cuerpo:", n_out, "vértices")
            except Exception as e:  # noqa: BLE001
                print("[gen_avatar] aviso: no pude separar la prenda del cuerpo:", repr(e))
            clothes_obj.data.polygons.foreach_set("use_smooth", [True] * len(clothes_obj.data.polygons))
            clothes_obj.data.update()
            loaded.append(clothes_obj)
            print("[gen_avatar] prenda vestida:", os.path.basename(path), "-> clothes_%d (x%.3f)" % (i, scale))
        except Exception as e:  # noqa: BLE001
            print("[gen_avatar] ERROR vistiendo", path, "->", repr(e))
    return loaded


def _select_only(obj):
    import bpy  # type: ignore

    try:
        bpy.ops.object.mode_set(mode="OBJECT")
    except Exception:  # noqa: BLE001
        pass
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def _name_obj(obj, name):
    obj.name = name
    if getattr(obj, "data", None) is not None:
        obj.data.name = name


def add_system_asset(human, rel_path, asset_type, name):
    """Añade un asset del pack de sistema (pelo, cejas, pestañas, ojos, ropa
    básica) con HumanService.add_mhclo_asset: carga la malla, el material
    (texturas) y la ajusta al cuerpo. Devuelve el objeto o None si falla."""
    HumanService = _find_human_service()
    path = os.path.join(SYSTEM_ASSETS, rel_path)
    if not os.path.exists(path):
        print("[gen_avatar] aviso: asset no existe:", path)
        return None
    try:
        obj = HumanService.add_mhclo_asset(
            path, human, asset_type=asset_type, subdiv_levels=0,
            material_type="GAMEENGINE", set_up_rigging=False,
        )
        _name_obj(obj, name)
        print("[gen_avatar] asset:", rel_path, "->", name)
        return obj
    except Exception as e:  # noqa: BLE001
        print("[gen_avatar] ERROR asset", rel_path, "->", repr(e))
        return None


# --------------------------------------------------------------------------
# Peinados procedurales (afro, trenzas): se construyen sobre la cabeza real
# --------------------------------------------------------------------------

def head_metrics(human):
    """Medidas de la cabeza a partir de la malla (tras posar): altura de los
    ojos, coronilla, centro y semiejes."""
    import bpy  # type: ignore

    mat = human.matrix_world
    body = human.vertex_groups["body"].index
    pts = []
    for v in human.data.vertices:
        if any(g.group == body and g.weight > 0.5 for g in v.groups):
            pts.append(mat @ v.co)
    ztop = max(p.z for p in pts)
    eyes = bpy.data.objects.get("eyes")
    if eyes is not None:
        ez = [(eyes.matrix_world @ v.co).z for v in eyes.data.vertices]
        zeye = sum(ez) / len(ez)
    else:
        zeye = ztop - 0.12
    band = [p for p in pts if zeye - 0.02 <= p.z <= ztop and p.z > zeye - 0.02]
    # Solo la cabeza: dentro de ~0.13 m de la vertical que pasa por la nariz/occipucio.
    xs = [p.x for p in band if abs(p.x) < 0.14]
    ys = [p.y for p in band]
    ymin, ymax = min(ys), max(ys)
    return {
        "zeye": zeye, "ztop": ztop,
        "xc": 0.0, "yc": (ymin + ymax) / 2, "hx": max(abs(min(xs)), abs(max(xs))),
        "hy": (ymax - ymin) / 2,
    }


def _hair_material(name="hair"):
    """Material con color por vértice (variación de claridad): el visor lo
    multiplica por el color de pelo. Base blanca, sin textura externa."""
    import bpy  # type: ignore

    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    vc = nt.nodes.new("ShaderNodeVertexColor")
    vc.layer_name = "Col"
    if bsdf:
        nt.links.new(vc.outputs["Color"], bsdf.inputs["Base Color"])
        bsdf.inputs["Roughness"].default_value = 0.6
    mat.diffuse_color = (0.3, 0.19, 0.12, 1.0)
    return mat


def _smooth(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


def hair_boundary_z(x, y, hm):
    """Altura del borde del pelo según el azimut en torno a la cabeza: línea
    frontal curva (más baja hacia las sienes), sobre las orejas por los lados y
    bajando por detrás de ellas hasta la nuca."""
    import math

    a = math.degrees(math.atan2(abs(x), -(y - hm["yc"])))  # 0 = frente, 180 = nuca
    front, side, back = hm["zeye"] + hm.get("front_off", 0.062), hm["zeye"] + 0.012, hm["zeye"] - 0.085
    if a < 90:
        return front + (side - front) * _smooth(a / 90.0)
    return side + (back - side) * _smooth((a - 90.0) / 90.0)


def _hair_region(human, bm, hm, offset_fn):
    """Copia al bmesh el cuero cabelludo del cuerpo hasta el borde del pelo.
    Los vértices bajo el borde se pegan a la curva (borde limpio, sin
    escalones) y todo se separa de la piel con `offset_fn(prof, normal, radial)`."""
    import mathutils  # type: ignore

    mat = human.matrix_world
    rot = mat.to_3x3()
    me = human.data
    body = human.vertex_groups["body"].index
    c = mathutils.Vector((0.0, hm["yc"], hm["zeye"] + 0.01))
    info = {}
    for v in me.vertices:
        if not any(g.group == body and g.weight > 0.5 for g in v.groups):
            continue
        p = mat @ v.co
        if abs(p.x) > 0.14 or p.z < hm["zeye"] - 0.12 or p.z > hm["ztop"] + 0.01:
            continue
        info[v.index] = (p, p.z - hair_boundary_z(p.x, p.y, hm))
    vmap = {}
    for poly in me.polygons:
        vs = poly.vertices
        if not all(i in info for i in vs) or not any(info[i][1] > 0 for i in vs):
            continue
        ids = []
        for i in vs:
            if i not in vmap:
                p, d = info[i]
                n = (rot @ me.vertices[i].normal).normalized()
                q = p.copy()
                if d < 0:
                    q.z = p.z - d
                prof = _smooth(max(d, 0.0) / 0.05)
                vmap[i] = bm.verts.new(q + offset_fn(prof, q, n, (p - c).normalized()))
            ids.append(vmap[i])
        try:
            bm.faces.new(ids)
        except ValueError:
            pass


def _set_vertex_colors(bm, light_fn):
    layer = bm.loops.layers.color.get("Col") or bm.loops.layers.color.new("Col")
    cache = {}
    for f in bm.faces:
        for lp in f.loops:
            v = lp.vert
            if v.index not in cache:
                cache[v.index] = light_fn(v)
            l = cache[v.index]
            lp[layer] = (l, l, l * 0.96, 1.0)


def _finish_hair(bm, human, light_fn, smooth=True):
    import bpy  # type: ignore

    bm.verts.index_update()
    _set_vertex_colors(bm, light_fn)
    me = bpy.data.meshes.new("hair")
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new("hair", me)
    bpy.context.scene.collection.objects.link(obj)
    if smooth:
        me.polygons.foreach_set("use_smooth", [True] * len(me.polygons))
    me.materials.append(_hair_material())
    obj.parent = human
    return obj


def build_afro(human):
    """Afro: volumen redondeado que abraza el cráneo (el cuero cabelludo real
    inflado), con borde curvo: frente → sienes → sobre y detrás de las orejas →
    nuca. Rizo por ruido y variación de claridad por vértice."""
    import bmesh  # type: ignore
    import mathutils  # type: ignore
    from mathutils import noise  # type: ignore

    hm = head_metrics(human)

    def off(prof, q, n, radial):
        up = max(0.0, (q.z - hm["zeye"]) / 0.1)
        t = (0.043 + 0.022 * up) * (0.1 + 0.9 * prof)
        return (n * 0.35 + radial * 0.65).normalized() * t

    bm = bmesh.new()
    _hair_region(human, bm, hm, off)
    bmesh.ops.subdivide_edges(bm, edges=list(bm.edges), cuts=2, use_grid_fill=True)
    c = mathutils.Vector((0.0, hm["yc"], hm["zeye"] + 0.01))
    disp = {}
    for v in bm.verts:
        prof = _smooth(max(v.co.z - hair_boundary_z(v.co.x, v.co.y, hm), 0.0) / 0.05)
        r = (v.co - c).normalized()
        p = v.co
        # Rizos: varias octavas + cresta (clumps de espirales pequeñas).
        ridge = 1.0 - abs(noise.noise(p * 95.0))
        f1 = noise.voronoi(p * 52.0)[0][0]
        b = max(0.0, 1.0 - f1 * 1.15)
        ball = b * b * (3 - 2 * b) - 0.3   # bultos redondeados (rizos pequeños)
        crown = 1.0 + 0.2 * max(0.0, (v.co.z - hm["zeye"] - 0.04) / 0.07)  # más rizo en la coronilla
        d = ((0.0075 * noise.noise(p * 38.0) + 0.0050 * noise.noise(p * 85.0)
              + 0.0042 * (ridge * ridge - 0.5) + 0.0022 * noise.noise(p * 210.0)) * 1.2
             + 0.0065 * ball) * crown
        amp = 0.25 + 0.75 * prof
        v.co += r * d * amp
        disp[v] = (max(-1.2, min(1.2, d / 0.02)), prof)

    def light(v):
        d, prof = disp.get(v, (0.0, 1.0))
        # Cavidades (d<0) oscuras, crestas claras; raíz más oscura.
        return max(0.12, (0.52 + 0.55 * d) * (0.55 + 0.45 * prof))

    return _finish_hair(bm, human, light)


def build_braids(human):
    """Trenzas (box braids): tubos de sección elíptica que giran a lo largo de
    la trenza, con raíces repartidas por el cuero cabelludo y cayendo detrás
    y a los lados hasta pasado el hombro."""
    import math
    import bmesh  # type: ignore
    import mathutils  # type: ignore

    hm = head_metrics(human)
    c = mathutils.Vector((0.0, hm["yc"], hm["zeye"] + 0.035))
    ax, ay, az = hm["hx"] + 0.006, hm["hy"] + 0.006, hm["ztop"] - c.z + 0.006
    bm = bmesh.new()
    hm["front_off"] = 0.05  # línea del pelo real, algo más baja
    _hair_region(human, bm, hm, lambda prof, q, n, radial: n * (0.0025 + 0.0035 * prof))
    bmesh.ops.subdivide_edges(bm, edges=list(bm.edges), cuts=2, use_grid_fill=True)
    bm.normal_update()
    strands = []
    lights = {}
    for v in bm.verts:
        # Cornrows: filas paralelas de delante hacia atrás con raya central. El
        # relieve es GEOMÉTRICO (surcos hondos entre filas), además de COLOR_0.
        stripe = 0.5 + 0.5 * math.cos(2 * math.pi * v.co.x / 0.0125)
        row = stripe ** 1.6
        v.co += v.normal * (0.0048 * row - 0.0014)
        lights[v] = 0.9 if abs(v.co.x) < 0.0025 else 0.2 + 0.55 * row
        if abs(v.co.x) < 0.0025:
            v.co -= v.normal * 0.0025  # la raya queda hundida
    # Tronco: referencia de dónde está la espalda/hombros bajo la cabeza.
    mat = human.matrix_world
    zsh = hm["zeye"] - 0.27
    torso = [mat @ v.co for v in human.data.vertices
             if abs((mat @ v.co).z - zsh) < 0.03 and abs((mat @ v.co).x) < 0.2]
    yback = max(p.y for p in torso) if torso else hm["yc"] + 0.1
    xsh = max(abs(p.x) for p in torso) if torso else 0.18
    zend = hm["zeye"] - 0.40

    rows = [(-0.005, 13), (0.03, 11), (0.055, 8)]  # (altura sobre c.z, nº de raíces)
    k = 0
    for row_i, (dz, n) in enumerate(rows):
        for i in range(n):
            # Azimut: 0 = frente; se excluye el arco frontal central (cara/frente).
            lo, hi = (72, 288)
            phi = math.radians(lo + (hi - lo) * (i + 0.5 * (row_i % 2)) / max(1, n - 1 if row_i % 2 == 0 else n))
            e = math.asin(max(-1, min(1, dz / az)))
            d = mathutils.Vector((math.sin(phi), -math.cos(phi), 0.0))
            root = c + mathutils.Vector((d.x * ax * math.cos(e), d.y * ay * math.cos(e), az * math.sin(e)))
            # Punto de caída: por fuera de cabeza/hombros.
            back = d.y > 0
            out_x = max(abs(root.x), 0.0)
            hang_x = math.copysign(min(max(out_x * 1.15, 0.05), xsh + 0.015), d.x) if abs(d.x) > 0.25 else root.x
            hang_x = root.x * 1.0 if abs(d.x) <= 0.25 else hang_x
            hang_y = max(root.y, yback + 0.03) if back else root.y - 0.02
            if abs(d.x) > 0.8:
                hang_y = hm["yc"] + 0.01
            top = mathutils.Vector((root.x, root.y, root.z)) + d * 0.012
            mid = mathutils.Vector((hang_x, hang_y, zsh + 0.04))
            end = mathutils.Vector((hang_x, hang_y, zend - 0.06 * ((i * 7 + row_i * 3) % 3)))
            path = _bezier_path([root, top, mid, end], 30)
            strands.append(_add_braid(bm, path, 0.0095, phase=k * 0.7, lights=lights))
            k += 1
    _push_out_of_body(bm, human, hm, strands)
    bm.verts.index_update()
    _BRAID_STRANDS[:] = [[[v.index for v in ring] for ring in st] for st in strands]
    return _finish_hair(bm, human, lambda v: lights.get(v, 0.5))


def _push_strands(strands, get_ring, move_ring, trees, zmax, need=0.024, to=0.030):
    """Aparta cada trenza del cuerpo/ropa moviendo ANILLOS enteros (rígido) y con
    desplazamientos suavizados a lo largo de la trenza: sin deformar la sección."""
    from mathutils import Vector  # type: ignore

    moved = 0
    for st in strands:
        deltas = []
        for ring in st:
            verts = get_ring(ring)
            c = sum(verts, Vector()) / len(verts)
            d = Vector()
            if c.z <= zmax:
                best = None
                for t in trees:
                    r = t.find_nearest(c)
                    if r[0] is not None and (best is None or r[3] < best[3]):
                        best = r
                if best is not None:
                    loc, nrm, _i, dist = best
                    if (c - loc).dot(nrm) < 0 or dist < need:
                        d = (loc + nrm * to) - c
            deltas.append(d)
        for _ in range(3):  # suaviza: sin quiebros entre anillos contiguos
            deltas = [(deltas[max(i - 1, 0)] + deltas[i] * 2 + deltas[min(i + 1, len(deltas) - 1)]) / 4 for i in range(len(deltas))]
        for ring, d in zip(st, deltas):
            if d.length > 1e-5:
                move_ring(ring, d)
                moved += 1
    return moved


def _body_trees(human):
    import bpy  # type: ignore
    from mathutils.bvhtree import BVHTree  # type: ignore

    dg = bpy.context.evaluated_depsgraph_get()
    objs = [human] + [o for o in bpy.data.objects if o.type == "MESH" and o.name.startswith(("clothes_", "basewear_"))]
    return [BVHTree.FromObject(o, dg) for o in objs]


def _push_out_of_body(bm, human, hm, strands):
    n = _push_strands(strands, lambda r: [v.co for v in r],
                      lambda r, d: [setattr(v, "co", v.co + d) for v in r],
                      _body_trees(human), hm["zeye"] - 0.12)
    print("[gen_avatar] trenzas separadas del cuerpo:", n, "anillos")


def _push_hair_final(human, style):
    """Última pasada (con ropa básica ya puesta), también por anillos rígidos."""
    import bpy  # type: ignore

    hair = bpy.data.objects.get("hair")
    if hair is None or style != "braids" or not _BRAID_STRANDS:
        return
    me = hair.data
    hm = head_metrics(human)
    n = _push_strands(_BRAID_STRANDS, lambda r: [me.vertices[i].co for i in r],
                      lambda r, d: [setattr(me.vertices[i], "co", me.vertices[i].co + d) for i in r],
                      _body_trees(human), hm["zeye"] - 0.12)
    me.update()
    print("[gen_avatar] trenzas (pasada final):", n, "anillos")


def _bezier_path(ctrl, n):
    import mathutils  # type: ignore

    out = []
    m = len(ctrl) - 1
    from math import comb
    for s in range(n):
        t = s / (n - 1)
        p = mathutils.Vector((0, 0, 0))
        for i, q in enumerate(ctrl):
            p += q * (comb(m, i) * (1 - t) ** (m - i) * t ** i)
        out.append(p)
    return out


def _add_braid(bm, path, radius, phase=0.0, lights=None):
    """Trenza: tubo de 6 lados con sección elíptica que gira (aspecto trenzado).
    En los últimos ~3 cm el giro se detiene y la sección se vuelve circular; el
    radio baja suave hasta ~40 % y se cierra con una media esfera de 3 anillos.
    Devuelve la lista de anillos (para moverlos rígidamente)."""
    import math
    import mathutils  # type: ignore

    sides = 6
    n_p = len(path)
    n_tip = 3                       # anillos de la punta (~3 cm a 1,7 cm/anillo + sobrante)
    i_tip = n_p - 1 - n_tip         # el giro se congela aquí
    rings = []

    def frame(t):
        up = mathutils.Vector((0, 1, 0)) if abs(t.y) < 0.9 else mathutils.Vector((1, 0, 0))
        u = t.cross(up).normalized()
        return u, t.cross(u).normalized()

    def smoothstep(x):
        x = max(0.0, min(1.0, x))
        return x * x * (3 - 2 * x)

    def make_ring(p, u, v, r, ang, round_k, light_fn):
        ring = []
        for j in range(sides):
            a = 2 * math.pi * j / sides
            ex = math.cos(a) * (1.35 + (1.0 - 1.35) * round_k)
            ey = math.sin(a) * (0.8 + (1.0 - 0.8) * round_k)
            cx = ex * math.cos(ang) - ey * math.sin(ang)
            cy = ex * math.sin(ang) + ey * math.cos(ang)
            nv = bm.verts.new(p + (u * cx + v * cy) * r)
            if lights is not None:
                lights[nv] = light_fn(a)
            ring.append(nv)
        return ring

    last_u = last_v = None
    for i, p in enumerate(path):
        t = (path[min(i + 1, n_p - 1)] - path[max(i - 1, 0)]).normalized()
        if i <= i_tip or last_u is None:
            u, v = frame(t)
            last_u, last_v = u, v
        else:
            u, v = last_u, last_v        # sin giro de marco en la punta
        ang = phase + min(i, i_tip) * 0.9
        k = max(0, i - i_tip)           # 0 hasta la goma, luego 1..n_tip
        round_k = smoothstep(k / float(n_tip))
        taper = 1.0 - 0.6 * smoothstep(k / float(n_tip))   # baja a 40 %
        tie = (k == 1)                  # goma justo donde empieza el afinado
        r = radius * (taper * (1.3 if tie else 1.0))
        lf = (lambda a, i=i, tie=tie: 0.12 if tie else (0.5 + 0.4 * math.sin(i * 1.8 + a * 2.0 + phase)) * (0.8 + 0.2 * math.sin(phase * 3.1)) + 0.1 * (i / n_p))
        rings.append(make_ring(p, u, v, r, ang, round_k, lf))
    # media esfera: 3 anillos que cierran la punta
    tdir = (path[-1] - path[-2]).normalized()
    r_end = radius * 0.4
    for th in (30.0, 60.0, 85.0):
        c = path[-1] + tdir * (r_end * math.sin(math.radians(th)))
        rr = r_end * math.cos(math.radians(th))
        rings.append(make_ring(c, last_u, last_v, rr, phase + i_tip * 0.9, 1.0, lambda a: 0.3))
    for a, b in zip(rings, rings[1:]):
        for j in range(sides):
            bm.faces.new((a[j], a[(j + 1) % sides], b[(j + 1) % sides], b[j]))
    tip = bm.verts.new(path[-1] + tdir * r_end * 1.0)
    if lights is not None:
        lights[tip] = 0.3
    for j in range(sides):
        bm.faces.new((rings[-1][j], rings[-1][(j + 1) % sides], tip))
    rings.append([tip])  # la punta se mueve con la trenza (si no, queda un pelo suelto)
    return rings

def _clear_fringe_over_eyes(hair_obj, hm):
    """El flequillo de bob02 cae sobre un ojo: se sube el borde del flequillo
    por encima de las cejas (los vértices frontales se pliegan hacia arriba con
    caída suave a los lados), sin dejar huecos en la malla."""
    me = hair_obj.data
    mat = hair_obj.matrix_world
    inv = mat.inverted()
    ztarget = hm["zeye"] + 0.04
    n = 0
    for v in me.vertices:
        p = mat @ v.co
        if p.y > hm["yc"] - 0.045 or not (hm["zeye"] - 0.06 < p.z < ztarget):
            continue
        t = 1.0 - min(1.0, max(0.0, (abs(p.x) - 0.06) / 0.035))
        if t <= 0:
            continue
        p.z = p.z + (ztarget - p.z) * t * min(1.0, (p.z - (hm["zeye"] - 0.06)) / 0.05)
        v.co = inv @ p
        n += 1
    me.update()
    print("[gen_avatar] flequillo subido:", n, "vértices")


def add_head_details(human, hair, gender):
    if hair == "auto":
        hair = "short" if gender.lower().startswith("m") else "long"
    add_system_asset(human, EYEBROWS_ASSET, "Eyebrows", "eyebrows")
    add_system_asset(human, EYELASHES_ASSET, "Eyelashes", "eyelashes")
    add_system_asset(human, EYES_ASSET, "Eyes", "eyes")
    if hair in ("afro", "braids"):
        try:
            (build_afro if hair == "afro" else build_braids)(human)
            print("[gen_avatar] pelo procedural:", hair)
        except Exception as e:  # noqa: BLE001
            import traceback
            traceback.print_exc()
            print("[gen_avatar] ERROR pelo procedural", hair, repr(e))
    elif hair != "none" and hair in HAIR_ASSETS:
        obj = add_system_asset(human, HAIR_ASSETS[hair], "Hair", "hair")
        if obj is not None and hair == "bob":
            _clear_fringe_over_eyes(obj, head_metrics(human))


def _strip_sleeves(parts, pieces_top):
    """Bajo una capa exterior se quitan las mangas de la ropa básica (asoman por
    las mangas de la prenda exterior)."""
    import bmesh  # type: ignore
    import bpy  # type: ignore

    arm = next((o for o in bpy.data.objects if o.type == "ARMATURE"), None)
    if arm is None:
        return
    segs = []
    m = arm.matrix_world
    for side in ("L", "R"):
        for nm in ("upperarm01.", "lowerarm01."):
            b = arm.data.bones.get(nm + side)
            if b:
                segs.append((m @ b.head_local, m @ b.tail_local))
    for o in parts:
        bm = bmesh.new()
        bm.from_mesh(o.data)
        kill = []
        for f in bm.faces:
            p = f.calc_center_median()
            for a, b in segs:
                ax = b - a
                L = ax.length or 1e-6
                t = (p - a).dot(ax) / (L * L)
                if t > 0.12:
                    q = a + ax * min(t, 1.0)
                    if (p - q).length < 0.075:
                        kill.append(f)
                        break
            else:
                if abs(p.x) > 0.115:  # costados/axila: asoman por la sisa
                    kill.append(f)
        if kill:
            bmesh.ops.delete(bm, geom=kill, context="FACES")
            bm.to_mesh(o.data)
        bm.free()


def _extend_top_to_hip(obj, human, z_end=None, bottom=None):
    """Bajo una capa exterior abierta, el top corto (crop) se alarga hasta la
    cadera para que no quede el abdomen al aire: se extruye el borde inferior
    en 4 filas pegadas a la superficie del cuerpo."""
    import bmesh  # type: ignore
    import bpy  # type: ignore
    import garment_shapes
    from mathutils import Vector  # type: ignore
    from mathutils.bvhtree import BVHTree  # type: ignore

    ctx = garment_shapes.BodyCtx(human)
    dg = bpy.context.evaluated_depsgraph_get()
    tree = BVHTree.FromObject(human, dg)
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    # Islas sueltas (motas de malla flotando sobre el vientre): se eliminan.
    seen, comps = set(), []
    for v0 in bm.verts:
        if v0 in seen:
            continue
        stack, comp = [v0], []
        seen.add(v0)
        while stack:
            vv = stack.pop()
            comp.append(vv)
            for e in vv.link_edges:
                o = e.other_vert(vv)
                if o not in seen:
                    seen.add(o)
                    stack.append(o)
        comps.append(comp)
    mx = max(len(c) for c in comps)
    for c in comps:
        if len(c) < mx * 0.05:
            print("[gen_avatar] isla suelta en el top eliminada:", len(c), "vértices")
            bmesh.ops.delete(bm, geom=c, context="VERTS")
    loops = garment_shapes._boundary_loops(bm)
    # Cierra agujeros pequeños del top (asomaba piel/gris por una mota en la cintura).
    small = [l for l in loops if 3 <= len(l) <= 14]
    if small:
        hole_edges = [e for e in bm.edges if e.is_boundary and any(e.verts[0] in l and e.verts[1] in l for l in small)]
        bmesh.ops.holes_fill(bm, edges=hole_edges, sides=16)
        bm.normal_update()
        loops = garment_shapes._boundary_loops(bm)
        print("[gen_avatar] agujeros cerrados en el top:", len(small))
    loops = [l for l in loops if len(l) >= 12]
    if not loops:
        bm.free()
        return
    hem = min(loops, key=lambda l: sum(v.co.z for v in l) / len(l))
    z_start = sum(v.co.z for v in hem) / len(hem)
    z_end = z_end if z_end is not None else ctx.Z(0.515)
    if bottom is not None:
        z_end = z_end
    if z_end >= z_start - 0.02:
        bm.free()
        return
    cx = sum(v.co.x for v in hem) / len(hem)
    cy = sum(v.co.y for v in hem) / len(hem)
    # Con leggings de ropa básica: cada vértice termina 2 cm bajo la cintura de los
    # leggings EN ESE PUNTO (la cintura es en V: más baja delante), sin hueco.
    ends = [z_end] * len(hem)
    if bottom is not None:
        zb = max((bottom.matrix_world @ v.co).z for v in bottom.data.vertices)
        band = [(bottom.matrix_world @ v.co) for v in bottom.data.vertices if (bottom.matrix_world @ v.co).z > zb - 0.10]
        for i, v in enumerate(hem):
            near = [p.z for p in band if (p.x - v.co.x) ** 2 + (p.y - v.co.y) ** 2 < 0.06 ** 2]
            ends[i] = (max(near) if near else zb) - 0.02
    rows = [hem]
    nrow = 5
    for k in range(1, nrow + 1):
        ring = []
        for vi, v in enumerate(hem):
            z = z_start + ((ends[vi] if ends[vi] is not None else z_end) - z_start) * k / nrow
            d = Vector((v.co.x - cx, v.co.y - cy, 0.0))
            if d.length < 1e-6:
                d = Vector((0.0, -1.0, 0.0))
            d.normalize()
            hit = tree.ray_cast(Vector((cx, cy, z)), d, 0.6)
            r0 = math.hypot(v.co.x - cx, v.co.y - cy)
            # el rayo puede dar con el brazo/mano: solo vale si cae cerca del contorno del borde
            if hit[0] is None or hit[3] > r0 * 1.25 + 0.03:
                p = Vector((v.co.x, v.co.y, z))
            else:
                p = hit[0] + hit[1] * 0.004
            ring.append(bm.verts.new(p))
        rows.append(ring)
    n = len(hem)
    uvl = bm.loops.layers.uv.active
    hem_uv = []
    # Color de las filas nuevas: el de una zona lisa del top, 3-7 cm sobre el borde
    # (el borde recortado lleva ribete/blanco y dejaba una banda pálida).
    cand = []
    if uvl:
        for v in bm.verts:
            if z_start + 0.03 < v.co.z < z_start + 0.07 and v.link_loops:
                cand.append((v.co.x, v.co.y, v.link_loops[0][uvl].uv.copy()))
    for v in hem:
        if uvl and cand:
            us = sorted(q[2].x for q in cand)
            vs = sorted(q[2].y for q in cand)
            from mathutils import Vector as _V  # type: ignore
            hem_uv.append(_V((us[len(us) // 2], vs[len(vs) // 2])))  # UV mediana: zona lisa del top
        else:
            hem_uv.append(v.link_loops[0][uvl].uv.copy() if (uvl and v.link_loops) else None)
    new_faces = []
    for r0, r1 in zip(rows, rows[1:]):
        for i in range(n):
            j = (i + 1) % n
            f = bm.faces.new((r0[i], r0[j], r1[j], r1[i]))
            new_faces.append((f, i, j))
    if uvl:
        for f, i, j in new_faces:
            for lp in f.loops:
                idx = [k for k, vv in enumerate(hem) if False]
            ids = (i, j, j, i)
            for lp, k in zip(f.loops, ids):
                if hem_uv[k] is not None:
                    lp[uvl].uv = hem_uv[k]
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(obj.data)
    bm.free()
    print("[gen_avatar] top alargado hasta la cadera")


_BASEWEAR_DELETE = {}


def add_basewear(human, regions, gender, outer_present=False):
    """Viste las regiones sin cubrir ("top"/"bottom") con ropa básica ajustada.
    Carga un traje de dos piezas, lo parte en islas y conserva solo las pedidas."""
    import bpy  # type: ignore

    regions = [r for r in regions if r in ("top", "bottom")]
    if not regions:
        return
    key = "male" if gender.lower().startswith("m") else "female"
    suit = add_system_asset(human, BASEWEAR_ASSET[key], "Clothes", "basewear_tmp")
    if suit is None:
        return
    _select_only(suit)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.separate(type="LOOSE")
    bpy.ops.object.mode_set(mode="OBJECT")
    parts = [o for o in bpy.data.objects if o.type == "MESH" and o.name.startswith("basewear_tmp")]
    # La parte alta tiene el centro más alto (eje Z de Blender).
    def zc(o):
        return sum((o.matrix_world @ v.co).z for v in o.data.vertices) / max(1, len(o.data.vertices))
    parts.sort(key=zc, reverse=True)
    # Descarta islas diminutas (botones, etc.): quédate con las 2 mayores por nº de vértices.
    big = sorted(parts, key=lambda o: len(o.data.vertices), reverse=True)[:2]
    for o in parts:
        if o not in big:
            bpy.data.objects.remove(o, do_unlink=True)
    big.sort(key=zc, reverse=True)
    pieces = {"top": big[0], "bottom": big[-1]} if len(big) > 1 else {"top": big[0], "bottom": big[0]}
    if outer_present and "top" in regions:
        # SOLO la pieza alta: mangas/costados fuera; el pantalón/leggings no se toca.
        _strip_sleeves([pieces["top"]], pieces_top=pieces["top"])
        if key == "female":
            z_end = None
            bot_piece = None
            if "bottom" not in regions and "z" in _OUTER_HEM:
                # pantalón/falda del usuario: el top acaba 3 cm POR ENCIMA del bajo de la
                # chaqueta (metido dentro), así no asoma por debajo.
                z_end = _OUTER_HEM["z"] + 0.03
            elif "bottom" in regions and pieces["bottom"] is not pieces["top"]:
                # el top se mete 2 cm bajo la cintura de los leggings (sin hueco)
                zb = max((pieces["bottom"].matrix_world @ v.co).z for v in pieces["bottom"].data.vertices)
                z_end = zb - 0.02
                bot_piece = pieces["bottom"]
            _extend_top_to_hip(pieces["top"], human, z_end, bot_piece)
    # Corte entre pieza alta y baja (para repartir los vértices a ocultar).
    if len(big) > 1:
        zs_top = min((big[0].matrix_world @ v.co).z for v in big[0].data.vertices)
        zs_bot = max((big[-1].matrix_world @ v.co).z for v in big[-1].data.vertices)
        zsplit = (zs_top + zs_bot) / 2
    else:
        zsplit = None
    keep = []
    for r in regions:
        o = pieces[r]
        if o not in keep:
            keep.append(o)
    for o in big:
        if o not in keep:
            bpy.data.objects.remove(o, do_unlink=True)
    suit_group = "Delete." + os.path.splitext(os.path.basename(BASEWEAR_ASSET[key]))[0]
    _BASEWEAR_DELETE["group"] = suit_group
    _BASEWEAR_DELETE["zsplit"] = zsplit
    _BASEWEAR_DELETE["regions"] = list(regions)
    for i, o in enumerate(keep):
        _name_obj(o, "basewear_%d" % i)
        # Sin la máscara "Delete" el cuerpo coincide con la prenda ceñida y
        # parpadea (z-fighting): se separa un poco a lo largo de las normales.
        o.data.update()
        for v in o.data.vertices:
            if outer_present:
                off = 0.0045 if (o is pieces["top"] and pieces["top"] is not pieces["bottom"]) else 0.0065  # cintura de los leggings sobre el top (borde del top oculto)
            else:
                off = BASEWEAR_OFFSET
            v.co += v.normal * off
    print("[gen_avatar] basewear:", regions, "->", [o.name for o in keep])


def build_body_mask(human, n_clothes):
    """Oculta la piel bajo cada prenda con UNA máscara "Delete.all": une el
    delete group de cada prenda pedida y, del traje básico, solo los vértices
    de la región conservada (arriba/abajo del corte)."""
    for m in [m for m in human.modifiers if m.type == "MASK" and (m.vertex_group or "").startswith("Delete.")]:
        human.modifiers.remove(m)
    names = ["Delete.clothes_%d" % i for i in range(n_clothes)]
    groups = {}
    for nm in names:
        if nm in human.vertex_groups:
            groups[nm] = _SKIRT_ZMAX.get(nm)
    bw = _BASEWEAR_DELETE
    if bw.get("group") and bw["group"] in human.vertex_groups:
        groups[bw["group"]] = (bw.get("zsplit"), bw.get("regions", []))
    if not groups:
        return
    idx = {human.vertex_groups[n].index: (n, rule) for n, rule in groups.items()}
    both = bw.get("zsplit") is None or set(bw.get("regions", [])) >= {"top", "bottom"}
    mat = human.matrix_world
    hide = []
    for v in human.data.vertices:
        for g in v.groups:
            hit = idx.get(g.group)
            if hit is None or g.weight < 0.5:
                continue
            rule = hit[1]
            if isinstance(rule, dict):
                zz = (mat @ v.co).z
                if zz < rule["range"][0] or zz > rule["range"][1] or abs((mat @ v.co).x) > rule.get("xmax", 9.0):
                    continue
            elif rule is not None and not both:
                z = (mat @ v.co).z
                regs = rule[1]
                if not ((z >= rule[0] and "top" in regs) or (z < rule[0] and "bottom" in regs)):
                    continue
            hide.append(v.index)
            break
    vg = human.vertex_groups.get("Delete.all") or human.vertex_groups.new(name="Delete.all")
    if hide:
        vg.add(hide, 1.0, "REPLACE")
    mod = human.modifiers.new("Delete.all", "MASK")
    mod.vertex_group = "Delete.all"
    mod.invert_vertex_group = True
    # Antes del Subsurf, justo tras el resto de máscaras.
    try:
        target = max(i for i, m in enumerate(human.modifiers) if m.type in ("ARMATURE", "MASK") and m != mod)
        human.modifiers.move(len(human.modifiers) - 1, target + 1)
    except Exception:  # noqa: BLE001
        pass
    print("[gen_avatar] máscara de piel:", len(hide), "vértices ocultos")


def prune_non_contract_meshes():
    """Elimina mallas sueltas que MPFB deja (p. ej. una Icosphere) y sus datos
    huérfanos, para que el GLB solo tenga los nombres del contrato."""
    import re
    import bpy  # type: ignore

    ok = re.compile(r"^(base|clothes_\d+|hair|eyebrows|eyelashes|eyes|basewear_\d+)$")
    for o in list(bpy.data.objects):
        if o.type == "MESH" and not ok.match(o.name):
            print("[gen_avatar] aviso: elimino malla fuera de contrato:", o.name)
            bpy.data.objects.remove(o, do_unlink=True)
    for m in list(bpy.data.meshes):
        if m.users == 0:
            bpy.data.meshes.remove(m)


def create_human_from_mhm(mhm_path):
    """Crea el humano a partir del .mhm. Firma real: (filename, settings)."""
    HumanService = _find_human_service()
    settings = HumanService.get_default_deserialization_settings()
    # El dict por defecto viene incompleto respecto a lo que lee el código;
    # rellenamos las claves que faltan (sin ropa ni accesorios).
    settings["load_clothes"] = False
    for k, v in {
        "clothes_deep_search": False,
        "bodypart_deep_search": False,
        "override_clothes_model": "PRESET",
        "override_eyes_model": "PRESET",
    }.items():
        settings.setdefault(k, v)
    return HumanService.deserialize_from_mhm(mhm_path, settings)


def arm_angle_for(args):
    """Cuánto se bajan los brazos: menos cuanto más ancha la cadera/busto, para
    que la mano no choque con el muslo."""
    if args.arm_angle is not None:
        return args.arm_angle
    wide = max(args.hip, args.bust * 0.95)
    return max(0.0, ARM_ANGLE_DEG - max(0.0, wide - 88.0) * 0.5)


def pose_arms_down(angle_deg=ARM_ANGLE_DEG, human=None):
    """Relaja los brazos y HORNEA la pose en la malla.

    El esqueleto por defecto de MPFB ya viene en A (brazos ~45° bajo la
    horizontal); `angle_deg` es cuánto se bajan ADEMÁS (hacia la vertical).
    Aplicar solo `armature_apply` no mueve la malla (la pose se pierde), así que
    se evalúa el modificador Armature, se copian los vértices deformados a la
    malla base y después se fija el reposo del esqueleto.
    """
    import bpy  # type: ignore
    import math
    import mathutils  # type: ignore

    arm = next((o for o in bpy.data.objects if o.type == "ARMATURE"), None)
    if not arm:
        print("[gen_avatar] aviso: sin armature, no aplico pose")
        return

    bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.object.select_all(action="DESELECT")
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="POSE")

    def rot(bone_name, deg):
        pb = arm.pose.bones.get(bone_name)
        if not pb:
            print("[gen_avatar] aviso: hueso no encontrado", bone_name)
            return
        head = pb.matrix.translation.copy()
        R = mathutils.Matrix.Rotation(math.radians(deg), 4, "Y")  # eje frontal (mundo)
        pb.matrix = (
            mathutils.Matrix.Translation(head) @ R @ mathutils.Matrix.Translation(-head) @ pb.matrix
        )
        bpy.context.view_layer.update()

    # Rotación positiva en Y baja el brazo izquierdo (+X); opuesta en el derecho.
    rot("upperarm01.L", angle_deg)
    rot("upperarm01.R", -angle_deg)
    relax_hands(arm)
    bpy.ops.object.mode_set(mode="OBJECT")

    if human is not None:
        _bake_armature_into_mesh(human)

    bpy.ops.object.select_all(action="DESELECT")
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="POSE")
    bpy.ops.pose.armature_apply()  # el reposo del esqueleto = la pose actual
    bpy.ops.object.mode_set(mode="OBJECT")
    print("[gen_avatar] pose relajada aplicada (+%.1f deg)" % angle_deg)


# Curvado relajado de los dedos (grados por falange) y signo del eje local.
FINGER_CURL = {2: (20, 24, 16), 3: (21, 25, 17), 4: (22, 26, 18), 5: (23, 27, 19)}
FINGER_SIGN = 1.0
THUMB_CURL = (4, 6, 4)
# Giro lateral (eje local Z) para juntar los dedos hacia el corazón.
FINGER_SPREAD = {2: 15.0, 3: 0.0, 4: -15.0, 5: -22.0}
THUMB_ADDUCT = (32.0, 0.0)
SPREAD_SIGN = {"L": 1.0, "R": 1.0}


def relax_hands(arm):
    """Dedos en reposo: dedos juntos con flexión suave y uniforme, pulgar
    descansando. Simétrico en L/R (rotación local por falange)."""
    import math

    for side in ("L", "R"):
        for f, curls in list(FINGER_CURL.items()) + [(1, THUMB_CURL)]:
            for j, deg in enumerate(curls, start=1):
                pb = arm.pose.bones.get("finger%d-%d.%s" % (f, j, side))
                if pb is None:
                    continue
                pb.rotation_mode = "XYZ"
                z = FINGER_SPREAD.get(f, 0.0) * SPREAD_SIGN[side] if j == 1 else 0.0
                ty = 0.0
                if f == 1 and j == 1:
                    z = THUMB_ADDUCT[0] * SPREAD_SIGN[side]
                    ty = THUMB_ADDUCT[1] * SPREAD_SIGN[side]
                pb.rotation_euler = (math.radians(deg * FINGER_SIGN), math.radians(ty), math.radians(z))
    bpy_update()


def bpy_update():
    import bpy  # type: ignore

    bpy.context.view_layer.update()


def _bake_armature_into_mesh(obj):
    """Copia a la malla base los vértices ya deformados por el esqueleto."""
    import bpy  # type: ignore

    _select_only(obj)
    if obj.data.shape_keys:
        bpy.ops.object.shape_key_remove(all=True, apply_mix=True)
    saved = []
    for m in obj.modifiers:
        if m.type != "ARMATURE":
            saved.append((m, m.show_viewport))
            m.show_viewport = False
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(dg)
    mesh = ev.to_mesh()
    n = len(obj.data.vertices)
    if len(mesh.vertices) != n:
        print("[gen_avatar] aviso: nº de vértices distinto, no horneo la pose")
    else:
        coords = [0.0] * (n * 3)
        mesh.vertices.foreach_get("co", coords)
        obj.data.vertices.foreach_set("co", coords)
        obj.data.update()
    ev.to_mesh_clear()
    for m, v in saved:
        m.show_viewport = v


def optimize_textures():
    """Aligera el GLB: quita mapas de normales/AO, reduce texturas (<=1024 px; pelo,
    ojos, cejas y pestañas <=512/256), guarda JPEG las opacas y PNG las que
    tienen alfa, y quita UVs de mallas sin textura."""
    import bpy  # type: ignore
    import numpy as np

    # 1) fuera mapas de normales (y sus imágenes)
    for mat in bpy.data.materials:
        if not mat.use_nodes:
            continue
        nt = mat.node_tree
        for n in [n for n in nt.nodes if n.type == "NORMAL_MAP"]:
            for inp in n.inputs:
                for lk in list(inp.links):
                    src = lk.from_node
                    nt.links.remove(lk)
                    if src.type == "TEX_IMAGE" and not any(o.links for o in src.outputs):
                        nt.nodes.remove(src)
            nt.nodes.remove(n)
        for n in [n for n in nt.nodes if n.type == "TEX_IMAGE" and not any(o.links for o in n.outputs)]:
            nt.nodes.remove(n)  # texturas sin uso (AO, bump...)
    # 2) reducir y elegir formato
    used = {n.image for m in bpy.data.materials if m.use_nodes for n in m.node_tree.nodes
            if n.type == "TEX_IMAGE" and n.image is not None}
    for img in used:
        name = img.name.lower()
        small = any(k in name for k in ("eye", "brow", "lash"))
        hairy = any(k in name for k in ("hair", "bob", "long", "short", "ponytail", "braid", "afro"))
        limit = 256 if ("brow" in name or "lash" in name) else (512 if (small or hairy) else 1024)
        w, h = img.size
        if max(w, h) > limit:
            k = limit / float(max(w, h))
            img.scale(max(4, int(w * k)), max(4, int(h * k)))
        has_alpha = False
        if img.channels == 4:
            px = np.empty(len(img.pixels), dtype=np.float32)
            img.pixels.foreach_get(px)
            has_alpha = bool((px[3::4] < 0.98).any())
        img.file_format = "PNG" if has_alpha else "JPEG"
        print("[gen_avatar] textura", img.name, img.size[:], "alfa" if has_alpha else "opaca")
    # 3) UVs solo donde hay textura
    textured = set()
    for o in bpy.data.objects:
        if o.type != "MESH":
            continue
        for slot in o.material_slots:
            m = slot.material
            if m and m.use_nodes and any(n.type == "TEX_IMAGE" for n in m.node_tree.nodes):
                textured.add(o)
    for o in bpy.data.objects:
        if o.type == "MESH" and o not in textured:
            while o.data.uv_layers:
                o.data.uv_layers.remove(o.data.uv_layers[0])


def export_glb(mesh_obj, out_path):
    import bpy

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)

    bpy.ops.object.select_all(action="DESELECT")
    # Exporta TODAS las mallas y esqueletos de la escena: así entran también las
    # prendas (que pueden ser objetos aparte, no hijos del cuerpo).
    for o in bpy.data.objects:
        if o.type in ("MESH", "ARMATURE"):
            o.select_set(True)
    bpy.context.view_layer.objects.active = mesh_obj

    bpy.ops.export_scene.gltf(
        filepath=out_path,
        export_format="GLB",
        use_selection=True,
        export_apply=True,  # aplica modificadores
        export_yup=True,
        export_image_format="AUTO",
        export_jpeg_quality=85,
    )


def main():
    # Los argumentos tras "--" son los nuestros.
    argv = sys.argv
    argv = argv[argv.index("--") + 1:] if "--" in argv else []
    args = parse_args(argv)

    print("[gen_avatar] medidas:", json.dumps(vars(args)))

    mhm = build_mhm(args)
    tmp = tempfile.NamedTemporaryFile("w", suffix=".mhm", delete=False)
    tmp.write(mhm)
    tmp.close()
    print("[gen_avatar] .mhm generado en", tmp.name)
    print(mhm)

    ensure_addon_enabled()

    # Limpia la escena por defecto (Cube/Camera/Light) para no exportarla.
    import bpy
    for o in list(bpy.data.objects):
        if o.type in ("MESH", "CAMERA", "LIGHT"):
            bpy.data.objects.remove(o, do_unlink=True)

    try:
        human = create_human_from_mhm(tmp.name)
    except Exception as e:  # noqa: BLE001
        print("[gen_avatar] ERROR creando el humano con MPFB2:", repr(e))
        print("[gen_avatar] Revisa que el addon MPFB2 esté habilitado y que la")
        print("             API `HumanService.deserialize_from_mhm` exista en tu versión.")
        sys.exit(2)
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass

    # `human` suele ser el objeto malla base; si no, búscalo en la escena.
    import bpy

    mesh_obj = human if getattr(human, "type", None) == "MESH" else None
    if mesh_obj is None:
        mesh_obj = next((o for o in bpy.data.objects if o.type == "MESH"), None)
    if mesh_obj is None:
        print("[gen_avatar] ERROR: no se encontró malla que exportar.")
        sys.exit(3)

    try:
        pose_arms_down(arm_angle_for(args), mesh_obj)
    except Exception as e:  # noqa: BLE001
        print("[gen_avatar] aviso: no pude aplicar la pose:", repr(e))

    outer_present = any(os.path.basename(os.path.dirname(c)).lower() in OUTER_FOLDERS for c in args.clothes)
    # Viste DESPUÉS de posar: la prenda se ajusta al cuerpo ya en pose A (sin rig).
    if args.clothes:
        print("[gen_avatar] vistiendo", len(args.clothes), "prenda(s)...")
        load_clothes_onto_human(mesh_obj, args.clothes, args.clothes_scale, args.clothes_style, outer_present)

    add_head_details(mesh_obj, args.hair, args.gender)
    add_basewear(mesh_obj, [r for r in args.basewear.split(",") if r], args.gender, outer_present)

    _push_hair_final(mesh_obj, args.hair)
    # Contrato de nombres con el visor web: el cuerpo se llama "base".
    _name_obj(mesh_obj, "base")
    build_body_mask(mesh_obj, len(args.clothes))
    prune_non_contract_meshes()
    mesh_obj.data.name = "base"

    try:
        optimize_textures()
    except Exception as e:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        print("[gen_avatar] aviso: no pude optimizar texturas:", repr(e))
    export_glb(mesh_obj, args.out)
    print("[gen_avatar] OK -> GLB exportado en", args.out)


if __name__ == "__main__":
    main()
