/**
 * Render 2D de prendas sobre el vídeo (probador en vivo).
 *
 * Plantillas bezier en un marco corporal normalizado (eje de hombros + eje del
 * torso, unidades de S = distancia entre hombros), mapeadas con la pose. La
 * talla modifica la silueta (ancho de pecho, caída de hombro, largo, manga).
 *
 * Sombreado: color base + luminancia real del vídeo (multiply / soft-light)
 * normalizada para que una habitación oscura no deje la prenda negra, textura
 * de piqué en patrón y sombra de borde. Oclusión: la prenda se recorta a la
 * silueta de la persona (dilatada según la holgura) y cara, pelo y brazos/manos
 * delanteros se repintan por encima.
 */

import {
  bodyPt,
  type BodyFrame,
  type GarmentKind,
  type PersonMasks,
  type Pt,
  type SleeveKind,
  type Sizing,
} from "./liveTryOn.ts";

export interface LayerSpec {
  kind: GarmentKind;
  sleeves: SleeveKind;
  categoria: string;
  color: string;
  sizing: Sizing;
}

type RGB = [number, number, number];

function parseColor(c: string): RGB {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim());
  if (!m) return [136, 136, 136];
  let h = m[1];
  if (h.length === 3) h = h.replace(/./g, (x) => x + x);
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function shade([r, g, b]: RGB, k: number, a = 1): string {
  const f = (v: number) => Math.round(k >= 0 ? v + (255 - v) * k : v * (1 + k));
  return `rgba(${f(r)},${f(g)},${f(b)},${a})`;
}

/** bodyPt con la línea de hombros subida: el landmark cae por debajo del hombro visible. */
const bp = (f: BodyFrame, a: number, b: number) => bodyPt(f, a, b - 0.05);

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** Curva suave por puntos (desde la posición actual del path hasta el último). */
function curveThrough(p: Path2D, pts: Pt[]) {
  for (let i = 0; i < pts.length - 1; i++) {
    if (i === pts.length - 2) p.lineTo(pts[i + 1].x, pts[i + 1].y);
    else {
      const m = mid(pts[i], pts[i + 1]);
      p.quadraticCurveTo(pts[i].x, pts[i].y, m.x, m.y);
    }
  }
}
/** Igual que curveThrough pero termina con una cuadrática al último punto (sin esquina). */
function smoothTo(p: Path2D, pts: Pt[]) {
  for (let i = 0; i < pts.length - 1; i++) {
    const end = i === pts.length - 2 ? pts[i + 1] : mid(pts[i], pts[i + 1]);
    p.quadraticCurveTo(pts[i].x, pts[i].y, end.x, end.y);
  }
}

// --------------------------------------------------------------------------
// Geometría de la prenda
// --------------------------------------------------------------------------

interface Geo {
  /** semiancho del pecho (axila) */
  c: number;
  /** semiancho de cintura y bajo */
  aw: number;
  ah: number;
  /** semiancho de hombro (costura) y su altura */
  hs: number;
  tipB: number;
  /** altura de la axila y del bajo */
  apB: number;
  hemB: number;
  /** semiancho del cuello y profundidad delantera */
  n: number;
  dip: number;
  /** cuerda trasera del cuello */
  chordB: number;
}

function geometry(kind: GarmentKind, z: Sizing): Geo {
  const c = 0.47 * clamp(z.r, 0.98, 1.65);
  const hs = 0.53 * clamp(z.shoulderRatio, 0.92, 1.42);
  const tipB = -0.02 + Math.max(0, z.shoulderRatio - 1.08) * 0.55;
  const dress = kind === "dress";
  const hemB = dress ? 2.5 : clamp(z.lengthCm / z.sCm - 0.1, 1.0, 3.2);
  const neck: Record<GarmentKind, [number, number]> = {
    polo: [0.17, 0.05],
    tee: [0.19, 0.1],
    shirt: [0.16, -0.04],
    knit: [0.19, 0.08],
    top: [0.19, 0.1],
    outer: [0.2, 0.0],
    dress: [0.2, 0.12],
    bottom: [0.2, 0.1],
  };
  const [n, dip] = neck[kind];
  return {
    c,
    aw: c * (0.94 + 0.06 * z.drape) * (dress ? 0.82 : 1),
    ah: c * (0.98 + 0.07 * z.drape) * (dress ? 1.55 : 1),
    hs,
    tipB,
    apB: 0.4,
    hemB,
    n,
    dip,
    chordB: -0.16,
  };
}

interface Built {
  body: Path2D;
  /** Unión de cuerpo + solapas, para recortar el sombreado. */
  clip: Path2D;
  hole: Path2D;
  /** Polígono donde la piel delantera NO debe repintarse (torso alto + mangas). */
  noSkin: Path2D[];
  sleevePolys: Pt[][];
  geo: Geo;
  /** [lado] -> {tip, apit, outer[], inner[]} para detalles. */
  sleeves: { tip: Pt; ap: Pt; q: Pt; qDir: Pt; qIn: Pt; qOut: Pt }[];
}

function armPoint(arm: BodyFrame["arms"][number], dist: number): { p: Pt; d: Pt } {
  const seg = (a: Pt, b: Pt) => ({ len: Math.hypot(b.x - a.x, b.y - a.y), a, b });
  const s1 = seg(arm.sh, arm.el);
  const s2 = seg(arm.el, arm.wr);
  const use = dist <= s1.len ? s1 : s2;
  const t0 = use === s1 ? 0 : s1.len;
  const t = (dist - t0) / (use.len || 1);
  const d = { x: (use.b.x - use.a.x) / (use.len || 1), y: (use.b.y - use.a.y) / (use.len || 1) };
  return { p: { x: use.a.x + (use.b.x - use.a.x) * t, y: use.a.y + (use.b.y - use.a.y) * t }, d };
}

/** Limita el ángulo del brazo a ±40° respecto a la vertical del torso (evita mangas "alas"). */
function clampArm(f: BodyFrame, a: BodyFrame["arms"][number], sg: number): BodyFrame["arms"][number] {
  const fix = (from: Pt, to: Pt): Pt => {
    const dx = to.x - from.x, dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    const along = (dx * f.down.x + dy * f.down.y) / len;
    const side = (dx * f.lat.x + dy * f.lat.y) / len * sg;
    const maxSide = Math.tan((40 * Math.PI) / 180) * Math.max(along, 0.2);
    if (along > 0.2 && side <= maxSide && side >= -0.3) return to;
    const s2 = clamp(side, -0.3, maxSide);
    const a2 = Math.max(along, 0.2);
    const n = Math.hypot(s2, a2);
    return {
      x: from.x + ((f.down.x * a2 + f.lat.x * s2 * sg) / n) * len,
      y: from.y + ((f.down.y * a2 + f.lat.y * s2 * sg) / n) * len,
    };
  };
  const el = fix(a.sh, a.el);
  const wr = fix(el, a.wr);
  return { sh: a.sh, el, wr };
}

function build(f: BodyFrame, spec: LayerSpec): Built {
  const z = spec.sizing;
  const g = geometry(spec.kind, z);
  const pt = (a: number, b: number) => bp(f, a, b);
  const pxCm = f.S / z.sCm;

  const path = new Path2D();
  const sides = [1, -1] as const;
  const sl = sides.map((sg, idx) => {
    if (spec.sleeves === "none") return null;
    const arm = clampArm(f, f.arms[idx], sg);
    const long = spec.sleeves === "long";
    const loose = clamp(z.r - 1, 0, 0.6);
    const lenPx = long
      ? Math.max(f.S * 0.8, z.sleeveCm * pxCm * 0.92)
      : Math.min(z.sleeveCm * pxCm, f.S * 0.8) * (spec.kind === "dress" ? 0.7 : 1);
    const mdl = armPoint(arm, lenPx * 0.5);
    const end = armPoint(arm, lenPx);
    const w1 = f.S * 0.2 * (1 + loose * 0.9);
    const w2 = f.S * (long ? 0.135 : 0.19) * (1 + loose * (long ? 0.5 : 0.8));
    const outward = (d: Pt): Pt => {
      let o = { x: -d.y, y: d.x };
      if (o.x * f.lat.x * sg + o.y * f.lat.y * sg < 0) o = { x: -o.x, y: -o.y };
      return o;
    };
    const om = outward(mdl.d);
    const oe = outward(end.d);
    return {
      mOut: { x: mdl.p.x + om.x * w1, y: mdl.p.y + om.y * w1 },
      mIn: { x: mdl.p.x - om.x * w1 * 0.9, y: mdl.p.y - om.y * w1 * 0.9 },
      qOut: { x: end.p.x + oe.x * w2, y: end.p.y + oe.y * w2 },
      qIn: { x: end.p.x - oe.x * w2, y: end.p.y - oe.y * w2 },
      q: end.p,
      qDir: end.d,
    };
  });

  const tip = (sg: number) => pt(sg * g.hs, g.tipB);
  const ap = (sg: number) => pt(sg * g.c, g.apB);
  const side = (sg: number): Pt[] => {
    const hem = pt(sg * g.ah, g.hemB);
    const mids: Pt[] = [ap(sg), pt(sg * g.c * 0.99, 0.75)];
    if (g.hemB > 1.4) mids.push(pt(sg * g.aw, 1.1));
    return [...mids, hem];
  };
  const nA = pt(g.n, -0.12);
  const nB = pt(-g.n, -0.12);
  const shoulderCtl = (sg: number) => pt(sg * (g.n + g.hs) * 0.5, (-0.12 + g.tipB) / 2 - 0.022);

  // --- A: cuello -> hombro -> manga -> axila -> costado -> bajo
  path.moveTo(nA.x, nA.y);
  const cA = shoulderCtl(1);
  path.quadraticCurveTo(cA.x, cA.y, tip(1).x, tip(1).y);
  const sA = sl[0];
  if (sA) {
    smoothTo(path, [sA.mOut, sA.qOut]);
    path.lineTo(sA.qIn.x, sA.qIn.y);
    smoothTo(path, [sA.mIn, ap(1)]);
  } else {
    path.lineTo(ap(1).x, ap(1).y);
  }
  const sideA = side(1);
  curveThrough(path, sideA);
  // bajo curvo ("sonrisa" suave)
  const hemB = pt(-g.ah, g.hemB);
  const hc = pt(0, g.hemB + 0.12);
  path.quadraticCurveTo(hc.x, hc.y, hemB.x, hemB.y);
  // --- B: sube por el otro costado
  const sideB = side(-1).reverse();
  curveThrough(path, [hemB, ...sideB.slice(1)]);
  const sB = sl[1];
  if (sB) {
    smoothTo(path, [sB.mIn, sB.qIn]);
    path.lineTo(sB.qOut.x, sB.qOut.y);
    smoothTo(path, [sB.mOut, tip(-1)]);
  } else {
    path.lineTo(tip(-1).x, tip(-1).y);
  }
  const cB = shoulderCtl(-1);
  path.quadraticCurveTo(cB.x, cB.y, nB.x, nB.y);
  // escote delantero
  const nc = pt(0, 2 * g.dip + 0.12);
  path.quadraticCurveTo(nc.x, nc.y, nA.x, nA.y);
  path.closePath();

  // hueco del cuello (entre la cuerda trasera y el escote)
  const hole = new Path2D();
  hole.moveTo(nA.x, nA.y);
  hole.quadraticCurveTo(nc.x, nc.y, nB.x, nB.y);
  const t1 = pt(-g.n * 0.92, g.chordB);
  const t2 = pt(g.n * 0.92, g.chordB);
  hole.lineTo(t1.x, t1.y);
  hole.lineTo(t2.x, t2.y);
  hole.closePath();

  // zona donde la piel delantera no se repinta: torso alto (con muesca del cuello) + mangas
  const noSkin: Path2D[] = [];
  const poly = (pts: Pt[]) => {
    const q = new Path2D();
    q.moveTo(pts[0].x, pts[0].y);
    for (const p of pts.slice(1)) q.lineTo(p.x, p.y);
    q.closePath();
    noSkin.push(q);
  };
  const W = g.hs + 0.15;
  poly([
    pt(-W, -0.45), pt(-g.n - 0.03, -0.45), pt(-g.n - 0.03, -0.1), pt(0, g.dip + 0.04),
    pt(g.n + 0.03, -0.1), pt(g.n + 0.03, -0.45), pt(W, -0.45), pt(W, 0.2), pt(-W, 0.2),
  ]);
  const sleevePolys: Pt[][] = [];
  sl.forEach((s, i) => {
    if (!s) return;
    const sg = sides[i];
    const poly4 = [tip(sg), s.mOut, s.qOut, s.qIn, s.mIn, ap(sg)];
    sleevePolys.push(poly4);
    poly(poly4);
  });

  const clip = new Path2D();
  clip.addPath(path);

  return {
    body: path,
    clip,
    hole,
    noSkin,
    sleevePolys,
    geo: g,
    sleeves: sl.map((s, i) => ({
      tip: tip(sides[i]),
      ap: ap(sides[i]),
      q: s?.q ?? tip(sides[i]),
      qDir: s?.qDir ?? f.down,
      qIn: s?.qIn ?? tip(sides[i]),
      qOut: s?.qOut ?? tip(sides[i]),
    })),
  };
}

/** Pantalón sintético: dos perneras desde la cintura (las piernas casi nunca se ven en cámara). */
function buildBottom(f: BodyFrame): Built {
  const pt = (a: number, b: number) => bp(f, a, b);
  const body = new Path2D();
  const pts = [
    pt(0.62, 1.15), pt(-0.62, 1.15), pt(-0.66, 3.6), pt(-0.08, 3.6), pt(-0.05, 1.85),
    pt(0.05, 1.85), pt(0.08, 3.6), pt(0.66, 3.6),
  ];
  body.moveTo(pts[0].x, pts[0].y);
  for (const p of pts.slice(1)) body.lineTo(p.x, p.y);
  body.closePath();
  const g = geometry("bottom", { r: 1, shoulderRatio: 1, sCm: 1, lengthCm: 1, sleeveCm: 0, tension: 0, drape: 0, verdict: null });
  return { body, clip: body, hole: new Path2D(), noSkin: [], sleevePolys: [], geo: g, sleeves: [] };
}

// --------------------------------------------------------------------------
// Render
// --------------------------------------------------------------------------

const mk = (w = 2, h = 2) => {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
};

export class GarmentRenderer {
  private layer = mk();
  private lum = mk();
  private front = mk();
  private dil = mk();
  private dilKey = "";
  private texture: CanvasPattern | null = null;
  private lumK = 1.4;
  private collar: { f: BodyFrame; g: Geo } | null = null;
  private union = mk();
  private handMask = mk();
  private handCtx = this.handMask.getContext("2d")!;
  private handFrames = [0, 0];
  private dil2 = mk();
  private hasFilter = true;
  /** Caja de trabajo (px): todas las pasadas de composición se limitan a ella. */
  private bb = { x: 0, y: 0, w: 2, h: 2 };

  constructor() {
    const t = mk(8, 8);
    const g = t.getContext("2d")!;
    g.fillStyle = "#f0f0f0";
    g.fillRect(0, 0, 8, 8);
    // piqué: pequeños rombos alternos
    g.fillStyle = "rgba(0,0,0,0.20)";
    for (const [x, y] of [[2, 2], [6, 6]]) {
      g.beginPath();
      g.moveTo(x, y - 1.6);
      g.lineTo(x + 1.6, y);
      g.lineTo(x, y + 1.6);
      g.lineTo(x - 1.6, y);
      g.fill();
    }
    g.fillStyle = "rgba(255,255,255,0.55)";
    for (const [x, y] of [[6, 2], [2, 6]]) g.fillRect(x - 1, y - 1, 2, 2);
    this.texture = g.createPattern(t, "repeat");
  }

  private ensure(w: number, h: number) {
    for (const c of [this.layer, this.lum, this.front, this.dil, this.union, this.dil2]) {
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
        this.dilKey = "";
      }
    }
  }

  /** Dilata la silueta `r` px (anillos de desplazamientos) para dejar sitio a la holgura. */
  private dilated(masks: PersonMasks, w: number, h: number, r: number): HTMLCanvasElement {
    const key = `${masks.version}:${Math.round(r)}:${w}x${h}`;
    if (key === this.dilKey) return this.dil;
    this.dilKey = key;
    const d = this.dil.getContext("2d")!;
    d.clearRect(0, 0, w, h);
    d.imageSmoothingEnabled = true;
    d.drawImage(masks.sil, 0, 0, w, h);
    if (r >= 1.5) {
      for (const rr of [r * 0.5, r]) {
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2;
          d.drawImage(masks.sil, Math.cos(a) * rr, Math.sin(a) * rr, w, h);
        }
      }
    }
    return this.dil;
  }

  /**
   * Dibuja las prendas sobre el fotograma ya pintado en `ctx` y repinta cara,
   * pelo y brazos delanteros. `lumMean`/máscaras son opcionales (degrada con gracia).
   */
  render(
    ctx: CanvasRenderingContext2D,
    video: HTMLVideoElement,
    f: BodyFrame,
    layers: LayerSpec[],
    masks: PersonMasks | null,
  ) {
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    this.ensure(w, h);
    this.collar = null;

    const xs = [f.M.x - f.S * 1.7, f.M.x + f.S * 1.7];
    const ys = [f.M.y - f.S * 0.5, h];
    for (const a of f.arms) for (const p of [a.sh, a.el, a.wr]) { xs.push(p.x - f.S * 0.5, p.x + f.S * 0.5); }
    const bx = Math.max(0, Math.floor(Math.min(...xs)));
    const by = Math.max(0, Math.floor(ys[0]));
    this.bb = { x: bx, y: by, w: Math.max(2, Math.min(w, Math.ceil(Math.max(...xs))) - bx), h: Math.max(2, h - by) };
    const B = this.bb;

    // Luminancia normalizada del vídeo (gris, brillo compensado por la ropa original).
    const target = 0.7;
    const wantK = clamp(target / Math.max(masks?.lumMean ?? 0.5, 0.08), 0.85, 2.4);
    this.lumK += (wantK - this.lumK) * 0.15;
    const lc = this.lum.getContext("2d")!;
    lc.globalCompositeOperation = "source-over";
    if (this.hasFilter && "filter" in lc) {
      // Desenfoque + contraste suave: deja pasar la luz y los pliegues grandes, no el estampado de la ropa original.
      lc.filter = `grayscale(1) blur(${Math.max(1, f.S * 0.014).toFixed(1)}px) brightness(${this.lumK.toFixed(3)}) contrast(0.9)`;
      lc.drawImage(video, B.x, B.y, B.w, B.h, B.x, B.y, B.w, B.h);
      lc.filter = "none";
    } else {
      this.hasFilter = false;
      lc.drawImage(video, B.x, B.y, B.w, B.h, B.x, B.y, B.w, B.h);
      lc.globalCompositeOperation = "saturation";
      lc.fillStyle = "#808080";
      lc.fillRect(B.x, B.y, B.w, B.h);
      lc.globalCompositeOperation = "source-over";
    }

    for (const spec of layers) {
      const built = spec.kind === "bottom" ? buildBottom(f) : build(f, spec);
      this.drawLayer(ctx, f, spec, built, masks, w, h);
      if (spec.kind !== "bottom") this.collar = { f, g: built.geo };
    }

    if (masks && masks.version > 0) this.drawFront(ctx, video, masks, w, h);
  }

  private drawLayer(
    ctx: CanvasRenderingContext2D,
    f: BodyFrame,
    spec: LayerSpec,
    b: Built,
    masks: PersonMasks | null,
    w: number,
    h: number,
  ) {
    const L = this.layer.getContext("2d")!;
    const z = spec.sizing;
    const g = b.geo;
    const rgb = parseColor(spec.color);
    const pt = (a: number, bb: number) => bp(f, a, bb);
    const S = f.S;

    const B = this.bb;
    L.setTransform(1, 0, 0, 1, 0, 0);
    L.globalCompositeOperation = "source-over";
    L.globalAlpha = 1;
    L.clearRect(0, 0, w, h);

    // 1) Hueco del cuello: piel de la propia persona (se repinta el cuello real por encima).
    if (spec.kind !== "bottom") {
      const sk = masks?.skinRgb ?? [217, 180, 154];
      const top = pt(0, g.chordB);
      const bot = pt(0, g.dip + 0.1);
      const grad = L.createLinearGradient(top.x, top.y, bot.x, bot.y);
      grad.addColorStop(0, `rgb(${sk.map((v) => Math.round(v * 0.95)).join(",")})`);
      grad.addColorStop(1, `rgb(${sk.map((v) => Math.round(v * 0.8)).join(",")})`);
      L.fillStyle = grad;
      L.fill(b.hole);
    }

    // 2) Color base con un leve degradado de volumen.
    const gTop = pt(0, -0.1);
    const gBot = pt(0, Math.min(g.hemB, 2.2));
    const base = L.createLinearGradient(gTop.x, gTop.y, gBot.x, gBot.y);
    base.addColorStop(0, shade(rgb, 0.07));
    base.addColorStop(1, shade(rgb, -0.05));
    L.fillStyle = base;
    L.fill(b.body);

    // Solapas / cuello rellenos con el mismo color (antes del sombreado)
    const deco = this.collarShapes(f, spec, b);
    for (const leaf of deco.leaves) {
      L.fillStyle = shade(rgb, 0.04);
      L.fill(leaf);
      b.clip.addPath(leaf);
    }

    // 3) Sombreado con la luz real del vídeo (dentro de la prenda).
    L.save();
    L.clip(b.clip);
    L.globalCompositeOperation = "multiply";
    L.globalAlpha = 0.5;
    L.drawImage(this.lum, B.x, B.y, B.w, B.h, B.x, B.y, B.w, B.h);
    L.globalCompositeOperation = "soft-light";
    L.globalAlpha = 0.45;
    L.drawImage(this.lum, B.x, B.y, B.w, B.h, B.x, B.y, B.w, B.h);

    // textura de piqué / punto, anclada al marco corporal
    if (this.texture && (spec.kind === "polo" || spec.kind === "knit" || spec.kind === "tee")) {
      const tile = Math.max(1.2, S / 55);
      this.texture.setTransform(new DOMMatrix().translate(f.M.x, f.M.y).rotate((f.angle * 180) / Math.PI).scale(tile));
      L.globalCompositeOperation = "multiply";
      L.globalAlpha = spec.kind === "polo" ? 0.55 : 0.35;
      L.fillStyle = this.texture;
      L.fillRect(B.x, B.y, B.w, B.h);
    }

    // volumen cilíndrico: bordes laterales más oscuros, brillo central
    L.globalCompositeOperation = "source-over";
    L.globalAlpha = 1;
    const e1 = pt(-g.hs - 0.1, 0);
    const e2 = pt(g.hs + 0.1, 0);
    const vol = L.createLinearGradient(e1.x, e1.y, e2.x, e2.y);
    vol.addColorStop(0, "rgba(0,0,0,0.30)");
    vol.addColorStop(0.2, "rgba(0,0,0,0.06)");
    vol.addColorStop(0.5, "rgba(255,255,255,0.07)");
    vol.addColorStop(0.8, "rgba(0,0,0,0.06)");
    vol.addColorStop(1, "rgba(0,0,0,0.30)");
    L.fillStyle = vol;
    L.fillRect(B.x, B.y, B.w, B.h);

    // sombra bajo el cuello/solapas y bajo las axilas
    for (const sg of [1, -1]) {
      const apx = pt(sg * g.c, g.apB);
      const rg = L.createRadialGradient(apx.x, apx.y, 0, apx.x, apx.y, S * 0.34);
      rg.addColorStop(0, "rgba(0,0,0,0.30)");
      rg.addColorStop(1, "rgba(0,0,0,0)");
      L.fillStyle = rg;
      L.fillRect(apx.x - S * 0.4, apx.y - S * 0.4, S * 0.8, S * 0.8);
    }
    const hemA = pt(0, g.hemB - 0.35);
    const hemZ = pt(0, g.hemB);
    const hg = L.createLinearGradient(hemA.x, hemA.y, hemZ.x, hemZ.y);
    hg.addColorStop(0, "rgba(0,0,0,0)");
    hg.addColorStop(1, "rgba(0,0,0,0.18)");
    L.fillStyle = hg;
    L.fillRect(B.x, B.y, B.w, B.h);

    this.foldsAndTension(L, f, spec, b, z);
    L.restore();

    // 4) Detalles de corte (cuello, botonadura, puños, costuras)
    this.details(L, f, spec, b, rgb, deco);

    // 5) Recorte a la silueta de la persona (+ holgura) para no pintar el fondo
    if (masks && masks.version > 0 && spec.kind !== "bottom") {
      const pxCm = S / z.sCm;
      const loose = Math.max(0, (z.r - 1.0) * 0.5 * 0.9 * S) + Math.max(0, (z.shoulderRatio - 1.05)) * 0.3 * S;
      const dil = this.dilated(masks, w, h, Math.max(S * 0.04, loose) + pxCm * 0.5);
      // dentro del torso (menos el borde lateral) la prenda no se recorta
      const D2 = this.dil2.getContext("2d")!;
      D2.globalCompositeOperation = "source-over";
      D2.clearRect(0, 0, w, h);
      D2.drawImage(dil, 0, 0, w, h);
      const tp = [pt(-g.c * 0.9, -0.2), pt(g.c * 0.9, -0.2), pt(g.c * 0.9, g.hemB), pt(-g.c * 0.9, g.hemB)];
      D2.beginPath();
      D2.moveTo(tp[0].x, tp[0].y);
      for (const q of tp.slice(1)) D2.lineTo(q.x, q.y);
      D2.closePath();
      D2.fillStyle = "#000";
      D2.fill();
      L.globalCompositeOperation = "destination-in";
      L.drawImage(this.dil2, 0, 0, w, h);
      L.globalCompositeOperation = "source-over";
    }

    // 6) A pantalla con sombra de borde suave
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.32)";
    ctx.shadowBlur = Math.max(4, S * 0.05);
    ctx.shadowOffsetY = Math.max(1, S * 0.012);
    ctx.drawImage(this.layer, 0, 0, w, h);
    ctx.restore();
  }

  /** Formas de solapa/cuello por tipo (se rellenan con el color antes de sombrear). */
  private collarShapes(f: BodyFrame, spec: LayerSpec, b: Built) {
    const g = b.geo;
    const pt = (a: number, bb: number) => bp(f, a, bb);
    const leaves: Path2D[] = [];
    const mk = (pts: Pt[], smooth = false) => {
      const p = new Path2D();
      p.moveTo(pts[0].x, pts[0].y);
      if (smooth) {
        for (let i = 1; i < pts.length - 1; i++) {
          const m = mid(pts[i], pts[i + 1]);
          p.quadraticCurveTo(pts[i].x, pts[i].y, m.x, m.y);
        }
        p.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
      } else for (const q of pts.slice(1)) p.lineTo(q.x, q.y);
      p.closePath();
      return p;
    };
    if (spec.kind === "polo") {
      for (const sg of [1, -1]) {
        leaves.push(
          mk([
            pt(sg * 0.04, g.dip + 0.07), pt(sg * (g.n + 0.01), -0.17), pt(sg * (g.n + 0.12), -0.14),
            pt(sg * (g.n + 0.15), -0.04), pt(sg * (g.n + 0.09), 0.1), pt(sg * 0.05, g.dip + 0.19),
          ]),
        );
      }
    } else if (spec.kind === "shirt") {
      for (const sg of [1, -1]) {
        leaves.push(
          mk([
            pt(sg * 0.02, 0.02), pt(sg * (g.n + 0.0), -0.2), pt(sg * (g.n + 0.1), -0.17),
            pt(sg * (g.n + 0.17), 0.04), pt(sg * (g.n + 0.12), 0.16), pt(sg * 0.04, 0.26),
          ]),
        );
      }
    } else if (spec.kind === "outer") {
      for (const sg of [1, -1]) {
        leaves.push(
          mk([
            pt(sg * 0.03, 0.55), pt(sg * (g.n + 0.0), -0.19), pt(sg * (g.n + 0.13), -0.14),
            pt(sg * (g.n + 0.2), 0.04), pt(sg * (g.n + 0.12), 0.34), pt(sg * 0.1, 0.62),
          ]),
        );
      }
    }
    return { leaves };
  }

  private foldsAndTension(L: CanvasRenderingContext2D, f: BodyFrame, spec: LayerSpec, b: Built, z: Sizing) {
    const g = b.geo;
    const S = f.S;
    const pt = (a: number, bb: number) => bp(f, a, bb);
    L.lineCap = "round";
    // caída: pliegues verticales suaves cuando sobra tela
    if (z.drape > 0.05 && spec.kind !== "bottom") {
      for (const sg of [1, -1]) {
        for (let k = 0; k < 3; k++) {
          const a0 = sg * (0.1 + 0.11 * k);
          const p0 = pt(a0, 0.45 + 0.05 * k);
          const p1 = pt(a0 * 1.25 + sg * 0.05, 0.9 + 0.15 * k);
          const p2 = pt(a0 * 1.5 + sg * 0.08, Math.min(g.hemB, 2.2));
          L.beginPath();
          L.moveTo(p0.x, p0.y);
          L.quadraticCurveTo(p1.x, p1.y, p2.x, p2.y);
          L.strokeStyle = `rgba(0,0,0,${0.07 * z.drape})`;
          L.lineWidth = S * 0.07;
          L.stroke();
          L.strokeStyle = `rgba(0,0,0,${0.16 * z.drape})`;
          L.lineWidth = Math.max(1, S * 0.012);
          L.stroke();
          const hi = pt(a0 + sg * 0.03, 0.5 + 0.05 * k);
          const hi2 = pt(a0 * 1.25 + sg * 0.1, 0.95 + 0.15 * k);
          L.beginPath();
          L.moveTo(hi.x, hi.y);
          L.lineTo(hi2.x, hi2.y);
          L.strokeStyle = `rgba(255,255,255,${0.09 * z.drape})`;
          L.lineWidth = Math.max(1, S * 0.02);
          L.stroke();
        }
      }
    }
    // tensión: arrugas horizontales desde axilas/costados hacia el centro del pecho
    if (z.tension > 0.05) {
      for (const sg of [1, -1]) {
        for (let k = 0; k < 4; k++) {
          const from = pt(sg * (g.c - 0.02), 0.36 + 0.09 * k);
          const to = pt(sg * (0.04 + 0.01 * k), 0.26 + 0.1 * k);
          const ctl = pt(sg * g.c * 0.5, 0.26 + 0.09 * k + 0.035);
          L.beginPath();
          L.moveTo(from.x, from.y);
          L.quadraticCurveTo(ctl.x, ctl.y, to.x, to.y);
          L.strokeStyle = `rgba(0,0,0,${0.3 * z.tension})`;
          L.lineWidth = Math.max(1.2, S * 0.014);
          L.stroke();
          L.strokeStyle = `rgba(255,255,255,${0.14 * z.tension})`;
          L.lineWidth = Math.max(1, S * 0.01);
          L.translate(0, S * 0.012);
          L.stroke();
          L.translate(0, -S * 0.012);
        }
      }
    }
  }

  private details(L: CanvasRenderingContext2D, f: BodyFrame, spec: LayerSpec, b: Built, rgb: RGB, deco: { leaves: Path2D[] }) {
    const g = b.geo;
    const S = f.S;
    const pt = (a: number, bb: number) => bp(f, a, bb);
    const line = (pts: Pt[], style: string, width: number, smooth = false) => {
      L.beginPath();
      L.moveTo(pts[0].x, pts[0].y);
      if (smooth && pts.length > 2) {
        for (let i = 1; i < pts.length - 1; i++) {
          const m = mid(pts[i], pts[i + 1]);
          L.quadraticCurveTo(pts[i].x, pts[i].y, m.x, m.y);
        }
        L.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
      } else for (const p of pts.slice(1)) L.lineTo(p.x, p.y);
      L.strokeStyle = style;
      L.lineWidth = width;
      L.lineCap = "round";
      L.lineJoin = "round";
      L.stroke();
    };
    const thin = Math.max(1, S * 0.008);
    const seam = "rgba(0,0,0,0.30)";
    const light = shade(rgb, 0.22, 0.55);

    // contorno de la prenda
    L.strokeStyle = seam;
    L.lineWidth = thin * 1.4;
    L.lineJoin = "round";
    L.stroke(b.body);
    for (const leaf of deco.leaves) {
      L.strokeStyle = "rgba(0,0,0,0.38)";
      L.lineWidth = thin * 1.3;
      L.stroke(leaf);
    }

    // costura de manga (sisa): baja sobre el brazo cuando el hombro "cae"
    if (spec.sleeves !== "none") {
      b.sleeves.forEach((s, i) => {
        const sg = i === 0 ? 1 : -1;
        const ctl = pt(sg * (g.hs - 0.02), 0.12);
        L.beginPath();
        L.moveTo(s.tip.x, s.tip.y);
        L.quadraticCurveTo(ctl.x, ctl.y, s.ap.x, s.ap.y);
        L.strokeStyle = "rgba(0,0,0,0.28)";
        L.lineWidth = thin * 1.2;
        L.stroke();
        // dobladillo de manga
        const hemInset = (spec.sleeves === "long" ? 0.05 : 0.04) * S;
        const qa = { x: s.qOut.x - s.qDir.x * hemInset, y: s.qOut.y - s.qDir.y * hemInset };
        const qb = { x: s.qIn.x - s.qDir.x * hemInset, y: s.qIn.y - s.qDir.y * hemInset };
        line([qa, qb], "rgba(0,0,0,0.22)", thin);
        line([s.qOut, s.qIn], "rgba(255,255,255,0.12)", thin);
      });
    }

    // dobladillo del bajo
    const h1 = pt(-g.ah, g.hemB - 0.05);
    const h2 = pt(g.ah, g.hemB - 0.05);
    const hm = pt(0, g.hemB + 0.07);
    L.beginPath();
    L.moveTo(h1.x, h1.y);
    L.quadraticCurveTo(hm.x, hm.y, h2.x, h2.y);
    L.strokeStyle = "rgba(0,0,0,0.20)";
    L.lineWidth = thin;
    L.stroke();

    const buttons = (aTop: number, aBot: number, count: number, r: number) => {
      for (let k = 0; k < count; k++) {
        const bb = aTop + ((aBot - aTop) * k) / Math.max(1, count - 1);
        const c = pt(0, bb);
        L.beginPath();
        L.arc(c.x, c.y, S * r, 0, Math.PI * 2);
        L.fillStyle = shade(rgb, 0.55, 0.92);
        L.fill();
        L.strokeStyle = "rgba(0,0,0,0.42)";
        L.lineWidth = thin;
        L.stroke();
        L.beginPath();
        L.arc(c.x - S * r * 0.2, c.y - S * r * 0.2, S * r * 0.22, 0, Math.PI * 2);
        L.fillStyle = "rgba(0,0,0,0.5)";
        L.fill();
        L.beginPath();
        L.arc(c.x + S * r * 0.2, c.y + S * r * 0.2, S * r * 0.22, 0, Math.PI * 2);
        L.fill();
      }
    };
    const placket = (aTop: number, aBot: number, half: number) => {
      const p = [pt(-half, aTop), pt(half, aTop), pt(half, aBot), pt(-half, aBot)];
      L.beginPath();
      L.moveTo(p[0].x, p[0].y);
      for (const q of p.slice(1)) L.lineTo(q.x, q.y);
      L.closePath();
      L.fillStyle = shade(rgb, 0.04, 0.35);
      L.fill();
      L.strokeStyle = "rgba(0,0,0,0.30)";
      L.lineWidth = thin;
      L.stroke();
      line([pt(0, aTop), pt(0, aBot)], "rgba(0,0,0,0.30)", thin);
    };

    switch (spec.kind) {
      case "polo": {
        // trabilla con 3 botones y banda del cuello (rib)
        const top = g.dip + 0.12;
        placket(top, top + 0.5, 0.045);
        buttons(top + 0.07, top + 0.43, 2, 0.026);
        // banda del cuello trasera
        const band = [pt(-g.n * 0.95, g.chordB + 0.01), pt(0, g.chordB - 0.025), pt(g.n * 0.95, g.chordB + 0.01)];
        line(band, shade(rgb, -0.25, 0.9), S * 0.04, true);
        line(band, shade(rgb, 0.25, 0.5), S * 0.012, true);
        // costillas de la solapa
        for (const sg of [1, -1]) {
          for (let k = 0; k < 3; k++) {
            const a = pt(sg * (g.n + 0.01 + 0.03 * k), -0.14 + 0.05 * k);
            const c = pt(sg * (0.07 + 0.02 * k), g.dip + 0.12 + 0.025 * k);
            line([a, c], "rgba(0,0,0,0.06)", thin * 0.8);
          }
        }
        break;
      }
      case "tee":
      case "top":
      case "knit": {
        const w = (spec.kind === "knit" ? 0.055 : 0.04) * S;
        const nA = pt(g.n, -0.12), nB = pt(-g.n, -0.12), nc = pt(0, 2 * g.dip + 0.12);
        const rib = new Path2D();
        rib.moveTo(nB.x, nB.y);
        rib.quadraticCurveTo(nc.x, nc.y, nA.x, nA.y);
        L.strokeStyle = shade(rgb, -0.18, 0.85);
        L.lineWidth = w;
        L.lineCap = "butt";
        L.stroke(rib);
        L.strokeStyle = shade(rgb, 0.22, 0.4);
        L.lineWidth = w * 0.3;
        L.stroke(rib);
        const band = [pt(-g.n * 0.95, g.chordB + 0.01), pt(0, g.chordB - 0.025), pt(g.n * 0.95, g.chordB + 0.01)];
        line(band, shade(rgb, -0.25, 0.9), w, true);
        if (spec.kind === "knit") {
          // puños y bajo de canalé
          b.sleeves.forEach((s) => {
            const a = { x: s.qOut.x - s.qDir.x * S * 0.1, y: s.qOut.y - s.qDir.y * S * 0.1 };
            const c = { x: s.qIn.x - s.qDir.x * S * 0.1, y: s.qIn.y - s.qDir.y * S * 0.1 };
            line([a, c], shade(rgb, -0.2, 0.8), S * 0.1);
          });
        }
        break;
      }
      case "shirt": {
        placket(g.dip + 0.18, g.hemB, 0.04);
        buttons(g.dip + 0.3, g.hemB - 0.1, Math.min(8, Math.round((g.hemB - g.dip) / 0.2)), 0.022);
        b.sleeves.forEach((s) => {
          const a = { x: s.qOut.x - s.qDir.x * S * 0.12, y: s.qOut.y - s.qDir.y * S * 0.12 };
          const c = { x: s.qIn.x - s.qDir.x * S * 0.12, y: s.qIn.y - s.qDir.y * S * 0.12 };
          line([a, c], "rgba(0,0,0,0.30)", thin * 1.2); // puño
        });
        line([pt(-g.n * 0.95, g.chordB + 0.01), pt(0, g.chordB - 0.025), pt(g.n * 0.95, g.chordB + 0.01)], shade(rgb, -0.25, 0.9), S * 0.035, true);
        break;
      }
      case "outer": {
        // frente abierto: forro oscuro y solapas
        const open = new Path2D();
        const q = [pt(-0.055, g.dip + 0.02), pt(0.055, g.dip + 0.02), pt(0.06, g.hemB), pt(-0.06, g.hemB)];
        open.moveTo(q[0].x, q[0].y);
        for (const p of q.slice(1)) open.lineTo(p.x, p.y);
        open.closePath();
        L.fillStyle = shade(rgb, -0.62, 0.92);
        L.fill(open);
        L.strokeStyle = "rgba(0,0,0,0.4)";
        L.lineWidth = thin * 1.2;
        L.stroke(open);
        break;
      }
      default:
        break;
    }
    void light;
  }

  /**
   * Repinta por encima de la prenda: cara/pelo/cuello SOLO por encima del cuello,
   * y antebrazos/manos SOLO si cruzan el torso, limitados a cápsulas de los landmarks.
   */
  private drawFront(ctx: CanvasRenderingContext2D, video: HTMLVideoElement, masks: PersonMasks, w: number, h: number) {
    const col = this.collar;
    if (!col) return;
    const { f, g } = col;
    const F = this.front.getContext("2d")!;
    const pt = (a: number, b: number) => bp(f, a, b);
    const paint = (masksIn: HTMLCanvasElement[]) => {
      F.globalCompositeOperation = "source-over";
      F.clearRect(0, 0, w, h);
      F.drawImage(video, 0, 0, w, h);
      F.globalCompositeOperation = "destination-in";
      // unión de máscaras: se dibujan en un canvas auxiliar
      const U = this.union.getContext("2d")!;
      U.clearRect(0, 0, w, h);
      for (const m of masksIn) U.drawImage(m, 0, 0, w, h);
      F.drawImage(this.union, 0, 0);
      F.globalCompositeOperation = "source-over";
    };
    const feather = Math.max(1.5, f.S * 0.012);

    // 1) cara + pelo + cuello (piel) por encima de la línea del cuello
    paint([masks.faceHair, masks.skin]);
    const W = g.hs + 0.3;
    const below = new Path2D();
    const pts = [
      pt(-W, -0.2), pt(-g.n - 0.03, -0.19), pt(-g.n * 0.5, g.dip * 0.5 - 0.12), pt(0, g.dip + 0.02),
      pt(g.n * 0.5, g.dip * 0.5 - 0.12), pt(g.n + 0.03, -0.19), pt(W, -0.2),
      pt(W, 4), pt(-W, 4),
    ];
    below.moveTo(pts[0].x, pts[0].y);
    for (const q of pts.slice(1)) below.lineTo(q.x, q.y);
    below.closePath();
    F.globalCompositeOperation = "destination-out";
    F.filter = `blur(${feather}px)`;
    F.fillStyle = "#000";
    F.fill(below);
    F.filter = "none";
    F.globalCompositeOperation = "source-over";
    ctx.drawImage(this.front, 0, 0);

    // 2) antebrazos/manos delante del torso: componente de piel conectado a la muñeca,
    //    acotado a cápsula+disco, con histéresis de 3 fotogramas
    const lateral = (p: Pt) => ((p.x - f.M.x) * f.lat.x + (p.y - f.M.y) * f.lat.y) / f.S;
    const depth = (p: Pt) => ((p.x - f.M.x) * f.down.x + (p.y - f.M.y) * f.down.y) / f.S;
    const mw = masks.w, mh = masks.h;
    const sx = mw / w, sy = mh / h;
    const out = this.handCtx;
    if (out.canvas.width !== mw || out.canvas.height !== mh) {
      out.canvas.width = mw;
      out.canvas.height = mh;
    }
    const img = out.createImageData(mw, mh);
    const px32 = new Uint32Array(img.data.buffer);
    let any = false;
    f.arms.forEach((a, i) => {
      const hands = f.hands[i].filter((p) => Math.abs(lateral(p)) < g.c && depth(p) > 0.3);
      const inFront = hands.length > 0 && (f.wristOk[i] || hands.length >= 2);
      this.handFrames[i] = inFront ? this.handFrames[i] + 1 : 0;
      if (this.handFrames[i] < 3) return;
      const rArm = f.S * 0.17, rHand = f.S * 0.18;
      const inRegion = (x: number, y: number) => {
        // distancia al segmento codo-muñeca o a algún punto de mano
        const ex = a.wr.x - a.el.x, ey = a.wr.y - a.el.y;
        const l2 = ex * ex + ey * ey || 1;
        const t = Math.min(1, Math.max(0, ((x - a.el.x) * ex + (y - a.el.y) * ey) / l2));
        if (Math.hypot(x - (a.el.x + ex * t), y - (a.el.y + ey * t)) <= rArm) return true;
        return hands.some((p) => Math.hypot(x - p.x, y - p.y) <= rHand);
      };
      // semillas: píxeles de piel cercanos a la muñeca y a los puntos de mano
      const stack: number[] = [];
      const seen = new Uint8Array(mw * mh);
      for (const p of [a.wr, ...hands]) {
        const cx = Math.round(p.x * sx), cy = Math.round(p.y * sy);
        const rr = Math.max(2, Math.round(f.S * 0.08 * sx));
        for (let dy = -rr; dy <= rr; dy++) for (let dx = -rr; dx <= rr; dx++) {
          const x = cx + dx, y = cy + dy;
          if (x < 0 || y < 0 || x >= mw || y >= mh) continue;
          const k = y * mw + x;
          if (masks.skinFlag[k] && !seen[k]) { seen[k] = 1; stack.push(k); }
        }
      }
      while (stack.length) {
        const k = stack.pop()!;
        px32[k] = 0xffffffff;
        any = true;
        const x = k % mw, y = (k / mw) | 0;
        for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
          if (nx < 0 || ny < 0 || nx >= mw || ny >= mh) continue;
          const nk = ny * mw + nx;
          if (seen[nk] || !masks.skinFlag[nk]) continue;
          seen[nk] = 1;
          if (inRegion(nx / sx, ny / sy)) stack.push(nk);
        }
      }
    });
    if (any) {
      out.putImageData(img, 0, 0);
      const U = this.union.getContext("2d")!;
      U.clearRect(0, 0, w, h);
      U.filter = `blur(${feather}px)`;
      U.drawImage(this.handMask, 0, 0, w, h);
      U.filter = "none";
      F.globalCompositeOperation = "source-over";
      F.clearRect(0, 0, w, h);
      F.drawImage(video, 0, 0, w, h);
      F.globalCompositeOperation = "destination-in";
      F.drawImage(this.union, 0, 0);
      F.globalCompositeOperation = "source-over";
      ctx.drawImage(this.front, 0, 0);
    }
  }
}
