/**
 * Muestreo de color de piel desde una imagen, en el navegador.
 * Privacidad: la imagen se procesa solo en memoria (canvas local); nunca se
 * sube a ningún servidor. Es la aplicación práctica de la Fase 5 del plan.
 */

import { averageRgb, type RGB } from "@retail/style-engine";

/** Dibuja la imagen en un canvas offscreen y devuelve su ImageData. */
export function imageToData(img: HTMLImageElement): {
  data: ImageData;
  width: number;
  height: number;
} {
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("No se pudo crear el contexto 2D");
  ctx.drawImage(img, 0, 0);
  return {
    data: ctx.getImageData(0, 0, canvas.width, canvas.height),
    width: canvas.width,
    height: canvas.height,
  };
}

/**
 * Muestrea un parche cuadrado alrededor de (cx, cy) en coordenadas de imagen
 * (0-1 normalizadas) y devuelve el color promedio, descartando píxeles muy
 * oscuros/claros (sombras y brillos) para robustez.
 */
export function samplePatch(
  data: ImageData,
  width: number,
  height: number,
  cxNorm: number,
  cyNorm: number,
  radiusPx = 12,
): RGB {
  const cx = Math.round(cxNorm * width);
  const cy = Math.round(cyNorm * height);
  const pixels: RGB[] = [];

  for (let y = cy - radiusPx; y <= cy + radiusPx; y++) {
    for (let x = cx - radiusPx; x <= cx + radiusPx; x++) {
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const i = (y * width + x) * 4;
      const r = data.data[i];
      const g = data.data[i + 1];
      const b = data.data[i + 2];
      const a = data.data[i + 3];
      if (a < 200) continue; // transparente
      const lum = (r + g + b) / 3;
      if (lum < 30 || lum > 245) continue; // sombra dura o brillo quemado
      pixels.push({ r, g, b });
    }
  }

  if (pixels.length === 0) throw new Error("El parche no contiene píxeles válidos");
  return averageRgb(pixels);
}

/**
 * Heurística sencilla de detección de piel (regla RGB clásica) para sugerir
 * un punto de muestreo automático: recorre la imagen y promedia los píxeles
 * que parecen piel. Sirve como valor por defecto antes de que el usuario
 * ajuste el punto manualmente.
 */
export function autoSkinColor(data: ImageData, width: number, height: number): RGB | null {
  const pixels: RGB[] = [];
  const step = Math.max(1, Math.floor(Math.min(width, height) / 200));

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      const r = data.data[i];
      const g = data.data[i + 1];
      const b = data.data[i + 2];
      if (isSkinLike(r, g, b)) pixels.push({ r, g, b });
    }
  }

  if (pixels.length < 20) return null;
  return averageRgb(pixels);
}

/** Regla de detección de piel de Kovac et al. (iluminación diurna). */
function isSkinLike(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return (
    r > 95 &&
    g > 40 &&
    b > 20 &&
    max - min > 15 &&
    Math.abs(r - g) > 15 &&
    r > g &&
    r > b
  );
}
