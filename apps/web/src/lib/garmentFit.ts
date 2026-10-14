/**
 * Ajuste de prendas al cuerpo humano real (GLB de MakeHuman).
 *
 * En vez de un tubo genérico, se MUESTREA la superficie real del cuerpo en el
 * rango de alturas de la prenda (excluyendo los brazos) para obtener el perfil
 * elíptico real a cada altura (incluida la barriga). La prenda se construye
 * siguiendo ese perfil, ligeramente por fuera → se adapta a las curvas.
 *
 * Nota: sigue siendo una capa tintada sin pliegues de tela (el render realista
 * de tela está en desarrollo). Pero ahora se AJUSTA al cuerpo.
 */

import * as THREE from "three";
import {
  fitStateFor,
  type Fabric,
  type FitState,
  type GarmentMeasures,
  type Measurements,
} from "@retail/style-engine";

const TAU = Math.PI * 2;
const SEGMENTS = 48;
const cmToRadius = (cm: number) => cm / TAU / 100;

interface Ring {
  y: number;
  rx: number;
  rz: number;
}

/** Muestrea el perfil (rx, rz) del torso a cada altura, excluyendo los brazos. */
function sampleTorsoProfile(
  bodyObj: THREE.Object3D,
  yFrom: number,
  yTo: number,
  levels = 18,
  bandFrac = 0.18,
): Ring[] {
  const bbox = new THREE.Box3().setFromObject(bodyObj);
  const cx = (bbox.min.x + bbox.max.x) / 2;
  const cz = (bbox.min.z + bbox.max.z) / 2;
  const H = bbox.max.y - bbox.min.y;
  // Semiancho del torso: banda estrecha => excluye deltoides/brazos (clave para
  // que el top no salga como un barril alrededor de los brazos).
  const band = bandFrac * H;

  const rx = new Array(levels).fill(0);
  const rz = new Array(levels).fill(0);
  const v = new THREE.Vector3();
  bodyObj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      mesh.localToWorld(v);
      if (v.y < yFrom || v.y > yTo) continue;
      const dx = v.x - cx;
      const dz = v.z - cz;
      if (Math.abs(dx) > band) continue; // brazo → fuera
      const li = Math.min(levels - 1, Math.max(0, Math.floor(((v.y - yFrom) / (yTo - yFrom)) * levels)));
      if (Math.abs(dx) > rx[li]) rx[li] = Math.abs(dx);
      if (Math.abs(dz) > rz[li]) rz[li] = Math.abs(dz);
    }
  });

  // rellena huecos (niveles sin muestras) con el vecino más cercano
  for (let i = 0; i < levels; i++) {
    if (rx[i] === 0) {
      for (let d = 1; d < levels; d++) {
        if (i - d >= 0 && rx[i - d] > 0) { rx[i] = rx[i - d]; rz[i] = rz[i - d]; break; }
        if (i + d < levels && rx[i + d] > 0) { rx[i] = rx[i + d]; rz[i] = rz[i + d]; break; }
      }
    }
  }

  const rings: Ring[] = [];
  for (let i = 0; i < levels; i++) {
    rings.push({
      y: yFrom + ((yTo - yFrom) * (i + 0.5)) / levels,
      rx: rx[i] || 0.12,
      rz: rz[i] || 0.1,
    });
  }
  return rings;
}

/** Superficie lofteada elíptica que sigue el perfil, algo por fuera (offset). */
function loftEllipse(rings: Ring[], offset = 1.05): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  // Los anillos se generan centrados en el origen; el llamador posiciona la
  // malla en el centro (cx, cz) del cuerpo.
  for (let i = 0; i < rings.length; i++) {
    const r = rings[i];
    for (let j = 0; j <= SEGMENTS; j++) {
      const a = (j / SEGMENTS) * TAU;
      pos.push(Math.cos(a) * r.rx * offset, r.y, Math.sin(a) * r.rz * offset);
      uv.push(j / SEGMENTS, i / Math.max(1, rings.length - 1));
    }
  }
  const cols = SEGMENTS + 1;
  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < SEGMENTS; j++) {
      const a = i * cols + j;
      const b = a + cols;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

interface LegRing {
  y: number;
  cx: number;
  cz: number;
  rx: number;
  rz: number;
}

/**
 * Muestrea UNA pierna (lado dado) del cuerpo real: para cada altura obtiene el
 * CENTRO (cx, cz) y el radio (rx, rz) de la pierna. Así la pernera sigue la
 * pierna aunque esté inclinada o adelantada, en vez de un cilindro recto que
 * flota. side = -1 (x<centro) izquierda, +1 derecha.
 */
function sampleLegProfile(
  bodyObj: THREE.Object3D,
  side: number,
  yFrom: number,
  yTo: number,
  levels = 16,
): LegRing[] {
  const bbox = new THREE.Box3().setFromObject(bodyObj);
  const cx0 = (bbox.min.x + bbox.max.x) / 2;
  const cz0 = (bbox.min.z + bbox.max.z) / 2;
  const H = bbox.max.y - bbox.min.y;
  const reach = 0.22 * H; // descarta el otro lado y manos/brazos lejanos
  const minX = new Array(levels).fill(Infinity);
  const maxX = new Array(levels).fill(-Infinity);
  const minZ = new Array(levels).fill(Infinity);
  const maxZ = new Array(levels).fill(-Infinity);
  const v = new THREE.Vector3();
  bodyObj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      mesh.localToWorld(v);
      if (v.y < yFrom || v.y > yTo) continue;
      const dx = v.x - cx0;
      if (Math.sign(dx) !== side) continue; // pierna del otro lado
      if (Math.abs(dx) > reach) continue; // demasiado lejos (mano/brazo)
      const li = Math.min(
        levels - 1,
        Math.max(0, Math.floor(((v.y - yFrom) / (yTo - yFrom)) * levels)),
      );
      if (v.x < minX[li]) minX[li] = v.x;
      if (v.x > maxX[li]) maxX[li] = v.x;
      if (v.z < minZ[li]) minZ[li] = v.z;
      if (v.z > maxZ[li]) maxZ[li] = v.z;
    }
  });

  const rings: LegRing[] = [];
  for (let i = 0; i < levels; i++) {
    if (maxX[i] === -Infinity) continue;
    rings.push({
      y: yFrom + ((yTo - yFrom) * (i + 0.5)) / levels,
      cx: (minX[i] + maxX[i]) / 2,
      cz: (minZ[i] + maxZ[i]) / 2,
      rx: Math.max(0.03, (maxX[i] - minX[i]) / 2),
      rz: Math.max(0.03, (maxZ[i] - minZ[i]) / 2),
    });
  }
  if (rings.length < 2) {
    // Fallback: cilindro razonable si el muestreo no encontró la pierna.
    return [
      { y: yFrom, cx: cx0 + side * 0.1, cz: cz0, rx: 0.08, rz: 0.07 },
      { y: yTo, cx: cx0 + side * 0.12, cz: cz0, rx: 0.09, rz: 0.08 },
    ];
  }
  return rings;
}

/** Loft de una pernera con centro (cx, cz) propio en cada anillo (coord. mundo). */
function loftLegRings(rings: LegRing[], offset = 1.08): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < rings.length; i++) {
    const r = rings[i];
    for (let j = 0; j <= SEGMENTS; j++) {
      const a = (j / SEGMENTS) * TAU;
      pos.push(r.cx + Math.cos(a) * r.rx * offset, r.y, r.cz + Math.sin(a) * r.rz * offset);
      uv.push(j / SEGMENTS, i / Math.max(1, rings.length - 1));
    }
  }
  const cols = SEGMENTS + 1;
  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < SEGMENTS; j++) {
      const a = i * cols + j;
      const b = a + cols;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Caché de texturas por URL/dataURL (evita recargar la misma imagen al re-vestir).
const textureCache = new Map<string, THREE.Texture>();
const texLoader = new THREE.TextureLoader();

/** Carga (y cachea) la textura de la prenda, tileada como tela. */
function garmentTexture(url: string): THREE.Texture {
  const cached = textureCache.get(url);
  if (cached) return cached;
  const tex = texLoader.load(url);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 3); // tejido: la imagen se repite como patrón de tela
  tex.anisotropy = 4;
  textureCache.set(url, tex);
  return tex;
}

function fabric(colorHex: string, texturaUrl?: string): THREE.MeshStandardMaterial {
  const map = texturaUrl ? garmentTexture(texturaUrl) : null;
  return new THREE.MeshStandardMaterial({
    // Con textura, el color base es blanco para no teñir la imagen.
    color: map ? new THREE.Color(1, 1, 1) : new THREE.Color(colorHex),
    map,
    roughness: 0.72,
    metalness: 0,
    envMapIntensity: 0.45,
    side: THREE.DoubleSide,
  });
}

/**
 * Construye la prenda AJUSTADA a la superficie real del cuerpo.
 */
export function buildGarmentForBody(
  bodyObj: THREE.Object3D,
  m: Measurements,
  bodyBottom: number,
  bodyTop: number,
  categoria: string,
  colorHex: string,
  texturaUrl?: string,
): THREE.Object3D {
  const H = bodyTop - bodyBottom;
  const yAt = (f: number) => bodyBottom + f * H;
  const mat = fabric(colorHex, texturaUrl);
  const g = new THREE.Group();

  // centro para posicionar la geometría (los anillos se generan centrados)
  const bbox = new THREE.Box3().setFromObject(bodyObj);
  const cx = (bbox.min.x + bbox.max.x) / 2;
  const cz = (bbox.min.z + bbox.max.z) / 2;

  const addFollowing = (fromFrac: number, toFrac: number, offset: number, bandFrac = 0.18) => {
    const rings = sampleTorsoProfile(bodyObj, yAt(fromFrac), yAt(toFrac), 18, bandFrac);
    const mesh = new THREE.Mesh(loftEllipse(rings, offset), mat);
    mesh.position.set(cx, 0, cz);
    g.add(mesh);
    return rings;
  };

  // Pantalón/pierna que sigue la pierna real (usado por bottom y dress opcional).
  const addFollowingLegs = (fromFrac: number, toFrac: number, offset: number) => {
    for (const side of [-1, 1]) {
      const rings = sampleLegProfile(bodyObj, side, yAt(fromFrac), yAt(toFrac));
      g.add(new THREE.Mesh(loftLegRings(rings, offset), mat));
    }
  };

  if (categoria === "dress") {
    const rings = addFollowing(0.48, 0.8, 1.05, 0.17); // cuerpo ajustado busto→cadera
    const hipRing = rings[0];
    const skirt = new THREE.Mesh(
      new THREE.CylinderGeometry(hipRing.rx * 1.15, hipRing.rx * 1.55, H * 0.24, 48, 1, true),
      mat,
    );
    skirt.position.set(cx, yAt(0.48) - H * 0.12, cz);
    skirt.scale.z = (hipRing.rz / hipRing.rx) * 1.1;
    g.add(skirt);
  } else if (categoria === "bottom") {
    // Banda cintura->cadera desde las medidas (evita coger las manos al muestrear)
    const rHip = cmToRadius(m.hip);
    const rWaist = cmToRadius(m.waist);
    const band = new THREE.Mesh(
      loftEllipse(
        [
          { y: yAt(0.62), rx: rWaist * 1.06, rz: rWaist * 0.78 },
          { y: yAt(0.46), rx: rHip * 1.06, rz: rHip * 0.8 },
        ],
        1,
      ),
      mat,
    );
    band.position.set(cx, 0, cz);
    g.add(band);
    // Perneras que SIGUEN la pierna real (centro + grosor por altura).
    addFollowingLegs(0.03, 0.47, 1.08);
  } else if (categoria === "outerwear") {
    addFollowing(0.48, 0.82, 1.12, 0.19); // abrigo algo más holgado
  } else {
    // Top tipo camiseta: torso ajustado hombro->cadera + mangas cortas.
    // Banda estrecha (0.15) para NO envolver los brazos (nada de barril).
    const rings = addFollowing(0.5, 0.82, 1.06, 0.15);
    const shoulder = rings[rings.length - 1]; // anillo superior = hombros
    const sleeveR = Math.max(0.05, shoulder.rz * 0.7);
    const sleeveLen = H * 0.15;
    for (const side of [-1, 1]) {
      const sleeve = new THREE.Mesh(
        new THREE.CylinderGeometry(sleeveR, sleeveR * 0.88, sleeveLen, 20, 1, false),
        mat,
      );
      sleeve.position.set(cx + side * (shoulder.rx + sleeveR * 0.5), yAt(0.79) - sleeveLen * 0.25, cz);
      sleeve.rotation.z = side * 0.5; // cae siguiendo el brazo
      g.add(sleeve);
    }
  }

  g.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.castShadow = true;
      o.renderOrder = 1;
    }
  });
  return g;
}

// ==========================================================================
//  Vestido POR TALLA — la prenda se dimensiona con la tabla de medidas y se
//  colorea (opcional) según cómo ajusta a cada altura. Reemplaza al offset
//  fijo: una M y una L se ven distintas sobre el mismo cuerpo.
// ==========================================================================

/** Perímetro de una elipse (Ramanujan) con semiejes a, b (metros). */
function ellipsePerim(a: number, b: number): number {
  const h = (a - b) ** 2 / (a + b) ** 2;
  return Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
}

interface CircAnchor {
  f: number; // fracción de altura del cuerpo (0..1)
  c: number; // circunferencia de la prenda a esa altura (cm)
}

/** Circunferencia de prenda interpolada (lineal a trozos) a la fracción f. */
function interpCirc(anchors: CircAnchor[], f: number): number {
  const a = [...anchors].sort((x, y) => x.f - y.f);
  if (f <= a[0].f) return a[0].c;
  const last = a[a.length - 1];
  if (f >= last.f) return last.c;
  for (let i = 0; i < a.length - 1; i++) {
    if (f >= a[i].f && f <= a[i + 1].f) {
      const t = (f - a[i].f) / (a[i + 1].f - a[i].f);
      return a[i].c + (a[i + 1].c - a[i].c) * t;
    }
  }
  return last.c;
}

/** Color del mapa de ajuste (coincide con las badges de la UI de tallas). */
const FIT_RGB: Record<FitState, [number, number, number]> = {
  "no-entra": [0.75, 0.11, 0.11],
  "muy-ajustada": [0.82, 0.31, 0.23],
  ajustada: [0.84, 0.6, 0.18],
  regular: [0.18, 0.62, 0.34],
  holgada: [0.35, 0.48, 0.7],
  oversize: [0.35, 0.48, 0.7],
};

interface ColoredRing {
  y: number;
  rx: number;
  rz: number;
  cx?: number;
  cz?: number;
  color: [number, number, number];
}

/**
 * Material de tela. Con `showFit` → color por vértice (mapa de ajuste). Sin él,
 * usa la textura de la prenda si la hay, o el color liso.
 */
function sizedMaterial(colorHex: string, showFit: boolean, texturaUrl?: string): THREE.MeshStandardMaterial {
  const map = !showFit && texturaUrl ? garmentTexture(texturaUrl) : null;
  return new THREE.MeshStandardMaterial({
    // Blanco con mapa de ajuste o con textura (no teñir); color liso en otro caso.
    color: showFit || map ? new THREE.Color(1, 1, 1) : new THREE.Color(colorHex),
    map,
    vertexColors: showFit,
    roughness: 0.72,
    metalness: 0,
    envMapIntensity: 0.45,
    side: THREE.DoubleSide,
  });
}

/** Loft con color por anillo. Centro (cx, cz) por anillo si se da; si no, origen. */
function loftColored(rings: ColoredRing[], offset = 1): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let ri = 0; ri < rings.length; ri++) {
    const r = rings[ri];
    const ox = r.cx ?? 0;
    const oz = r.cz ?? 0;
    for (let j = 0; j <= SEGMENTS; j++) {
      const a = (j / SEGMENTS) * TAU;
      pos.push(ox + Math.cos(a) * r.rx * offset, r.y, oz + Math.sin(a) * r.rz * offset);
      col.push(r.color[0], r.color[1], r.color[2]);
      uv.push(j / SEGMENTS, ri / Math.max(1, rings.length - 1));
    }
  }
  const cols = SEGMENTS + 1;
  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < SEGMENTS; j++) {
      const a = i * cols + j;
      const b = a + cols;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * Medidas de prenda POR DEFECTO cuando no hay tabla de tallas: cuerpo + holgura
 * típica por categoría (cm). Permite vestir cualquier prenda del catálogo con el
 * mismo motor dimensionado (sin barriles), aunque no tenga tallas cargadas.
 */
export function defaultGarmentMeasures(categoria: string, body: Measurements): GarmentMeasures {
  const { bust, waist, hip } = body;
  if (categoria === "bottom") {
    return { waist: waist + 3, hip: hip + 4, thigh: hip * 0.6, length: 100, inseam: 78 };
  }
  if (categoria === "dress") {
    return { chest: bust + 6, waist: waist + 8, hip: hip + 6, length: 95 };
  }
  if (categoria === "outerwear") {
    return { chest: bust + 14, waist: waist + 14, hip: hip + 12, length: 72 };
  }
  // top
  return { chest: bust + 7, waist: waist + 9, shoulder: 45, length: 70, sleeve: 20 };
}

/** Aspecto elíptico (rz/rx) de torso y prendas. */
const GARMENT_DEPTH = 0.72;

/** Radio elíptico (rx, m) para una circunferencia dada (cm) con aspecto DEPTH. */
function rxFromCirc(cm: number, depth = GARMENT_DEPTH): number {
  return cm / 100 / (TAU * Math.sqrt((1 + depth * depth) / 2));
}

/**
 * Construye una prenda DIMENSIONADA por su talla sobre el cuerpo real.
 *
 * Clave: el TAMAÑO sale de los NÚMEROS (tabla de tallas + medidas del cuerpo),
 * no de muestrear el ancho de la malla — así los brazos no contaminan el ancho
 * (antes el brazo se colaba y salía un barril). El cuerpo solo aporta el centro
 * y, en las piernas, la trayectoria. La prenda nunca entra por dentro (holgura
 * mínima → mata el z-fighting) y el top se CIERRA hacia el cuello (no un cubo).
 * Con `showFit` pinta el mapa de ajuste; si no, color/textura de la prenda.
 */
export function buildGarmentSized(
  bodyObj: THREE.Object3D,
  body: Measurements,
  measures: GarmentMeasures,
  fabric: Fabric,
  bodyBottom: number,
  bodyTop: number,
  categoria: string,
  colorHex: string,
  showFit: boolean,
  texturaUrl?: string,
): THREE.Object3D {
  const yAt = (f: number) => bodyBottom + (bodyTop - bodyBottom) * f;
  const stretch = fabric.stretchPct;
  const g = new THREE.Group();
  const mat = sizedMaterial(colorHex, showFit, texturaUrl);

  const bbox = new THREE.Box3().setFromObject(bodyObj);
  const cx = (bbox.min.x + bbox.max.x) / 2;
  const cz = (bbox.min.z + bbox.max.z) / 2;

  const chest = measures.chest ?? measures.waist ?? body.bust;
  const waist = measures.waist ?? measures.chest ?? body.waist;
  const hip = measures.hip ?? waist;

  // Circunferencia del CUERPO por fracción de altura (de las medidas reales).
  const bodyAnchors: CircAnchor[] = [
    { f: 0.46, c: body.hip },
    { f: 0.62, c: body.waist },
    { f: 0.78, c: body.bust },
  ];

  // Tubo de torso dimensionado por talla, centrado en el cuerpo. `closeTop`
  // añade un canesú que estrecha hacia el cuello (hombros en pendiente).
  const addTorsoTube = (fromF: number, toF: number, garment: CircAnchor[], closeTop: boolean) => {
    const rings: ColoredRing[] = [];
    const steps = 22;
    for (let i = 0; i <= steps; i++) {
      const f = fromF + ((toF - fromF) * i) / steps;
      const garmentCm = interpCirc(garment, f);
      const bodyCm = interpCirc(bodyAnchors, f);
      // Radio de la prenda, nunca menor que el cuerpo + holgura (evita z-fight).
      const rx = Math.max(rxFromCirc(garmentCm), rxFromCirc(bodyCm) * 1.05);
      rings.push({ y: yAt(f), rx, rz: rx * GARMENT_DEPTH, color: FIT_RGB[fitStateFor(bodyCm, garmentCm, stretch)] });
    }
    if (closeTop) {
      // Canesú: de la anchura de hombros al cuello en un tramo corto.
      const top = rings[rings.length - 1];
      const neckRx = rxFromCirc(40); // ~cuello
      const neckF = toF + 0.04;
      for (const t of [0.4, 0.72, 1]) {
        const rx = top.rx + (neckRx - top.rx) * t;
        rings.push({ y: yAt(toF + (neckF - toF) * t), rx, rz: rx * GARMENT_DEPTH, color: top.color });
      }
    }
    const mesh = new THREE.Mesh(loftColored(rings), mat);
    mesh.position.set(cx, 0, cz);
    g.add(mesh);
    return rings;
  };

  if (categoria === "dress") {
    addTorsoTube(0.46, 0.8, [
      { f: 0.5, c: hip },
      { f: 0.62, c: waist },
      { f: 0.78, c: chest },
    ], true);
  } else if (categoria === "outerwear") {
    addTorsoTube(0.46, 0.82, [
      { f: 0.5, c: hip },
      { f: 0.6, c: waist },
      { f: 0.78, c: chest },
    ], true);
  } else if (categoria === "bottom") {
    // Banda cintura->cadera; baja hasta debajo de la entrepierna para tapar la ingle.
    addTorsoTube(0.42, 0.62, [
      { f: 0.46, c: hip },
      { f: 0.62, c: waist },
    ], false);
    // Perneras: el CUERPO da la trayectoria (cx/cz), la talla da el grosor. El
    // tope solapa la banda (0.52) para que no asome piel en la entrepierna.
    const thigh = measures.thigh ?? hip * 0.55;
    const legTop = 0.52;
    for (const side of [-1, 1]) {
      const legRings = sampleLegProfile(bodyObj, side, yAt(0.03), yAt(legTop));
      const colored = legRings.map((r): ColoredRing => {
        const frac = (r.y - yAt(0.03)) / (yAt(legTop) - yAt(0.03)); // 0 tobillo, 1 muslo
        const targetCm = thigh * (0.62 + 0.4 * frac); // afina hacia el tobillo
        const gRx = rxFromCirc(targetCm);
        // ≥ pierna real + holgura amplia (mata z-fighting / huecos de rodilla).
        const rx = Math.max(gRx, r.rx * 1.14);
        const rz = Math.max(gRx * GARMENT_DEPTH, r.rz * 1.14);
        const state = fitStateFor(ellipsePerim(r.rx, r.rz) * 100, targetCm, stretch);
        return { y: r.y, cx: r.cx, cz: r.cz, rx, rz, color: FIT_RGB[state] };
      });
      g.add(new THREE.Mesh(loftColored(colored), mat));
    }
  } else {
    // Top tipo camiseta: tubo cintura->hombro cerrado al cuello.
    addTorsoTube(0.5, 0.82, [
      { f: 0.55, c: waist },
      { f: 0.78, c: chest },
    ], true);
  }

  g.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.castShadow = true;
      o.renderOrder = 1;
    }
  });
  return g;
}
