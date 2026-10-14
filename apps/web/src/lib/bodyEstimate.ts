/**
 * Estimación de medidas + sexo desde una foto — self-built sobre MediaPipe.
 *
 * Combina DOS modelos:
 *  • PoseLandmarker (solo landmarks, sin máscara → sin crash): da hombros y
 *    cadera para (a) fijar las alturas anatómicas, (b) definir la BANDA del
 *    torso y así EXCLUIR los brazos del ancho, (c) adivinar el sexo por la
 *    proporción hombros/cadera.
 *  • ImageSegmenter: silueta para la extensión vertical (escala con la altura)
 *    y el ancho del cuerpo DENTRO de la banda del torso.
 *
 * El sexo se DEDUCE por proporciones (editable con el selector); no es una
 * clasificación definitiva, solo una estimación corregible por el usuario.
 */

import type { ImageSegmenter, PoseLandmarker } from "@mediapipe/tasks-vision";
import type { Measurements } from "@retail/style-engine";

export const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";
export const SEG_MODEL =
  "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite";
const POSE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

/** El ancho del torso ya no incluye brazos; descuenta holgura de ropa (afinado). */
const BODY_FROM_WIDTH = 0.85;

let segmenterPromise: Promise<ImageSegmenter> | null = null;
let posePromise: Promise<PoseLandmarker> | null = null;

/** Segmentador multiclase compartido (cacheado); también lo usa photoColors. */
export function getSegmenter(): Promise<ImageSegmenter> {
  if (!segmenterPromise) {
    segmenterPromise = (async () => {
      const { FilesetResolver, ImageSegmenter } = await import("@mediapipe/tasks-vision");
      const vision = await FilesetResolver.forVisionTasks(WASM);
      return ImageSegmenter.createFromOptions(vision, {
        baseOptions: { modelAssetPath: SEG_MODEL },
        runningMode: "IMAGE",
        outputCategoryMask: true,
        outputConfidenceMasks: false,
      });
    })().catch((e) => {
      segmenterPromise = null; // permite reintentar tras un fallo
      throw e;
    });
  }
  return segmenterPromise;
}

function getPose(): Promise<PoseLandmarker> {
  if (!posePromise) {
    posePromise = (async () => {
      const { FilesetResolver, PoseLandmarker } = await import("@mediapipe/tasks-vision");
      const vision = await FilesetResolver.forVisionTasks(WASM);
      return PoseLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: POSE_MODEL },
        runningMode: "IMAGE",
        numPoses: 1,
      });
    })().catch((e) => {
      posePromise = null;
      throw e;
    });
  }
  return posePromise;
}

function widthToCircumference(widthCm: number, depthRatio = 0.75): number {
  const a = widthCm / 2;
  const b = (widthCm * depthRatio) / 2;
  const h = (a - b) ** 2 / (a + b) ** 2;
  return Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
}

export interface EstimateResult {
  measurements: Measurements;
  /** Solo se rellena si la foto da una señal fiable; si no, se respeta el selector. */
  gender?: "female" | "male";
  note: string;
  /** Fiabilidad de la estimación: foto recortada → media; recortada y tapada → baja. */
  confidence: "alta" | "media" | "baja";
}

/**
 * Antropometría de referencia (proporciones de la altura H, adultos):
 * hombro (acromion) ≈ 0.818·H, articulación de cadera ≈ 0.52·H → el tramo
 * hombro→cadera de los landmarks ≈ 0.29·H. Sirve de regla cuando la foto no
 * enseña los pies (retrato de medio cuerpo).
 */
const TORSO_FRACTION = 0.29;
/**
 * Proporciones plausibles: busto respecto a la distancia entre hombros
 * (landmarks), y cintura/cadera respecto al busto. lo/hi cubren desde figuras
 * delgadas hasta tallas grandes; typ es el valor medio.
 */
const PROP = {
  bust: { lo: 2.1, typ: 2.55, hi: 3.4 },
  waist: { lo: 0.65, typ: 0.8, hi: 1.3 },
  hip: { lo: 0.9, typ: 1.08, hi: 1.45 },
};

export class NoPersonError extends Error {}

function toOpaqueCanvas(img: HTMLImageElement): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0);
  return canvas;
}

export async function estimateFromPhoto(
  img: HTMLImageElement,
  heightCm: number,
): Promise<EstimateResult> {
  const [segmenter, pose] = await Promise.all([getSegmenter(), getPose()]);
  const canvas = toOpaqueCanvas(img);

  // --- Silueta ---
  const segRes = segmenter.segment(canvas);
  const cat = segRes.categoryMask;
  if (!cat) throw new Error("Sin máscara de segmentación.");
  const mw = cat.width;
  const mh = cat.height;
  // selfie_multiclass: 0 fondo, 1 pelo, 2 piel, 3 cara, 4 ropa, 5 otros
  // (accesorios/objetos sujetados). Los objetos NO son cuerpo → fuera.
  const raw = cat.getAsUint8Array();
  const mask = raw.map((v) => (v === 5 ? 0 : v));
  cat.close?.();

  let top = -1;
  let bottom = -1;
  for (let y = 0; y < mh; y++) {
    for (let x = 0; x < mw; x++) {
      if (mask[y * mw + x] !== 0) {
        if (top === -1) top = y;
        bottom = y;
        break;
      }
    }
  }
  if (top === -1 || bottom - top < mh * 0.25) {
    throw new NoPersonError("No se detectó una persona de cuerpo entero en la foto.");
  }

  // --- Pose: torso sin brazos + alturas ---
  const poseRes = pose.detect(canvas);
  if (!poseRes.landmarks || poseRes.landmarks.length === 0) {
    throw new NoPersonError("No se detectó la pose. Usa una foto de pie, de frente y completa.");
  }
  const p = poseRes.landmarks[0];

  // --- Escala (cm por píxel) ---
  // Con los pies en cuadro, la silueta mide la altura. Si la foto está
  // recortada (tobillos fuera o invisibles), la silueta mide solo una parte y
  // la escala se dispara (todo sale ~1.5–2× más ancho): usamos el torso.
  const ankleVisible = [27, 28].every((i) => p[i].y <= 0.98 && (p[i].visibility ?? 0) > 0.5);
  const torsoPx = Math.abs((p[23].y + p[24].y) / 2 - (p[11].y + p[12].y) / 2) * mh;
  const cropped = !ankleVisible || bottom >= mh - 2;
  const cmPerPx = cropped ? (heightCm * TORSO_FRACTION) / torsoPx : heightCm / (bottom - top);
  const px = (n: number) => n * mw; // normalizado -> columnas de máscara
  const shoulderSpan = Math.abs(px(p[11].x) - px(p[12].x));
  const hipSpan = Math.abs(px(p[23].x) - px(p[24].x));
  const centerX = (px((p[11].x + p[12].x) / 2) + px((p[23].x + p[24].x) / 2)) / 2;
  // banda del torso: ancho generoso que incluye tejido/barriga pero NO los brazos
  const band = (Math.max(shoulderSpan, hipSpan) / 2) * 1.55;

  const shoulderY = (p[11].y + p[12].y) / 2;
  const hipY = (p[23].y + p[24].y) / 2;
  const span = hipY - shoulderY;
  const bustY = shoulderY + 0.2 * span;
  const waistY = shoulderY + 0.62 * span;
  const hipMeasY = hipY + 0.04 * span;

  // Ancho del TORSO a una altura: recorre CONTIGUO desde el centro hasta el
  // primer píxel de fondo. Así, si los brazos/codos están separados del tronco
  // (p. ej. manos en la cintura), el hueco de fondo entre tronco y brazo corta
  // el recorrido y NO se cuentan como cuerpo. Devuelve el ancho en cm.
  const reach = Math.round(band);
  const widthAt = (yNorm: number): number => {
    const row = Math.min(mh - 1, Math.max(0, Math.round(yNorm * mh)));
    const c = Math.min(mw - 1, Math.max(0, Math.round(centerX)));
    // Si el centro cae en fondo, engancha el píxel de persona más próximo.
    let start = c;
    if (mask[row * mw + start] === 0) {
      let found = -1;
      for (let d = 1; d <= reach; d++) {
        if (c - d >= 0 && mask[row * mw + (c - d)] !== 0) { found = c - d; break; }
        if (c + d < mw && mask[row * mw + (c + d)] !== 0) { found = c + d; break; }
      }
      if (found === -1) return 0;
      start = found;
    }
    let l = start;
    let r = start;
    while (l - 1 >= 0 && start - (l - 1) <= reach && mask[row * mw + (l - 1)] !== 0) l--;
    while (r + 1 < mw && (r + 1) - start <= reach && mask[row * mw + (r + 1)] !== 0) r++;
    return (r - l + 1) * cmPerPx * BODY_FROM_WIDTH;
  };

  // --- Detección de pose "manos en la cintura" (jarras) ---
  // Muñecas (15/16) pegadas a las caderas (23/24): la silueta mete el brazo en
  // la banda del torso e infla cintura/cadera. Lo avisamos y recortamos.
  const distPx = (a: number, b: number, c: number, d: number) =>
    Math.hypot(px(a) - px(c), (b - d) * mh);
  const wristHipL = distPx(p[15].x, p[15].y, p[23].x, p[23].y);
  const wristHipR = distPx(p[16].x, p[16].y, p[24].x, p[24].y);
  const handsOnHips = wristHipL < shoulderSpan * 0.7 && wristHipR < shoulderSpan * 0.7;

  const round = (v: number) => Math.round(v);
  const bust = round(widthToCircumference(widthAt(bustY)));
  let waist = round(widthToCircumference(widthAt(waistY)));
  let hip = round(widthToCircumference(widthAt(hipMeasY)));

  // Salvaguarda anti-pose: con manos en la cintura desconfiamos de la silueta a
  // la altura de la mano; el torso no debería superar busto/cadera de golpe.
  if (handsOnHips) {
    const cap = Math.round(Math.max(bust, hip) * 1.05);
    waist = Math.min(waist, cap);
    hip = Math.min(hip, Math.round(Math.max(bust, waist) * 1.12));
  }

  // Oclusión: una muñeca DELANTE del torso (brazo cruzado, sujetando algo) o
  // en la cadera mete brazo/objeto en la silueta. Los landmarks de hombro no
  // se ven afectados por eso → acotamos los contornos con ellos.
  const torsoL = Math.min(px(p[11].x), px(p[12].x));
  const torsoR = Math.max(px(p[11].x), px(p[12].x));
  const wristInFront = [15, 16].some(
    (i) => px(p[i].x) > torsoL && px(p[i].x) < torsoR && p[i].y > shoulderY && p[i].y < hipY + 0.1 * span,
  );
  const occluded = handsOnHips || wristInFront;
  const shoulderCm = shoulderSpan * cmPerPx;
  // Rango plausible de cada contorno. Si la silueta es fiable, solo se acota;
  // si está tapada y se sale del rango (señal de que mide brazo/objeto), se
  // sustituye por la proporción típica: preferimos un valor típico corregible
  // a uno absurdo (busto 190 o cadera 62).
  const fit = (v: number, lo: number, hi: number, typ: number) =>
    v >= lo && v <= hi ? v : occluded ? Math.round(typ) : Math.round(Math.min(hi, Math.max(lo, v)));
  const bustTyp = shoulderCm * PROP.bust.typ;
  const bustFit = fit(bust, shoulderCm * PROP.bust.lo, shoulderCm * (occluded ? PROP.bust.typ * 1.15 : PROP.bust.hi), bustTyp);
  const waistFit = fit(waist, bustFit * PROP.waist.lo, bustFit * (occluded ? 1.0 : PROP.waist.hi), bustFit * PROP.waist.typ);
  const hipFit = fit(hip, bustFit * PROP.hip.lo, bustFit * PROP.hip.hi, bustFit * PROP.hip.typ);
  const clamped = { bust: bustFit, waist: waistFit, hip: hipFit };
  const wasClamped = clamped.bust !== bust || clamped.waist !== waist || clamped.hip !== hip;

  // `shoulder` no se rellena: el motor lo usa a la vez como contorno
  // (morfología) y como ancho de hombro a hombro (tallas), y la distancia entre
  // articulaciones de la foto no es ninguno de los dos → falseaba la silueta
  // (busto 91 / cadera 98 salía "triángulo invertido"). Queda para el usuario.
  const measurements: Measurements = { ...clamped };

  // Sexo: la proporción hombros/cadera de los LANDMARKS (articulaciones) es
  // ~1.5–1.8 en casi cualquier adulto, y la ropa (hombreras) la altera → no es
  // una señal fiable. No lo deducimos: se respeta el selector Mujer/Hombre.

  const warnings: string[] = [];
  if (cropped) warnings.push("la foto no muestra los pies: la escala se estima por el torso");
  if (occluded) warnings.push("brazos u objetos delante del cuerpo: contornos acotados por el ancho de hombros");
  const base = "Medidas estimadas. Revisa el sexo en el selector y ajusta si hace falta.";
  const note = warnings.length
    ? `⚠️ ${warnings.join("; ")}${wasClamped ? " (se corrigieron valores inflados)" : ""}. Para más precisión: foto de cuerpo entero, de frente, brazos sueltos y ropa ajustada. ${base}`
    : base;

  const confidence = cropped && occluded ? "baja" : cropped || occluded ? "media" : "alta";

  return { measurements, note, confidence };
}
