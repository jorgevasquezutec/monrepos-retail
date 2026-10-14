/**
 * Catálogo de demostración. En producción esto vendría de tu backend de
 * retail; aquí es un conjunto pequeño para probar el recomendador end-to-end.
 * Cada prenda declara color, siluetas favorables y a qué SEXO va dirigida.
 */

import type { Fabric, SizeChart } from "./sizing.js";

export type Genero = "female" | "male" | "unisex";

export interface Garment {
  id: string;
  nombre: string;
  categoria: "top" | "bottom" | "dress" | "outerwear";
  /** Público de la prenda: mujer, hombre o unisex. */
  genero: Genero;
  /** Color principal en hex. */
  color: string;
  /** Etiquetas de silueta que casan con `ShapeInfo.favorece`. */
  siluetas: string[];
  precio: number;
  /** Tabla de medidas de la prenda terminada por talla (cm). Opcional. */
  tallas?: SizeChart;
  /** Tejido: define cuánta holgura negativa tolera (punto estira; plano no). */
  tejido?: Fabric;
  /** URL de la imagen/textura del producto (para el render). Opcional. */
  texturaUrl?: string;
  /** Asset de ropa REAL (carpeta en tools/assets/clothes/) para vestir el GLB
   *  en Blender. Si está, se usa malla real en vez del tubo procedural. */
  mhclo?: string;
}

export const DEMO_CATALOG: Garment[] = [
  // --- Mujer ---
  { id: "w-top-01", nombre: "Blusa manga abullonada", categoria: "top", genero: "female", color: "#F6A6B2", siluetas: ["manga-abullonada", "hombro-estructurado"], precio: 39.9 },
  { id: "w-top-02", nombre: "Body escote en V", categoria: "top", genero: "female", color: "#0057B8", siluetas: ["escote-en-v", "cintura-entallada"], precio: 29.9 },
  { id: "w-dress-01", nombre: "Vestido cruzado", categoria: "dress", genero: "female", color: "#C8102E", siluetas: ["vestido-cruzado", "cintura-entallada", "corte-a"], precio: 79.9 },
  { id: "w-dress-02", nombre: "Vestido línea imperio", categoria: "dress", genero: "female", color: "#CFE8DE", siluetas: ["linea-imperio", "tejido-fluido"], precio: 69.9 },
  { id: "w-dress-03", nombre: "Vestido corte A", categoria: "dress", genero: "female", color: "#B5651D", siluetas: ["corte-a", "cinturon"], precio: 74.5 },
  { id: "w-bottom-01", nombre: "Falda acampanada", categoria: "bottom", genero: "female", color: "#7A8B2E", siluetas: ["falda-acampanada", "corte-a"], precio: 54.0 },
  { id: "w-out-01", nombre: "Cárdigan peplum", categoria: "outerwear", genero: "female", color: "#A88BB5", siluetas: ["peplum", "cinturon", "punto"], precio: 64.0 },
  { id: "w-bottom-02", nombre: "Pantalón pierna ancha", categoria: "bottom", genero: "female", color: "#1F2A44", siluetas: ["pantalon-pierna-ancha", "color-claro-abajo"], precio: 59.9 },

  // --- Hombre ---
  { id: "m-top-01", nombre: "Camisa oxford", categoria: "top", genero: "male", color: "#1E3A5F", siluetas: ["hombro-estructurado", "capa-vertical", "camisa"], precio: 45.0 },
  {
    id: "m-top-02",
    nombre: "Polo piqué",
    categoria: "top",
    genero: "male",
    color: "#2E5E3A",
    siluetas: ["recto", "hombro-estructurado", "cuello-polo"],
    precio: 39.0,
    // Piqué de algodón: punto con poca elasticidad.
    tejido: { tipo: "punto", stretchPct: 4 },
    tallas: {
      S: { chest: 100, waist: 96, shoulder: 44, length: 70, sleeve: 21 },
      M: { chest: 106, waist: 102, shoulder: 46, length: 72, sleeve: 22 },
      L: { chest: 112, waist: 108, shoulder: 48, length: 74, sleeve: 23 },
      XL: { chest: 120, waist: 116, shoulder: 50, length: 76, sleeve: 24 },
      XXL: { chest: 128, waist: 124, shoulder: 52, length: 78, sleeve: 25 },
    },
  },
  {
    id: "m-top-03",
    nombre: "Camiseta cuello redondo",
    categoria: "top",
    genero: "male",
    color: "#3A3A3E",
    siluetas: ["recto", "cuello-redondo"],
    precio: 22.0,
    // Punto de algodón con algo de elastano → estira ~8 %.
    tejido: { tipo: "punto", stretchPct: 8 },
    // Prenda REAL (malla CC0 ajustada en Blender) en vez del tubo procedural.
    mhclo: "camiseta",
    tallas: {
      S: { chest: 96, waist: 92, shoulder: 44, length: 69, sleeve: 20 },
      M: { chest: 102, waist: 98, shoulder: 46, length: 71, sleeve: 21 },
      L: { chest: 108, waist: 104, shoulder: 48, length: 73, sleeve: 22 },
      XL: { chest: 116, waist: 112, shoulder: 50, length: 75, sleeve: 23 },
    },
  },
  {
    id: "m-bottom-01",
    nombre: "Pantalón chino",
    categoria: "bottom",
    genero: "male",
    color: "#C9B18A",
    siluetas: ["pantalon-recto", "recto"],
    precio: 55.0,
    // Sarga de algodón rígida → sin estiramiento útil.
    tejido: { tipo: "plano", stretchPct: 2 },
    // Pantalón REAL (malla CC-BY ajustada en Blender).
    mhclo: "pantalon",
    // Pantalón: tallas NUMÉRICAS (EU), no de letra.
    tallas: {
      "40": { waist: 80, hip: 98, thigh: 58, length: 100, inseam: 78 },
      "42": { waist: 84, hip: 104, thigh: 61, length: 102, inseam: 80 },
      "44": { waist: 88, hip: 110, thigh: 64, length: 104, inseam: 81 },
      "46": { waist: 92, hip: 116, thigh: 68, length: 106, inseam: 82 },
    },
  },
  { id: "m-bottom-02", nombre: "Vaquero slim", categoria: "bottom", genero: "male", color: "#2A3F5C", siluetas: ["pantalon-recto", "slim"], precio: 59.0 },
  { id: "m-out-01", nombre: "Blazer sport", categoria: "outerwear", genero: "male", color: "#23262B", siluetas: ["hombro-estructurado", "capa-vertical", "blazer"], precio: 110.0 },
  { id: "m-out-02", nombre: "Sudadera con capucha", categoria: "outerwear", genero: "male", color: "#5A5E63", siluetas: ["recto", "capa-vertical", "capucha"], precio: 49.0 },

  // --- Unisex ---
  { id: "u-out-01", nombre: "Chaqueta vaquera", categoria: "outerwear", genero: "unisex", color: "#4A6079", siluetas: ["hombro-estructurado", "recto"], precio: 69.0 },
  { id: "u-top-01", nombre: "Jersey de punto", categoria: "top", genero: "unisex", color: "#8E9AA3", siluetas: ["tejido-fluido", "capa-vertical", "punto"], precio: 45.0 },
];
