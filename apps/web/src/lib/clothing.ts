import { sortSizes, type GarmentMeasures, type SizeChart, type SizeLabel } from "@retail/style-engine";

/**
 * Asset de ropa REAL por categoría (fallback si la prenda no define `mhclo`).
 * Así TODAS las prendas del catálogo se visten con malla real (coloreada con su
 * color), aunque solo tengamos unos pocos assets. Categorías sin asset → tubo.
 */
const CATEGORY_ASSET: Record<string, string> = {
  top: "camiseta",
  outerwear: "chaqueta",
  bottom: "pantalon",
  dress: "vestido",
};

export function assetForGarment(g: {
  mhclo?: string;
  categoria: string;
  siluetas?: string[];
}): string | undefined {
  if (g.mhclo) return g.mhclo;
  // Faldas (cualquier etiqueta "falda*") → su propia malla en vez del pantalón.
  if (g.categoria === "bottom" && g.siluetas?.some((s) => s.startsWith("falda"))) return "falda";
  if (g.categoria === "outerwear") {
    // Prenda de abrigo: el tipo sale de las etiquetas del catálogo.
    const tags = g.siluetas ?? [];
    const has = (t: string) => tags.some((s) => s.includes(t));
    if (has("capucha")) return "sudadera";
    if (has("blazer")) return "blazer";
    if (has("punto")) return "cardigan";
    return "chaqueta";
  }
  return CATEGORY_ASSET[g.categoria];
}

/**
 * Escala de contorno de la prenda para una talla, **derivada de las medidas
 * reales** de la tabla (contorno de la talla ÷ contorno de la talla media). Así
 * funciona igual con tallas de letra (S/M/L) o numéricas (38/40/42). La usa
 * Blender para escalar la malla. 1.0 = talla media.
 */
export function sizeScale(
  chart: SizeChart | undefined,
  size: SizeLabel | undefined,
  categoria: string,
): number {
  if (!chart || !size) return 1.0;
  const sizes = sortSizes(Object.keys(chart));
  if (sizes.length < 2) return 1.0;
  const ref = sizes[Math.floor((sizes.length - 1) / 2)]; // talla media = referencia
  const key: keyof GarmentMeasures = categoria === "bottom" ? "waist" : "chest";
  const val = chart[size]?.[key] ?? chart[size]?.waist ?? chart[size]?.chest;
  const refVal = chart[ref]?.[key] ?? chart[ref]?.waist ?? chart[ref]?.chest;
  if (!val || !refVal) return 1.0;
  return val / refVal;
}
