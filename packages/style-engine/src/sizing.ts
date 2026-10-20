/**
 * Tallaje y ajuste — Fase 1 del probador por tallas.
 *
 * Modelo de datos + matemática de AJUSTE, pura y determinista. La idea central:
 * una prenda NO es su foto, es su TABLA DE MEDIDAS por talla (prenda terminada,
 * en cm). Dado un cuerpo (medidas de la persona) y una talla (medidas de la
 * prenda), la holgura por zona (`garment − body`) dice cómo queda: aprieta,
 * entallada, regular, holgada u oversize. El tejido (punto/plano) modula cuánta
 * holgura NEGATIVA se tolera (un punto elástico estira; un plano rígido no).
 *
 * Sin navegador ni 3D: esta capa la consume tanto el render (Fase 2) como el
 * recomendador de talla y los tests.
 */

import type { Measurements } from "./morphology.js";

/**
 * Etiqueta de talla: de letra ("S", "M", "L"…) o NUMÉRICA ("38", "40"…), según
 * la prenda (los pantalones/vaqueros suelen ir por número). Es un `string` libre.
 */
export type SizeLabel = string;

/** Orden canónico de las tallas de LETRA (para chips y ordenación). */
export const SIZE_ORDER: SizeLabel[] = ["XXS", "XS", "S", "M", "L", "XL", "XXL", "XXXL"];

/**
 * Etiquetas de TALLA ÚNICA (one size) normalizadas a "O/S". Muchas fábricas de
 * punto (chales, ponchos, accesorios) venden casi todo en talla única.
 */
export const ONE_SIZE = "O/S";
const ONE_SIZE_ALIASES = new Set(["O/S", "OS", "O-S", "OSFA", "U", "ÚNICA", "UNICA", "T.U", "TU"]);

/** ¿Es una etiqueta de talla única? (normaliza variantes a O/S). */
export function isOneSize(s: string): boolean {
  return ONE_SIZE_ALIASES.has(s.trim().toUpperCase());
}

/** Rango para ordenar: numéricas por su valor; de letra por su posición; única al final. */
function sizeRank(s: SizeLabel): number {
  const n = Number(s);
  if (Number.isFinite(n)) return n; // "38" → 38
  if (isOneSize(s)) return 900; // talla única, antes de "desconocida"
  const i = SIZE_ORDER.indexOf(s);
  return i >= 0 ? i : 999;
}

/** Ordena una lista de tallas (numéricas ascendentes; de letra en su orden). */
export function sortSizes(labels: SizeLabel[]): SizeLabel[] {
  return [...labels].sort((a, b) => sizeRank(a) - sizeRank(b));
}

/**
 * Medidas de la PRENDA TERMINADA (cm). Los contornos (chest/waist/hip/thigh)
 * son circunferencias de la prenda, no del cuerpo. Todas opcionales: una
 * camiseta no declara `inseam`, un pantalón no declara `sleeve`.
 */
export interface GarmentMeasures {
  /** Contorno de pecho de la prenda (cm). */
  chest?: number;
  /** Contorno de cintura de la prenda (cm). */
  waist?: number;
  /** Contorno de cadera de la prenda (cm). */
  hip?: number;
  /** Contorno de muslo de la prenda (cm). */
  thigh?: number;
  /** Ancho de hombros de la prenda (cm). */
  shoulder?: number;
  /** Largo total: hombro→bajo (top/vestido) o cintura→bajo (pantalón), cm. */
  length?: number;
  /** Largo de manga (cm). */
  sleeve?: number;
  /** Entrepierna / tiro interior del pantalón (cm). */
  inseam?: number;
}

/** Tabla de tallas: cada talla declarada → sus medidas de prenda terminada. */
export type SizeChart = Partial<Record<SizeLabel, GarmentMeasures>>;

/** Tejido: `punto` estira (elástico); `plano` es rígido (woven). */
export type FabricType = "punto" | "plano";

export interface Fabric {
  tipo: FabricType;
  /** % de elasticidad utilizable del tejido (0 = rígido; ~20 = muy elástico). */
  stretchPct: number;
}

/** Tejido plano rígido por defecto (sin estirar). */
export const FABRIC_PLANO: Fabric = { tipo: "plano", stretchPct: 0 };

// --------------------------------------------------------------------------
// Ajuste por zona
// --------------------------------------------------------------------------

export type FitState =
  | "no-entra"
  | "muy-ajustada"
  | "ajustada"
  | "regular"
  | "holgada"
  | "oversize";

export interface ZoneFit {
  /** Clave de la medida de prenda comparada. */
  zone: keyof GarmentMeasures;
  /** Etiqueta legible (Pecho, Cintura…). */
  label: string;
  garmentCm: number;
  bodyCm: number;
  /** Holgura = prenda − cuerpo (cm). Negativa = la prenda aprieta. */
  easeCm: number;
  /** Holgura relativa al cuerpo (%). */
  easePct: number;
  state: FitState;
}

export interface GarmentFit {
  size: SizeLabel;
  zones: ZoneFit[];
  /** Peor estado entre las zonas (el que decide si "te vale"). */
  worst: FitState;
  /** false si alguna zona no entra (aprieta más allá del estiramiento). */
  fits: boolean;
  /** 0..1 — 1 = ajuste ideal en todas las zonas (manda la peor zona). */
  score: number;
}

/** Zonas de prenda ↔ medidas del cuerpo. Solo se evalúan las presentes en ambos. */
const ZONE_MAP: { zone: keyof GarmentMeasures; body: keyof Measurements; label: string }[] = [
  { zone: "chest", body: "bust", label: "Pecho" },
  { zone: "shoulder", body: "shoulder", label: "Hombros" },
  { zone: "waist", body: "waist", label: "Cintura" },
  { zone: "hip", body: "hip", label: "Cadera" },
];

/** Holgura ideal (%) — un poco de aire sobre el cuerpo se siente "bien". */
const IDEAL_EASE_PCT = 8;

/**
 * Estado de ajuste de UNA zona: compara la circunferencia de la prenda con la
 * del cuerpo, teniendo en cuenta el estiramiento del tejido. Exportada para que
 * el render 3D pueda colorear la prenda por altura con el mismo criterio.
 */
export function fitStateFor(bodyCm: number, garmentCm: number, stretchPct: number): FitState {
  // Con el tejido estirado al máximo, ¿entra el cuerpo?
  const maxBody = garmentCm * (1 + stretchPct / 100);
  if (bodyCm > maxBody) return "no-entra";

  const easePct = ((garmentCm - bodyCm) / bodyCm) * 100;
  // El tejido elástico convierte parte de la holgura negativa en "ajustada".
  if (easePct < -stretchPct * 0.5) return "muy-ajustada";
  if (easePct < 3) return "ajustada";
  if (easePct < 12) return "regular";
  if (easePct < 28) return "holgada";
  return "oversize";
}

const zoneState = fitStateFor;

/** Puntuación 0..1 de una zona: campana alrededor de la holgura ideal. */
function zoneScore(bodyCm: number, garmentCm: number, stretchPct: number): number {
  if (bodyCm > garmentCm * (1 + stretchPct / 100)) return 0; // no entra
  const easePct = ((garmentCm - bodyCm) / bodyCm) * 100;
  const d = easePct - IDEAL_EASE_PCT;
  return Math.exp(-(d * d) / (2 * 14 * 14)); // σ≈14% de holgura
}

const WORSE_ORDER: FitState[] = [
  "regular",
  "ajustada",
  "holgada",
  "muy-ajustada",
  "oversize",
  "no-entra",
];

/**
 * Calcula el ajuste de una talla concreta sobre un cuerpo. Solo evalúa las
 * zonas presentes tanto en la prenda como en el cuerpo (así un pantalón ignora
 * el pecho y una camiseta ignora la cadera si no la declara).
 */
export function computeFit(
  body: Measurements,
  measures: GarmentMeasures,
  fabric: Fabric,
  size: SizeLabel,
): GarmentFit {
  const zones: ZoneFit[] = [];
  for (const { zone, body: bkey, label } of ZONE_MAP) {
    const garmentCm = measures[zone];
    const bodyCm = body[bkey];
    if (garmentCm == null || bodyCm == null) continue;
    const easeCm = garmentCm - bodyCm;
    zones.push({
      zone,
      label,
      garmentCm,
      bodyCm,
      easeCm: Math.round(easeCm * 10) / 10,
      easePct: Math.round((easeCm / bodyCm) * 1000) / 10,
      state: zoneState(bodyCm, garmentCm, fabric.stretchPct),
    });
  }

  const fits = zones.every((z) => z.state !== "no-entra");
  const scores = zones.map((z) => zoneScore(z.bodyCm, z.garmentCm, fabric.stretchPct));
  const score = scores.length ? Math.min(...scores) : 0; // manda la peor zona
  const worst = zones.reduce<FitState>(
    (acc, z) => (WORSE_ORDER.indexOf(z.state) > WORSE_ORDER.indexOf(acc) ? z.state : acc),
    "regular",
  );

  return { size, zones, worst, fits, score: Math.round(score * 100) / 100 };
}

export interface SizeRecommendation {
  /** Mejor talla, o null si el cuerpo no entra en ninguna talla declarada. */
  best: SizeLabel | null;
  /** Ajuste de cada talla, ordenadas de menor a mayor. */
  all: GarmentFit[];
  /** Texto listo para mostrar (p. ej. "Tu talla: M · L te quedará holgada"). */
  nota: string;
}

/**
 * Recomienda la mejor talla para un cuerpo, evaluando toda la tabla. Prefiere la
 * de mayor puntuación (holgura cercana a la ideal); descarta las que no entran.
 */
export function recommendSize(
  body: Measurements,
  chart: SizeChart,
  fabric: Fabric = FABRIC_PLANO,
): SizeRecommendation {
  const all: GarmentFit[] = sortSizes(Object.keys(chart)).map((s) =>
    computeFit(body, chart[s]!, fabric, s),
  );

  const wearable = all.filter((f) => f.fits);
  let best: SizeLabel | null = null;
  if (wearable.length) {
    best = wearable.reduce((a, b) => (b.score > a.score ? b : a)).size;
  }

  let nota: string;
  if (!all.length) nota = "Esta prenda no tiene tabla de tallas cargada.";
  else if (!best) nota = "Ninguna talla disponible te entra según tus medidas.";
  else {
    const bf = all.find((f) => f.size === best)!;
    nota = `Tu talla: ${best} (${bf.worst}).`;
  }

  return { best, all, nota };
}

// --------------------------------------------------------------------------
// Ingesta manual / CSV
// --------------------------------------------------------------------------

const CSV_KEYS: (keyof GarmentMeasures)[] = [
  "chest",
  "waist",
  "hip",
  "thigh",
  "shoulder",
  "length",
  "sleeve",
  "inseam",
];

/**
 * Alias de cabecera → clave canónica. Acepta español (pecho, cintura…), inglés
 * y variantes comunes de ficha técnica, sin acentos ni mayúsculas. Así una
 * fábrica puede pegar su tabla tal cual ("talla,pecho,cintura,cadera,largo").
 */
const HEADER_ALIASES: Record<string, keyof GarmentMeasures> = {
  // pecho / busto
  chest: "chest", pecho: "chest", busto: "chest", bust: "chest", "1/2 pecho": "chest",
  // cintura
  waist: "waist", cintura: "waist",
  // cadera
  hip: "hip", cadera: "hip", hips: "hip",
  // muslo
  thigh: "thigh", muslo: "thigh", pierna: "thigh",
  // hombro(s)
  shoulder: "shoulder", hombro: "shoulder", hombros: "shoulder",
  // largo
  length: "length", largo: "length", alto: "length", longitud: "length",
  // manga
  sleeve: "sleeve", manga: "sleeve", mangas: "sleeve",
  // entrepierna / tiro interior
  inseam: "inseam", entrepierna: "inseam", "entre pierna": "inseam", tiro: "inseam",
};

/** Normaliza una cabecera: sin acentos, minúsculas, espacios colapsados. */
function normHeader(h: string): string {
  return h
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/** Etiqueta de talla aliases → también acepta "talla", "size", "tla". */
const TALLA_HEADERS = new Set(["talla", "size", "tla", "tallas"]);

export interface SizeChartParse {
  chart: SizeChart;
  errors: string[];
}

/**
 * Parsea una tabla de tallas en CSV. Primera fila = cabecera; debe incluir
 * `talla` y una o más columnas de medida (chest, waist, hip, length, sleeve,
 * thigh, inseam, shoulder). Celdas vacías → medida ausente. Robusto a espacios,
 * mayúsculas y columnas desconocidas (se ignoran). Devuelve la tabla y los
 * errores encontrados (para avisar al usuario sin abortar).
 *
 * Ejemplo:
 *   talla,chest,waist,hip,length
 *   S,96,84,98,70
 *   M,102,90,104,72
 */
export function parseSizeChartCSV(csv: string): SizeChartParse {
  const errors: string[] = [];
  const chart: SizeChart = {};
  const rows = csv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (rows.length < 2) {
    return { chart, errors: ["El CSV necesita una cabecera y al menos una talla."] };
  }

  const header = rows[0].split(",").map(normHeader);
  // Resuelve cada columna a su clave canónica (o null si no es una medida).
  const colKey: (keyof GarmentMeasures | null)[] = header.map((h) => HEADER_ALIASES[h] ?? null);
  const tallaIdx = header.findIndex((h) => TALLA_HEADERS.has(h));
  if (tallaIdx === -1) {
    return { chart, errors: ["Falta la columna 'talla' en la cabecera."] };
  }

  const validLetters = new Set<string>(SIZE_ORDER);
  const isValidTalla = (s: string) =>
    validLetters.has(s) || /^\d{1,3}$/.test(s) || isOneSize(s);

  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i].split(",").map((c) => c.trim());
    const rawTalla = (cells[tallaIdx] ?? "").toUpperCase();
    if (!isValidTalla(rawTalla)) {
      errors.push(`Fila ${i + 1}: talla desconocida "${cells[tallaIdx] ?? ""}" (se omite).`);
      continue;
    }
    // Normaliza cualquier variante de talla única a "O/S".
    const size = (isOneSize(rawTalla) ? ONE_SIZE : rawTalla) as SizeLabel;
    const measures: GarmentMeasures = {};
    for (let c = 0; c < header.length; c++) {
      const key = colKey[c];
      if (c === tallaIdx || key == null) continue; // columnas desconocidas (p.ej. tolerancia) se ignoran
      const raw = cells[c];
      if (raw == null || raw === "") continue;
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) {
        errors.push(`Fila ${i + 1}, ${key}: valor no válido "${raw}" (se omite).`);
        continue;
      }
      measures[key] = n;
    }
    if (Object.keys(measures).length === 0) {
      errors.push(`Fila ${i + 1} (${size}): sin ninguna medida válida (se omite).`);
      continue;
    }
    chart[size] = measures;
  }

  return { chart, errors };
}

/** Serializa una tabla a CSV (para exportar / editar a mano). */
export function sizeChartToCSV(chart: SizeChart): string {
  const sizes = sortSizes(Object.keys(chart));
  const used = CSV_KEYS.filter((k) => sizes.some((s) => chart[s]?.[k] != null));
  const header = ["talla", ...used].join(",");
  const lines = sizes.map((s) => {
    const m = chart[s]!;
    return [s, ...used.map((k) => (m[k] != null ? String(m[k]) : ""))].join(",");
  });
  return [header, ...lines].join("\n");
}
