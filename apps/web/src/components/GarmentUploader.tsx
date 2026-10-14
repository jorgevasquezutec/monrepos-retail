import { useMemo, useState } from "react";
import {
  parseSizeChartCSV,
  SIZE_ORDER,
  sortSizes,
  type FabricType,
  type Garment,
  type GarmentMeasures,
  type SizeChart,
  type SizeLabel,
} from "@retail/style-engine";
import { createGarment, type NewGarment } from "../lib/api.ts";

interface Props {
  onClose: () => void;
  onCreated: (g: Garment) => void;
}

/**
 * Procesa la imagen de la prenda: la reescala (máx. 512 px), la codifica como
 * data URL y extrae su color dominante (ignorando el fondo blanco típico de
 * catálogo). El color rellena el picker; la imagen se usa como textura 3D.
 */
async function processImage(file: File): Promise<{ dataUrl: string; color: string }> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = reject;
    el.src = URL.createObjectURL(file);
  });
  const max = 512;
  const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0, w, h);
  URL.revokeObjectURL(img.src);

  const { data } = ctx.getImageData(0, 0, w, h);
  let r = 0, gAcc = 0, b = 0, n = 0;
  for (let i = 0; i < data.length; i += 4) {
    const [R, G, B, A] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
    if (A < 128) continue; // transparente
    if (R > 240 && G > 240 && B > 240) continue; // fondo blanco
    r += R; gAcc += G; b += B; n++;
  }
  const to2 = (v: number) => Math.round(v).toString(16).padStart(2, "0");
  const color = n ? `#${to2(r / n)}${to2(gAcc / n)}${to2(b / n)}` : "#888888";
  return { dataUrl: canvas.toDataURL("image/jpeg", 0.85), color };
}

type Categoria = Garment["categoria"];
type Genero = Garment["genero"];

/** Columnas de medida relevantes por categoría (evita pedir manga a un pantalón). */
const COLS_BY_CAT: Record<Categoria, (keyof GarmentMeasures)[]> = {
  top: ["chest", "waist", "shoulder", "length", "sleeve"],
  outerwear: ["chest", "waist", "shoulder", "length", "sleeve"],
  bottom: ["waist", "hip", "thigh", "length", "inseam"],
  dress: ["chest", "waist", "hip", "length"],
};

const COL_LABEL: Record<keyof GarmentMeasures, string> = {
  chest: "Pecho",
  waist: "Cintura",
  hip: "Cadera",
  thigh: "Muslo",
  shoulder: "Hombros",
  length: "Largo",
  sleeve: "Manga",
  inseam: "Entrep.",
};

/**
 * Alta de prenda (gestión de catálogo). Datos básicos + tejido + tabla de tallas
 * a mano (rejilla) o rellenada desde un CSV. Produce el mismo `SizeChart` que el
 * importador, y lo persiste vía `POST /catalog`.
 */
export function GarmentUploader({ onClose, onCreated }: Props) {
  const [nombre, setNombre] = useState("");
  const [categoria, setCategoria] = useState<Categoria>("top");
  const [genero, setGenero] = useState<Genero>("unisex");
  const [color, setColor] = useState("#3A3A3E");
  const [texturaUrl, setTexturaUrl] = useState("");
  const [precio, setPrecio] = useState<number | "">("");
  const [siluetasText, setSiluetasText] = useState("");
  const [fabricTipo, setFabricTipo] = useState<FabricType>("plano");
  const [stretch, setStretch] = useState(2);

  const [sizes, setSizes] = useState<SizeLabel[]>(["S", "M", "L"]);
  const [chart, setChart] = useState<SizeChart>({});
  const [csv, setCsv] = useState("");
  const [csvErrors, setCsvErrors] = useState<string[]>([]);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleImage = async (file: File) => {
    try {
      const { dataUrl, color: c } = await processImage(file);
      setTexturaUrl(dataUrl);
      setColor(c); // color dominante como base
    } catch {
      setError("No pude procesar la imagen.");
    }
  };

  const cols = COLS_BY_CAT[categoria];

  const setCell = (size: SizeLabel, key: keyof GarmentMeasures, raw: string) => {
    setChart((prev) => {
      const row: GarmentMeasures = { ...prev[size] };
      if (raw === "") delete row[key];
      else row[key] = Number(raw);
      return { ...prev, [size]: row };
    });
  };

  const toggleSize = (s: SizeLabel) =>
    setSizes((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...SIZE_ORDER.filter((o) => prev.includes(o) || o === s)]));

  const fillFromCSV = () => {
    const { chart: parsed, errors } = parseSizeChartCSV(csv);
    setCsvErrors(errors);
    const keys = sortSizes(Object.keys(parsed));
    if (keys.length) {
      setChart(parsed);
      setSizes(keys);
    }
  };

  // ¿Hay al menos una talla con alguna medida? (para habilitar tallas opcionales)
  const chartHasData = useMemo(
    () => sizes.some((s) => chart[s] && Object.keys(chart[s]!).length > 0),
    [sizes, chart],
  );

  const canSave = nombre.trim() !== "" && /^#[0-9a-fA-F]{6}$/.test(color) && precio !== "" && Number(precio) >= 0;

  const handleSave = async () => {
    setError(null);
    setSaving(true);
    try {
      // Solo tallas con medidas; el resto se descarta.
      const tallas: SizeChart = {};
      for (const s of sizes) {
        if (chart[s] && Object.keys(chart[s]!).length > 0) tallas[s] = chart[s];
      }
      const siluetas = siluetasText
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const payload: NewGarment = {
        nombre: nombre.trim(),
        categoria,
        genero,
        color,
        precio: Number(precio),
        siluetas,
        ...(texturaUrl ? { texturaUrl } : {}),
        ...(chartHasData ? { tallas, tejido: { tipo: fabricTipo, stretchPct: stretch } } : {}),
      };
      const created = await createGarment(payload);
      onCreated(created);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo guardar. ¿Sesión iniciada y API activa?");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="kicker">Subir prenda</span>
          <button className="ghost-btn" onClick={onClose}>cerrar</button>
        </div>

        {/* Datos básicos */}
        <div className="fields">
          <div className="field field-wide">
            <label htmlFor="g-nombre">Nombre</label>
            <div className="input-wrap">
              <input id="g-nombre" value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Camiseta cuello redondo" />
            </div>
          </div>
          <div className="field">
            <label htmlFor="g-precio">Precio</label>
            <div className="input-wrap">
              <input
                id="g-precio"
                type="number"
                min={0}
                value={precio}
                onChange={(e) => setPrecio(e.target.value === "" ? "" : Number(e.target.value))}
                placeholder="—"
              />
              <span className="unit">€</span>
            </div>
          </div>
          <div className="field">
            <label htmlFor="g-color">Color</label>
            <div className="input-wrap color-wrap">
              <input id="g-color" type="color" value={color} onChange={(e) => setColor(e.target.value)} />
              <input className="hex" value={color} onChange={(e) => setColor(e.target.value)} />
            </div>
          </div>
          <div className="field field-wide">
            <label>Imagen de la prenda · opcional (color y textura)</label>
            <div className="img-row">
              <label className="img-drop">
                <input
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={(e) => e.target.files?.[0] && handleImage(e.target.files[0])}
                />
                {texturaUrl ? "cambiar imagen" : "subir imagen"}
              </label>
              {texturaUrl && (
                <>
                  <img className="img-thumb" src={texturaUrl} alt="Prenda" />
                  <button className="ghost-btn" onClick={() => setTexturaUrl("")}>quitar</button>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Siluetas (para el recomendador) */}
        <div className="fields">
          <div className="field field-wide">
            <label htmlFor="g-siluetas">Siluetas · separadas por comas (recomendador)</label>
            <div className="input-wrap">
              <input
                id="g-siluetas"
                value={siluetasText}
                onChange={(e) => setSiluetasText(e.target.value)}
                placeholder="recto, hombro-estructurado"
              />
            </div>
          </div>
        </div>

        {/* Categoría */}
        <div className="chips">
          {(["top", "bottom", "dress", "outerwear"] as Categoria[]).map((c) => (
            <button key={c} className={`chip-btn ${categoria === c ? "on" : ""}`} onClick={() => setCategoria(c)}>
              {c}
            </button>
          ))}
        </div>

        {/* Género + tejido */}
        <div className="seg">
          {(["female", "male", "unisex"] as Genero[]).map((gn) => (
            <button key={gn} className={genero === gn ? "on" : ""} onClick={() => setGenero(gn)}>
              {gn === "female" ? "Mujer" : gn === "male" ? "Hombre" : "Unisex"}
            </button>
          ))}
        </div>
        <div className="seg" style={{ marginTop: 8 }}>
          <button className={fabricTipo === "plano" ? "on" : ""} onClick={() => { setFabricTipo("plano"); setStretch(2); }}>
            Plano (rígido)
          </button>
          <button className={fabricTipo === "punto" ? "on" : ""} onClick={() => { setFabricTipo("punto"); setStretch(8); }}>
            Punto (elástico)
          </button>
        </div>

        {/* Tabla de tallas: selección de tallas + rejilla */}
        <div className="block-head" style={{ marginTop: 20 }}>
          <span className="kicker">Tallas (cm de la prenda) · opcional</span>
        </div>
        <div className="chips">
          {SIZE_ORDER.map((s) => (
            <button key={s} className={`chip-btn ${sizes.includes(s) ? "on" : ""}`} onClick={() => toggleSize(s)}>
              {s}
            </button>
          ))}
        </div>

        {sizes.length > 0 && (
          <div className="size-grid">
            <table>
              <thead>
                <tr>
                  <th>Talla</th>
                  {cols.map((c) => (
                    <th key={c}>{COL_LABEL[c]}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortSizes(sizes).map((s) => (
                  <tr key={s}>
                    <td className="talla">{s}</td>
                    {cols.map((c) => (
                      <td key={c}>
                        <input
                          type="number"
                          min={0}
                          value={chart[s]?.[c] ?? ""}
                          onChange={(e) => setCell(s, c, e.target.value)}
                          placeholder="—"
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Relleno rápido por CSV */}
        <details className="csv-fill">
          <summary>o pega un CSV</summary>
          <textarea
            className="csv-input"
            value={csv}
            spellCheck={false}
            placeholder={"talla,chest,waist,length\nS,96,84,69\nM,102,90,71"}
            onChange={(e) => setCsv(e.target.value)}
          />
          <div className="csv-actions">
            <button className="ghost-btn" onClick={fillFromCSV}>rellenar rejilla</button>
          </div>
          {csvErrors.length > 0 && (
            <ul className="csv-errors">
              {csvErrors.map((er, i) => (
                <li key={i}>⚠️ {er}</li>
              ))}
            </ul>
          )}
        </details>

        {error && <p className="est-status" style={{ maxWidth: "none", color: "#b23a2e", marginTop: 12 }}>{error}</p>}

        <div className="modal-foot">
          <button className="est-btn" onClick={handleSave} disabled={!canSave || saving}>
            {saving ? "Guardando…" : "Guardar prenda"}
          </button>
          {!chartHasData && <span className="est-status">Sin tallas se guarda igual (se probará con ajuste al cuerpo).</span>}
        </div>
      </div>
    </div>
  );
}
