/**
 * Recomendador: puntúa cada prenda del catálogo cruzando dos señales:
 *  1. Afinidad de color con la paleta de la estación del usuario.
 *  2. Afinidad de silueta con la figura del usuario.
 */

import { colorDistance, hexToRgb } from "./color.js";
import type { Season } from "./seasons.js";
import { shapeLabel, type ShapeInfo } from "./morphology.js";
import type { Garment } from "./catalog.js";

export interface ScoredGarment {
  garment: Garment;
  /** Puntuación total 0-1 (mayor = mejor recomendación). */
  score: number;
  colorScore: number;
  siluetaScore: number;
  /** Motivos legibles de por qué se recomienda. */
  motivos: string[];
}

export interface RecommendInput {
  season: Season;
  shape: ShapeInfo;
  catalog: Garment[];
  /** Peso relativo del color frente a la silueta (0-1). Por defecto 0.5. */
  pesoColor?: number;
  /** Filtra el catálogo por sexo (incluye siempre las prendas unisex). */
  genero?: "female" | "male";
}

/**
 * Afinidad de color: 1 si el color de la prenda coincide con el mejor color
 * de la paleta de la estación, decayendo con la distancia perceptual.
 */
function scoreColor(garmentHex: string, palette: string[]): number {
  const g = hexToRgb(garmentHex);
  const nearest = Math.min(...palette.map((p) => colorDistance(g, hexToRgb(p))));
  // ~255 de distancia se considera ya "muy distinto". Normalizamos e invertimos.
  return Math.max(0, 1 - nearest / 255);
}

/** Afinidad de silueta: proporción de etiquetas favorables, penalizando las a evitar. */
function scoreSilueta(garment: Garment, shape: ShapeInfo): number {
  if (garment.siluetas.length === 0) return 0.3;
  const favorables = garment.siluetas.filter((s) => shape.favorece.includes(s)).length;
  const penalizadas = garment.siluetas.filter((s) => shape.evitar.includes(s)).length;
  const raw = (favorables - penalizadas) / garment.siluetas.length;
  // Lleva de [-1,1] a [0,1].
  return Math.min(1, Math.max(0, (raw + 1) / 2));
}

export function recommend(input: RecommendInput): ScoredGarment[] {
  const { season, shape } = input;
  const catalog = input.genero
    ? input.catalog.filter((g) => g.genero === input.genero || g.genero === "unisex")
    : input.catalog;
  const pesoColor = input.pesoColor ?? 0.5;
  const pesoSilueta = 1 - pesoColor;

  return catalog
    .map((garment): ScoredGarment => {
      const colorScore = scoreColor(garment.color, season.paleta);
      const siluetaScore = scoreSilueta(garment, shape);
      const score = colorScore * pesoColor + siluetaScore * pesoSilueta;

      const motivos: string[] = [];
      if (colorScore >= 0.7) motivos.push(`Color afín a tu paleta ${season.nombre}`);
      const favs = garment.siluetas.filter((s) => shape.favorece.includes(s));
      if (favs.length > 0) motivos.push(`Silueta favorable para tu figura (${shapeLabel(shape, input.genero)})`);
      const bad = garment.siluetas.filter((s) => shape.evitar.includes(s));
      if (bad.length > 0) motivos.push(`Precaución: silueta menos favorable`);

      return { garment, score, colorScore, siluetaScore, motivos };
    })
    .sort((a, b) => b.score - a.score);
}
