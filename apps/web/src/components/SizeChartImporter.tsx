import { useMemo, useRef, useState } from "react";
import {
  parseSizeChartCSV,
  recommendSize,
  sortSizes,
  type Fabric,
  type FabricType,
  type GarmentMeasures,
  type Measurements,
  type SizeChart,
} from "@retail/style-engine";

interface Props {
  /** Medidas del cuerpo actual, para calcular el ajuste en vivo. */
  measurements: Measurements;
  /** Se llama al confirmar una tabla válida (para asociarla a una prenda). */
  onApply?: (chart: SizeChart, fabric: Fabric) => void;
}

// Ejemplo en español (el parser también acepta inglés y talla única O/S).
// Son medidas de la PRENDA TERMINADA en cm, no del cuerpo.
const PLACEHOLDER = `talla,pecho,cintura,cadera,largo,manga
S,96,84,98,70,20
M,102,90,104,72,21
L,108,96,110,74,22`;

/** Orden y etiqueta de las columnas de medida que mostramos en la vista previa. */
const COLS: { key: keyof GarmentMeasures; label: string }[] = [
  { key: "chest", label: "Pecho" },
  { key: "waist", label: "Cintura" },
  { key: "hip", label: "Cadera" },
  { key: "thigh", label: "Muslo" },
  { key: "shoulder", label: "Hombros" },
  { key: "length", label: "Largo" },
  { key: "sleeve", label: "Manga" },
  { key: "inseam", label: "Entrep." },
];

/** Clase CSS por estado de ajuste (para el color del veredicto). */
const STATE_CLASS: Record<string, string> = {
  "no-entra": "fit-bad",
  "muy-ajustada": "fit-tight",
  ajustada: "fit-snug",
  regular: "fit-ok",
  holgada: "fit-loose",
  oversize: "fit-loose",
};

/**
 * Importador de tabla de tallas por CSV. Pega o sube un CSV, se parsea con el
 * motor del style-engine (mismo formato que el formulario web produciría), y se
 * previsualiza la tabla, los avisos y —clave— cómo te quedaría cada talla con
 * tus medidas actuales.
 */
export function SizeChartImporter({ measurements, onApply }: Props) {
  const [text, setText] = useState("");
  const [fabricTipo, setFabricTipo] = useState<FabricType>("plano");
  const [stretch, setStretch] = useState(2);
  const fileRef = useRef<HTMLInputElement>(null);

  const fabric: Fabric = useMemo(
    () => ({ tipo: fabricTipo, stretchPct: stretch }),
    [fabricTipo, stretch],
  );

  const parsed = useMemo(() => (text.trim() ? parseSizeChartCSV(text) : null), [text]);
  const chart: SizeChart = parsed?.chart ?? {};
  const sizes = sortSizes(Object.keys(chart));
  const usedCols = COLS.filter((c) => sizes.some((s) => chart[s]?.[c.key] != null));

  const measuresOk = !!(measurements.bust && measurements.waist && measurements.hip);
  const rec = useMemo(
    () => (sizes.length && measuresOk ? recommendSize(measurements, chart, fabric) : null),
    [sizes.length, measuresOk, measurements, chart, fabric],
  );

  const handleFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => setText(String(reader.result ?? ""));
    reader.readAsText(file);
  };

  return (
    <div className="panel-block">
      <div className="block-head">
        <span className="kicker">Importar tallas · CSV</span>
        {sizes.length > 0 && onApply && (
          <button className="ghost-btn" onClick={() => onApply(chart, fabric)}>
            usar tabla
          </button>
        )}
      </div>

      {/* Tejido: define cuánto tolera la holgura negativa */}
      <div className="seg" style={{ marginBottom: 12 }}>
        <button
          className={fabricTipo === "plano" ? "on" : ""}
          onClick={() => {
            setFabricTipo("plano");
            setStretch(2);
          }}
        >
          Plano (rígido)
        </button>
        <button
          className={fabricTipo === "punto" ? "on" : ""}
          onClick={() => {
            setFabricTipo("punto");
            setStretch(8);
          }}
        >
          Punto (elástico)
        </button>
      </div>

      <textarea
        className="csv-input"
        value={text}
        placeholder={PLACEHOLDER}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
      />

      <div className="csv-actions">
        <button className="ghost-btn" onClick={() => fileRef.current?.click()}>
          subir .csv
        </button>
        <button className="ghost-btn" onClick={() => setText(PLACEHOLDER)}>
          ejemplo
        </button>
        {text && (
          <button className="ghost-btn" onClick={() => setText("")}>
            limpiar
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv,text/plain"
          hidden
          onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
        />
      </div>

      {/* Avisos de parseo */}
      {parsed && parsed.errors.length > 0 && (
        <ul className="csv-errors">
          {parsed.errors.map((err, i) => (
            <li key={i}>⚠️ {err}</li>
          ))}
        </ul>
      )}

      {/* Vista previa de la tabla parseada */}
      {sizes.length > 0 && (
        <div className="csv-preview">
          <table>
            <thead>
              <tr>
                <th>Talla</th>
                {usedCols.map((c) => (
                  <th key={c.key}>{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sizes.map((s) => (
                <tr key={s}>
                  <td className="talla">{s}</td>
                  {usedCols.map((c) => (
                    <td key={c.key}>{chart[s]?.[c.key] ?? "—"}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Ajuste en vivo contra las medidas actuales */}
      {rec && (
        <div className="csv-fit">
          <div className="csv-fit-head">
            <span className="kicker">Con tus medidas</span>
            <strong>{rec.best ? `Tu talla: ${rec.best}` : "Ninguna talla te entra"}</strong>
          </div>
          <ul>
            {rec.all.map((f) => (
              <li key={f.size} className={f.size === rec.best ? "best" : ""}>
                <span className="talla">{f.size}</span>
                <span className={`fit-badge ${STATE_CLASS[f.worst] ?? ""}`}>{f.worst}</span>
                <span className="zones">
                  {f.zones.map((z) => `${z.label} ${z.easeCm > 0 ? "+" : ""}${z.easeCm}cm`).join(" · ")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {sizes.length > 0 && !measuresOk && (
        <p className="est-status" style={{ maxWidth: "none", marginTop: 8 }}>
          Estima o introduce tus medidas para ver cómo te queda cada talla.
        </p>
      )}
    </div>
  );
}
