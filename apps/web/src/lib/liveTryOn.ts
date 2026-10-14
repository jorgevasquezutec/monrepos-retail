/**
 * Probador en vivo 2D — self-built sobre MediaPipe PoseLandmarker (modo VIDEO)
 * + ImageSegmenter (silueta/oclusión) + tabla de tallas del catálogo.
 *
 * Este módulo: modelos, suavizado de landmarks, completado de la pose cuando
 * solo se ven cabeza y hombros (webcam de escritorio), máscaras de persona y
 * la lógica de talla/veredicto. El dibujo está en garmentRender.ts.
 * El vídeo nunca sale del dispositivo.
 */

import type { ImageSegmenter, PoseLandmarker } from "@mediapipe/tasks-vision";
import { computeFit, type Fabric, type FitState, type GarmentFit, type Measurements, type SizeChart, type SizeLabel } from "@retail/style-engine";
import { SEG_MODEL, WASM as BODY_WASM } from "./bodyEstimate.ts";

const WASM = BODY_WASM;
const POSE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

let videoPosePromise: Promise<PoseLandmarker> | null = null;

/** PoseLandmarker en modo VIDEO (instancia aparte de la de bodyEstimate). */
export function getVideoPose(): Promise<PoseLandmarker> {
  if (!videoPosePromise) {
    videoPosePromise = (async () => {
      const { FilesetResolver, PoseLandmarker } = await import("@mediapipe/tasks-vision");
      const vision = await FilesetResolver.forVisionTasks(WASM);
      return PoseLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: POSE_MODEL },
        runningMode: "VIDEO",
        numPoses: 1,
      });
    })().catch((e) => {
      videoPosePromise = null; // permite reintentar tras un fallo de descarga
      throw e;
    });
  }
  return videoPosePromise;
}

export interface Pt {
  x: number;
  y: number;
}
export interface Lm extends Pt {
  visibility: number;
}
export type Polygon = Pt[];

/** Landmark crudo de MediaPipe (normalizado 0..1). */
interface RawLm {
  x: number;
  y: number;
  visibility?: number;
}

const MIN_VISIBILITY = 0.4;
const HOLD_MS = 500;

/**
 * Suavizado exponencial por landmark. Si la visibilidad es baja se mantiene el
 * último valor bueno durante HOLD_MS; pasado ese tiempo se acepta el estimado.
 */
export class LandmarkSmoother {
  private prev: Lm[] | null = null;
  private lastGood: number[] = [];

  constructor(private alpha = 0.45) {}

  /** Último resultado suavizado (null si no hay persona). */
  latest(): Lm[] | null {
    return this.prev;
  }

  reset() {
    this.prev = null;
    this.lastGood = [];
  }

  update(raw: RawLm[], now: number): Lm[] {
    const prev = this.prev;
    const out = raw.map((r, i): Lm => {
      const vis = r.visibility ?? 1;
      const p = prev?.[i];
      if (!p) {
        this.lastGood[i] = now;
        return { x: r.x, y: r.y, visibility: vis };
      }
      if (vis < MIN_VISIBILITY) {
        const held = now - (this.lastGood[i] ?? 0) < HOLD_MS;
        if (held) return { ...p, visibility: vis };
        return { x: p.x + (r.x - p.x) * this.alpha, y: p.y + (r.y - p.y) * this.alpha, visibility: vis };
      }
      this.lastGood[i] = now;
      return {
        x: p.x + (r.x - p.x) * this.alpha,
        y: p.y + (r.y - p.y) * this.alpha,
        visibility: vis,
      };
    });
    this.prev = out;
    return out;
  }
}


// --------------------------------------------------------------------------
// Pose: torso fiable y completado de landmarks ausentes
// --------------------------------------------------------------------------

/** Mínimo para vestir: nariz + ambos hombros (la webcam de escritorio no ve caderas). */
export function hasTorso(lm: Lm[]): boolean {
  return [0, 11, 12].every((i) => (lm[i]?.visibility ?? 0) >= 0.3);
}

export type FramingHint = "ok" | "cerca" | "lejos" | "lado";

/** ¿Los hombros están demasiado pegados al borde (o demasiado lejos)? */
export function framingHint(lm: Lm[]): FramingHint {
  const a = lm[11];
  const b = lm[12];
  const span = Math.abs(a.x - b.x);
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  if (minX < 0.05 || maxX > 0.95) return "lado";
  if (span > 0.62) return "cerca";
  if (span < 0.1) return "lejos";
  return "ok";
}

/** Marco corporal en píxeles: origen en el punto medio de hombros, ejes lateral/torso. */
export interface BodyFrame {
  M: Pt;
  /** Distancia entre landmarks de hombro (px): unidad de escala. */
  S: number;
  /** Unitario de B (hombro 12) a A (hombro 11). */
  lat: Pt;
  /** Unitario hacia las caderas. */
  down: Pt;
  /** Rotación del eje lateral (rad). */
  angle: number;
  /** Hombro, codo y muñeca por lado (A = landmarks 11/13/15, B = 12/14/16), completados. */
  arms: [Arm, Arm];
  /** Caderas visibles de verdad (no sintetizadas). */
  hipsReal: boolean;
  /** Puntos de mano fiables (visibilidad ≥0.6) por lado: muñeca, meñique, índice. */
  hands: [Pt[], Pt[]];
  /** Muñeca fiable (visibilidad ≥0.6) por lado. */
  wristOk: [boolean, boolean];
}
export interface Arm {
  sh: Pt;
  el: Pt;
  wr: Pt;
}

const hyp = (p: Pt) => Math.hypot(p.x, p.y) || 1;
const unit = (p: Pt): Pt => {
  const h = hyp(p);
  return { x: p.x / h, y: p.y / h };
};

/** Punto del marco corporal: `a` lateral (hacia A), `b` hacia abajo, ambos en unidades de S. */
export function bodyPt(f: BodyFrame, a: number, b: number): Pt {
  return {
    x: f.M.x + (f.lat.x * a + f.down.x * b) * f.S,
    y: f.M.y + (f.lat.y * a + f.down.y * b) * f.S,
  };
}

/**
 * Construye el marco corporal a partir de los landmarks suavizados. Codos y
 * muñecas ausentes se sintetizan bajando desde el hombro (ligeramente hacia
 * fuera); las caderas no hacen falta: la prenda se extiende más allá del encuadre.
 */
export function buildFrame(lm: Lm[], width: number, height: number): BodyFrame {
  const P = (i: number): Pt => ({ x: lm[i].x * width, y: lm[i].y * height });
  const sA = P(11);
  const sB = P(12);
  const S = Math.max(Math.hypot(sA.x - sB.x, sA.y - sB.y), 1);
  const lat = unit({ x: sA.x - sB.x, y: sA.y - sB.y });
  let down: Pt = { x: -lat.y, y: lat.x };
  if (down.y < 0) down = { x: -down.x, y: -down.y };
  const M = { x: (sA.x + sB.x) / 2, y: (sA.y + sB.y) / 2 };

  const hipsReal = (lm[23]?.visibility ?? 0) >= 0.35 && (lm[24]?.visibility ?? 0) >= 0.35 && lm[23].y < 1.05 && lm[24].y < 1.05;
  if (hipsReal) {
    // La línea hombros→caderas es mejor eje de torso que la perpendicular pura.
    const hm = { x: (P(23).x + P(24).x) / 2, y: (P(23).y + P(24).y) / 2 };
    const d = unit({ x: hm.x - M.x, y: hm.y - M.y });
    down = unit({ x: down.x * 0.5 + d.x * 0.5, y: down.y * 0.5 + d.y * 0.5 });
  }

  const arm = (sh: Pt, iEl: number, iWr: number, sign: 1 | -1): Arm => {
    const elOk = (lm[iEl]?.visibility ?? 0) >= 0.4 && lm[iEl].y * height < height * 1.2;
    const wrOk = elOk && (lm[iWr]?.visibility ?? 0) >= 0.4;
    // Brazo colgando, 8° hacia fuera.
    const dir = unit({ x: down.x + lat.x * sign * 0.14, y: down.y + lat.y * sign * 0.14 });
    const el = elOk ? P(iEl) : { x: sh.x + dir.x * S * 0.82, y: sh.y + dir.y * S * 0.82 };
    const wr = wrOk ? P(iWr) : { x: el.x + dir.x * S * 0.72, y: el.y + dir.y * S * 0.72 };
    return { sh, el, wr };
  };

  return {
    M,
    S,
    lat,
    down,
    angle: Math.atan2(lat.y, lat.x),
    arms: [arm(sA, 13, 15, 1), arm(sB, 14, 16, -1)],
    hipsReal,
    hands: [[15, 17, 19, 21], [16, 18, 20, 22]].map((ids) =>
      ids.filter((i) => (lm[i]?.visibility ?? 0) >= 0.5).map(P),
    ) as [Pt[], Pt[]],
    wristOk: [(lm[15]?.visibility ?? 0) >= 0.5, (lm[16]?.visibility ?? 0) >= 0.5],
  };
}

// --------------------------------------------------------------------------
// Segmentación de persona (oclusión) — ImageSegmenter en modo VIDEO
// --------------------------------------------------------------------------

let videoSegPromise: Promise<ImageSegmenter> | null = null;

export function getVideoSegmenter(): Promise<ImageSegmenter> {
  if (!videoSegPromise) {
    videoSegPromise = (async () => {
      const { FilesetResolver, ImageSegmenter } = await import("@mediapipe/tasks-vision");
      const vision = await FilesetResolver.forVisionTasks(WASM);
      return ImageSegmenter.createFromOptions(vision, {
        baseOptions: { modelAssetPath: SEG_MODEL },
        runningMode: "VIDEO",
        outputCategoryMask: true,
        outputConfidenceMasks: false,
      });
    })().catch((e) => {
      videoSegPromise = null;
      throw e;
    });
  }
  return videoSegPromise;
}

const mkCanvas = (w = 2, h = 2) => {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
};

/**
 * Máscaras de la persona (selfie_multiclass: 0 fondo, 1 pelo, 2 piel, 3 cara,
 * 4 ropa, 5 otros). Cada máscara es un canvas con alfa 255 donde aplica.
 */
export class PersonMasks {
  /** Silueta completa (pelo+piel+cara+ropa). */
  sil = mkCanvas();
  /** Cara + pelo: siempre por encima de la prenda. */
  faceHair = mkCanvas();
  /** Piel de cuerpo + objetos sujetados: por encima solo donde hay brazo/mano delante. */
  skin = mkCanvas();
  /** Piel (clase 2/5) por píxel de máscara, para el flood-fill de manos. */
  skinFlag = new Uint8Array(0);
  /** Incrementa en cada actualización (para cachés). */
  version = 0;
  w = 0;
  h = 0;
  /** Color medio de la cara (para el hueco del cuello). */
  skinRgb: [number, number, number] = [217, 180, 154];
  /** Luminancia media (0..1) de la ropa original de la persona. */
  lumMean = 0.5;

  private small = mkCanvas(96, 72);
  private smallCtx = this.small.getContext("2d", { willReadFrequently: true })!;
  private imgs: ImageData[] = [];

  update(seg: ImageSegmenter, video: HTMLVideoElement, ts: number) {
    seg.segmentForVideo(video, ts, (res) => {
      const m = res.categoryMask;
      if (!m) return;
      const w = m.width;
      const h = m.height;
      const cls = m.getAsUint8Array();
      if (w !== this.w || h !== this.h) {
        this.w = w;
        this.h = h;
        for (const c of [this.sil, this.faceHair, this.skin]) {
          c.width = w;
          c.height = h;
        }
        this.skinFlag = new Uint8Array(w * h);
        this.imgs = [this.sil, this.faceHair, this.skin].map((c) => c.getContext("2d")!.createImageData(w, h));
      }
      const [iS, iF, iK] = this.imgs.map((im) => new Uint32Array(im.data.buffer));
      const OPAQUE = 0xffffffff;
      for (let i = 0; i < cls.length; i++) {
        const c = cls[i];
        iS[i] = c >= 1 && c <= 5 ? OPAQUE : 0;
        iF[i] = c === 1 || c === 3 ? OPAQUE : 0;
        iK[i] = c === 2 || c === 5 ? OPAQUE : 0;
        this.skinFlag[i] = c === 2 || c === 5 ? 1 : 0;
      }
      [this.sil, this.faceHair, this.skin].forEach((c, k) => c.getContext("2d")!.putImageData(this.imgs[k], 0, 0));
      this.version++;
      this.sampleColors(video, cls, w, h);
    });
  }

  /** Color de cara y luminancia de la ropa original, muestreando el vídeo reducido. */
  private sampleColors(video: HTMLVideoElement, cls: Uint8Array, w: number, h: number) {
    const sw = this.small.width;
    const sh = this.small.height;
    this.smallCtx.drawImage(video, 0, 0, sw, sh);
    const d = this.smallCtx.getImageData(0, 0, sw, sh).data;
    let fr = 0, fg = 0, fb = 0, fn = 0, ln = 0, ls = 0, an = 0, as = 0;
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        const c = cls[Math.floor((y / sh) * h) * w + Math.floor((x / sw) * w)];
        const o = (y * sw + x) * 4;
        const l = (0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2]) / 255;
        if (c === 3) {
          fr += d[o]; fg += d[o + 1]; fb += d[o + 2]; fn++;
        } else if (c === 4) {
          ls += l; ln++;
        }
        if (c >= 1 && c <= 4) {
          as += l; an++;
        }
      }
    }
    if (fn > 20) this.skinRgb = [fr / fn, fg / fn, fb / fn];
    const mean = ln > 30 ? ls / ln : an > 30 ? as / an : 0.5;
    this.lumMean += (mean - this.lumMean) * 0.3;
  }
}

// --------------------------------------------------------------------------
// Talla y ajuste
// --------------------------------------------------------------------------

export type GarmentKind = "polo" | "tee" | "shirt" | "knit" | "top" | "outer" | "dress" | "bottom";
export type SleeveKind = "short" | "long" | "none";

/** Tipo de corte a dibujar según categoría, nombre y etiquetas de silueta. */
export function garmentKind(g: { categoria: string; nombre: string; siluetas?: string[] }): { kind: GarmentKind; sleeves: SleeveKind } {
  const tags = new Set(g.siluetas ?? []);
  const name = g.nombre.toLowerCase();
  if (g.categoria === "bottom") return { kind: "bottom", sleeves: "none" };
  if (g.categoria === "dress") return { kind: "dress", sleeves: "short" };
  if (g.categoria === "outerwear") return { kind: "outer", sleeves: "long" };
  if (tags.has("cuello-polo") || /polo/.test(name)) return { kind: "polo", sleeves: "short" };
  if (tags.has("camisa") || /camisa|oxford|blusa/.test(name)) return { kind: "shirt", sleeves: "long" };
  if (/jersey|punto|sudadera/.test(name)) return { kind: "knit", sleeves: "long" };
  if (/camiseta|body|tee|top/.test(name)) return { kind: "tee", sleeves: "short" };
  return { kind: "top", sleeves: "short" };
}

export type FitTone = "good" | "snug" | "loose" | "bad";

export interface FitVerdict {
  label: string;
  tone: FitTone;
  /** Zona clave y holgura, p. ej. "Pecho +14 cm". */
  detail: string;
  estimated: boolean;
}

/** Parámetros de dibujo derivados de talla vs cuerpo (adimensionales / cm). */
export interface Sizing {
  /** Contorno de pecho de la prenda / busto de la persona. */
  r: number;
  /** Hombro de la prenda / hombro de la persona. */
  shoulderRatio: number;
  /** cm que mide la unidad S (distancia entre landmarks de hombro). */
  sCm: number;
  lengthCm: number;
  sleeveCm: number;
  /** 0..1: tensión en el pecho (prenda aprieta). */
  tension: number;
  /** 0..1: caída/holgura visible. */
  drape: number;
  verdict: FitVerdict | null;
}

export interface SizingInput {
  tallas?: SizeChart;
  tejido?: Fabric;
  size?: SizeLabel;
}

/** Medidas del cuerpo: las del usuario o, si faltan, estimadas desde la altura. */
export function bodyForFit(m: Measurements, heightCm: number, known: boolean): Measurements {
  const shoulder = m.shoulder ?? heightCm * 0.235;
  if (known) return { ...m, shoulder };
  const bust = shoulder * 2.4;
  return { bust, waist: bust * 0.82, hip: bust * 1.03, shoulder };
}

const STATE_TONE: Record<FitState, FitTone> = {
  regular: "good",
  ajustada: "snug",
  "muy-ajustada": "snug",
  holgada: "loose",
  oversize: "loose",
  "no-entra": "bad",
};
const STATE_LABEL: Record<FitState, string> = {
  regular: "Te queda bien",
  ajustada: "Ajustada",
  "muy-ajustada": "Ajustada",
  holgada: "Holgada",
  oversize: "Holgada",
  "no-entra": "No te entra",
};
const STATE_BAD_ORDER: FitState[] = ["regular", "ajustada", "holgada", "muy-ajustada", "oversize", "no-entra"];

export function sizingFor(g: SizingInput, body: Measurements, heightCm: number, estimated: boolean): Sizing {
  const shoulderCm = body.shoulder ?? heightCm * 0.235;
  const sCm = shoulderCm * 0.92;
  const m = g.size ? g.tallas?.[g.size] : undefined;
  const base: Sizing = { r: 1.1, shoulderRatio: 1.06, sCm, lengthCm: 70, sleeveCm: 22, tension: 0, drape: 0.1, verdict: null };
  if (!m) return base;

  const r = m.chest ? Math.min(Math.max(m.chest / body.bust, 0.85), 1.7) : base.r;
  const shoulderRatio = m.shoulder ? Math.min(Math.max(m.shoulder / shoulderCm, 0.85), 1.45) : base.shoulderRatio;
  let fit: GarmentFit | null = null;
  try {
    fit = computeFit(body, m, g.tejido ?? { tipo: "plano", stretchPct: 0 }, g.size!);
  } catch {
    fit = null;
  }
  // Veredicto: manda la peor zona entre pecho y hombros.
  const zones = (fit?.zones ?? []).filter((z) => z.zone === "chest" || z.zone === "shoulder");
  let verdict: FitVerdict | null = null;
  let state: FitState = "regular";
  if (zones.length) {
    const worst = zones.reduce((a, z) => (STATE_BAD_ORDER.indexOf(z.state) > STATE_BAD_ORDER.indexOf(a.state) ? z : a));
    state = worst.state;
    const sign = worst.easeCm >= 0 ? "+" : "";
    verdict = {
      label: STATE_LABEL[state],
      tone: STATE_TONE[state],
      detail: `${worst.label} ${sign}${Math.round(worst.easeCm)} cm`,
      estimated,
    };
  }
  const tension = state === "no-entra" ? 1 : state === "muy-ajustada" ? 0.8 : state === "ajustada" ? 0.45 : Math.max(0, (1.0 - r) * 3);
  const drape = Math.min(1, Math.max(0, (r - 1.1) / 0.3));
  return { r, shoulderRatio, sCm, lengthCm: m.length ?? 70, sleeveCm: m.sleeve ?? 22, tension, drape, verdict };
}
