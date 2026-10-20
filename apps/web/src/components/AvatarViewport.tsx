import { useCallback, useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import {
  rgbToHex,
  type Fabric,
  type Measurements,
  type RGB,
  type SizeChart,
  type SizeLabel,
} from "@retail/style-engine";
import { rgbToLab } from "../lib/photoColors.ts";
import { buildAvatar, buildGarment, type AvatarBuild } from "../lib/avatar.ts";
import { buildGarmentSized, defaultGarmentMeasures } from "../lib/garmentFit.ts";

/** Prenda puesta, con datos de talla/tejido para dimensionarla en 3D. */
export interface WornGarment {
  id: string;
  nombre: string;
  color: string;
  categoria: string;
  tallas?: SizeChart;
  tejido?: Fabric;
  /** Imagen/textura de la prenda (URL o data URL) para el render 3D. */
  texturaUrl?: string;
  /** Asset de ropa real: si está, la prenda va horneada en el GLB (no tubo). */
  mhclo?: string;
  /** Etiquetas de silueta del catálogo (el servicio las usa para elegir el corte). */
  siluetas?: string[];
  /** Talla efectiva a mostrar (override del usuario o la recomendada). */
  size?: SizeLabel;
  /** Talla recomendada por medidas (para marcarla en el selector). */
  recommended?: SizeLabel | null;
}

// El GLB del servicio viene con geometría comprimida en Draco (gen_avatar.py):
// pesa ~5x menos, clave cuando el servicio llega por un enlace lento/remoto.
// DRACOLoader la descomprime en el navegador (decoder wasm desde la CDN oficial).
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.7/");
const gltfLoader = new GLTFLoader();
gltfLoader.setDRACOLoader(dracoLoader);

/** Luminancia lineal media de los píxeles opacos de una textura (0..1), o 1 si no se puede leer. */
/** Luminancia media de un atributo de color por vértice (para compensar el tinte). */
function attributeMeanLuminance(attr: THREE.BufferAttribute): number {
  let sum = 0;
  const step = Math.max(1, Math.floor(attr.count / 4000));
  let n = 0;
  for (let i = 0; i < attr.count; i += step, n++) {
    sum += 0.2126 * attr.getX(i) + 0.7152 * attr.getY(i) + 0.0722 * attr.getZ(i);
  }
  return Math.max(0.05, n ? sum / n : 1);
}

function textureMeanLuminance(tex: THREE.Texture | null | undefined): number {
  try {
    const img = tex?.image as CanvasImageSource | undefined;
    if (!img) return 1;
    const cv = document.createElement("canvas");
    cv.width = cv.height = 32;
    const g = cv.getContext("2d", { willReadFrequently: true })!;
    g.drawImage(img, 0, 0, 32, 32);
    const d = g.getImageData(0, 0, 32, 32).data;
    const lin = (v: number) => ((v / 255 + 0.055) / 1.055) ** 2.4;
    let sum = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3]! < 128) continue;
      sum += 0.2126 * lin(d[i]!) + 0.7152 * lin(d[i + 1]!) + 0.0722 * lin(d[i + 2]!);
      n++;
    }
    return n ? Math.max(0.02, sum / n) : 1;
  } catch {
    return 1;
  }
}

/** Evita z-fighting: la tela gana al cuerpo donde casi coinciden. */
const clothOffset = { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, depthWrite: true } as const;

/** Libera geometrías y materiales de un objeto y sus hijos. */
function disposeObject(obj: THREE.Object3D) {
  obj.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.geometry?.dispose();
      const m = o.material;
      if (Array.isArray(m)) m.forEach((x) => x.dispose());
      else m?.dispose();
    }
  });
}

/** Escala y sitúa un cuerpo cargado: ~1.7 m de alto, pies sobre el suelo, centrado. */
function fitToFrame(group: THREE.Object3D, targetHeight = 1.7, groundY = -0.86) {
  const box = new THREE.Box3().setFromObject(group);
  const size = new THREE.Vector3();
  box.getSize(size);
  if (size.y > 0.0001) group.scale.setScalar(targetHeight / size.y);
  const box2 = new THREE.Box3().setFromObject(group);
  const center = new THREE.Vector3();
  box2.getCenter(center);
  group.position.x -= center.x;
  group.position.z -= center.z;
  group.position.y += groundY - box2.min.y;
}

interface Props {
  measurements: Measurements;
  skin: RGB;
  /** Color de pelo leído de la foto (null → castaño oscuro por defecto). */
  hairColor?: RGB | null;
  /** URL del cuerpo GLB generado desde las medidas; null → maniquí procedural. */
  bodyUrl: string | null;
  /** Prendas puestas (una por zona: top/bottom/outerwear, o un dress). */
  garments: WornGarment[];
  /** Pinta el mapa de calor de ajuste en vez del color liso de la prenda. */
  showFit: boolean;
}

/**
 * Visor 3D del avatar paramétrico. Monta una escena Three.js en el escenario,
 * con iluminación de estudio, sombra de contacto y órbita 360°. Fondo
 * transparente para que la rejilla en perspectiva del CSS asome detrás.
 */
export function AvatarViewport({ measurements, skin, hairColor, bodyUrl, garments, showFit }: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const ctx = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    skinMat: THREE.MeshPhysicalMaterial;
    /** Materiales de pelo del GLB actual, con su factor de oscurecimiento (cejas/pestañas). */
    hairMats: { mat: THREE.MeshStandardMaterial; k: number; gain: number }[];
    /** Ropa base del GLB actual (su color depende del tono de piel). */
    baseMats: THREE.MeshStandardMaterial[];
    /** Cuerpo actual en escena (procedural o GLB). */
    bodyGroup: THREE.Object3D | null;
    /** Parámetros del cuerpo procedural (null cuando el cuerpo es un GLB). */
    build: AvatarBuild | null;
    /** Alturas (mundo) del cuerpo GLB para colocar las prendas; null si procedural. */
    bodyBottom: number | null;
    bodyTop: number | null;
    garmentObjs: THREE.Object3D[];
    /** Token de la última carga para descartar cargas GLB obsoletas. */
    loadToken: number;
    raf: number;
  } | null>(null);

  // Refs a los props actuales, para leerlos desde callbacks estables.
  const garmentsRef = useRef(garments);
  garmentsRef.current = garments;
  const measRef = useRef(measurements);
  measRef.current = measurements;
  const showFitRef = useRef(showFit);
  showFitRef.current = showFit;

  // Aplica TODAS las prendas puestas (una por zona) sobre el procedural o el GLB.
  const applyGarments = useCallback(() => {
    const c = ctx.current;
    if (!c) return;
    for (const obj of c.garmentObjs) {
      obj.parent?.remove(obj);
      disposeObject(obj);
    }
    c.garmentObjs = [];
    for (const g of garmentsRef.current) {
      // Prenda real: ya viene horneada en el GLB del cuerpo → no dibujes tubo.
      if (g.mhclo && !c.build) continue;
      if (c.build) {
        const gm = buildGarment(c.build, g.categoria, g.color);
        c.build.group.add(gm);
        c.garmentObjs.push(gm);
      } else if (c.bodyGroup && c.bodyBottom != null && c.bodyTop != null) {
        const m = measRef.current;
        if (!m.bust || !m.waist || !m.hip) continue;
        // Todas las prendas se dimensionan con el mismo motor. Con tabla de
        // tallas → la talla elegida; sin tabla → medidas por defecto (cuerpo +
        // holgura por categoría), para que nada salga como barril.
        const measures =
          (g.tallas && g.size ? g.tallas[g.size] : undefined) ??
          defaultGarmentMeasures(g.categoria, m);
        const fabric = g.tejido ?? { tipo: "plano" as const, stretchPct: 4 };
        const gm = buildGarmentSized(
          c.bodyGroup,
          m,
          measures,
          fabric,
          c.bodyBottom,
          c.bodyTop,
          g.categoria,
          g.color,
          showFitRef.current,
          g.texturaUrl,
        );
        c.scene.add(gm); // espacio mundo: el cuerpo no rota (rota la cámara)
        c.garmentObjs.push(gm);
      }
    }
  }, []);

  const skinRef = useRef(skin);
  skinRef.current = skin;
  const hairRef = useRef(hairColor);
  hairRef.current = hairColor;

  // Tiñe piel y pelo con el color actual (barato: no reconstruye el cuerpo).
  const applyColors = useCallback(() => {
    const c = ctx.current;
    if (!c) return;
    c.skinMat.color.set(rgbToHex(skinRef.current));
    const h = hairRef.current;
    const base = new THREE.Color(h ? rgbToHex(h) : "#3b2a20");
    // Ropa base: nunca debe leerse como piel desnuda → contraste según la luminosidad de la piel.
    const s = skinRef.current;
    const skinL = rgbToLab(s.r, s.g, s.b)[0];
    const baseColor = skinL > 45 ? "#2f3441" : "#a39d93"; // piel clara/media → carbón; oscura → gris cálido claro
    for (const m of c.baseMats) m.color.set(baseColor);
    for (const { mat, k, gain } of c.hairMats) mat.color.copy(base).multiplyScalar(k * gain);
  }, []);

  // --- Montaje único de la escena ---
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.style.display = "block";

    const scene = new THREE.Scene();

    // Entorno para reflejos PBR suaves (mejora piel y telas).
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
    camera.position.set(0, 0, 3.6);

    // Iluminación de estudio: ambiente suave + clave + relleno + contra.
    scene.add(new THREE.HemisphereLight(0xffffff, 0xcfcfca, 0.3));
    const key = new THREE.DirectionalLight(0xffffff, 0.95);
    key.position.set(0.7, 4.2, 2.4); // casi sobre el eje de cámara: la sombra cae bajo los pies
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 12;
    key.shadow.camera.left = -2;
    key.shadow.camera.right = 2;
    key.shadow.camera.top = 2.5;
    key.shadow.camera.bottom = -2.5;
    key.shadow.bias = -0.0006;
    key.shadow.normalBias = 0.02; // evita acné de sombra (puntas de trenza sobre hombros)
    key.shadow.radius = 6;
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.3);
    fill.position.set(-3, 1.5, 1.5);
    scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffffff, 0.45);
    rim.position.set(-1, 2, -3);
    scene.add(rim);

    // Sombra de contacto sobre el suelo (plano invisible salvo la sombra).
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(6, 6),
      new THREE.ShadowMaterial({ opacity: 0.16 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.86;
    ground.receiveShadow = true;
    scene.add(ground);

    // OrbitControls captura el puntero; con eventos sintéticos o punteros ya
    // liberados el navegador lanza → lo silenciamos para no ensuciar la consola.
    for (const k of ["setPointerCapture", "releasePointerCapture"] as const) {
      const el = renderer.domElement;
      const orig = el[k].bind(el);
      el[k] = (id: number) => {
        try {
          orig(id);
        } catch {
          /* puntero inactivo */
        }
      };
    }

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.enablePan = false;
    controls.minDistance = 2.2;
    controls.maxDistance = 4.5;
    controls.minPolarAngle = Math.PI * 0.28;
    controls.maxPolarAngle = Math.PI * 0.62;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.9;
    controls.target.set(0, 0, 0);

    // Piel: rugosidad media + un velo de "sheen" cálido para el aspecto suave
    // de la piel, sin clearcoat (que la haría parecer plástico).
    const skinMat = new THREE.MeshPhysicalMaterial({
      color: 0xd9b49a,
      roughness: 0.55,
      metalness: 0.0,
      envMapIntensity: 0.25,
      sheen: 0.25,
      sheenRoughness: 0.6,
      sheenColor: new THREE.Color(0xffd9c4),
    });

    const c = {
      renderer, scene, camera, controls, skinMat,
      hairMats: [] as { mat: THREE.MeshStandardMaterial; k: number; gain: number }[],
      baseMats: [] as THREE.MeshStandardMaterial[],
      bodyGroup: null as THREE.Object3D | null,
      build: null as AvatarBuild | null,
      bodyBottom: null as number | null,
      bodyTop: null as number | null,
      garmentObjs: [] as THREE.Object3D[],
      loadToken: 0,
      raf: 0,
    };
    ctx.current = c;

    let lastAz = "";
    const animate = () => {
      controls.update();
      // Lectura para pruebas; solo toca el DOM cuando cambia (no en cada frame).
      const az = controls.getAzimuthalAngle().toFixed(2);
      if (az !== lastAz) renderer.domElement.dataset.azimuth = lastAz = az;
      renderer.render(scene, camera);
      c.raf = requestAnimationFrame(animate);
    };
    animate();

    const ro = new ResizeObserver(() => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });
    ro.observe(mount);

    // Detiene la autorrotación en cuanto el usuario interactúa.
    const stopAuto = () => (controls.autoRotate = false);
    renderer.domElement.addEventListener("pointerdown", stopAuto);

    return () => {
      cancelAnimationFrame(c.raf);
      ro.disconnect();
      renderer.domElement.removeEventListener("pointerdown", stopAuto);
      controls.dispose();
      pmrem.dispose();
      renderer.dispose();
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement);
      ctx.current = null;
    };
  }, []);

  // --- Reconstruye el cuerpo cuando cambian medidas o tono de piel ---
  useEffect(() => {
    const c = ctx.current;
    if (!c || !measurements.bust || !measurements.waist || !measurements.hip) return;

    const token = ++c.loadToken;

    const clearBody = () => {
      for (const obj of c.garmentObjs) {
        obj.parent?.remove(obj);
        disposeObject(obj);
      }
      c.garmentObjs = [];
      if (c.bodyGroup) {
        c.scene.remove(c.bodyGroup);
        disposeObject(c.bodyGroup);
        c.bodyGroup = null;
      }
      c.build = null;
      c.bodyBottom = null;
      c.bodyTop = null;
      c.hairMats = [];
      c.baseMats = [];
    };

    const useProcedural = () => {
      if (token !== c.loadToken) return;
      clearBody();
      applyColors();
      const build = buildAvatar(measurements, c.skinMat);
      c.scene.add(build.group);
      c.bodyGroup = build.group;
      c.build = build;
      applyGarments();
    };

    // Con URL de cuerpo real (GLB del servicio) la cargamos; si no, procedural.
    if (!bodyUrl) {
      useProcedural();
    } else {
      gltfLoader
        .loadAsync(bodyUrl)
        .then((gltf) => {
          if (token !== c.loadToken) return; // llegó una carga más nueva
          clearBody();
          const body = gltf.scene;
          // Prendas reales horneadas: Blender las nombra clothes_0, clothes_1…
          // en el MISMO orden que las prendas con mhclo → color 1:1.
          const clothed = garmentsRef.current.filter((g) => g.mhclo);
          body.traverse((o) => {
            if (!(o instanceof THREE.Mesh)) return;
            const name = o.name || o.parent?.name || "";
            const orig = (Array.isArray(o.material) ? o.material[0] : o.material) as
              | THREE.MeshStandardMaterial
              | undefined;
            const cm = /clothes_(\d+)/.exec(name);
            if (cm) {
              const color = clothed[Number(cm[1])]?.color ?? "#8a8f98";
              o.material = new THREE.MeshStandardMaterial({
                color: new THREE.Color(color), // hex → sRGB→lineal (ColorManagement)
                roughness: 0.8,
                metalness: 0,
                side: THREE.DoubleSide,
                ...clothOffset,
              });
            } else if (/basewear/i.test(name)) {
              o.material = new THREE.MeshStandardMaterial({
                color: new THREE.Color("#8f897f"),
                roughness: 0.9,
                metalness: 0,
                side: THREE.DoubleSide,
                ...clothOffset,
              });
              c.baseMats.push(o.material as THREE.MeshStandardMaterial);
            } else if (/^(hair|eyebrows?|eyelashes?)/i.test(name)) {
              // Pelo/cejas/pestañas: conserva textura y alfa del GLB si existen.
              // Recorte duro (alphaTest + depthWrite) + alphaToCoverage (MSAA) para
              // bordes suaves sin ordenar transparencias: ni casco sólido ni artefactos.
              const hasAlpha = !!(orig?.alphaMap || orig?.map || orig?.transparent);
              // Pelo procedural (afro/trenzas) trae el detalle en COLOR_0.
              const vcol = o.geometry.getAttribute("color") as THREE.BufferAttribute | undefined;
              // Luminancia media del detalle: el contraste se aplica relativo a ella.
              const meanLum = orig?.map
                ? textureMeanLuminance(orig.map)
                : vcol
                  ? attributeMeanLuminance(vcol)
                  : 1;
              // Brillo suave de mechón (sheen) + especular moderado: evita el aspecto plástico.
              const mat = new THREE.MeshPhysicalMaterial({
                vertexColors: !!vcol,
                map: orig?.map ?? null,
                alphaMap: orig?.alphaMap ?? null,
                roughness: 0.45,
                metalness: 0,
                sheen: 1,
                sheenRoughness: 0.5,
                sheenColor: new THREE.Color("#6b625a"),
                side: THREE.DoubleSide,
                alphaTest: hasAlpha ? 0.5 : 0,
                alphaToCoverage: false,
                transparent: false,
                depthWrite: true,
              });
              // Matiz determinista: la textura / color por vértice del GLB aporta SOLO
              // luminancia (detalle claro-oscuro); el matiz sale únicamente del color de
              // la foto. Así todos los peinados se tiñen igual. Además, los bordes de
              // mechón (alfa bajo, color blanco/gris por sangrado) se oscurecen.
              const lum = "vec3(0.2126, 0.7152, 0.0722)";
              mat.onBeforeCompile = (sh) => {
                let fs = sh.fragmentShader;
                if (orig?.map) {
                  fs = fs.replace(
                    "#include <map_fragment>",
                    `#ifdef USE_MAP
  vec4 sampledDiffuseColor = texture2D( map, vMapUv );
  diffuseColor.rgb *= hairShade(dot(sampledDiffuseColor.rgb, ${lum}));
  diffuseColor.a *= sampledDiffuseColor.a;
#endif`,
                  );
                }
                if (vcol) {
                  fs = fs.replace(
                    "#include <color_fragment>",
                    `#ifdef USE_COLOR
  diffuseColor.rgb *= hairShade(dot(vColor.rgb, ${lum}));
#endif`,
                  );
                }
                if (hasAlpha) {
                  fs = fs.replace(
                    "#include <alphamap_fragment>",
                    `#include <alphamap_fragment>
  if (diffuseColor.a < 0.5) discard;
  diffuseColor.rgb *= mix(0.3, 1.0, smoothstep(0.5, 0.92, diffuseColor.a));`,
                  );
                }
                // final = colorFoto · mix(0.55, 1.45, lum/media): conserva el relieve claro-oscuro.
                fs = fs.replace(
                  "void main() {",
                  `float hairShade(float l) { return mix(0.55, 1.45, clamp(0.5 * l / ${meanLum.toFixed(5)}, 0.0, 1.0)); }
void main() {`,
                );
                sh.fragmentShader = fs;
              };
              mat.customProgramCacheKey = () => `hair-${!!orig?.map}-${!!vcol}-${hasAlpha}-${meanLum.toFixed(5)}`;
              const gain = 1; // el contraste ya va normalizado en el shader
              c.hairMats.push({ mat, k: /hair/i.test(name) ? 1 : /lash/i.test(name) ? 0.45 : 0.7, gain });
              o.material = mat;
            } else if (/^eyes?/i.test(name)) {
              if (!orig?.map) {
                o.material = new THREE.MeshStandardMaterial({
                  color: new THREE.Color("#2b1d14"),
                  roughness: 0.25,
                  metalness: 0,
                });
              }
            } else if (/^(base|human)/i.test(name) || !orig) {
              o.material = c.skinMat; // cuerpo (base/Human) → piel
            }
            // Otros meshes desconocidos conservan su material del GLB.
            o.castShadow = true;
            o.receiveShadow = true;
          });
          applyColors(); // tiñe piel y pelo recién creados
          // Cuerpo nuevo → vuelve a mirar al frente.
          c.camera.position.set(0, 0, 3.6);
          c.controls.update();
          fitToFrame(body);
          c.scene.add(body);
          c.bodyGroup = body;
          c.build = null; // GLB: sin parámetros procedurales
          const bb = new THREE.Box3().setFromObject(body);
          c.bodyBottom = bb.min.y;
          c.bodyTop = bb.max.y;
          applyGarments(); // viste el cuerpo real con las medidas del usuario
        })
        .catch(useProcedural);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bodyUrl, measurements.bust, measurements.waist, measurements.hip, measurements.shoulder]);

  useEffect(() => {
    applyColors();
  }, [skin.r, skin.g, skin.b, hairColor?.r, hairColor?.g, hairColor?.b, applyColors]);

  // --- Añade / cambia / quita la prenda, cambia de talla o alterna el ajuste ---
  useEffect(() => {
    applyGarments();
  }, [garments, showFit, applyGarments]);

  return <div className="avatar-viewport" ref={mountRef} />;
}
