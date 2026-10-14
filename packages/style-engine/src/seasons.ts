/**
 * Análisis de colorimetría personal: del color de piel a una de las
 * 12 estaciones (sistema de las 12 estaciones / "Color Analysis").
 *
 * Modelo: se sitúa la piel en tres ejes continuos y se elige la estación
 * cuyo prototipo queda más cerca. Todo es determinista y explicable.
 *
 *   temperature: -1 (frío) ............ +1 (cálido)
 *   value:       -1 (profundo/oscuro) . +1 (claro)
 *   chroma:      -1 (apagado/suave) ... +1 (brillante/nítido)
 */

import { rgbToHsl, type RGB } from "./color.js";

export type SeasonId =
  | "light-spring"
  | "true-spring"
  | "bright-spring"
  | "light-summer"
  | "true-summer"
  | "soft-summer"
  | "soft-autumn"
  | "true-autumn"
  | "deep-autumn"
  | "deep-winter"
  | "true-winter"
  | "bright-winter";

export interface SeasonAxes {
  temperature: number; // -1 frío .. +1 cálido
  value: number; // -1 profundo .. +1 claro
  chroma: number; // -1 apagado .. +1 brillante
}

export interface Season {
  id: SeasonId;
  /** Familia estacional. */
  family: "spring" | "summer" | "autumn" | "winter";
  nombre: string;
  /** Descripción corta orientada al usuario. */
  descripcion: string;
  /** Prototipo en los tres ejes; se usa para el vecino más cercano. */
  proto: SeasonAxes;
  /** Paleta de colores que favorecen a esta estación (hex). */
  paleta: string[];
}

export const SEASONS: Record<SeasonId, Season> = {
  "light-spring": {
    id: "light-spring",
    family: "spring",
    nombre: "Primavera Clara",
    descripcion: "Cálida y luminosa: colores frescos, claros y delicados.",
    proto: { temperature: 0.5, value: 1, chroma: 0.5 },
    paleta: ["#F7D9C4", "#FDE9A0", "#BFE0C4", "#A7D8DE", "#F6A6B2", "#FCEFC7"],
  },
  "true-spring": {
    id: "true-spring",
    family: "spring",
    nombre: "Primavera Cálida",
    descripcion: "Cálida y viva: dorados, coral y verdes frescos.",
    proto: { temperature: 1, value: 0.2, chroma: 0.7 },
    paleta: ["#F7A93B", "#FF6F4E", "#F4C531", "#7FBF4D", "#3FB6A8", "#EF5D60"],
  },
  "bright-spring": {
    id: "bright-spring",
    family: "spring",
    nombre: "Primavera Brillante",
    descripcion: "Cálida y muy nítida: colores saturados y con contraste.",
    proto: { temperature: 0.5, value: 0.2, chroma: 1 },
    paleta: ["#FF4D3D", "#FFC300", "#12C4B0", "#2D9CDB", "#FF5DA2", "#8AE234"],
  },
  "light-summer": {
    id: "light-summer",
    family: "summer",
    nombre: "Verano Claro",
    descripcion: "Fría y clara: pasteles suaves y frescos.",
    proto: { temperature: -0.5, value: 1, chroma: -0.2 },
    paleta: ["#DCE7F2", "#F3D6E4", "#CFE8DE", "#E7DCF0", "#BFD3E6", "#F6E1E7"],
  },
  "true-summer": {
    id: "true-summer",
    family: "summer",
    nombre: "Verano Frío",
    descripcion: "Fría y suave: azules, malvas y rosados apagados.",
    proto: { temperature: -1, value: 0, chroma: -0.5 },
    paleta: ["#6E8CB0", "#A88BB5", "#C97A97", "#5FA4A4", "#8899C6", "#B5657E"],
  },
  "soft-summer": {
    id: "soft-summer",
    family: "summer",
    nombre: "Verano Suave",
    descripcion: "Fría y apagada: tonos grisáceos y neutros elegantes.",
    proto: { temperature: -0.5, value: -0.2, chroma: -1 },
    paleta: ["#8E9AA3", "#A9968F", "#7E8C8A", "#9C8AA0", "#6F8388", "#B0A0A6"],
  },
  "soft-autumn": {
    id: "soft-autumn",
    family: "autumn",
    nombre: "Otoño Suave",
    descripcion: "Cálida y apagada: tonos tierra suaves y neutros cálidos.",
    proto: { temperature: 0.5, value: -0.2, chroma: -1 },
    paleta: ["#B99C74", "#A9714B", "#8E9A6C", "#C99A6A", "#7E7A5A", "#B08268"],
  },
  "true-autumn": {
    id: "true-autumn",
    family: "autumn",
    nombre: "Otoño Cálido",
    descripcion: "Cálida y rica: terracota, mostaza, oliva y cobre.",
    proto: { temperature: 1, value: -0.3, chroma: -0.5 },
    paleta: ["#B5651D", "#C99700", "#7A8B2E", "#9E4A2E", "#5F7A3A", "#8A5A2B"],
  },
  "deep-autumn": {
    id: "deep-autumn",
    family: "autumn",
    nombre: "Otoño Profundo",
    descripcion: "Cálida y profunda: tonos oscuros, intensos y terrosos.",
    proto: { temperature: 0.5, value: -1, chroma: -0.3 },
    paleta: ["#5E2B1E", "#7A4A12", "#3F4A22", "#6B2D2D", "#4A3312", "#2F4038"],
  },
  "deep-winter": {
    id: "deep-winter",
    family: "winter",
    nombre: "Invierno Profundo",
    descripcion: "Fría y profunda: colores oscuros e intensos con contraste.",
    proto: { temperature: -0.5, value: -1, chroma: 0.3 },
    paleta: ["#1F2A44", "#4B1E3B", "#0E3B34", "#5A1F2E", "#2E2A55", "#111318"],
  },
  "true-winter": {
    id: "true-winter",
    family: "winter",
    nombre: "Invierno Frío",
    descripcion: "Fría y nítida: colores puros, fríos y con alto contraste.",
    proto: { temperature: -1, value: 0, chroma: 0.5 },
    paleta: ["#0057B8", "#C8102E", "#00A19A", "#5F259F", "#E5007E", "#111318"],
  },
  "bright-winter": {
    id: "bright-winter",
    family: "winter",
    nombre: "Invierno Brillante",
    descripcion: "Fría y muy nítida: colores eléctricos y saturados.",
    proto: { temperature: -0.5, value: 0.2, chroma: 1 },
    paleta: ["#0075FF", "#FF0059", "#00E0C7", "#7A00FF", "#FFE500", "#FF3D8B"],
  },
};

export interface SeasonAnalysis {
  season: Season;
  /** Ejes calculados a partir de la piel. */
  axes: SeasonAxes;
  /** Subtono legible derivado de la temperatura. */
  subtono: "cálido" | "frío" | "neutro";
  /** Confianza 0-1: cuán clara fue la clasificación frente a la 2ª opción. */
  confianza: number;
  /** Ranking completo por cercanía (la mejor primero). */
  ranking: { season: Season; distancia: number }[];
}

/**
 * Sitúa un color de piel en los tres ejes de colorimetría.
 * Heurísticas derivadas de HSL + balance de canales:
 *  - temperatura: la piel cálida tira a dorado (R alto vs B) y hue 30-55;
 *    la fría tira a rosado/azulado (B relativamente alto).
 *  - valor: luminosidad (L).
 *  - croma: saturación.
 */
export function skinToAxes(skin: RGB): SeasonAxes {
  const { h, s, l } = rgbToHsl(skin);

  // --- Temperatura ---
  // Balance rojo-azul normalizado a [-1, 1]: dominante para cálido/frío.
  const rb = (skin.r - skin.b) / 255; // ~0..1 en pieles reales
  // La piel cálida se centra en hue ~45°, la fría cae hacia 0-20 o >55 (rosados).
  const hueWarmth = 1 - Math.min(Math.abs(h - 45) / 45, 1); // 1 en 45°, 0 lejos
  // Mezcla ambos indicadores y expande al rango [-1, 1].
  const temperature = clampUnit((rb * 2.2 - 0.35) * 0.7 + (hueWarmth - 0.5) * 0.6);

  // --- Valor (claro/profundo) --- L típica de piel ~0.35..0.85.
  const value = clampUnit((l - 0.58) / 0.27);

  // --- Croma (brillante/apagado) --- S típica de piel ~0.15..0.6.
  const chroma = clampUnit((s - 0.38) / 0.28);

  return { temperature, value, chroma };
}

function clampUnit(v: number): number {
  return Math.min(1, Math.max(-1, v));
}

/** Distancia euclidiana ponderada en el espacio de ejes. */
function axesDistance(a: SeasonAxes, b: SeasonAxes): number {
  // La temperatura pesa más: es el eje que primero separa las familias.
  const dt = (a.temperature - b.temperature) * 1.3;
  const dv = a.value - b.value;
  const dc = a.chroma - b.chroma;
  return Math.sqrt(dt * dt + dv * dv + dc * dc);
}

/** Analiza un color de piel y devuelve la estación más probable + ranking. */
export function analyzeSeason(skin: RGB): SeasonAnalysis {
  const axes = skinToAxes(skin);

  const ranking = Object.values(SEASONS)
    .map((season) => ({ season, distancia: axesDistance(axes, season.proto) }))
    .sort((a, b) => a.distancia - b.distancia);

  const best = ranking[0];
  const second = ranking[1];

  // Confianza: separación relativa entre la 1ª y 2ª opción.
  const gap = second.distancia - best.distancia;
  const confianza = Math.min(1, gap / 0.6);

  const subtono =
    axes.temperature > 0.2 ? "cálido" : axes.temperature < -0.2 ? "frío" : "neutro";

  return { season: best.season, axes, subtono, confianza, ranking };
}
