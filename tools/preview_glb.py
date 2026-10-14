"""
preview_glb.py — Renderiza un GLB con Blender Workbench (rápido, sin GPU)
desde de frente, 3/4 y de perfil. Para revisar visualmente el avatar.

    blender --background --python tools/preview_glb.py -- --glb a.glb --out /tmp/prev
    -> /tmp/prev_front.png, /tmp/prev_34.png, /tmp/prev_side.png
"""
import math
import sys

import bpy  # type: ignore
import mathutils  # type: ignore


def main():
    argv = sys.argv[sys.argv.index("--") + 1:]
    glb = argv[argv.index("--glb") + 1]
    out = argv[argv.index("--out") + 1]
    # Primer plano opcional: --focus <fracción de altura 0..1> --span <metros>
    focus = float(argv[argv.index("--focus") + 1]) if "--focus" in argv else None
    fx = float(argv[argv.index("--fx") + 1]) if "--fx" in argv else 0.0
    span = float(argv[argv.index("--span") + 1]) if "--span" in argv else None

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=glb)
    meshes = [o for o in bpy.data.objects if o.type == "MESH" and not o.name.startswith("Icosphere")]
    print("MESHES:", sorted(o.name for o in meshes))

    if "--hide" in argv:  # oculta objetos por nombre (coma) para depurar
        for nm in argv[argv.index("--hide") + 1].split(","):
            for o in meshes:
                if o.name.startswith(nm):
                    o.hide_render = True
    if "--poke" in argv:  # cuerpo en rojo, resto gris: delata piel que asoma
        for o in meshes:
            o.color = (0.85, 0.15, 0.1, 1) if o.name.startswith("base") else (0.75, 0.75, 0.78, 1)
        bpy.context.scene.display.shading.color_type = "OBJECT"
    pts = [o.matrix_world @ mathutils.Vector(c) for o in meshes for c in o.bound_box]
    lo = mathutils.Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = mathutils.Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    center = (lo + hi) / 2
    height = hi.z - lo.z

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.render.resolution_x, scene.render.resolution_y = 700, 1000
    sh = scene.display.shading
    sh.light = "STUDIO"
    sh.color_type = "OBJECT" if "--poke" in argv else "TEXTURE"
    sh.show_shadows = False
    scene.view_settings.view_transform = "Standard"
    scene.world = bpy.data.worlds.new("w")
    scene.world.color = (0.82, 0.84, 0.88)

    cam_data = bpy.data.cameras.new("cam")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = span if span else height * 1.12
    if focus is not None:
        center = mathutils.Vector((center.x + fx, center.y, lo.z + height * focus))
        scene.render.resolution_x = scene.render.resolution_y = 800
    cam = bpy.data.objects.new("cam", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam

    # glTF importado: Y arriba en glTF -> Z arriba en Blender; frente = -Y.
    views = [("front", 0), ("34", 40), ("side", 90)] + ([("back", 180), ("back34", 140)] if "--back" in argv else [])
    for name, yaw in views:
        a = math.radians(yaw)
        d = height * 3
        cam.location = center + mathutils.Vector((math.sin(a) * d, -math.cos(a) * d, 0))
        direction = center - cam.location
        cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = "%s_%s.png" % (out, name)
        bpy.ops.render.render(write_still=True)
        if "--vcol" in argv:  # color por vértice (variación del pelo)
            sh.color_type = "VERTEX"
            scene.render.filepath = "%s_%s_vc.png" % (out, name)
            bpy.ops.render.render(write_still=True)
            sh.color_type = "TEXTURE"


main()
