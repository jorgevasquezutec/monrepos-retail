import { useEffect, useMemo, useRef, useState } from "react";
import type { Measurements, SizeLabel } from "@retail/style-engine";
import { sortSizes } from "@retail/style-engine";
import {
  LandmarkSmoother,
  PersonMasks,
  bodyForFit,
  buildFrame,
  framingHint,
  garmentKind,
  getVideoPose,
  getVideoSegmenter,
  hasTorso,
  sizingFor,
  type FramingHint,
} from "../lib/liveTryOn.ts";
import { GarmentRenderer, type LayerSpec } from "../lib/garmentRender.ts";
import type { WornGarment } from "./AvatarViewport.tsx";

const DEMO_COLOR = "#c8553d";
const DRAW_ORDER = ["bottom", "dress", "top", "outerwear"];

export interface QuickPick {
  id: string;
  nombre: string;
  color: string;
}

type Phase = "camera" | "model" | "ready" | "error";

function cameraError(e: unknown): string {
  const name = (e as { name?: string })?.name;
  if (name === "NotAllowedError" || name === "SecurityError")
    return "Permiso de cámara denegado. Actívalo en el navegador y vuelve a intentarlo.";
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError")
    return "No se encontró ninguna cámara en este dispositivo.";
  if (name === "NotReadableError" || name === "AbortError")
    return "La cámara está en uso por otra aplicación.";
  return "No se pudo acceder a la cámara.";
}

const HINTS: Record<FramingHint, string | null> = {
  ok: null,
  cerca: "Colócate a 1–1,5 m, de frente",
  lejos: "Colócate a 1–1,5 m, de frente",
  lado: "Colócate a 1–1,5 m, de frente",
};

interface Props {
  garments: WornGarment[];
  quickPicks?: QuickPick[];
  onPickGarment?: (id: string) => void;
  onSizeChange?: (id: string, size: SizeLabel) => void;
  measurements: Measurements;
  heightCm: number;
  /** El usuario ya introdujo/estimó sus medidas (si no, se estiman desde la pose). */
  measuresKnown?: boolean;
}

/** Probador en vivo 2D: vídeo de la cámara + prendas ancladas a la pose, con talla. */
export function LiveTryOn({
  garments,
  quickPicks = [],
  onPickGarment,
  onSizeChange,
  measurements,
  heightCm,
  measuresKnown = false,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const [phase, setPhase] = useState<Phase>("camera");
  const [tracking, setTracking] = useState(false);
  const [hint, setHint] = useState<FramingHint>("ok");
  const [error, setError] = useState<string | null>(null);
  const trackingRef = useRef(false);
  const hintRef = useRef<FramingHint>("ok");

  // Capas a dibujar + veredicto de ajuste (se recalcula al cambiar talla/medidas).
  const { layers, main } = useMemo(() => {
    const body = bodyForFit(measurements, heightCm, measuresKnown);
    const specs: LayerSpec[] = garments.map((g) => {
      const { kind, sleeves } = garmentKind(g);
      return {
        kind,
        sleeves,
        categoria: g.categoria,
        color: g.color,
        sizing: sizingFor(g, body, heightCm, !measuresKnown),
      };
    });
    if (!specs.length) {
      specs.push({
        kind: "tee",
        sleeves: "short",
        categoria: "top",
        color: DEMO_COLOR,
        sizing: sizingFor({}, body, heightCm, !measuresKnown),
      });
    }
    const byGarment = [...specs];
    specs.sort((a, b) => DRAW_ORDER.indexOf(a.categoria) - DRAW_ORDER.indexOf(b.categoria));
    const m =
      garments.find((g) => g.categoria === "top") ??
      garments.find((g) => g.categoria === "dress") ??
      garments.find((g) => g.categoria === "outerwear") ??
      null;
    const idx = m ? garments.indexOf(m) : -1;
    return { layers: specs, main: m ? { garment: m, spec: byGarment[idx] ?? null } : null };
  }, [garments, measurements, heightCm, measuresKnown]);

  const layersRef = useRef(layers);
  layersRef.current = layers;

  useEffect(() => {
    let cancelled = false;
    let raf = 0;
    let stream: MediaStream | null = null;
    const video = videoRef.current!;

    const releaseCamera = () => {
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
      video.srcObject = null;
    };

    const fail = (msg: string) => {
      releaseCamera();
      if (cancelled) return;
      setError(msg);
      setPhase("error");
    };

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        return fail("Este navegador (o contexto no seguro) no permite usar la cámara.");
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
      } catch (e) {
        return fail(cameraError(e));
      }
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      video.srcObject = stream;
      try {
        await video.play();
      } catch {
        return fail("No se pudo iniciar el vídeo de la cámara.");
      }

      setPhase("model");
      let pose;
      try {
        pose = await getVideoPose();
      } catch {
        return fail("No se pudo descargar el modelo de pose. Revisa tu conexión e inténtalo de nuevo.");
      }
      if (cancelled) return;
      setPhase("ready");

      // Segmentación (oclusión): carga en segundo plano; sin ella se dibuja sin recorte.
      let seg: Awaited<ReturnType<typeof getVideoSegmenter>> | null = null;
      getVideoSegmenter()
        .then((s) => {
          seg = s;
        })
        .catch(() => {
          /* sin segmentación: la prenda se dibuja sin oclusión */
        });

      const canvas = canvasRef.current!;
      const ctx = canvas.getContext("2d")!;
      const smoother = new LandmarkSmoother();
      const renderer = new GarmentRenderer();
      const masks = new PersonMasks();
      let lastTime = -1;
      let lastTs = 0;
      let lastSegTs = 0;
      let poseFrames = 0;
      let fpsCount = 0;
      let renderMs = 0;
      let fpsT0 = performance.now();

      const setTrack = (v: boolean) => {
        if (trackingRef.current !== v) {
          trackingRef.current = v;
          setTracking(v);
        }
      };

      const loop = () => {
        if (cancelled) return;
        raf = requestAnimationFrame(loop);
        if (video.readyState < 2 || !video.videoWidth) return;
        if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
        }
        const { width, height } = canvas;
        ctx.drawImage(video, 0, 0, width, height);

        if (video.currentTime !== lastTime) {
          lastTime = video.currentTime;
          const ts = Math.max(performance.now(), lastTs + 1);
          lastTs = ts;
          try {
            const res = pose.detectForVideo(video, ts);
            const raw = res.landmarks?.[0];
            if (raw) smoother.update(raw, ts);
            else smoother.reset();
          } catch {
            /* fotograma fallido */
          }
          // La segmentación va a menor cadencia (cada 3 fotogramas de pose).
          if (seg && poseFrames++ % 3 === 0) {
            try {
              const sts = Math.max(performance.now(), lastSegTs + 1);
              lastSegTs = sts;
              masks.update(seg, video, sts);
            } catch {
              /* se reintenta */
            }
          }
        }
        const lm = smoother.latest();
        if (!lm || !hasTorso(lm)) {
          setTrack(false);
          return;
        }
        setTrack(true);
        const h = framingHint(lm);
        if (h !== hintRef.current) {
          hintRef.current = h;
          setHint(h);
        }

        const frame = buildFrame(lm, width, height);
        const t0 = performance.now();
        renderer.render(ctx, video, frame, layersRef.current, seg ? masks : null);
        renderMs += performance.now() - t0;

        fpsCount++;
        const now = performance.now();
        if (now - fpsT0 >= 1000) {
          rootRef.current?.setAttribute("data-fps", String(Math.round((fpsCount * 1000) / (now - fpsT0))));
          rootRef.current?.setAttribute("data-render-ms", (renderMs / fpsCount).toFixed(1));
          renderMs = 0;
          fpsCount = 0;
          fpsT0 = now;
        }
      };
      raf = requestAnimationFrame(loop);
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      (video.srcObject as MediaStream | null)?.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    };
  }, []);

  let status: string;
  if (phase === "camera") status = "Solicitando cámara…";
  else if (phase === "model") status = "Cargando modelo de pose…";
  else if (phase === "error") status = error ?? "Error";
  else status = tracking ? "Seguimiento activo" : "Sin persona detectada";

  const g = main?.garment ?? null;
  const sizes = g?.tallas ? sortSizes(Object.keys(g.tallas)) : [];
  const verdict = main?.spec?.sizing.verdict ?? null;
  const hintText = phase === "ready" && tracking ? HINTS[hint] : null;

  return (
    <div className="live-tryon" ref={rootRef}>
      <video ref={videoRef} className="live-video" playsInline muted />
      <canvas ref={canvasRef} className="live-canvas" data-testid="live-tryon-canvas" />
      <div className="live-badge kicker">Procesado en tu dispositivo · no se sube vídeo</div>

      <div className="live-dock">
        {hintText && <div className="live-hint kicker">{hintText}</div>}
        {verdict && g && (
          <div className={`live-fit tone-${verdict.tone}`} data-testid="live-tryon-fit">
            <strong>{verdict.label}</strong>
            <span>
              {g.nombre} {g.size} · {verdict.detail}
              {verdict.estimated ? " · medidas estimadas" : ""}
            </span>
          </div>
        )}
        {g && sizes.length > 0 && (
          <div className="live-sizes" role="group" aria-label="Talla">
            {sizes.map((s) => (
              <button
                key={s}
                type="button"
                className={`live-chip ${g.size === s ? "on" : ""} ${g.recommended === s ? "rec" : ""}`}
                aria-pressed={g.size === s}
                onClick={() => onSizeChange?.(g.id, s)}
                title={g.recommended === s ? "Talla recomendada" : undefined}
              >
                {s}
              </button>
            ))}
          </div>
        )}
        {garments.length === 0 && phase !== "error" && quickPicks.length > 0 && (
          <div className="live-picks">
            <span className="kicker">Pruébate</span>
            {quickPicks.map((p) => (
              <button
                key={p.id}
                type="button"
                className="live-chip pick"
                onClick={() => onPickGarment?.(p.id)}
              >
                <i style={{ background: p.color }} />
                {p.nombre}
              </button>
            ))}
          </div>
        )}
        {garments.length === 0 && phase !== "error" && quickPicks.length === 0 && (
          <div className="live-hint kicker">Elige una prenda del catálogo · mostrando camiseta de demostración</div>
        )}
        <div
          className={`live-status kicker ${phase === "error" ? "err" : ""}`}
          data-testid="live-tryon-status"
          role="status"
        >
          {status}
        </div>
      </div>
    </div>
  );
}
