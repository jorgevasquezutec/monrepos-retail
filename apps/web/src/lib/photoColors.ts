/**
 * Color de piel y de pelo leídos automáticamente del retrato, en el navegador.
 * Usa el segmentador multiclase (0 fondo, 1 pelo, 2 piel cuerpo, 3 piel cara,
 * 4 ropa, 5 otros) para elegir SOLO píxeles de piel/pelo, y reduce con una
 * mediana recortada en CIELAB (perceptual) descartando brillos especulares y
 * sombras profundas. La imagen no sale del dispositivo.
 */

import type { RGB } from "@retail/style-engine";
import { getSegmenter } from "./bodyEstimate.ts";

export interface PhotoColors {
  skin: RGB | null;
  hair: RGB | null;
}

type Lab = [number, number, number];

const lin = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const gam = (v: number) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

export function rgbToLab(r: number, g: number, b: number): Lab {
  const R = lin(r), G = lin(g), B = lin(b);
  const x = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

function labToRgb([L, a, b]: Lab): RGB {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const inv = (t: number) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  const X = inv(fx) * 0.95047, Y = inv(fy), Z = inv(fz) * 1.08883;
  const R = 3.2406 * X - 1.5372 * Y - 0.4986 * Z;
  const G = -0.9689 * X + 1.8758 * Y + 0.0415 * Z;
  const B = 0.0557 * X - 0.204 * Y + 1.057 * Z;
  const c = (v: number) => Math.round(Math.min(255, Math.max(0, gam(Math.min(1, Math.max(0, v))))));
  return { r: c(R), g: c(G), b: c(B) };
}

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

/**
 * Mediana recortada: descarta los extremos de L (sombras/brillos), luego los
 * outliers de croma (labios, ojos, bordes) y devuelve la mediana por canal.
 */
function robustColor(px: Lab[], lowQ: number, highQ: number): RGB | null {
  if (px.length < 40) return null;
  const sorted = [...px].sort((p, q) => p[0] - q[0]);
  const core = sorted.slice(Math.floor(sorted.length * lowQ), Math.ceil(sorted.length * highQ));
  const ma = median(core.map((p) => p[1]));
  const mb = median(core.map((p) => p[2]));
  const kept = core.filter((p) => Math.hypot(p[1] - ma, p[2] - mb) < 18);
  const use = kept.length >= 20 ? kept : core;
  return labToRgb([median(use.map((p) => p[0])), median(use.map((p) => p[1])), median(use.map((p) => p[2]))]);
}

/** Última máscara de segmentación, para validar muestreos manuales sobre la misma imagen. */
let lastMask: { img: HTMLImageElement; mask: Uint8Array; mw: number; mh: number } | null = null;

/** Clase de segmentación en un punto normalizado de la imagen (null si aún no hay máscara). */
export function classAtPoint(img: HTMLImageElement, xNorm: number, yNorm: number): number | null {
  if (!lastMask || lastMask.img !== img) return null;
  const { mask, mw, mh } = lastMask;
  const x = Math.min(mw - 1, Math.max(0, Math.floor(xNorm * mw)));
  const y = Math.min(mh - 1, Math.max(0, Math.floor(yNorm * mh)));
  return mask[y * mw + x]!;
}

/** ¿Tiene un color el tono/croma propio de la piel humana (de muy clara a muy oscura)? */
export function isPlausibleSkin({ r, g, b }: RGB): boolean {
  const [L, a, bb] = rgbToLab(r, g, b);
  const chroma = Math.hypot(a, bb);
  const hue = (Math.atan2(bb, a) * 180) / Math.PI; // piel: rojo-naranja-amarillo
  return L > 12 && L < 92 && chroma > 6 && chroma < 48 && hue > 15 && hue < 75;
}

export async function detectPhotoColors(img: HTMLImageElement): Promise<PhotoColors> {
  const segmenter = await getSegmenter();
  // Opaco sobre blanco, y limitado de tamaño (la máscara es lo caro).
  const scale = Math.min(1, 640 / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);

  const res = segmenter.segment(canvas);
  const cat = res.categoryMask;
  if (!cat) return { skin: null, hair: null };
  const mw = cat.width, mh = cat.height;
  const mask = cat.getAsUint8Array().slice();
  cat.close?.();
  lastMask = { img, mask, mw, mh };

  // Los píxeles se leen a la resolución de la imagen escalada.
  const data = ctx.getImageData(0, 0, w, h).data;
  const face: Lab[] = [], body: Lab[] = [], hair: Lab[] = [];
  for (let y = 0; y < h; y++) {
    const my = Math.min(mh - 1, Math.floor((y / h) * mh));
    for (let x = 0; x < w; x++) {
      const cls = mask[my * mw + Math.min(mw - 1, Math.floor((x / w) * mw))]!;
      if (cls !== 1 && cls !== 2 && cls !== 3) continue;
      const i = (y * w + x) * 4;
      const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!;
      // Quemado (brillo especular / fondo blanco) o negro duro: no informa.
      if (Math.min(r, g, b) > 238 || Math.max(r, g, b) < 14) continue;
      const lab = rgbToLab(r, g, b);
      (cls === 3 ? face : cls === 2 ? body : hair).push(lab);
    }
  }

  // Piel: cara si hay suficiente; si no, piel del cuerpo. Quita 12 % de sombras y 12 % de brillos.
  const skin = robustColor(face, 0.12, 0.88) ?? robustColor(body, 0.12, 0.88);
  // Pelo: el brillo del pelo es especular → recorta más los claros.
  const hairC = robustColor(hair, 0.05, 0.8);
  return { skin, hair: hairC };
}
