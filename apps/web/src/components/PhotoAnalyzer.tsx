import { useCallback, useRef, useState } from "react";
import { rgbToHex, type RGB } from "@retail/style-engine";
import { imageToData, samplePatch, autoSkinColor } from "../lib/skinSample.ts";

interface Props {
  onSkinColor: (rgb: RGB) => void;
}

/**
 * Sube una foto (procesada solo en local), detecta el tono de piel
 * automáticamente y permite ajustar el punto de muestreo con un clic.
 */
export function PhotoAnalyzer({ onSkinColor }: Props) {
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [marker, setMarker] = useState<{ x: number; y: number } | null>(null);
  const [swatch, setSwatch] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const dataRef = useRef<ReturnType<typeof imageToData> | null>(null);

  const handleFile = useCallback((file: File) => {
    const url = URL.createObjectURL(file);
    setImgUrl(url);
    setMarker(null);
    setSwatch(null);
  }, []);

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
  }, [onSkinColor]);

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLImageElement>) => {
      const img = imgRef.current;
      const parsed = dataRef.current;
      if (!img || !parsed) return;

      const rect = img.getBoundingClientRect();
      const xNorm = (e.clientX - rect.left) / rect.width;
      const yNorm = (e.clientY - rect.top) / rect.height;
      setMarker({ x: xNorm, y: yNorm });

      const rgb = samplePatch(parsed.data, parsed.width, parsed.height, xNorm, yNorm);
      setSwatch(rgbToHex(rgb));
      onSkinColor(rgb);
    },
    [onSkinColor],
  );

  return (
    <section className="section">
      <div className="sec-head">
        <span className="sec-num">01</span>
        <h2>Tu tono de piel</h2>
      </div>
      <p className="hint">
        Un retrato con luz natural basta. Se revela <strong>solo en tu
        dispositivo</strong> — nada viaja a la nube. Toca tu mejilla para afinar
        la lectura.
      </p>

      {!imgUrl && (
        <label className="upload">
          <input
            type="file"
            accept="image/*"
            onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
          />
          <span className="mark">Elegir retrato</span>
          <span className="sub">JPG · PNG · local</span>
        </label>
      )}

      {imgUrl && (
        <div className="photo-wrap">
          <img
            ref={imgRef}
            src={imgUrl}
            alt="Tu retrato"
            className="photo"
            onLoad={handleImageLoad}
            onClick={handleClick}
          />
          {marker && (
            <span
              className="marker"
              style={{ left: `${marker.x * 100}%`, top: `${marker.y * 100}%` }}
            />
          )}
        </div>
      )}

      {swatch && (
        <div className="swatch-row">
          <span className="swatch" style={{ background: swatch }} />
          <span>
            Tono leído <code>{swatch}</code>
          </span>
          <button className="link" onClick={() => setImgUrl(null)}>
            cambiar
          </button>
        </div>
      )}
    </section>
  );
}
