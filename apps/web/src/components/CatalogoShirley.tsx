import { useEffect, useMemo, useState } from "react";
import {
  defaultSizeChart,
  FABRIC_PUNTO,
  recommendSize,
  tieneAjuste,
  TIPO_LABEL,
  type Garment,
  type GarmentTipo,
  type Measurements,
  type SizeLabel,
} from "@retail/style-engine";

/** Base pública donde el extractor dejó el catálogo y las fotos de la fábrica. */
const BASE = "/shirley";

/** Fila cruda del catálogo extraído de los Excel de la fábrica. */
interface Row {
  modelo: string;
  descripcion: string;
  categoria: Garment["categoria"] | "accessory";
  tipo: GarmentTipo;
  tejido: "punto" | "plano";
  colores: string[];
  tallas_disponibles: SizeLabel[];
  stock: Record<string, number>;
  total: number;
  peso_kg: number | null;
  foto: string | null;
  /** Color dominante precalculado desde la foto (hex), o null si no hay foto. */
  color?: string | null;
}

/** Mapea el tipo de prenda a la categoría + silueta que mejor malla 3D elige. */
const TIPO_3D: Record<GarmentTipo, { categoria: Garment["categoria"]; siluetas: string[] }> = {
  coat: { categoria: "outerwear", siluetas: ["punto"] },
  cardigan: { categoria: "outerwear", siluetas: ["punto"] },
  jacket: { categoria: "outerwear", siluetas: [] },
  poncho: { categoria: "outerwear", siluetas: ["punto"] },
  shawl: { categoria: "outerwear", siluetas: ["punto"] },
  sweater: { categoria: "top", siluetas: ["punto"] },
  vest: { categoria: "top", siluetas: [] },
  dress: { categoria: "dress", siluetas: [] },
  skirt: { categoria: "bottom", siluetas: ["falda"] },
  pants: { categoria: "bottom", siluetas: [] },
  top: { categoria: "top", siluetas: [] },
};

/** Clase CSS por estado de ajuste (reaprovecha la paleta del importador). */
const STATE_CLASS: Record<string, string> = {
  "no-entra": "fit-bad",
  "muy-ajustada": "fit-tight",
  ajustada: "fit-snug",
  regular: "fit-ok",
  holgada: "fit-loose",
  oversize: "fit-loose",
};

interface Props {
  measurements: Measurements;
  onClose: () => void;
  /** Lleva la prenda al avatar 3D (la añade al catálogo y la selecciona). */
  onTryOn?: (g: Garment) => void;
}

/**
 * Color dominante (promedio) de la foto del producto, ignorando el fondo blanco
 * típico de catálogo y las sombras muy oscuras. Sirve para que la prenda en 3D
 * respete el color real (los códigos de color de fábrica no son hex). La foto es
 * del mismo origen, así que el canvas no queda "tainted".
 */
async function dominantColorFromUrl(url: string): Promise<string | null> {
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.crossOrigin = "anonymous";
      el.onload = () => resolve(el);
      el.onerror = reject;
      el.src = url;
    });
    const w = 64;
    const h = 64;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      const R = data[i];
      const G = data[i + 1];
      const B = data[i + 2];
      const A = data[i + 3];
      if (A < 128) continue;
      if (R > 235 && G > 235 && B > 235) continue; // fondo blanco
      if (R < 16 && G < 16 && B < 16) continue; // sombra negra
      r += R;
      g += G;
      b += B;
      n += 1;
    }
    if (!n) return null;
    const to2 = (v: number) => Math.round(v / n).toString(16).padStart(2, "0");
    return `#${to2(r)}${to2(g)}${to2(b)}`;
  } catch {
    return null;
  }
}

/** Convierte una fila de fábrica en un `Garment` con su tabla por defecto. */
function toGarment(r: Row): Garment {
  const tallas = defaultSizeChart(r.tipo, r.tallas_disponibles);
  const map = TIPO_3D[r.tipo] ?? { categoria: "top", siluetas: [] };
  return {
    id: `shirley-${r.modelo}`,
    nombre: r.descripcion || r.modelo,
    categoria: map.categoria,
    genero: "female",
    // Color real de la prenda (precalculado desde la foto); gris neutro si falta.
    color: r.color ?? "#6b6f76",
    siluetas: map.siluetas,
    precio: 0,
    tallas,
    tejido: FABRIC_PUNTO,
    texturaUrl: r.foto ? `${BASE}/fotos/${r.foto}` : undefined,
  };
}

/**
 * Catálogo real de la fábrica (Shirley): navega 937 modelos con su foto, y para
 * cada uno te dice QUÉ TALLA te queda con tus medidas actuales. Como la fábrica
 * no entrega ficha técnica, el ajuste usa tablas estándar por tipo de prenda
 * (claramente señalado); si algún día llega la ficha real, manda esa.
 */
export function CatalogoShirley({ measurements, onClose, onTryOn }: Props) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [tipo, setTipo] = useState<GarmentTipo | "todas">("todas");
  const [onlyPhoto, setOnlyPhoto] = useState(true);
  const [limit, setLimit] = useState(48);
  const [sel, setSel] = useState<Row | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`${BASE}/catalogo.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: Row[]) => alive && setRows(data))
      .catch((e) => alive && setErr(String(e)));
    return () => {
      alive = false;
    };
  }, []);

  const tipos = useMemo(
    () =>
      rows
        ? (Array.from(new Set(rows.map((r) => r.tipo))) as GarmentTipo[]).sort(
            (a, b) => TIPO_LABEL[a].localeCompare(TIPO_LABEL[b]),
          )
        : [],
    [rows],
  );

  const filtered = useMemo(() => {
    if (!rows) return [];
    const qq = q.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (!onlyPhoto || r.foto) &&
        (tipo === "todas" || r.tipo === tipo) &&
        (!qq ||
          r.modelo.toLowerCase().includes(qq) ||
          r.descripcion.toLowerCase().includes(qq)),
    );
  }, [rows, q, tipo, onlyPhoto]);

  const visible = filtered.slice(0, limit);

  const measuresOk = !!(measurements.bust && measurements.waist && measurements.hip);

  // Recomendación de talla para la prenda seleccionada.
  const rec = useMemo(() => {
    if (!sel || !measuresOk || !tieneAjuste(sel.tipo)) return null;
    const chart = defaultSizeChart(sel.tipo, sel.tallas_disponibles);
    if (!Object.keys(chart).length) return null;
    return recommendSize(measurements, chart, FABRIC_PUNTO);
  }, [sel, measuresOk, measurements]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="kicker">Catálogo Shirley · {rows ? rows.length : "…"} modelos</span>
          <button className="ghost-btn" onClick={onClose}>
            cerrar
          </button>
        </div>

        {err && <p className="csv-errors">No pude cargar el catálogo: {err}</p>}

        {/* Filtros */}
        <div className="cat-filters">
          <input
            className="cat-search"
            placeholder="Buscar modelo o descripción…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setLimit(48);
            }}
          />
          <select
            className="cat-tipo"
            value={tipo}
            onChange={(e) => {
              setTipo(e.target.value as GarmentTipo | "todas");
              setLimit(48);
            }}
          >
            <option value="todas">Todos los tipos</option>
            {tipos.map((t) => (
              <option key={t} value={t}>
                {TIPO_LABEL[t]}
              </option>
            ))}
          </select>
          <label className="cat-onlyphoto">
            <input
              type="checkbox"
              checked={onlyPhoto}
              onChange={(e) => setOnlyPhoto(e.target.checked)}
            />
            solo con foto
          </label>
          <span className="cat-count">{filtered.length} resultados</span>
        </div>

        {!measuresOk && (
          <p className="est-status" style={{ maxWidth: "none", margin: "0 0 8px" }}>
            Introduce tus medidas para ver qué talla te queda en cada prenda.
          </p>
        )}

        <div className="cat-body">
          {/* Rejilla */}
          <div className="shirley-grid">
            {!rows && !err && <p className="est-status">Cargando catálogo…</p>}
            {visible.map((r) => (
              <div
                key={r.modelo}
                role="button"
                tabIndex={0}
                className={`shirley-card${sel?.modelo === r.modelo ? " on" : ""}`}
                onClick={() => setSel(r)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSel(r);
                  }
                }}
              >
                <div className="shirley-thumb">
                  {r.foto ? (
                    <img src={`${BASE}/fotos/${r.foto}`} alt={r.descripcion} loading="lazy" />
                  ) : (
                    <span className="no-photo">sin foto</span>
                  )}
                </div>
                <div className="shirley-meta">
                  <strong>{r.descripcion || r.modelo}</strong>
                  <span className="shirley-sub">
                    {TIPO_LABEL[r.tipo]} · {r.tallas_disponibles.join("/")}
                  </span>
                </div>
              </div>
            ))}
            {visible.length < filtered.length && (
              <button className="ghost-btn cat-more" onClick={() => setLimit((n) => n + 48)}>
                cargar más ({filtered.length - visible.length})
              </button>
            )}
          </div>

          {/* Detalle de la prenda seleccionada */}
          {sel && (
            <aside className="shirley-detail">
              <div className="shirley-detail-photo">
                {sel.foto ? (
                  <img src={`${BASE}/fotos/${sel.foto}`} alt={sel.descripcion} />
                ) : (
                  <span className="no-photo">sin foto</span>
                )}
              </div>
              <h3>{sel.descripcion || sel.modelo}</h3>
              <p className="shirley-detail-sub">
                {TIPO_LABEL[sel.tipo]} · modelo {sel.modelo} · {sel.colores.length} color(es)
              </p>
              <p className="shirley-detail-sub">
                Tallas en stock: <strong>{sel.tallas_disponibles.join(", ")}</strong>
              </p>

              {/* Veredicto de talla */}
              {!tieneAjuste(sel.tipo) ? (
                <p className="shirley-onesize">Talla única — no requiere ajuste por medidas.</p>
              ) : rec ? (
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
                          {f.zones
                            .map((z) => `${z.label} ${z.easeCm > 0 ? "+" : ""}${z.easeCm}cm`)
                            .join(" · ")}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="est-status" style={{ maxWidth: "none" }}>
                  Introduce tus medidas para ver el ajuste.
                </p>
              )}

              <p className="shirley-note">
                ⚠️ Ajuste con tabla estándar aproximada por tipo de prenda (la fábrica no
                entrega ficha técnica). Si cargas la ficha real, el ajuste será exacto.
              </p>

              {onTryOn && (
                <button
                  className="primary-btn"
                  onClick={async () => {
                    const g = toGarment(sel);
                    // El color viene precalculado desde la foto; si faltara, se
                    // extrae en el cliente como respaldo.
                    if (!sel.color && sel.foto) {
                      const color = await dominantColorFromUrl(`${BASE}/fotos/${sel.foto}`);
                      if (color) g.color = color;
                    }
                    onTryOn(g);
                    onClose();
                  }}
                >
                  Probármela en el avatar 3D
                </button>
              )}
              {onTryOn && (
                <p className="shirley-note" style={{ borderTop: "none", paddingTop: 6 }}>
                  Vista aproximada: el avatar viste una prenda <strong>genérica de la
                  categoría</strong> con el color de la foto, no la prenda exacta.
                </p>
              )}
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}
