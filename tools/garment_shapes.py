"""
garment_shapes.py — Deformaciones de silueta sobre una prenda ya ajustada al
cuerpo (se aplican en coordenadas de mundo, tras `fit_clothes_to_human`).

Cada etiqueta de "silueta" del catálogo mueve vértices de la prenda con funciones
suaves de la altura. Las etiquetas desconocidas se ignoran.
"""
import math

import bmesh  # type: ignore
import bpy  # type: ignore
from mathutils import Vector  # type: ignore


def smooth(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


class BodyCtx:
    """Proporciones y ejes del cuerpo ya posado (sirven para colocar cada efecto)."""

    def __init__(self, human, arm_obj=None):
        mat = human.matrix_world
        body = human.vertex_groups["body"].index
        pts = [mat @ v.co for v in human.data.vertices
               if any(g.group == body and g.weight > 0.5 for g in v.groups)]
        self.zmin = min(p.z for p in pts)
        self.zmax = max(p.z for p in pts)
        self.H = self.zmax - self.zmin
        self.pts = pts
        # centro (x, y) del tronco por franjas de 1 cm
        self._bins = {}
        self._legs = {}
        for p in pts:
            k = int(round(p.z * 100))
            if abs(p.x) < 0.25:
                self._bins.setdefault(k, []).append(p)
            if abs(p.x) > 0.02 and abs(p.x) < 0.25:
                self._legs.setdefault((k, p.x > 0), []).append(p)
        self.arms = {}
        if arm_obj is not None:
            for side in ("L", "R"):
                b = arm_obj.data.bones.get("upperarm01." + side)
                e = arm_obj.data.bones.get("lowerarm01." + side)
                if b:
                    m = arm_obj.matrix_world
                    self.arms[side] = (m @ b.head_local, m @ (e.head_local if e else b.tail_local))

    def Z(self, f):
        return self.zmin + f * self.H

    def center_y(self, z):
        k = int(round(z * 100))
        for d in (0, 1, -1, 2, -2, 3, -3):
            ps = self._bins.get(k + d)
            if ps:
                return sum(p.y for p in ps) / len(ps)
        return 0.0

    def leg_line(self, z, right_side):
        """Eje de la pierna como recta entre la entrepierna y el tobillo (sin ruido)."""
        z0, z1 = self.Z(0.46), self.Z(0.04)
        a = self.leg_center(z0, right_side)
        b = self.leg_center(z1, right_side)
        t = max(0.0, min(1.0, (z0 - z) / (z0 - z1)))
        return a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t

    def leg_center(self, z, right_side):
        k = int(round(z * 100))
        for d in (0, 1, -1, 2, -2, 3, -3):
            ps = self._legs.get((k + d, right_side))
            if ps:
                return sum(p.x for p in ps) / len(ps), sum(p.y for p in ps) / len(ps)
        return (0.1 if right_side else -0.1), 0.0


def _radial_axis(obj, ctx, fn):
    """fn(z) -> (escala, desplazamiento_cm) radial en torno al eje del tronco."""
    for v in obj.data.vertices:
        s, d = fn(v.co.z)
        if s == 1.0 and d == 0.0:
            continue
        cy = ctx.center_y(v.co.z)
        px, py = v.co.x, v.co.y - cy
        r = math.hypot(px, py) or 1e-6
        k = (r * s + d) / r
        v.co.x, v.co.y = px * k, cy + py * k


def _radial_legs(obj, ctx, fn, zmax):
    for v in obj.data.vertices:
        if v.co.z > zmax or abs(v.co.x) < 0.012:
            continue
        s, d = fn(v.co.z)
        if s == 1.0 and d == 0.0:
            continue
        cx, cy = ctx.leg_line(v.co.z, v.co.x > 0)
        px, py = v.co.x - cx, v.co.y - cy
        r = math.hypot(px, py) or 1e-6
        k = (r * s + d) / r
        v.co.x, v.co.y = cx + px * k, cy + py * k


def _z_range(obj):
    zs = [v.co.z for v in obj.data.vertices]
    return min(zs), max(zs)


# ---- etiquetas -----------------------------------------------------------

def level_hem(obj, band=0.035):
    """Iguala el borde inferior (bajo/ruedo) a una altura común y lo cierra."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    zlo = min(v.co.z for v in bm.verts)
    hem = [v for v in bm.verts if v.co.z < zlo + band and any(e.is_boundary for e in v.link_edges)]
    if hem:
        zt = zlo + 0.012
        for v in hem:
            v.co.z = zt
    bm.to_mesh(obj.data)
    bm.free()


def pantalon_recto(obj, ctx, wide=False, slim=False):
    zhip, zk = ctx.Z(0.50), ctx.Z(0.285)
    zlo, _ = _z_range(obj)

    def fn(z):
        ease = (0.015 if slim else 0.028) * smooth((zhip - z) / 0.10)  # holgura bajo la cadera
        s = 1.0
        if slim:  # estrecha de la rodilla al tobillo (~0,85x)
            t = max(0.0, min(1.0, (zk - z) / max(0.05, zk - zlo)))
            s = 1.0 - 0.15 * t * t * (3 - 2 * t)
        if wide:
            # Acampanado monótono desde la rodilla (curva suave, sin bultos).
            t = max(0.0, min(1.0, (zk - z) / max(0.05, zk - zlo)))
            s = 1.0 + 0.55 * t * t * (3 - 2 * t)
        return s, ease
    _radial_legs(obj, ctx, fn, zhip)
    smooth_band(obj, zlo + 0.03, zhip, iters=6)
    level_hem(obj)


def a_line(obj, ctx, flare, zstart):
    zlo, _ = _z_range(obj)

    def fn(z):
        if z >= zstart:
            return 1.0, 0.0
        return 1.0 + (flare - 1.0) * smooth((zstart - z) / max(0.05, zstart - zlo)), 0.0
    _radial_axis(obj, ctx, fn)


def fluido(obj, ctx, zstart):
    def fn(z):
        return 1.0, 0.014 * smooth((zstart - z) / 0.08)
    _radial_axis(obj, ctx, fn)


def puff_sleeves(obj, ctx):
    for side, (a, b) in ctx.arms.items():
        axis = b - a
        L = axis.length
        if L < 1e-4:
            continue
        axis /= L
        for v in obj.data.vertices:
            w = v.co - a
            t = w.dot(axis) / L
            if t < 0.12 or t > 1.1:
                continue
            q = a + axis * (w.dot(axis))
            rad = v.co - q
            r = rad.length
            if r > 0.085 or r < 1e-6:
                continue
            gather = smooth(t / 0.35) * (1.0 - smooth((t - 0.75) / 0.3))
            v.co = q + rad * (1.0 + 0.45 * gather)


def imperio(obj, ctx):
    """Línea imperio: costura marcada justo bajo el busto (cresta visible) y falda
    suelta y más amplia desde ahí, con el bajo algo más largo."""
    zseam = ctx.Z(0.685)
    for v in obj.data.vertices:  # bajo ~9% más largo
        if v.co.z < zseam:
            v.co.z = zseam - (zseam - v.co.z) * 1.09
    zlo_h, _ = _z_range(obj)

    def fn(z):
        ridge = 0.006 * max(0.0, 1.0 - abs(z - zseam) / 0.014)
        if z >= zseam + 0.014:
            return 1.0, 0.0
        t = smooth((zseam - z) / max(0.1, zseam - zlo_h))
        return 1.0 + 0.36 * t, ridge
    _radial_axis(obj, ctx, fn)


def peplum(obj, ctx):
    """Vuelo circular parejo: desplazamiento radial uniforme + ligera caída."""
    zlo, zhi = _z_range(obj)
    zthr = zlo + 0.24 * (zhi - zlo)

    def fn(z):
        if z >= zthr:
            return 1.0, 0.0
        t = smooth((zthr - z) / max(0.04, zthr - zlo))
        return 1.0, 0.075 * t
    _radial_axis(obj, ctx, fn)
    smooth_band(obj, zlo, zthr + 0.02, iters=5)
    level_hem(obj, band=0.03)


def structured_shoulders(obj, ctx):
    zs = ctx.Z(0.82)
    for v in obj.data.vertices:
        ax = abs(v.co.x)
        w = smooth((ax - 0.09) / 0.07) * (1.0 - smooth((ax - 0.24) / 0.08)) * smooth((v.co.z - (zs - 0.06)) / 0.05)
        if w > 0 and v.normal.z > 0.1:
            v.co += v.normal * 0.012 * w
            v.co.z += 0.006 * w


def smooth_band(obj, zlo, zhi, iters=6):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    verts = [v for v in bm.verts if zlo <= v.co.z <= zhi]
    for _ in range(iters):
        bmesh.ops.smooth_vert(bm, verts=verts, factor=0.5, use_axis_x=True, use_axis_y=True, use_axis_z=True)
    bm.to_mesh(obj.data)
    bm.free()


def _boundary_loops(bm):
    edges = [e for e in bm.edges if e.is_boundary]
    seen, loops = set(), []
    adj = {}
    for e in edges:
        a, b = e.verts
        adj.setdefault(a, []).append(b)
        adj.setdefault(b, []).append(a)
    for v0 in adj:
        if v0 in seen:
            continue
        loop, prev, cur = [v0], None, v0
        seen.add(v0)
        while True:
            nxt = [n for n in adj[cur] if n != prev and n not in seen]
            if not nxt:
                break
            prev, cur = cur, nxt[0]
            seen.add(cur)
            loop.append(cur)
        loops.append(loop)
    return loops


def polo_collar(obj, human, ctx, zeye, pointed=False):
    """Cuello de polo: banda plegada con rollo visible que sigue el borde real del
    escote de la prenda (de pie, luego doblada hacia fuera y abajo)."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    # Centro del cuello (del cuerpo) y escote real: el punto más alto de la prenda
    # en cada cuña angular alrededor del cuello.
    ring = [p for p in ctx.pts if abs(p.z - (zeye - 0.12)) < 0.01 and abs(p.x) < 0.07]
    if not ring:
        bm.free()
        return
    ncx = sum(p.x for p in ring) / len(ring)
    ncy = sum(p.y for p in ring) / len(ring)
    nseg = 36
    best = [None] * nseg
    for v in bm.verts:
        dx, dy = v.co.x - ncx, v.co.y - ncy
        if math.hypot(dx, dy) > 0.12 or v.co.z < ctx.Z(0.74):
            continue
        k = int(((math.atan2(dy, dx) + math.pi) / (2 * math.pi)) * nseg) % nseg
        if best[k] is None or v.co.z > best[k].co.z:
            best[k] = v
    loop = [v for v in best if v is not None]
    if len(loop) < nseg * 0.8:
        bm.free()
        return
    cx, cy = ncx, ncy
    from types import SimpleNamespace
    pts = [v.co.copy() for v in loop]
    for _ in range(4):  # suaviza el escote (la cuña da dientes)
        pts = [(pts[i - 1] + pts[i] * 2 + pts[(i + 1) % len(pts)]) / 4 for i in range(len(pts))]
    loop = [SimpleNamespace(co=p) for p in pts]
    profile = [(-0.004, 0.0), (0.018, -0.002), (0.028, 0.007), (0.022, 0.016), (0.008, 0.020)]  # (arriba, afuera)
    rings = []
    for up, out in profile:
        ring = []
        for v in loop:
            dx, dy = v.co.x - cx, v.co.y - cy
            d = math.hypot(dx, dy) or 1e-6
            k = 1.0
            if pointed:  # puntas de cuello de camisa: más vuelo y altura al frente
                fw = max(0.0, -dy / d) ** 3
                k = 1.0 + 1.1 * fw
            ring.append(bm.verts.new((v.co.x + dx / d * out * k, v.co.y + dy / d * out * k, v.co.z + up * (1.0 + 0.4 * (k - 1.0)))))
        rings.append(ring)
    n = len(loop)
    for r0, r1 in zip(rings, rings[1:]):
        for i in range(n):
            bm.faces.new((r0[i], r0[(i + 1) % n], r1[(i + 1) % n], r1[i]))
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(obj.data)
    bm.free()


def _front_y(pts, x, z):
    """Superficie frontal suavizada: media de los vértices cercanos (sin dientes)."""
    near = [p.y for p in pts if (p.x - x) ** 2 + (p.z - z) ** 2 < 0.02 ** 2]
    if near:
        return sum(near) / len(near)
    best, by = 1e9, 0.0
    for p in pts:
        d = (p.x - x) ** 2 + (p.z - z) ** 2
        if d < best:
            best, by = d, p.y
    return by


def _tube(bm, pts, r, sides=6):
    rings = []
    for i, p in enumerate(pts):
        t = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
        up = Vector((1, 0, 0)) if abs(t.x) < 0.9 else Vector((0, 1, 0))
        u = t.cross(up).normalized()
        v = t.cross(u).normalized()
        rings.append([bm.verts.new(p + (u * math.cos(2 * math.pi * j / sides) + v * math.sin(2 * math.pi * j / sides)) * r) for j in range(sides)])
    for a, b in zip(rings, rings[1:]):
        for j in range(sides):
            bm.faces.new((a[j], a[(j + 1) % sides], b[(j + 1) % sides], b[j]))


def short_sleeves(obj, ctx):
    """Camiseta de cuello redondo a partir del jersey (cuello redondo de origen):
    se cortan las mangas a ~60% del brazo y se elimina todo lo que cuelga del
    antebrazo, con un plano de corte limpio."""
    arm = next((o for o in bpy.data.objects if o.type == "ARMATURE"), None)
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    for side, (a, b) in ctx.arms.items():
        ax = b - a
        L = ax.length
        if L < 1e-4:
            continue
        ax /= L
        wrist = b
        if arm is not None:
            lb = arm.data.bones.get("lowerarm01." + ("L" if a.x > 0 else "R"))
            if lb is not None:
                wrist = arm.matrix_world @ lb.tail_local
        fa = wrist - b
        fL = fa.length or 1e-6
        fa /= fL
        sgn = 1.0 if a.x > 0 else -1.0
        cut = a + ax * (L * 0.62)
        geom = list(bm.verts) + list(bm.edges) + list(bm.faces)
        bmesh.ops.bisect_plane(bm, geom=geom, plane_co=cut, plane_no=ax, clear_outer=False, clear_inner=False)
        kill = []
        for f in bm.faces:
            c = f.calc_center_median()
            if c.x * sgn < 0.1:
                continue
            t = (c - a).dot(ax)
            on_upper = t > L * 0.62 and (c - (a + ax * t)).length < 0.09
            t2 = (c - b).dot(fa)
            on_fore = -0.02 < t2 < fL * 1.15 and (c - (b + fa * t2)).length < 0.09
            if on_upper or on_fore:
                kill.append(f)
        bmesh.ops.delete(bm, geom=kill, context="FACES")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    # fuera islas sueltas (puños que quedaron aislados)
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
    big = max(len(c) for c in comps)
    for c in comps:
        if len(c) < big * 0.5:
            bmesh.ops.delete(bm, geom=c, context="VERTS")
    bm.to_mesh(obj.data)
    bm.free()


def crew_neck(obj, ctx, zeye):
    """Cuello redondo: cierra el escote en V con un paño hasta un aro redondo a la
    altura de la base del cuello y le añade un ribete (banda acanalada)."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    ring = [p for p in ctx.pts if abs(p.z - (zeye - 0.12)) < 0.01 and abs(p.x) < 0.07]
    if not ring:
        bm.free()
        return
    ncx = sum(p.x for p in ring) / len(ring)
    ncy = sum(p.y for p in ring) / len(ring)
    rx = (max(p.x for p in ring) - min(p.x for p in ring)) / 2 + 0.016
    ry = (max(p.y for p in ring) - min(p.y for p in ring)) / 2 + 0.016
    nseg = 72
    best = [None] * nseg
    for v in bm.verts:
        dx, dy = v.co.x - ncx, v.co.y - ncy
        if math.hypot(dx, dy) > 0.13 or v.co.z < ctx.Z(0.70):
            continue
        k = int(((math.atan2(dy, dx) + math.pi) / (2 * math.pi)) * nseg) % nseg
        if best[k] is None or v.co.z > best[k].co.z:
            best[k] = v
    if sum(b is not None for b in best) < nseg * 0.8:
        bm.free()
        return
    edge = []
    for k in range(nseg):
        b = best[k] or next(best[(k + j) % nseg] for j in range(1, nseg) if best[(k + j) % nseg])
        edge.append(b)
    zs = sorted(v.co.z for v in edge)
    zt = zs[int(len(zs) * 0.75)]  # altura del borde en lados/espalda
    pts = []
    for k in range(nseg):
        e = edge[k].co
        dx, dy = e.x - ncx, e.y - ncy
        d = math.hypot(dx, dy) or 1e-6
        fw = max(0.0, -dy / d) ** 2 if dy < 0 else 0.0  # peso hacia el frente
        a = math.atan2(dy, dx)
        cx_, cy_ = ncx + math.cos(a) * rx, ncy + math.sin(a) * ry
        px = e.x + (cx_ - e.x) * fw * 0.35  # leve acercamiento al cuello (cortina casi vertical)
        py = e.y + (cy_ - e.y) * fw * 0.35
        pz = max(e.z, zt - 0.035 * fw)
        pts.append(Vector((px, py, pz)))
    for _ in range(3):
        pts = [(pts[i - 1] + pts[i] * 2 + pts[(i + 1) % nseg]) / 4 for i in range(nseg)]
    target = [bm.verts.new(p) for p in pts]
    # Paño que cierra la V: rejilla bajo el borde frontal, pegada a la superficie
    # del cuerpo (altura hasta el vértice de la V), más tiras en el resto del aro.
    fw_k = []
    for k in range(nseg):
        e = edge[k].co
        d = math.hypot(e.x - ncx, e.y - ncy) or 1e-6
        fw_k.append(max(0.0, -(e.y - ncy) / d) ** 2 if e.y < ncy else 0.0)
    front = [k for k in range(nseg) if fw_k[k] > 0.35]
    front.sort(key=lambda k: pts[k].x)
    body_front = [p for p in ctx.pts if p.y < ncy and abs(p.x) < 0.12 and ctx.Z(0.6) < p.z < ctx.Z(0.9)]
    z_apex = min(edge[k].co.z for k in front) if front else None
    for k in range(nseg):
        j = (k + 1) % nseg
        if front and k in front and j in front:
            continue
        bm.faces.new((edge[k], edge[j], target[j], target[k]))
    if front and z_apex is not None:
        nrow = 7
        cols = []
        for k in front:
            col = []
            for r in range(nrow + 1):
                z = pts[k].z - (pts[k].z - z_apex) * r / nrow
                near = [p.y for p in body_front if (p.x - pts[k].x) ** 2 + (p.z - z) ** 2 < 0.025 ** 2]
                y = (sum(near) / len(near)) if near else pts[k].y
                col.append(target[k] if r == 0 else bm.verts.new((pts[k].x, y - 0.011, z)))
            cols.append(col)
        for c0, c1 in zip(cols, cols[1:]):
            for r in range(nrow):
                bm.faces.new((c0[r], c1[r], c1[r + 1], c0[r + 1]))
    # ribete: banda gruesa y acanalada alrededor del aro
    profile = [(0.0, 0.0), (0.009, -0.002), (0.012, 0.002), (0.004, 0.006)]
    rings = [target]
    for up, out in profile[1:]:
        r = []
        for k, t in enumerate(target):
            dx, dy = t.co.x - ncx, t.co.y - ncy
            d = math.hypot(dx, dy) or 1e-6
            wob = 0.0012 * math.sin(k * 5.0)
            r.append(bm.verts.new((t.co.x + dx / d * (out + wob), t.co.y + dy / d * (out + wob), t.co.z + up)))
        rings.append(r)
    for r0, r1 in zip(rings, rings[1:]):
        for k in range(nseg):
            j = (k + 1) % nseg
            bm.faces.new((r0[k], r0[j], r1[j], r1[k]))
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(obj.data)
    bm.free()


def hoodie_details(obj, ctx, zeye):
    """Bolsillo canguro con grosor (paredes inclinadas, labio superior abierto) y
    cordones sobre el pecho de la sudadera."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    cy = ctx.center_y(ctx.Z(0.6))
    front = [v.co.copy() for v in bm.verts if v.co.y < cy and abs(v.co.x) < 0.22 and ctx.Z(0.4) < v.co.z < ctx.Z(0.85)]
    zlo = min(v.co.z for v in bm.verts)
    z0, z1 = zlo + 0.04, zlo + 0.15  # sobre el dobladillo de la sudadera
    nx, nz = 14, 6
    grid = []
    for j in range(nz + 1):
        row = []
        for i in range(nx + 1):
            u = i / nx
            z = z0 + (z1 - z0) * j / nz
            half = 0.115 * (1.0 - 0.28 * j / nz)  # boca más estrecha: entradas inclinadas
            x = -half + 2 * half * u
            edge = min(i, nx - i, j, nz - j)
            if j == nz:
                off = 0.0
            elif edge == 0:
                off = 0.001
            elif j == nz - 1 and 1 <= i <= nx - 1:
                off = 0.0125
            else:
                off = (0.0135, 0.0125)[edge > 1]
            row.append(bm.verts.new((x, _front_y(front, x, z) - 0.002 - off, z)))
        grid.append(row)
    for j in range(nz):
        for i in range(nx):
            bm.faces.new((grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]))
    zn = zeye - 0.145
    for sx in (-0.03, 0.03):
        pts = []
        for k in range(8):
            z = zn - 0.015 - k * 0.012
            pts.append(Vector((sx, _front_y(front, sx, z) - 0.006, z)))
        _tube(bm, pts, 0.0035)
    bm.normal_update()
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(obj.data)
    bm.free()


def cardigan_buttons(obj, ctx, z_top=None, step=0.055, count=6):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    cy = ctx.center_y(ctx.Z(0.65))
    front = [v.co.copy() for v in bm.verts if v.co.y < cy and abs(v.co.x) < 0.1 and ctx.Z(0.45) < v.co.z < ctx.Z(0.85)]
    for k in range(count):
        z = (ctx.Z(0.77) if z_top is None else z_top) - k * step
        y = _front_y(front, 0.0, z) - 0.004
        c = Vector((0.0, y, z))
        s = 0.0065
        top, bot = bm.verts.new(c + Vector((0, 0, s))), bm.verts.new(c + Vector((0, 0, -s)))
        ring = [bm.verts.new(c + Vector((math.cos(a) * s, math.sin(a) * s * 0.6 - 0.002, 0))) for a in [i * math.pi / 3 for i in range(6)]]
        for i in range(6):
            j = (i + 1) % 6
            bm.faces.new((top, ring[j], ring[i]))
            bm.faces.new((bot, ring[i], ring[j]))
    bm.normal_update()
    bm.to_mesh(obj.data)
    bm.free()


def placket(obj, ctx, z_top):
    """Tapeta de botones a todo lo largo del frente (camisa)."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    cy = ctx.center_y(ctx.Z(0.65))
    front = [v.co.copy() for v in bm.verts if v.co.y < cy and abs(v.co.x) < 0.1 and ctx.Z(0.4) < v.co.z < ctx.Z(0.9)]
    z_bot = min(v.co.z for v in bm.verts) + 0.012
    n = 14
    rows = []
    for j in range(n + 1):
        z = z_top + (z_bot - z_top) * j / n
        y = _front_y(front, 0.0, z) - 0.0035
        rows.append((bm.verts.new((-0.0135, y, z)), bm.verts.new((0.0135, y, z))))
    for a, b in zip(rows, rows[1:]):
        bm.faces.new((a[0], a[1], b[1], b[0]))
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(obj.data)
    bm.free()
    return z_bot


def ribbing(obj, ctx):
    """Bajo y puños acanalados (jersey de punto) con relieve GEOMÉTRICO: la malla
    se subdivide y las costillas verticales se desplazan 4 mm."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.subdivide_edges(bm, edges=list(bm.edges), cuts=3, use_grid_fill=True)
    zlo = min(v.co.z for v in bm.verts)
    # Suaviza el torso (la subdivisión lineal deja manchas de sombreado) sin tocar bajo/puños.
    torso = [v for v in bm.verts if v.co.z > zlo + 0.09 and abs(v.co.x) < 0.2]
    for _ in range(3):
        bmesh.ops.smooth_vert(bm, verts=torso, factor=0.5, use_axis_x=True, use_axis_y=True, use_axis_z=True)
    bm.normal_update()
    cy = ctx.center_y(zlo + 0.05)
    arm = next((o for o in bpy.data.objects if o.type == "ARMATURE"), None)
    cuffs = []
    if arm is not None:
        for side in ("L", "R"):
            bn = arm.data.bones.get("lowerarm01." + side)
            if bn is not None:
                a, b = arm.matrix_world @ bn.head_local, arm.matrix_world @ bn.tail_local
                L = (b - a).length
                cuffs.append((a, (b - a) / L, L))
    for v in bm.verts:
        w = 0.0
        th = 0.0
        if v.co.z < zlo + 0.07 and abs(v.co.x) < 0.2:
            th = math.atan2(v.co.y - cy, v.co.x)
            w = 1.0 - smooth((v.co.z - zlo - 0.03) / 0.04)
            n = 44
        else:
            n = 28
            for a, ax, L in cuffs:
                t = (v.co - a).dot(ax)
                if L * 0.7 < t < L * 1.3:
                    rad = v.co - (a + ax * t)
                    if rad.length < 0.08:
                        th = math.atan2(rad.y, rad.x)
                        w = smooth((t - L * 0.7) / (L * 0.12))
                        break
        if w > 0:
            # costillas: surco/cresta alternos + el borde engrosado
            rib = 0.5 + 0.5 * math.cos(th * n)
            v.co += v.normal * (0.0055 * rib * w + 0.0025 * w)
    bm.to_mesh(obj.data)
    bm.free()


def shirt_collar(obj, ctx, zeye):
    """Cuello de camisa: pie de cuello (~3 cm) pegado al cuello + solapa doblada
    (~4,5 cm) con puntas largas sobre la clavícula, con grosor y pliegue marcado.
    Abierto en la garganta (primer botón desabrochado)."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    ring = [p for p in ctx.pts if abs(p.z - (zeye - 0.12)) < 0.01 and abs(p.x) < 0.07]
    if not ring:
        bm.free()
        return
    ncx = sum(p.x for p in ring) / len(ring)
    ncy = sum(p.y for p in ring) / len(ring)
    nseg = 36
    best = [None] * nseg
    for v in bm.verts:
        dx, dy = v.co.x - ncx, v.co.y - ncy
        if math.hypot(dx, dy) > 0.12 or v.co.z < ctx.Z(0.74):
            continue
        k = int(((math.atan2(dy, dx) + math.pi) / (2 * math.pi)) * nseg) % nseg
        if best[k] is None or v.co.z > best[k].co.z:
            best[k] = v
    if sum(b is not None for b in best) < nseg * 0.8:
        bm.free()
        return
    pts = []
    for k in range(nseg):
        b = best[k] or next(best[(k + j) % nseg] for j in range(1, nseg) if best[(k + j) % nseg])
        pts.append(b.co.copy())
    for _ in range(4):
        pts = [(pts[i - 1] + pts[i] * 2 + pts[(i + 1) % nseg]) / 4 for i in range(nseg)]
    front_k = 9  # atan2(-1, 0) -> segmento 9
    rings = []
    for k, p in enumerate(pts):
        dx, dy = p.x - ncx, p.y - ncy
        d = math.hypot(dx, dy) or 1e-6
        ox, oy = dx / d, dy / d
        # peso de punta: máximo junto a la abertura frontal
        dk = min(abs(k - front_k), nseg - abs(k - front_k))
        fw = max(0.0, 1.0 - (dk - 2) / 5.0) if dk >= 2 else 0.0
        fw = min(1.0, fw)
        tip_up = -0.004 - 0.020 * fw
        tip_out = 0.040 + 0.022 * fw
        prof = [(-0.004, -0.002), (0.030, -0.002), (0.035, 0.004), (0.021, 0.024), (tip_up, tip_out),
                (tip_up + 0.003, tip_out - 0.004), (0.024, 0.021), (0.030, 0.005), (0.028, -0.006), (-0.004, -0.006)]
        ring = [bm.verts.new((p.x + ox * out, p.y + oy * out, p.z + up)) for up, out in prof]
        rings.append(ring)
    m = len(rings[0])
    for i in range(nseg):
        j = (i + 1) % nseg
        if i in (front_k - 1, front_k):  # abertura en la garganta
            continue
        for a in range(m):
            b = (a + 1) % m
            bm.faces.new((rings[i][a], rings[i][b], rings[j][b], rings[j][a]))
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(obj.data)
    bm.free()


def hood(obj, ctx, zeye, yc):
    """Capucha caída sobre la parte alta de la espalda: cuello-capucha (cowl) que
    enmarca el cuello por delante, y un volumen redondeado detrás de la base de la
    cabeza que cae sobre la espalda."""
    zn = zeye - 0.14
    cy = ctx.center_y(zn)
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    sides, steps = 10, 48
    rx, ry = 0.108, 0.104
    rings = []
    for i in range(steps + 1):
        u = i / steps
        ang = math.radians(-168 + 336 * u)  # 0 = detrás
        back = (1 + math.cos(ang)) / 2       # 1 detrás, 0 delante
        r_tube = 0.017 + 0.016 * back
        cx, cyy = math.sin(ang) * rx, cy + math.cos(ang) * ry + 0.004
        zc = zn - 0.006 + 0.030 * back
        nxr, nyr = math.sin(ang), math.cos(ang)
        ring = []
        for j in range(sides):
            a2 = 2 * math.pi * j / sides
            ox, oz = math.cos(a2), math.sin(a2)
            ring.append(bm.verts.new((cx + nxr * ox * r_tube * 1.3, cyy + nyr * ox * r_tube * 1.3, zc + oz * r_tube * (0.6 + 0.3 * back))))
        rings.append(ring)
    for r0, r1 in zip(rings, rings[1:]):
        for j in range(sides):
            bm.faces.new((r0[j], r0[(j + 1) % sides], r1[(j + 1) % sides], r1[j]))
    tmp = bmesh.new()
    bmesh.ops.create_icosphere(tmp, subdivisions=4, radius=1.0)
    c = Vector((0.0, cy + 0.06, zn + 0.03))
    keep = {}
    for f in tmp.faces:
        p = f.calc_center_median()
        if p.y > -0.25 and p.z > -0.75:
            ids = []
            for v in f.verts:
                if v.index not in keep:
                    q = Vector((v.co.x * 0.125, v.co.y * 0.115, v.co.z * 0.105))
                    if q.z < 0:
                        q.y += -q.z * 0.35
                    keep[v.index] = bm.verts.new(c + q)
                ids.append(keep[v.index])
            try:
                bm.faces.new(ids)
            except ValueError:
                pass
    tmp.free()
    bm.normal_update()
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(obj.data)
    bm.free()


def apply(obj, kind, tags, ctx, zeye, yc, outer_present=False):
    """kind: top | outer | bottom | dress | skirt."""
    tags = set(tags or [])
    if outer_present and kind != "outer":
        tags.discard("manga-abullonada")  # no cabe bajo la capa exterior
    obj.data.update()
    zbust, zhip = ctx.Z(0.72), ctx.Z(0.52)
    if kind == "bottom":
        if tags & {"pantalon-pierna-ancha", "pantalon-recto", "recto", "slim"}:
            pantalon_recto(obj, ctx, wide="pantalon-pierna-ancha" in tags, slim="slim" in tags)
    if kind in ("dress", "skirt"):
        if "falda-acampanada" in tags:
            a_line(obj, ctx, 1.45, zhip)
        elif tags & {"corte-a", "vestido-cruzado"} and "linea-imperio" not in tags:
            a_line(obj, ctx, 1.35, zhip)
        if "linea-imperio" in tags:
            imperio(obj, ctx)
        if "tejido-fluido" in tags:
            fluido(obj, ctx, zbust)
    if kind in ("top", "outer", "dress"):
        if "manga-abullonada" in tags:
            puff_sleeves(obj, ctx)
        if "hombro-estructurado" in tags:
            structured_shoulders(obj, ctx)
        if "tejido-fluido" in tags and kind != "dress":
            fluido(obj, ctx, zbust)
    if kind in ("top", "outer"):
        if "peplum" in tags:
            peplum(obj, ctx)
        if "cuello-polo" in tags and kind == "top" and "_camisa" not in tags:
            polo_collar(obj, None, ctx, zeye)
        if "capucha" in tags and kind == "outer":
            hood(obj, ctx, zeye, yc)
        if "_hoodie" in tags:
            hoodie_details(obj, ctx, zeye)
        if "_cardigan" in tags:
            cardigan_buttons(obj, ctx)
        if "_camisa" in tags:
            shirt_collar(obj, ctx, zeye)
            zb = placket(obj, ctx, zeye - 0.17)
            cardigan_buttons(obj, ctx, z_top=zeye - 0.19, step=0.062, count=int((zeye - 0.19 - zb) / 0.062))
        if "_punto" in tags:
            ribbing(obj, ctx)
        if "_shortsleeve" in tags:
            short_sleeves(obj, ctx)
    if kind == "dress":  # (en la falda no: el borde cortado se deformaría)
        smooth_band(obj, ctx.Z(0.58), ctx.Z(0.68))  # quita la arruga de la cintura
    obj.data.update()
