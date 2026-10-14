import type { Measurements } from "@retail/style-engine";
import type { HairStyle } from "../lib/bodyService.ts";

export type Gender = "female" | "male";

interface Props {
  value: Measurements;
  onChange: (m: Measurements) => void;
  gender: Gender;
  onGenderChange: (g: Gender) => void;
  hair: HairStyle;
  /** Invita a corregir las medidas (estimación poco fiable). */
  highlightMeasures?: boolean;
  onHairChange: (h: HairStyle) => void;
}

const HAIR_STYLES: { id: HairStyle; label: string }[] = [
  { id: "auto", label: "Auto" },
  { id: "short", label: "Corto" },
  { id: "bob", label: "Bob" },
  { id: "long", label: "Largo" },
  { id: "ponytail", label: "Coleta" },
  { id: "braids", label: "Trenzas" },
  { id: "afro", label: "Afro" },
  { id: "none", label: "Sin pelo" },
];

const FIELDS: { key: keyof Measurements; label: string }[] = [
  { key: "bust", label: "Busto" },
  { key: "waist", label: "Cintura" },
  { key: "hip", label: "Cadera" },
  { key: "shoulder", label: "Hombros" },
];

/** Presets de silueta: fijan las medidas típicas de cada figura. */
const SILHOUETTES: { id: string; label: string; m: Measurements }[] = [
  { id: "hourglass", label: "Reloj de arena", m: { bust: 92, waist: 68, hip: 94 } },
  { id: "pear", label: "Pera", m: { bust: 88, waist: 74, hip: 104 } },
  { id: "apple", label: "Manzana", m: { bust: 100, waist: 102, hip: 96 } },
  { id: "rectangle", label: "Rectángulo", m: { bust: 90, waist: 82, hip: 92 } },
  { id: "inverted", label: "Triángulo inv.", m: { bust: 104, waist: 80, hip: 90 } },
];

/** Captura de sexo, silueta y medidas (Fase 2 · configurador manual). */
export function BodyForm({ value, onChange, gender, onGenderChange, hair, onHairChange, highlightMeasures }: Props) {
  return (
    <div className="panel-block">
      <div className="block-head">
        <span className="kicker">Cuerpo</span>
      </div>

      {/* Sexo */}
      <div className="seg">
        <button className={gender === "female" ? "on" : ""} onClick={() => onGenderChange("female")}>
          Mujer
        </button>
        <button className={gender === "male" ? "on" : ""} onClick={() => onGenderChange("male")}>
          Hombre
        </button>
      </div>

      {/* Siluetas preestablecidas */}
      <div className="chips">
        {SILHOUETTES.map((s) => (
          <button
            key={s.id}
            className="chip-btn"
            onClick={() => onChange({ ...value, ...s.m })}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* Peinado */}
      <span className="kicker">Pelo</span>
      <div className="chips">
        {HAIR_STYLES.map((h) => (
          <button
            key={h.id}
            className={`chip-btn ${hair === h.id ? "on" : ""}`}
            aria-pressed={hair === h.id}
            onClick={() => onHairChange(h.id)}
          >
            {h.label}
          </button>
        ))}
      </div>

      {/* Medidas */}
      <div className={`fields ${highlightMeasures ? "fields-review" : ""}`}>
        {highlightMeasures && (
          <p className="fields-note">Estimación poco fiable: revisa y corrige tus medidas.</p>
        )}
        {FIELDS.map((f) => (
          <div key={f.key} className="field">
            <label htmlFor={`m-${f.key}`}>{f.label}</label>
            <div className="input-wrap">
              <input
                id={`m-${f.key}`}
                type="number"
                inputMode="numeric"
                min={40}
                max={200}
                placeholder="—"
                value={value[f.key] ?? ""}
                onChange={(e) =>
                  onChange({
                    ...value,
                    [f.key]: e.target.value === "" ? undefined : Number(e.target.value),
                  })
                }
              />
              <span className="unit">cm</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
