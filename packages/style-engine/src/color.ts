/**
 * Utilidades de color puras: conversiones de espacio y distancia.
 * Sin dependencias — sirve tanto en Node (tests) como en el navegador.
 */

export interface RGB {
  /** 0-255 */ r: number;
  /** 0-255 */ g: number;
  /** 0-255 */ b: number;
}

export interface HSL {
  /** 0-360 grados */ h: number;
  /** 0-1 */ s: number;
  /** 0-1 */ l: number;
}

const clamp = (v: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, v));

/** Convierte RGB (0-255) a HSL (h en grados, s/l en 0-1). */
export function rgbToHsl({ r, g, b }: RGB): HSL {
  const rn = clamp(r, 0, 255) / 255;
  const gn = clamp(g, 0, 255) / 255;
  const bn = clamp(b, 0, 255) / 255;

  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;

  const l = (max + min) / 2;

  let h = 0;
  let s = 0;

  if (delta !== 0) {
    s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);

    switch (max) {
      case rn:
        h = ((gn - bn) / delta) % 6;
        break;
      case gn:
        h = (bn - rn) / delta + 2;
        break;
      default:
        h = (rn - gn) / delta + 4;
    }
    h *= 60;
    if (h < 0) h += 360;
  }

  return { h, s, l };
}

/** Parsea "#rrggbb" (o "rrggbb") a RGB. Lanza si el formato es inválido. */
export function hexToRgb(hex: string): RGB {
  const clean = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) {
    throw new Error(`Hex de color inválido: "${hex}"`);
  }
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

/** Convierte RGB (0-255) a "#rrggbb". */
export function rgbToHex({ r, g, b }: RGB): string {
  const toHex = (v: number) =>
    Math.round(clamp(v, 0, 255)).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * Distancia perceptual aproximada entre dos colores (0 = idénticos).
 * Usa la fórmula "redmean" ponderada, más fiel al ojo humano que la
 * distancia euclidiana simple en RGB.
 * @see https://www.compuphase.com/cmetric.htm
 */
export function colorDistance(a: RGB, b: RGB): number {
  const rMean = (a.r + b.r) / 2;
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return Math.sqrt(
    (2 + rMean / 256) * dr * dr +
      4 * dg * dg +
      (2 + (255 - rMean) / 256) * db * db,
  );
}

/** Promedia una lista de píxeles RGB (p. ej. un parche de piel muestreado). */
export function averageRgb(pixels: RGB[]): RGB {
  if (pixels.length === 0) throw new Error("No hay píxeles para promediar");
  const sum = pixels.reduce(
    (acc, p) => ({ r: acc.r + p.r, g: acc.g + p.g, b: acc.b + p.b }),
    { r: 0, g: 0, b: 0 },
  );
  return {
    r: sum.r / pixels.length,
    g: sum.g / pixels.length,
    b: sum.b / pixels.length,
  };
}
