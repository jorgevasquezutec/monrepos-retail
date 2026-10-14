import { rgbToHex, type SeasonAnalysis, type ShapeInfo, type RGB } from "@retail/style-engine";

interface Props {
  analysis: SeasonAnalysis;
  shape: ShapeInfo;
  skin: RGB;
}

/** Bloque de perfil: estación de color, paleta y silueta. */
export function ProfilePanel({ analysis, shape, skin }: Props) {
  const { season, subtono, confianza } = analysis;
  return (
    <>
      <div className="panel-block">
        <div className="block-head">
          <span className="kicker">Perfil · color</span>
          <span className="kicker">{(confianza * 100).toFixed(0)}% conf.</span>
        </div>
        <div className="season-row">
          <span className="season-sw" style={{ background: rgbToHex(skin) }} />
          <div>
            <div className="season-name">{season.nombre}</div>
            <div className="season-sub">
              subtono {subtono} · {season.family}
            </div>
          </div>
        </div>
        <p className="season-desc">{season.descripcion}</p>
        <div className="palette">
          {season.paleta.map((c) => (
            <span key={c} className="chip" style={{ background: c }} title={c} />
          ))}
        </div>
      </div>

      <div className="panel-block">
        <div className="block-head">
          <span className="kicker">Perfil · silueta</span>
        </div>
        <div className="shape-row">
          <span className="shape-name">{shape.nombre}</span>
        </div>
        <p className="shape-obj">{shape.objetivo}</p>
      </div>
    </>
  );
}
