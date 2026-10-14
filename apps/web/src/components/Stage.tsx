import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  computeFit,
  rgbToHex,
  sortSizes,
  type Measurements,
  type RGB,
  type SizeLabel,
} from "@retail/style-engine";
import { imageToData, samplePatch, autoSkinColor } from "../lib/skinSample.ts";
import { classAtPoint, detectPhotoColors, isPlausibleSkin } from "../lib/photoColors.ts";
import type { HairStyle } from "../lib/bodyService.ts";
import { estimateFromPhoto, NoPersonError } from "../lib/bodyEstimate.ts";
import type { WornGarment } from "./AvatarViewport.tsx";

import { ErrorBoundary } from "./ErrorBoundary.tsx";

const loadAvatar = () => import("./AvatarViewport.tsx").then((m) => ({ default: m.AvatarViewport }));
const loadLive = () => import("./LiveTryOn.tsx").then((m) => ({ default: m.LiveTryOn }));
// `let`: al reintentar se recrea el lazy para que vuelva a pedir el chunk.
let AvatarViewport = lazy(loadAvatar);
let LiveTryOn = lazy(loadLive);

/** Tono de piel neutro por defecto (modo sin foto). */
const DEFAULT_SKIN: RGB = { r: 217, g: 180, b: 154 };

const FIT_CLASS: Record<string, string> = {
  "no-entra": "fit-bad",
  "muy-ajustada": "fit-tight",
  ajustada: "fit-snug",
  regular: "fit-ok",
  holgada: "fit-loose",
  oversize: "fit-loose",
};

interface Props {
  onSkinColor: (rgb: RGB) => void;
  onHairColor: (rgb: RGB | null) => void;
  onConfidence: (c: Confidence | null) => void;
  confidence: Confidence | null;
  hairColor: RGB | null;
  hairStyle: HairStyle;
  onMeasurements: (m: Measurements) => void;
  heightCm: number;
  onHeightChange: (n: number) => void;
  measurements: Measurements;
  gender: "female" | "male";
  onGenderChange: (g: "female" | "male") => void;
  skin: RGB | null;
  garments: WornGarment[];
  /** Tops del catálogo para elegir con un clic en la vista de cámara. */
  quickPicks?: { id: string; nombre: string; color: string }[];
  onPickGarment?: (id: string) => void;
  /** Las medidas las introdujo/estimó el usuario (si no, la cámara las estima). */
  measuresKnown?: boolean;
  onSizeChange: (id: string, size: SizeLabel) => void;
  /** Firma de las prendas reales puestas; al cambiar, se regenera el cuerpo vestido. */
  clothesSig: string;
  bodyUrl: string | null;
  generating: boolean;
  genError: string | null;
  onGenerateBody: () => void;
}

export type Confidence = "alta" | "media" | "baja";

const CONF_LABEL: Record<Confidence, string> = { alta: "Alta", media: "Media", baja: "Baja" };

const CONF_LINE: Record<Confidence, string> = {
  alta: "Medidas fiables.",
  media: "Medidas aproximadas; afínalas si hace falta.",
  baja: "Revisa y corrige tus medidas.",
};

type Mode = "retrato" | "avatar" | "camara";

/**
 * El escenario / viewport. Alterna entre el retrato (leer color + estimar
 * medidas desde la foto) y el avatar 3D paramétrico montado en el mismo lugar.
 */
export function Stage({
  onConfidence,
  confidence,
  onSkinColor,
  onHairColor,
  hairColor,
  hairStyle,
  onMeasurements,
  heightCm,
  onHeightChange,
  measurements,
  gender,
  onGenderChange,
  skin,
  garments,
  quickPicks,
  onPickGarment,
  measuresKnown,
  onSizeChange,
  clothesSig,
  bodyUrl,
  generating,
  genError,
  onGenerateBody,
}: Props) {
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [marker, setMarker] = useState<{ x: number; y: number } | null>(null);
  const [swatch, setSwatch] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("retrato");
  const [showFit, setShowFit] = useState(false);
  const [estimating, setEstimating] = useState(false);
  const [estStatus, setEstStatus] = useState<string | null>(null);
  const [skinHint, setSkinHint] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const dataRef = useRef<ReturnType<typeof imageToData> | null>(null);
  /** El usuario muestreó a mano: la lectura automática no lo pisa. */
  const manualSkinRef = useRef(false);

  const measuresOk = !!(measurements.bust && measurements.waist && measurements.hip);
  // El avatar NO requiere foto: basta con las medidas (piel por defecto si no hay foto).
  const canAvatar = measuresOk;
  const effSkin = skin ?? DEFAULT_SKIN;

  const handleFile = useCallback((file: File) => {
    setImgUrl(URL.createObjectURL(file));
    setMarker(null);
    setSwatch(null);
    setEstStatus(null);
    manualSkinRef.current = false;
    setSkinHint(null);
    onConfidence(null);
    onHairColor(null);
  }, [onHairColor, onConfidence]);

  const handleImageLoad = useCallback(() => {
    const img = imgRef.current;
    if (!img) return;
    const parsed = imageToData(img);
    dataRef.current = parsed;
    const auto = autoSkinColor(parsed.data, parsed.width, parsed.height);
    if (auto) {
      setSwatch(rgbToHex(auto));
      onSkinColor(auto);
    }
    // Lectura precisa con segmentación (cara/pelo); sustituye a la heurística.
    detectPhotoColors(img)
      .then((c) => {
        if (imgRef.current !== img) return; // la foto cambió mientras tanto
        if (c.skin && !manualSkinRef.current) {
          setSwatch(rgbToHex(c.skin));
          onSkinColor(c.skin);
        }
        if (c.hair) onHairColor(c.hair);
      })
      .catch((e) => console.warn("[photoColors]", e));
  }, [onSkinColor, onHairColor]);

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLImageElement>) => {
      const img = imgRef.current;
      const parsed = dataRef.current;
      if (!img || !parsed) return;
      const rect = img.getBoundingClientRect();
      const xNorm = (e.clientX - rect.left) / rect.width;
      const yNorm = (e.clientY - rect.top) / rect.height;
      const hint = "Toca una zona de piel (cara, cuello o manos)";
      let rgb: RGB;
      try {
        rgb = samplePatch(parsed.data, parsed.width, parsed.height, xNorm, yNorm);
      } catch {
        setSkinHint(hint); // parche sin píxeles válidos (fuera de imagen, brillo o sombra dura)
        return;
      }
      // Debe ser piel: según la segmentación (cara/cuerpo) y por tono/croma plausible.
      const cls = classAtPoint(img, xNorm, yNorm);
      if ((cls !== null && cls !== 2 && cls !== 3) || !isPlausibleSkin(rgb)) {
        setSkinHint(hint);
        return;
      }
      setSkinHint(null);
      setMarker({ x: xNorm, y: yNorm });
      manualSkinRef.current = true;
      setSwatch(rgbToHex(rgb));
      onSkinColor(rgb);
    },
    [onSkinColor],
  );

  const handleEstimate = useCallback(async () => {
    const img = imgRef.current;
    if (!img) return;
    setEstimating(true);
    setEstStatus("Analizando la foto…");
    try {
      const r = await estimateFromPhoto(img, heightCm);
      onMeasurements(r.measurements);
      onConfidence(r.confidence);
      if (r.gender) onGenderChange(r.gender);
      setEstStatus(r.note);
      setMode("avatar");
    } catch (e) {
      if (!(e instanceof NoPersonError)) console.error("[estimate]", e);
      setEstStatus(
        e instanceof NoPersonError
          ? "No se detectó una persona de cuerpo entero. Usa una foto de pie y completa."
          : "No se pudo estimar (se descargan modelos; revisa la conexión).",
      );
    } finally {
      setEstimating(false);
    }
  }, [heightCm, onMeasurements, onGenderChange, onConfidence]);

  const showAvatar = mode === "avatar" && canAvatar;
  const showCamera = mode === "camara";

  // Genera el cuerpo automáticamente al entrar en Avatar 3D Y cada vez que
  // cambian las medidas o la altura (p. ej. tras reemplazar la foto y estimar).
  const lastGenSig = useRef<string | null>(null);
  useEffect(() => {
    if (!showAvatar || !canAvatar || generating) return;
    const sig = `${measurements.bust}-${measurements.waist}-${measurements.hip}-${measurements.shoulder ?? 0}-${heightCm}-${gender}-${clothesSig}-${hairStyle}`;
    if (lastGenSig.current === sig) return; // ya generado para esta config
    lastGenSig.current = sig;
    onGenerateBody();
  }, [
    showAvatar,
    canAvatar,
    generating,
    measurements.bust,
    measurements.waist,
    measurements.hip,
    measurements.shoulder,
    heightCm,
    gender,
    clothesSig,
    hairStyle,
    onGenerateBody,
  ]);

  return (
    <div className={`stage ${showAvatar ? "stage-avatar" : ""}`}>
      <div className="viewport-chrome">
        <span className="tl" /><span className="tr" />
        <span className="bl" /><span className="br" />
      </div>
      <div className="viewport-label kicker">
        Viewport · {showCamera ? "cámara" : showAvatar ? "avatar 3D" : "retrato"}
      </div>
      <div className="viewport-hint kicker">
        {showCamera ? "ponte de pie frente a la cámara" : showAvatar ? "arrastra para girar" : imgUrl ? "clic para muestrear" : "3D · sube tu retrato"}
      </div>

      <div className="mode-toggle">
        <button className={mode === "retrato" ? "on" : ""} onClick={() => setMode("retrato")}>
          Retrato
        </button>
        {canAvatar && (
          <button className={mode === "avatar" ? "on" : ""} onClick={() => setMode("avatar")}>
            Avatar 3D
          </button>
        )}
        <button className={mode === "camara" ? "on" : ""} onClick={() => setMode("camara")}>
          Cámara
        </button>
      </div>

      {imgUrl && !showAvatar && !showCamera && (
        <div className="stage-actions">
          <button className="ghost-btn" onClick={() => setImgUrl(null)}>
            reemplazar
          </button>
        </div>
      )}

      {showCamera ? (
        <ErrorBoundary
          message="No se pudo cargar el probador en vivo."
          onReset={() => { LiveTryOn = lazy(loadLive); }}
        >
          <Suspense fallback={<div className="live-loading kicker">Cargando cámara…</div>}>
            <LiveTryOn
              garments={garments}
              quickPicks={quickPicks}
              onPickGarment={onPickGarment}
              onSizeChange={onSizeChange}
              measurements={measurements}
              heightCm={heightCm}
              measuresKnown={measuresKnown}
            />
          </Suspense>
        </ErrorBoundary>
      ) : showAvatar ? (
        <ErrorBoundary
          message="No se pudo cargar el visor 3D."
          onReset={() => { AvatarViewport = lazy(loadAvatar); }}
        >
          <Suspense fallback={<div className="live-loading kicker">Cargando visor 3D…</div>}>
            <AvatarViewport
              measurements={measurements}
              skin={effSkin}
              hairColor={hairColor}
              bodyUrl={bodyUrl}
              garments={garments}
              showFit={showFit}
            />
          </Suspense>
        </ErrorBoundary>
      ) : (
        <div className="stage-inner">
          {!imgUrl ? (
            <div className="ghost">
              <Silhouette />
              <label className="upload">
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
                />
                <span className="plus">+</span> Sube tu retrato
              </label>
              <ul className="photo-guide">
                <li>Cuerpo entero, de frente</li>
                <li>Brazos sueltos, sin objetos delante</li>
                <li>Ropa ajustada</li>
                <li>Fondo liso y buena luz</li>
              </ul>
            </div>
          ) : (
            <>
              <img
                ref={imgRef}
                src={imgUrl}
                alt="Tu retrato"
                className="portrait"
                onLoad={handleImageLoad}
                onClick={handleClick}
              />
              {marker && (
                <span
                  className="marker"
                  style={{ left: `${marker.x * 100}%`, top: `${marker.y * 100}%` }}
                />
              )}
            </>
          )}
        </div>
      )}

      {/* Barra de estimación de medidas desde la foto */}
      {imgUrl && !showAvatar && !showCamera && (
        <div className="estimate-bar">
          <label className="est-height">
            <span className="kicker">Altura</span>
            <span className="est-input">
              <input
                type="number"
                min={120}
                max={220}
                value={heightCm}
                onChange={(e) => onHeightChange(Number(e.target.value) || 0)}
              />
              <span className="unit">cm</span>
            </span>
          </label>
          <button className="est-btn" onClick={handleEstimate} disabled={estimating || !heightCm}>
            {estimating ? "Analizando…" : "Estimar medidas desde la foto"}
          </button>
          {(confidence || estStatus) && (
            <div className="est-info">
              {confidence ? (
                <>
                  <div className="est-conf-row">
                    <span className={`conf-chip conf-${confidence}`} title="Fiabilidad de las medidas estimadas">
                      Confianza: {CONF_LABEL[confidence]}
                    </span>
                    <span className="est-status">{CONF_LINE[confidence]}</span>
                  </div>
                  {estStatus && (
                    <details className="est-why">
                      <summary>¿Por qué?</summary>
                      <p>{estStatus}</p>
                    </details>
                  )}
                </>
              ) : (
                <span className="est-status">{estStatus}</span>
              )}
            </div>
          )}
        </div>
      )}

      {skinHint && !showAvatar && !showCamera && <div className="skin-hint">{skinHint}</div>}
      {swatch && !showAvatar && !showCamera && (
        <div className="readout">
          <span className="sw" style={{ background: swatch }} />
          <span className="val">{swatch.toUpperCase()}</span>
        </div>
      )}
      {showAvatar && garments.length > 0 && (
        <div className="garment-sizes">
          {garments.some((g) => g.tallas) && (
            <button
              className={`fit-toggle ${showFit ? "on" : ""}`}
              onClick={() => setShowFit((v) => !v)}
              title="Colorea la prenda según cómo ajusta"
            >
              {showFit ? "● Ajuste" : "○ Ajuste"}
            </button>
          )}
          {garments.map((g) => {
            const sizes = g.tallas ? sortSizes(Object.keys(g.tallas)) : [];
            const fit =
              g.tallas && g.size && measurements.bust
                ? computeFit(measurements, g.tallas[g.size]!, g.tejido ?? { tipo: "plano", stretchPct: 0 }, g.size)
                : null;
            return (
              <div key={g.id} className="gs-row">
                <span className="sw" style={{ background: g.color }} />
                <span className="gs-name" title={g.nombre}>{g.nombre}</span>
                {sizes.length > 0 ? (
                  <>
                    <span className="gs-tallas">
                      {sizes.map((s) => (
                        <button
                          key={s}
                          className={`gs-talla ${s === g.size ? "on" : ""} ${s === g.recommended ? "gs-rec" : ""}`}
                          onClick={() => onSizeChange(g.id, s)}
                          title={s === g.recommended ? "Talla recomendada" : undefined}
                        >
                          {s}
                        </button>
                      ))}
                    </span>
                    {fit && <span className={`fit-badge ${FIT_CLASS[fit.worst] ?? ""}`}>{fit.worst}</span>}
                  </>
                ) : (
                  <span className="gs-notalla kicker">Talla única</span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Cartel mientras el servicio genera el cuerpo (Blender emulado, ~15 s) */}
      {showAvatar && generating && (
        <div className="gen-overlay">
          <span className="spinner" />
          <span>Generando tu cuerpo real…</span>
          <span className="gen-sub">Blender está modelándote (~15 s)</span>
        </div>
      )}

      {/* Regenerar / reintentar */}
      {/* Falló la generación: el modelo mostrado ya no coincide con la selección → se atenúa */}
      {showAvatar && !generating && genError && (
        <div className="gen-overlay gen-failed" role="alert">
          <span>No pudimos generar tu avatar</span>
          <span className="gen-sub">El modelo mostrado puede no reflejar tu selección actual.</span>
          <button className="est-btn" onClick={onGenerateBody}>Reintentar</button>
        </div>
      )}

      {showAvatar && !generating && !genError && (
        <div className="estimate-bar">
          <button className="est-btn" onClick={onGenerateBody}>
            {bodyUrl ? "Regenerar con estas medidas" : "Generar mi cuerpo real"}
          </button>
        </div>
      )}
    </div>
  );
}

/** Silueta neutra que prefigura el futuro avatar 3D. */
function Silhouette() {
  return (
    <svg viewBox="0 0 120 300" fill="none" aria-hidden>
      <path
        d="M60 18c9 0 16 7 16 17s-7 19-16 19-16-9-16-19 7-17 16-17Zm-22 62c4-6 13-10 22-10s18 4 22 10c5 8 8 26 9 44 1 12 1 20-1 24-2 3-6 3-8-1-2-5-3-14-4-24-1 20-1 44-3 78-1 10-2 18-4 22-2 3-8 3-9-1-2-8-3-24-4-44-1 20-2 36-4 44-1 4-7 4-9 1-2-4-3-12-4-22-2-34-2-58-3-78-1 10-2 19-4 24-2 4-6 4-8 1-2-4-2-12-1-24 1-18 4-36 9-44Z"
        fill="currentColor"
      />
    </svg>
  );
}
