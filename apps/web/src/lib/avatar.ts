/**
 * Avatar paramétrico procedural — 100% propio, sin modelos externos.
 *
 * El torso es una superficie "lofteada": una pila de secciones elípticas cuyas
 * anchuras se derivan de las medidas reales (busto, cintura, cadera, hombros),
 * de modo que la silueta refleja la morfología. Cabeza y extremidades son
 * primitivas cónicas fundidas. Las prendas se construyen por categoría como
 * capas/volúmenes teñidos: stand-in propio hasta hornear GLB reales en Blender.
 */

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Measurements } from "@retail/style-engine";

const TAU = Math.PI * 2;
const cmToRadius = (cm: number) => cm / TAU / 100;

interface Level {
  y: number;
  rx: number;
}

const DEPTH_RATIO = 0.72;
const SEGMENTS = 60;

function interpRx(key: Level[], y: number): number {
  if (y <= key[0].y) return key[0].rx;
  const last = key[key.length - 1];
  if (y >= last.y) return last.rx;
  for (let i = 0; i < key.length - 1; i++) {
    const a = key[i];
    const b = key[i + 1];
    if (y >= a.y && y <= b.y) {
      const t = (y - a.y) / (b.y - a.y);
      const s = 0.5 - 0.5 * Math.cos(t * Math.PI); // suavizado coseno
      return a.rx + (b.rx - a.rx) * s;
    }
  }
  return last.rx;
}

export interface AvatarBuild {
  group: THREE.Group;
  key: Level[];
  torsoTop: number;
  torsoBottom: number;
  hipR: number;
  bustR: number;
  shoulderR: number;
}

export function buildAvatar(m: Measurements, material: THREE.Material): AvatarBuild {
  const shoulder = m.shoulder ?? m.bust * 1.02;
  const rShoulder = cmToRadius(shoulder) * 1.04;
  const rBust = cmToRadius(m.bust);
  const rWaist = cmToRadius(m.waist);
  const rHip = cmToRadius(m.hip);
  const neckR = rShoulder * 0.34;

  // Perfil del torso (de entrepierna a base del cuello). El nivel superior se
  // estrecha hacia el cuello para que los hombros caigan en pendiente natural.
  const key: Level[] = [
    { y: 0.84, rx: rHip * 0.82 },
    { y: 0.95, rx: rHip },
    { y: 1.06, rx: rWaist },
    { y: 1.18, rx: rBust * 0.92 },
    { y: 1.3, rx: rBust },
    { y: 1.42, rx: rShoulder },
    { y: 1.5, rx: neckR * 1.35 }, // caída de hombro hacia el cuello
  ];
  const torsoBottom = key[0].y;
  const torsoTop = key[key.length - 1].y;

  const group = new THREE.Group();

  const torso = new THREE.Mesh(buildLoft(key, torsoBottom, torsoTop), material);
  torso.castShadow = true;
  torso.receiveShadow = true;
  group.add(torso);

  // Cuello + cabeza
  const neck = new THREE.Mesh(
    new THREE.CylinderGeometry(neckR * 0.85, neckR * 1.15, 0.09, 24),
    material,
  );
  neck.position.y = torsoTop + 0.035;
  neck.castShadow = true;
  group.add(neck);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.099, 40, 28), material);
  head.scale.set(0.86, 1.06, 0.9);
  head.position.y = torsoTop + 0.17;
  head.castShadow = true;
  group.add(head);

  // Brazos: cónicos, fundidos, cayendo con leve apertura
  const armLen = 0.6;
  const armGeo = taperedLimb(rBust * 0.22, rBust * 0.15, armLen);
  for (const side of [-1, 1]) {
    const arm = new THREE.Mesh(armGeo, material);
    arm.castShadow = true;
    arm.position.set(side * (rShoulder + rBust * 0.02), torsoTop - 0.08 - armLen / 2, 0);
    arm.rotation.z = side * 0.07;
    group.add(arm);
  }

  // Piernas: cónicas, fundidas, desde la cadera al tobillo
  const legLen = 0.84;
  const legGeo = taperedLimb(rHip * 0.5, rHip * 0.26, legLen);
  for (const side of [-1, 1]) {
    const leg = new THREE.Mesh(legGeo, material);
    leg.castShadow = true;
    leg.position.set(side * rHip * 0.42, torsoBottom + 0.02 - legLen / 2, 0);
    group.add(leg);
  }

  group.position.y = -0.85;
  return { group, key, torsoTop, torsoBottom, hipR: rHip, bustR: rBust, shoulderR: rShoulder };
}

/** Superficie lofteada del torso entre yBottom e yTop. */
function buildLoft(key: Level[], yBottom: number, yTop: number, scale = 1): THREE.BufferGeometry {
  const rings = 48;
  const positions: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i <= rings; i++) {
    const y = yBottom + ((yTop - yBottom) * i) / rings;
    let rx = interpRx(key, y) * scale;
    const edge = Math.min(i, rings - i) / rings;
    const taper = Math.min(1, edge * 7 + 0.12);
    rx *= 0.5 + 0.5 * taper;
    const rz = rx * DEPTH_RATIO;
    for (let j = 0; j <= SEGMENTS; j++) {
      const a = (j / SEGMENTS) * TAU;
      positions.push(Math.cos(a) * rx, y, Math.sin(a) * rz);
    }
  }

  const cols = SEGMENTS + 1;
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < SEGMENTS; j++) {
      const a = i * cols + j;
      const b = a + cols;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/** Miembro cónico (cilindro + casquetes esféricos) fundido en una geometría. */
function taperedLimb(rTop: number, rBottom: number, length: number): THREE.BufferGeometry {
  const body = new THREE.CylinderGeometry(rTop, rBottom, length, 20, 1, true);
  const cap1 = new THREE.SphereGeometry(rTop, 20, 12, 0, TAU, 0, Math.PI / 2);
  cap1.translate(0, length / 2, 0);
  const cap2 = new THREE.SphereGeometry(rBottom, 20, 12, 0, TAU, Math.PI / 2, Math.PI / 2);
  cap2.translate(0, -length / 2, 0);
  return mergeGeometries([body, cap1, cap2], false)!;
}

/** Material de tela con leve rugosidad. */
function fabric(colorHex: string, roughness = 0.72): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(colorHex),
    roughness,
    metalness: 0,
    envMapIntensity: 0.45,
    side: THREE.DoubleSide,
  });
}

/**
 * Construye la prenda seleccionada según su categoría, teñida con su color.
 * Devuelve un Object3D listo para añadir al grupo del avatar.
 */
export function buildGarment(
  build: AvatarBuild,
  categoria: string,
  colorHex: string,
): THREE.Object3D {
  const g = new THREE.Group();
  const mat = fabric(colorHex);
  const key = build.key;

  if (categoria === "dress") {
    // Cuerpo ajustado (busto→cadera) + falda acampanada hasta el muslo.
    const bodice = new THREE.Mesh(buildLoft(key, 0.96, 1.36, 1.06), mat);
    const skirt = new THREE.Mesh(
      new THREE.CylinderGeometry(build.hipR * 1.12, build.hipR * 1.9, 0.42, 48, 1, true),
      mat,
    );
    skirt.position.y = 0.96 - 0.42 / 2 + 0.02;
    g.add(bodice, skirt);
  } else if (categoria === "bottom") {
    // Banda de cadera + dos perneras ajustadas.
    const band = new THREE.Mesh(buildLoft(key, 0.9, 1.04, 1.08), mat);
    g.add(band);
    const legLen = 0.8;
    const legGeo = new THREE.CylinderGeometry(build.hipR * 0.56, build.hipR * 0.3, legLen, 22, 1, true);
    for (const side of [-1, 1]) {
      const leg = new THREE.Mesh(legGeo, mat);
      leg.position.set(side * build.hipR * 0.42, 0.86 - legLen / 2, 0);
      g.add(leg);
    }
  } else if (categoria === "outerwear") {
    // Abrigo holgado y algo más largo.
    g.add(new THREE.Mesh(buildLoft(key, 0.98, 1.46, 1.16), mat));
  } else {
    // Top: banda busto→cintura con dos tirantes sobre los hombros.
    g.add(new THREE.Mesh(buildLoft(key, 1.02, 1.36, 1.08), mat));
    const strapGeo = new THREE.CylinderGeometry(build.bustR * 0.045, build.bustR * 0.045, 0.2, 10);
    for (const side of [-1, 1]) {
      const strap = new THREE.Mesh(strapGeo, mat);
      strap.position.set(side * build.bustR * 0.5, 1.36, -build.bustR * 0.1);
      g.add(strap);
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
