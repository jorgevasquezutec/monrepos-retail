"""
inspect_mpfb.py — Descubre la API de ropa de MPFB2 y los assets instalados.

No genera nada: solo IMPRIME qué servicios/entidades de ropa existen en TU
versión de MPFB, sus métodos públicos, y dónde busca MPFB los assets (.mhclo).
Con esa salida escribimos la carga de ropa exacta, sin adivinar.

USO
---
    blender --background --python tools/inspect_mpfb.py

    # o dentro del contenedor:
    docker compose run --rm avatar \
        /opt/blender/blender --background --python /app/tools/inspect_mpfb.py
"""

import importlib
import os
import sys


def enable_mpfb():
    import bpy  # type: ignore
    for mod in ("bl_ext.user_default.mpfb", "mpfb"):
        try:
            bpy.ops.preferences.addon_enable(module=mod)
            print("[inspect] MPFB habilitado:", mod)
            return
        except Exception as e:  # noqa: BLE001
            print("[inspect] no pude habilitar", mod, "->", repr(e))


def mpfb_base_names():
    """Nombres de módulo base de MPFB, ya sea extensión (bl_ext.*) o legacy."""
    names = ["bl_ext.user_default.mpfb", "mpfb"]
    for name in list(sys.modules):
        if name.endswith(".mpfb") and name not in names:
            names.append(name)
    return names


def try_import(subpath):
    """Importa <base><subpath> probando todas las bases MPFB."""
    for base in mpfb_base_names():
        try:
            return importlib.import_module(base + subpath), base + subpath
        except Exception:  # noqa: BLE001
            continue
    return None, None


def dump_members(mod, label):
    if not mod:
        print(f"[inspect] {label}: NO ENCONTRADO")
        return
    print(f"\n[inspect] === {label} ({mod.__name__}) ===")
    for name in dir(mod):
        if name.startswith("_"):
            continue
        obj = getattr(mod, name)
        kind = type(obj).__name__
        # Métodos públicos de clases/servicios
        if isinstance(obj, type) or kind in ("function", "builtin_function_or_method"):
            methods = [m for m in dir(obj) if not m.startswith("_")] if isinstance(obj, type) else []
            print(f"  - {name} ({'class' if isinstance(obj, type) else kind})")
            for m in methods:
                print(f"      .{m}")


def find_asset_dirs():
    print("\n[inspect] === Búsqueda de assets de ropa (.mhclo) ===")
    # Rutas típicas donde MPFB/MakeHuman guardan assets.
    candidates = [
        os.path.expanduser("~/Documents/makehuman/v1py3/data"),
        os.path.expanduser("~/.config/blender"),
        "/root/.config/blender",
        "/root/Documents/makehuman",
        os.environ.get("MH_USER_DIR", ""),
    ]
    # Intenta preguntar a MPFB por su LocationService.
    loc_mod, _ = try_import(".services.locationservice")
    if loc_mod and hasattr(loc_mod, "LocationService"):
        LS = loc_mod.LocationService
        for attr in dir(LS):
            if attr.startswith("get") and "user" in attr.lower():
                try:
                    val = getattr(LS, attr)()
                    print(f"  LocationService.{attr}() = {val}")
                    if isinstance(val, str):
                        candidates.append(val)
                except Exception:  # noqa: BLE001
                    pass

    found = 0
    for root in filter(None, candidates):
        if not os.path.isdir(root):
            continue
        for dirpath, _dirs, files in os.walk(root):
            for f in files:
                if f.endswith(".mhclo"):
                    print("   .mhclo:", os.path.join(dirpath, f))
                    found += 1
    print(f"[inspect] total .mhclo encontrados: {found}")
    if found == 0:
        print("[inspect] ⚠️ No hay prendas instaladas. Hay que añadir assets CC0 (ver tools/assets/clothes/README.md).")


def main():
    enable_mpfb()
    print("\n[inspect] bases MPFB:", mpfb_base_names())

    for sub, label in [
        (".services.clothesservice", "ClothesService"),
        (".services.assetservice", "AssetService"),
        (".services.objectservice", "ObjectService"),
        (".services.humanservice", "HumanService"),
        (".entities.mhclo.mhclo", "Mhclo entity"),
        (".entities.objectproperties", "objectproperties"),
    ]:
        mod, full = try_import(sub)
        dump_members(mod, f"{label}  [{sub}]")

    find_asset_dirs()
    print("\n[inspect] LISTO. Pega esta salida y con ella escribo la carga de ropa exacta.")


if __name__ == "__main__":
    main()
