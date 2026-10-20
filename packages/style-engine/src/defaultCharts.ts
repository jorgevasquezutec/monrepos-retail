/**
 * Tablas de medidas POR DEFECTO por tipo de prenda — Fase 2 del probador por tallas.
 *
 * Contexto: una fábrica de tejido de punto (p. ej. el catálogo Shirley) suele
 * registrar STOCK por talla (XS/S/M/L/XL/O-S) pero NO la ficha técnica con las
 * medidas de prenda terminada. Sin esas medidas, el motor de ajuste
 * ({@link computeFit}) no puede opinar. Este módulo rellena ese hueco con tablas
 * ESTÁNDAR APROXIMADAS por tipo de prenda y tejido, para dar un veredicto
 * razonable mientras no exista la ficha real (que, si llega, siempre manda).
 *
 * Son medidas de PRENDA TERMINADA (cm), con la holgura de uso ya incorporada
 * (por eso un suéter de punto M declara ~104 cm de pecho, no 90). El grading
 * (salto entre tallas) ronda 5–6 cm de contorno, típico de punto.
 *
 * ⚠️ Aproximado por diseño. No sustituye a la ficha técnica del patronista.
 */

import type { Fabric, GarmentMeasures, SizeChart, SizeLabel } from "./sizing.js";

/** Tipos de prenda que sabemos graduar. Derivados de la descripción del catálogo. */
export type GarmentTipo =
  | "coat"
  | "cardigan"
  | "jacket"
  | "poncho"
  | "shawl"
  | "sweater"
  | "vest"
  | "dress"
  | "skirt"
  | "pants"
  | "top";

/** Etiqueta legible por tipo (ES), para UI. */
export const TIPO_LABEL: Record<GarmentTipo, string> = {
  coat: "Abrigo",
  cardigan: "Cárdigan",
  jacket: "Chaqueta",
  poncho: "Poncho",
  shawl: "Chal / Estola",
  sweater: "Suéter",
  vest: "Chaleco",
  dress: "Vestido",
  skirt: "Falda",
  pants: "Pantalón",
  top: "Top",
};

/** Tejido por defecto de la fábrica: punto con elasticidad media (~8%). */
export const FABRIC_PUNTO: Fabric = { tipo: "punto", stretchPct: 8 };

/** Tallas de letra que graduamos (O/S y OTRA se tratan aparte). */
const LETTER_SIZES: SizeLabel[] = ["XS", "S", "M", "L", "XL"];

/**
 * Receta por tipo: medidas base en talla M + salto por talla (grade). Solo se
 * declaran las zonas relevantes de cada prenda (un pantalón no lleva `chest`).
 * `base` = valor en M; `grade` = cuánto suma/resta por cada paso de talla.
 */
interface Receta {
  base: GarmentMeasures;
  grade: Partial<Record<keyof GarmentMeasures, number>>;
}

// Medidas de prenda terminada (cm) en talla M para mujer, tejido de punto.
const RECETAS: Record<GarmentTipo, Receta> = {
  coat:     { base: { chest: 112, waist: 108, hip: 116, shoulder: 42, length: 92, sleeve: 60 },
              grade: { chest: 6, waist: 6, hip: 6, shoulder: 1.2, length: 1.5, sleeve: 1.2 } },
  cardigan: { base: { chest: 106, waist: 102, hip: 110, shoulder: 40, length: 66, sleeve: 59 },
              grade: { chest: 6, waist: 6, hip: 6, shoulder: 1.2, length: 1.2, sleeve: 1.2 } },
  jacket:   { base: { chest: 110, waist: 104, hip: 112, shoulder: 41, length: 64, sleeve: 60 },
              grade: { chest: 6, waist: 6, hip: 6, shoulder: 1.2, length: 1.2, sleeve: 1.2 } },
  poncho:   { base: { chest: 140, length: 70 },
              grade: { chest: 0, length: 0 } }, // talla única de facto
  shawl:    { base: { length: 180 },
              grade: { length: 0 } }, // accesorio: el ajuste no aplica
  sweater:  { base: { chest: 104, waist: 100, hip: 106, shoulder: 39, length: 62, sleeve: 58 },
              grade: { chest: 6, waist: 6, hip: 6, shoulder: 1.2, length: 1.2, sleeve: 1.2 } },
  vest:     { base: { chest: 104, waist: 100, hip: 106, shoulder: 38, length: 60 },
              grade: { chest: 6, waist: 6, hip: 6, shoulder: 1.2, length: 1.2 } },
  dress:    { base: { chest: 100, waist: 88, hip: 104, shoulder: 38, length: 96, sleeve: 56 },
              grade: { chest: 5, waist: 5, hip: 5, shoulder: 1, length: 1.5, sleeve: 1.2 } },
  skirt:    { base: { waist: 74, hip: 100, length: 60 },
              grade: { waist: 5, hip: 5, length: 1 } },
  pants:    { base: { waist: 76, hip: 102, thigh: 60, length: 100, inseam: 76 },
              grade: { waist: 5, hip: 5, thigh: 2, length: 1, inseam: 1 } },
  top:      { base: { chest: 98, waist: 94, hip: 100, shoulder: 38, length: 60, sleeve: 56 },
              grade: { chest: 5, waist: 5, hip: 5, shoulder: 1, length: 1, sleeve: 1.2 } },
};

/** Redondeo a 0.5 cm, como una ficha técnica real. */
const r = (n: number) => Math.round(n * 2) / 2;

/** Construye las medidas de una talla concreta a partir de la receta. */
function measuresForStep(receta: Receta, step: number): GarmentMeasures {
  const m: GarmentMeasures = {};
  for (const k of Object.keys(receta.base) as (keyof GarmentMeasures)[]) {
    const base = receta.base[k]!;
    const g = receta.grade[k] ?? 0;
    m[k] = r(base + g * step);
  }
  return m;
}

/**
 * Tabla de tallas estándar para un tipo de prenda, SOLO para las tallas pedidas
 * (las que la fábrica tiene en stock). `O/S` y `OTRA` se mapean a una talla única
 * ancha (grade 0, en el punto M+1 para que "entre a casi todos"). Tallas
 * desconocidas se omiten.
 */
export function defaultSizeChart(
  tipo: GarmentTipo,
  sizes: SizeLabel[] = LETTER_SIZES,
): SizeChart {
  const receta = RECETAS[tipo];
  const chart: SizeChart = {};
  for (const s of sizes) {
    const up = s.toUpperCase();
    const idx = LETTER_SIZES.indexOf(up);
    if (idx >= 0) {
      chart[up] = measuresForStep(receta, idx - 2); // M = paso 0
    } else if (up === "O/S" || up === "OS" || up === "O-S" || up === "U" || up === "ÚNICA") {
      // Talla única: una M generosa (+1 paso) para representar "le entra a casi todo".
      chart[up] = measuresForStep(receta, 1);
    }
    // "OTRA" / desconocidas: sin medidas (se omiten del ajuste).
  }
  return chart;
}

/** ¿Este tipo de prenda tiene ajuste significativo? (un chal no). */
export function tieneAjuste(tipo: GarmentTipo): boolean {
  return tipo !== "shawl" && tipo !== "poncho";
}
