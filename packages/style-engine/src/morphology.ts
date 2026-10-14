/**
 * Clasificación de morfología corporal a partir de medidas (cm) y
 * recomendaciones de silueta asociadas. Reglas deterministas y explicables.
 */

export type BodyShape =
  | "hourglass" // reloj de arena
  | "pear" // pera / triángulo
  | "apple" // manzana / óvalo
  | "rectangle" // rectángulo
  | "inverted-triangle"; // triángulo invertido

export interface Measurements {
  /** Contorno de busto/pecho (cm). */
  bust: number;
  /** Contorno de cintura (cm). */
  waist: number;
  /** Contorno de cadera (cm). */
  hip: number;
  /** Opcional: contorno de hombros; si falta se aproxima con el busto. */
  shoulder?: number;
}

export interface ShapeInfo {
  shape: BodyShape;
  nombre: string;
  descripcion: string;
  /** Objetivo estilístico general para esta figura. */
  objetivo: string;
  /** Siluetas/prendas que favorecen (etiquetas usadas por el recomendador). */
  favorece: string[];
  /** Siluetas a usar con cautela. */
  evitar: string[];
}

const SHAPE_INFO: Record<BodyShape, Omit<ShapeInfo, "shape">> = {
  hourglass: {
    nombre: "Reloj de arena",
    descripcion: "Busto y cadera equilibrados con cintura marcada.",
    objetivo: "Mantener el equilibrio natural y resaltar la cintura.",
    favorece: ["cintura-entallada", "vestido-cruzado", "cinturon", "corte-a"],
    evitar: ["oversize", "recto-holgado"],
  },
  pear: {
    nombre: "Pera (triángulo)",
    descripcion: "Cadera más ancha que los hombros/busto.",
    objetivo: "Equilibrar la parte inferior aportando volumen arriba.",
    favorece: ["hombro-estructurado", "escote-barco", "manga-abullonada", "color-claro-arriba", "pantalon-recto"],
    evitar: ["pantalon-pitillo-claro", "bolsillos-cadera"],
  },
  apple: {
    nombre: "Manzana (óvalo)",
    descripcion: "Volumen concentrado en el medio, cintura poco definida.",
    objetivo: "Alargar el torso y crear una línea vertical fluida.",
    favorece: ["linea-imperio", "escote-en-v", "capa-vertical", "tejido-fluido", "corte-a"],
    evitar: ["cinturon-ancho", "ajustado-medio"],
  },
  rectangle: {
    nombre: "Rectángulo",
    descripcion: "Busto, cintura y cadera de anchura similar.",
    objetivo: "Crear curvas e insinuar una cintura.",
    favorece: ["peplum", "cinturon", "capas", "volumen-cadera", "corte-a"],
    evitar: ["recto-holgado"],
  },
  "inverted-triangle": {
    nombre: "Triángulo invertido",
    descripcion: "Hombros/busto más anchos que la cadera.",
    objetivo: "Equilibrar aportando volumen en la parte inferior.",
    favorece: ["pantalon-pierna-ancha", "falda-acampanada", "escote-en-v", "color-claro-abajo"],
    evitar: ["hombro-estructurado", "manga-abullonada", "escote-barco"],
  },
};

/**
 * Clasifica la figura a partir de las medidas.
 *
 * Umbrales (proporción, no valores absolutos, para que sea independiente de la talla):
 *  - Diferencia significativa busto/cadera: > 5% => desequilibrio arriba/abajo.
 *  - Cintura marcada: cintura <= 75% del mayor entre busto y cadera.
 */
export function classifyBody(m: Measurements): ShapeInfo {
  const shoulder = m.shoulder ?? m.bust;
  const top = Math.max(m.bust, shoulder);
  const { waist, hip } = m;

  const balanceRef = Math.max(top, hip);
  const waistRatio = waist / balanceRef; // más bajo = cintura más marcada
  const definedWaist = waistRatio <= 0.75;

  const topVsHip = (top - hip) / balanceRef; // >0 => arriba más ancho

  let shape: BodyShape;

  if (waist >= top && waist >= hip) {
    // La cintura es la medida mayor: volumen central.
    shape = "apple";
  } else if (topVsHip > 0.05) {
    shape = "inverted-triangle";
  } else if (topVsHip < -0.05) {
    // Cadera claramente más ancha; con cintura marcada sigue siendo pera.
    shape = "pear";
  } else if (definedWaist) {
    // Arriba y abajo equilibrados + cintura marcada.
    shape = "hourglass";
  } else {
    shape = "rectangle";
  }

  return { shape, ...SHAPE_INFO[shape] };
}

/** Nombre de la figura con vocabulario acorde al sexo (pera/reloj de arena son términos femeninos). */
const MALE_SHAPE_LABEL: Record<BodyShape, string> = {
  hourglass: "proporción equilibrada",
  pear: "tronco estrecho y cadera ancha",
  apple: "torso ancho",
  rectangle: "complexión recta",
  "inverted-triangle": "torso en V",
};

export function shapeLabel(info: ShapeInfo, genero?: "female" | "male"): string {
  return genero === "male" ? MALE_SHAPE_LABEL[info.shape] : info.nombre;
}
