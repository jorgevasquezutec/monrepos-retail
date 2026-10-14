import { useMemo, useState } from "react";
import type { Garment, ScoredGarment } from "@retail/style-engine";

interface Props {
  recs: ScoredGarment[];
  selectedIds: Set<string>;
  onSelect: (id: string) => void;
}

type Filter = "all" | Garment["categoria"];

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "Todo" },
  { id: "top", label: "Tops" },
  { id: "dress", label: "Vestidos" },
  { id: "bottom", label: "Bajos" },
  { id: "outerwear", label: "Abrigos" },
];

/** Siluetas planas (viewBox 0 0 100 120) que se tiñen con el color de la prenda. */
const SHAPES = {
  top: "M30 20 L42 13 Q50 20 58 13 L70 20 L87 36 L77 46 L71 40 L71 106 L29 106 L29 40 L23 46 L13 36 Z",
  dress: "M39 10 L45 10 Q50 17 55 10 L61 10 L64 40 Q60 47 62 52 L85 110 L15 110 L38 52 Q40 47 36 40 Z",
  bottom: "M30 12 L70 12 L76 110 L57 110 L50 46 L43 110 L24 110 Z",
  wide: "M31 12 L69 12 L84 110 L56 110 L50 48 L44 110 L16 110 Z",
  skirt: "M35 22 L65 22 L68 30 L86 100 L14 100 L32 30 Z",
  outer: "M31 16 L43 10 L50 42 L57 10 L69 16 L88 40 L88 104 L77 104 L74 52 L72 110 L28 110 L26 52 L23 104 L12 104 L12 40 Z",
};

function shapeFor(g: Garment): string {
  if (g.categoria === "bottom") {
    if (g.siluetas.some((s) => s.startsWith("falda"))) return SHAPES.skirt;
    return g.siluetas.includes("pantalon-pierna-ancha") ? SHAPES.wide : SHAPES.bottom;
  }
  if (g.categoria === "dress") return SHAPES.dress;
  if (g.categoria === "outerwear") return SHAPES.outer;
  return SHAPES.top;
}

/** Umbrales de afinidad → etiqueta legible (en vez de una barra). */
function level(score: number): { label: string; tone: "hi" | "mid" | "lo" } {
  if (score >= 0.6) return { label: "Muy afín", tone: "hi" };
  if (score >= 0.45) return { label: "Afín", tone: "mid" };
  return { label: "Opcional", tone: "lo" };
}

/** Catálogo recomendado en galería; al tocar una prenda se prueba en el avatar 3D. */
export function Recommendations({ recs, selectedIds, onSelect }: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const present = useMemo(() => new Set(recs.map((r) => r.garment.categoria)), [recs]);
  const shown = filter === "all" ? recs : recs.filter((r) => r.garment.categoria === filter);

  return (
    <div className="panel-block">
      <div className="block-head">
        <span className="kicker">Selección para ti</span>
        <span className="kicker cat-count">{shown.length} prendas</span>
      </div>
      <p className="hint" style={{ marginBottom: 14 }}>
        Ordenado por afinidad con tu color y tu silueta. Toca para probártela; otra vez para quitarla.
      </p>

      <div className="cat-filters" role="group" aria-label="Filtrar por tipo">
        {FILTERS.filter((f) => f.id === "all" || present.has(f.id)).map((f) => (
          <button
            key={f.id}
            type="button"
            className={`cat-filter${filter === f.id ? " on" : ""}`}
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="cat-grid">
        {shown.map((r, i) => {
          const g = r.garment;
          const worn = selectedIds.has(g.id);
          const lv = level(r.score);
          return (
            <button
              key={g.id}
              type="button"
              className={`cat-card${worn ? " worn" : ""}`}
              style={{ animationDelay: `${i * 0.03}s` }}
              onClick={() => onSelect(g.id)}
              aria-pressed={worn}
              aria-label={`${worn ? "Quitar" : "Probar"} ${g.nombre}`}
            >
              <span className="cat-thumb">
                <svg viewBox="0 0 100 120" aria-hidden="true">
                  <path d={shapeFor(g)} fill={g.color} />
                </svg>
                <span className={`cat-badge ${lv.tone}`}>
                  {Math.round(r.score * 100)}% · {lv.label}
                </span>
                {worn && (
                  <span className="cat-worn">
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M3 8.5l3 3 7-7" />
                    </svg>
                    Puesta
                  </span>
                )}
              </span>
              <span className="cat-info">
                <span className="cat-row">
                  <span className="cat-name">{g.nombre}</span>
                  <span className="cat-price">{g.precio.toFixed(0)} €</span>
                </span>
                {r.motivos[0] && <span className="cat-reason">{r.motivos[0]}</span>}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
